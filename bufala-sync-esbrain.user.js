// ==UserScript==
// @name         Búfala · Sync ESBRAIN automático
// @namespace    https://instalacionesbufala-hue.github.io/bufala
// @version      2.0.0
// @description  Sincroniza las instalaciones de ESBRAIN con el sistema Búfala. Se ejecuta solo, recarga la página cada 15 minutos y no necesita que nadie pulse nada.
// @author       Búfala Tech S.L.
// @match        https://esbrain.esmove.es/*
// @grant        GM_xmlhttpRequest
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
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
  var VER = '2.0.0';
  var MINUTOS = 15;          // cada cuánto se recarga y sincroniza
  var ESPERA_LISTA = 25000;  // margen para que la lista termine de pintarse
  var PARALELO = 6;

  var CLAVE_ULT = 'bufala_sync_ultima';
  var CLAVE_ON  = 'bufala_sync_activo';

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
      'padding:7px 10px;cursor:pointer">Sincronizar ya</button></div>';
    var b = document.getElementById('bfOnOff');
    if (b) b.onclick = function () {
      localStorage.setItem(CLAVE_ON, activo() ? 'no' : 'si');
      pinta(activo() ? '<div>Activado. Sincronizará en breve.</div>' : '<div>Desactivado. No se recargará la página.</div>');
      if (activo()) arranca();
    };
    var y = document.getElementById('bfYa');
    if (y) y.onclick = function () { arranca(); };
  }
  if (document.body) document.body.appendChild(caja);

  // ─────────────────── lectura del listado ───────────────────
  var RE = /instalaciones\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

  function idsEnDom() {
    var ids = [];
    var enlaces = document.querySelectorAll('a[href*="/instalaciones/"]');
    for (var i = 0; i < enlaces.length; i++) {
      var m = RE.exec(enlaces[i].getAttribute('href') || '');
      if (m && ids.indexOf(m[1].toLowerCase()) < 0) ids.push(m[1].toLowerCase());
    }
    return ids;
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
  function envia(inst, fallos) {
    return new Promise(function (resolve) {
      var cuerpo = 'payload=' + encodeURIComponent(JSON.stringify({
        accion: 'esbrainSync', bmVersion: 'US' + VER, instalaciones: inst
      }));
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
            pinta('<div>✅ ' + inst.length + ' fichas enviadas</div>' +
              '<div style="margin-top:4px">Nuevas: <b>' + (r.creados || 0) + '</b> · Actualizadas: <b>' +
              (r.actualizados || 0) + '</b> · Sin cambios: ' + (r.sinCambios || 0) + om + '</div>' +
              (r.reagendados ? '<div style="color:#fbbf24">Reagendadas: ' + r.reagendados + '</div>' : '') +
              (fallos ? '<div style="color:#fbbf24">Fichas no leídas: ' + fallos + '</div>' : '') +
              '<div style="opacity:.6;margin-top:6px">' + new Date().toLocaleTimeString() +
              ' · siguiente en ' + MINUTOS + ' min</div>');
          } else {
            pinta('<div style="color:#fca5a5">Respuesta inesperada (HTTP ' + resp.status + ')</div>' +
                  '<div style="font-size:11px;opacity:.8">Se reintentará en ' + MINUTOS + ' min.</div>');
          }
          resolve();
        },
        onerror: function () {
          pinta('<div style="color:#fca5a5">No se pudo contactar con el sistema Búfala.</div>' +
                '<div style="font-size:11px;opacity:.8">Se reintentará en ' + MINUTOS + ' min.</div>');
          resolve();
        },
        ontimeout: function () {
          pinta('<div style="color:#fca5a5">Tiempo agotado al enviar.</div>');
          resolve();
        }
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
  function arranca() {
    if (corriendo) return;
    corriendo = true;
    pinta('<div>Esperando la lista…</div>');
    esperaLista().then(function (ids) {
      if (!ids.length) {
        pinta('<div style="color:#fbbf24">No se ha encontrado ninguna instalación.</div>');
        corriendo = false;
        return;
      }
      pinta('<div>' + ids.length + ' instalaciones. Leyendo fichas…</div>');
      return leeFichas(ids).then(function (r) {
        return envia(r.inst, r.fallos);
      }).then(function () { corriendo = false; });
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
