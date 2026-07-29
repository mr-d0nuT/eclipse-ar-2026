/* =========================================================================
   geocode.js — Buscar por nombre de sitio

   Hasta ahora solo se podía elegir ubicación con el GPS, tocando el mapa o
   con los botones de ciudades. Faltaba lo más obvio: escribir dónde estarás.

   Fuente: CartoCiudad, el geocodificador del Instituto Geográfico Nacional.
   Es el mismo que usa el visualizador oficial de eclipses del IGN
   (https://visualizadores.ign.es/eclipses/2026). Sin clave y con CORS abierto.

   Dos pasos, como manda la API: `candidates` para la lista de sugerencias
   —que llega sin coordenadas, solo con la etiqueta— y `find` para resolver la
   elegida a latitud y longitud.

   Responde con JSONP aunque mande la cabecera CORS, así que se lee como texto
   y se le quita la envoltura `callback(...)`.
   ========================================================================= */
(function (global) {
  'use strict';

  const API = 'https://www.cartociudad.es/geocoder/api/geocoder/';

  function unwrap(txt) {
    return JSON.parse(String(txt).trim().replace(/^[\w$]+\(/, '').replace(/\);?$/, ''));
  }

  async function ask(path, timeoutMs) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctl) ctl.abort(); }, timeoutMs || 9000);
    try {
      const r = await fetch(API + path, ctl ? { signal: ctl.signal } : undefined);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return unwrap(await r.text());
    } finally { clearTimeout(timer); }
  }

  /**
   * Sugerencias para lo que se va escribiendo.
   * @returns {Promise<Array<{label:string, muni:string, province:string}>>}
   */
  async function suggest(q) {
    if (!q || q.trim().length < 3) return [];
    try {
      const j = await ask('candidatesJsonp?q=' + encodeURIComponent(q.trim()) + '&limit=8');
      if (!Array.isArray(j)) return [];
      return j.map(c => ({
        label: c.address || c.poblacion || c.muni || '',
        muni: c.muni || '',
        province: c.province || '',
        type: c.type || ''
      })).filter(c => c.label);
    } catch (e) { return []; }
  }

  /** Coordenadas de una sugerencia ya elegida */
  async function resolve(label) {
    try {
      const j = await ask('findJsonp?q=' + encodeURIComponent(label));
      const lat = parseFloat(j && j.lat), lon = parseFloat(j && j.lng);
      // La API devuelve 0,0 cuando no ha sabido resolverlo
      if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) return null;
      return { lat, lon, label: j.address || label, muni: j.muni || '', province: j.province || '' };
    } catch (e) { return null; }
  }

  /**
   * Al revés: de coordenadas a municipio. Para poder decir «Tarragona
   * (Tarragona), Catalunya» debajo de unas coordenadas, como hace el
   * visualizador del IGN.
   * Se cachea sin caducidad: los municipios no se mueven.
   */
  async function reverse(lat, lon) {
    const key = `rgeo:${lat.toFixed(4)},${lon.toFixed(4)}`;
    try {
      const res = await Net.cached(key, null, async () => {
        const j = await ask(`reverseGeocode?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`, 9000);
        if (!j || !j.muni) throw new Error('sin municipio');
        return { muni: j.muni, province: j.province || '', comunidadAutonoma: j.comunidadAutonoma || '' };
      });
      return res.value;
    } catch (e) { return null; }
  }

  global.Geocode = { suggest, resolve, reverse };
})(window);
