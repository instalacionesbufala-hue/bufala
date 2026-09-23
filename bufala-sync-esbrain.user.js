// ==UserScript==
// @name         Búfala · Sync ESBRAIN automático
// @namespace    https://instalacionesbufala-hue.github.io/bufala
// @version      2.3.1
// @description  Sincroniza las instalaciones de ESBRAIN con el sistema Búfala. Se ejecuta solo, recarga la página cada 15 minutos y no necesita que nadie pulse nada.
// @author       Búfala Tech S.L.
// @match        https://esbrain.esmove.es/*
// @grant        GM_xmlhttpRequest
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// @updateURL    https://instalacionesbufala-hue.github.io/bufala/bufala-sync-esbrain.user.js
// @downloadURL  https://instalacionesbufala-hue.github.io/bufala/bufala-sync-esbrain.user.js
// ==/UserScript==

/*
 * POR QUÉ UN USERSCRIPT Y NO EL MARCADOR
 * --------------------------------------
 * Diagnóstico del 17/09/2026: ESBRAIN devuelve la página VACÍA (12 KB, cero
 * UUID) y la lista la pide el navegador después de cargar. Un marcador solo
 * puede leer el DOM ya montado, así que para tener datos frescos hay que
 * recargar... y al recargar el marcador desaparece con la página.
 *
 * Un userscript se reinyecta solo en cada carga, así que SÍ puede recargar y
 * seguir trabajando. De ahí que este sea el único camino realmente automático
 * mientras ESMOVE no nos dé el webhook.
 */

(function () {
  'use strict';

  var W = 'https://script.google.com/macros/s/AKfycbxMMeyP9g75p1lxytithxeFfQVbe0cXV3aFHlJObfI05ewIN1mtTxPYBNPYp--BPKc9tw/exec';
  var VER = '2.3.1';
  var MINUTOS = 15;          // cada cuánto se recarga y sincroniza
  var ESPERA_LISTA = 25000;  // margen para que la lista termine de pintarse
  var PARALELO = 6;

  // ── v2.1.0 · DOS RITMOS (idea de César, 17/09/2026) ──
  // Leer las 134 fichas cada cuarto de hora es tiempo tirado: 112 están
  // COMPLETADAS y no van a cambiar. El estado ya se ve en la propia lista,
  // así que en las pasadas normales solo se piden las fichas de las que
  // siguen VIVAS (asignada, en curso, reagendada) y una vez cada 12 h se hace
  // una pasada COMPLETA que refresca estados y permite detectar retiradas.
  //
  // Es seguro porque el backend (v3.16.7+) solo juzga como retiradas las filas
  // que estuvieran en los estados que trae el payload: si solo mandamos
  // asignadas, una completada que no aparece ni se toca.
  var HORAS_PASADA_COMPLETA = 12;
  var RE_COMPLETADA = /completad/i;

  // ── v2.3.0 · LA LISTA DE LO QUE SE VE (23/09/2026) ──
  // El 23/09 ESMOVE retiró una instalación del día siguiente y el sistema no
  // se enteró: el backend solo sabe qué existe en ESBRAIN por las fichas que
  // le mandamos, y en la pasada rápida no van las completadas. No podía
  // distinguir «ya no está» de «no me la han mandado», así que exigía faltar
  // en dos sincronizaciones seguidas antes de decir nada.
  // Ahora cada envío lleva TODOS los identificadores que hay en la página,
  // se lea su ficha o no. Con esa lista, lo que no aparece está retirado de
  // verdad y se marca a la primera. Cuesta un puñado de bytes.
  var visiblesUlt = [];

  var CLAVE_ULT  = 'bufala_sync_ultima';
  var CLAVE_ON   = 'bufala_sync_activo';
  var CLAVE_FULL = 'bufala_sync_ultima_completa';

  // Solo trabaja en la pantalla del listado
  if (location.pathname.indexOf('/partner/instalaciones') !== 0) return;
  // Y no en la ficha de una instalación concreta
  if (/\/instalaciones\/[0-9a-f-]{36}/i.test(location.pathname)) return;

  // ─────────────────────── panel ───────────────────────
  var caja = document.createElement('div');
  caja.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;background:#111827;' +
    'color:#fff;font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;padding:12px 14px;' +
    'border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:330px';
  function activo() { return localStorage.getItem(CLAVE_ON) !== 'no'; }
  function pinta(html) {
    caja.innerHTML = '<div style="font-weight:700;margin-bottom:6px">Sync ESBRAIN auto v' + VER + '</div>' +
      html +
      '<div style="margin-top:10px;display:flex;gap:8px">' +
      '<button id="bfOnOff" style="flex:1;background:' + (activo() ? '#dc2626' : '#16a34a') +
      ';color:#fff;border:0;border-radius:8px;padding:7px 10px;font-weight:700;cursor:pointer">' +
      (activo() ? 'Desactivar' : 'Activar') + '</button>' +
      '<button id="bfYa" style="background:#374151;color:#fff;border:0;border-radius:8px;' +
      'padding:7px 10px;cursor:pointer">Sincronizar ya</button>' +
      '<button id="bfFull" title="Lee también las completadas" style="background:#374151;color:#fff;' +
      'border:0;border-radius:8px;padding:7px 10px;cursor:pointer">Completa</button></div>';
    var b = document.getElementById('bfOnOff');
    if (b) b.onclick = function () {
      localStorage.setItem(CLAVE_ON, activo() ? 'no' : 'si');
      pinta(activo() ? '<div>Activado. Sincronizará en breve.</div>' : '<div>Desactivado. No se recargará la página.</div>');
      if (activo()) arranca();
    };
    var y = document.getElementById('bfYa');
    if (y) y.onclick = function () { arranca(); };
    var f = document.getElementById('bfFull');
    if (f) f.onclick = function () { forzarCompleta = true; arranca(); };
  }
  if (document.body) document.body.appendChild(caja);

  // ─────────────────── lectura del listado ───────────────────
  var RE = /instalaciones\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

  // Devuelve [{id, completada}] leyendo el estado de la propia tarjeta.
  function fichasEnDom() {
    var out = [], vistos = {};
    var enlaces = document.querySelectorAll('a[href*="/instalaciones/"]');
    for (var i = 0; i < enlaces.length; i++) {
      var m = RE.exec(enlaces[i].getAttribute('href') || '');
      if (!m) continue;
      var id = m[1].toLowerCase();
      if (vistos[id]) continue;
      vistos[id] = true;
      // La tarjeta trae la etiqueta de estado («Completada», «Asignada»…).
      // Si no se reconoce, se trata como VIVA: ante la duda se lee la ficha,
      // que es perder un segundo, nunca un dato.
      var txt = '';
      try {
        var cont = enlaces[i].closest('li, article, div[class*="card"], div') || enlaces[i];
        txt = (cont.textContent || '').slice(0, 400);
      } catch (e) { txt = enlaces[i].textContent || ''; }
      out.push({ id: id, completada: RE_COMPLETADA.test(txt) });
    }
    return out;
  }

  function idsEnDom() {
    return fichasEnDom().map(function (f) { return f.id; });
  }

  function tocaCompleta() {
    var ult = parseInt(localStorage.getItem(CLAVE_FULL) || '0', 10);
    return !ult || (Date.now() - ult) > HORAS_PASADA_COMPLETA * 3600000;
  }

  // La lista se pinta después de cargar: se espera a que deje de crecer.
  function esperaLista() {
    return new Promise(function (resolve) {
      var t0 = Date.now(), ultimo = 0, estable = 0;
      var iv = setInterval(function () {
        var n = idsEnDom().length;
        if (n > 0 && n === ultimo) estable++; else estable = 0;
        ultimo = n;
        pinta('<div>Esperando la lista… (' + n + ' instalaciones)</div>');
        // 3 comprobaciones seguidas con el mismo número = ya está entera
        if ((estable >= 3 && n > 0) || Date.now() - t0 > ESPERA_LISTA) {
          clearInterval(iv);
          resolve(idsEnDom());
        }
      }, 700);
    });
  }

  // ─────────────────────── fichas ───────────────────────
  function jget(url) {
    return fetch(url, { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }
  function notas(d) {
    var p = [];
    if (typeof d.comentarios === 'string' && d.comentarios.trim()) p.push(d.comentarios);
    if (typeof d.nota_interna === 'string' && d.nota_interna.trim()) p.push('Nota interna: ' + d.nota_interna);
    return p.join('\n');
  }
  function mapea(d) {
    return {
      uuid: d.id || d.uuid,
      presupuesto_num: d.presupuesto_num || '',
      cliente_nombre: d.cliente_nombre || '',
      cliente_telefono: d.cliente_telefono || '',
      cliente_email: d.cliente_email || '',
      direccion: d.direccion || '',
      codigo_postal: d.codigo_postal || '',
      poblacion: d.poblacion || '',
      fecha_instalacion: d.fecha_instalacion || '',
      turno: d.turno || '',
      estado: d.estado || '',
      tipo_garaje: d.tipo_garaje || '',
      hardware_desc: d.hardware_desc || '',
      numero_serie_hardware: d.numero_serie_hardware || '',
      metros_presupuestados: (d.metros_presupuestados == null ? '' : d.metros_presupuestados),
      instalacion_desc: d.instalacion_desc || '',
      requiere_preinstalacion_suministro: d.requiere_preinstalacion_suministro === true,
      equipo: (d.equipo && d.equipo.nombre) ? { nombre: d.equipo.nombre } : null,
      notas: notas(d)
    };
  }
  function leeFichas(ids) {
    var inst = [], fallos = 0, i = 0, hechas = 0;
    function una() {
      if (i >= ids.length) return Promise.resolve();
      var id = ids[i++];
      return jget('/api/partner/instalaciones/' + id).then(function (d) {
        if (d && (d.id || d.uuid)) inst.push(mapea(d)); else fallos++;
        hechas++;
        if (hechas % 10 === 0) pinta('<div>Leyendo fichas… ' + hechas + ' de ' + ids.length + '</div>');
        return una();
      });
    }
    var hilos = [];
    for (var h = 0; h < Math.min(PARALELO, ids.length); h++) hilos.push(una());
    return Promise.all(hilos).then(function () { return { inst: inst, fallos: fallos }; });
  }

  // ─────────────────────── envío ───────────────────────
  // GM_xmlhttpRequest evita cualquier problema de origen cruzado con Google.
  // v2.2.0 — El ping previo NO es opcional: Apps Script redirige internamente
  // a googleusercontent.com y, sin una peticion previa que resuelva esa
  // redireccion, el POST responde 404 (paso con el marcador v1.3.0 y ha vuelto
  // a pasar aqui el 17/09/2026). Se hace por el mismo canal que el envio.
  function ping() {
    return new Promise(function (res) {
      GM_xmlhttpRequest({
        method: 'GET', url: W + '?action=ping', timeout: 20000,
        onload: function (r) { var j = null; try { j = JSON.parse(r.responseText); } catch (e) {} res(j); },
        onerror: function () { res(null); },
        ontimeout: function () { res(null); }
      });
    });
  }

  // v2.2.0 — Ante un fallo NO se espera al siguiente ciclo de 15 minutos: si
  // el primer envio del dia falla, esperar un cuarto de hora puede significar
  // no arrancar nunca (aviso de César). Se reintenta a los 45 s, luego a los
  // 2 min y luego a los 5, y solo despues se deja para el ciclo normal.
  var ESPERAS_REINTENTO = [45000, 120000, 300000];

  // v2.3.0 — Aviso en el propio banner de las instalaciones que ya no están
  // en ESBRAIN, con lo que falta para darlas por retiradas. Lo manda el
  // backend en `ausentes`; si no viene (backend antiguo), no se pinta nada.
  function avisoAusentes(r) {
    var lista = (r && r.ausentes) || [];
    if (!lista.length) return '';
    var filas = lista.map(function (a) {
      var quien = (a.cliente || '?') + ' — ' + (a.fecha || '');
      var cola;
      if (a.fase === 'confirmada') {
        cola = a.borrado ? 'retirada confirmada · evento borrado'
                         : 'retirada confirmada · el evento está en ' +
                           (a.calendario || 'un calendario de brigada') + ', NO se ha tocado';
      } else if (a.fase === 'aviso') {
        cola = 'se confirma en ' + (a.minutosParaConfirmar != null ? a.minutosParaConfirmar : '?') + ' min' +
               (a.conBrigada ? ' · está en ' + (a.calendario || 'un calendario de brigada') +
                               ': no se borrará sola' : ' · se borrará del calendario principal');
      } else {
        cola = 'se reintenta en ' + MINUTOS + ' min (falta' +
               (a.faltan === 1 ? '' : 'n') + ' ' + (a.faltan != null ? a.faltan : 1) + ' comprobación' +
               (a.faltan === 1 ? '' : 'es') + ')';
      }
      return '<div style="margin-top:2px">· ' + quien + ' <span style="opacity:.85">(' + cola + ')</span></div>';
    }).join('');
    return '<div style="background:#7c2d12;border-left:3px solid #fbbf24;padding:6px 8px;' +
           'border-radius:6px;margin-bottom:6px;font-size:12px">' +
           '<b>⚠️ ' + lista.length + (lista.length === 1 ? ' instalación que ya no aparece' :
                                       ' instalaciones que ya no aparecen') +
           ' en ESBRAIN</b>' + filas + '</div>';
  }

  function envia(inst, fallos, completa, omitidas, intento) {
    intento = intento || 0;
    return new Promise(function (resolve) {
      var cuerpo = 'payload=' + encodeURIComponent(JSON.stringify({
        accion: 'esbrainSync', bmVersion: 'US' + VER, instalaciones: inst,
        idsVisibles: visiblesUlt          // v2.3.0: todo lo que se ve en la página
      }));
      function reintenta(motivo) {
        if (intento < ESPERAS_REINTENTO.length) {
          var ms = ESPERAS_REINTENTO[intento];
          pinta('<div style="color:#fca5a5">' + motivo + '</div>' +
                '<div style="font-size:11px;opacity:.85">Reintento ' + (intento + 1) + ' de ' +
                ESPERAS_REINTENTO.length + ' en ' + Math.round(ms / 1000) + ' s…</div>');
          setTimeout(function () { envia(inst, fallos, completa, omitidas, intento + 1); }, ms);
        } else {
          pinta('<div style="color:#fca5a5">' + motivo + '</div>' +
                '<div style="font-size:11px;opacity:.85">Agotados los reintentos. ' +
                'Se volverá a intentar en el próximo ciclo (' + MINUTOS + ' min) ' +
                'o pulsa «Sincronizar ya».</div>');
        }
      }

      GM_xmlhttpRequest({
        method: 'POST',
        url: W,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: cuerpo,
        timeout: 180000,
        onload: function (resp) {
          var r = null;
          try { r = JSON.parse(resp.responseText); } catch (e) {}
          if (r && r.accion === 'esbrainSync') {
            localStorage.setItem(CLAVE_ULT, String(Date.now()));
            var om = r.omitidasCompletadas ? ' · ' + r.omitidasCompletadas + ' completadas omitidas' : '';
            pinta(avisoAusentes(r) +
              '<div>✅ ' + inst.length + ' fichas enviadas</div>' +
              '<div style="margin-top:4px">Nuevas: <b>' + (r.creados || 0) + '</b> · Actualizadas: <b>' +
              (r.actualizados || 0) + '</b> · Sin cambios: ' + (r.sinCambios || 0) + om + '</div>' +
              (r.reagendados ? '<div style="color:#fbbf24">Reagendadas: ' + r.reagendados + '</div>' : '') +
              (fallos ? '<div style="color:#fbbf24">Fichas no leídas: ' + fallos + '</div>' : '') +
              '<div style="opacity:.6;margin-top:6px">' + new Date().toLocaleTimeString() +
              (completa ? ' · pasada completa' : ' · rápida' +
                (omitidas ? ' (' + omitidas + ' completadas omitidas aquí)' : '')) +
              ' · siguiente en ' + MINUTOS + ' min</div>');
          } else {
            reintenta('Respuesta inesperada (HTTP ' + resp.status + ')');
          }
          resolve();
        },
        onerror: function () { reintenta('No se pudo contactar con el sistema Búfala.'); resolve(); },
        ontimeout: function () { reintenta('Tiempo agotado al enviar.'); resolve(); }
      });
    });
  }

  // ─────────────────── ciclo automático ───────────────────
  function programaRecarga() {
    if (!activo()) return;
    setTimeout(function () {
      if (activo()) location.reload();
    }, MINUTOS * 60000);
  }

  var corriendo = false;
  var forzarCompleta = false;
  function arranca() {
    if (corriendo) return;
    corriendo = true;
    pinta('<div>Comprobando el sistema Búfala…</div>');
    ping().then(function (pj) {
      var v = (pj && (pj.version || (pj.meta && pj.meta.version))) || '';
      pinta('<div>' + (v ? 'Backend ' + v : '⚠️ Backend sin confirmar') + ' · esperando la lista…</div>');
      return esperaLista();
    }).then(function (ids) {
      if (!ids.length) {
        pinta('<div style="color:#fbbf24">No se ha encontrado ninguna instalación.</div>');
        corriendo = false;
        return;
      }
      var todas = fichasEnDom();
      visiblesUlt = todas.map(function (f) { return f.id; });   // v2.3.0
      var completa = forzarCompleta || tocaCompleta();
      forzarCompleta = false;
      var aLeer = completa ? todas : todas.filter(function (f) { return !f.completada; });
      var omitidas = todas.length - aLeer.length;

      if (!aLeer.length) {
        pinta('<div>Nada que actualizar: las ' + todas.length + ' instalaciones están completadas.</div>' +
              '<div style="opacity:.6;margin-top:6px">' + new Date().toLocaleTimeString() + '</div>');
        corriendo = false;
        return;
      }

      pinta('<div>' + (completa ? '🔄 Pasada COMPLETA' : '⚡ Pasada rápida') + ': ' +
            aLeer.length + ' de ' + todas.length +
            (omitidas ? ' <span style="opacity:.7">(' + omitidas + ' completadas se dejan para la pasada de cada ' +
              HORAS_PASADA_COMPLETA + ' h)</span>' : '') +
            '. Leyendo fichas…</div>');

      return leeFichas(aLeer.map(function (f) { return f.id; })).then(function (r) {
        return envia(r.inst, r.fallos, completa, omitidas);
      }).then(function () {
        if (completa) localStorage.setItem(CLAVE_FULL, String(Date.now()));
        corriendo = false;
      });
    }).catch(function (e) {
      pinta('<div style="color:#fca5a5">Error: ' + (e && e.message ? e.message : e) + '</div>');
      corriendo = false;
    });
  }

  if (!activo()) {
    pinta('<div>Desactivado.</div>');
  } else {
    arranca();
    programaRecarga();   // recarga la página dentro de 15 min y vuelve a empezar
  }
}());
