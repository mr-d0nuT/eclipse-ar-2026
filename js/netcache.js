/* =========================================================================
   netcache.js — Peticiones con tiempo límite y caché persistente

   Las funciones nuevas (nubes, horizonte) dependen de la red, y esta app se
   usa en el campo. Todo lo que se descarga se guarda, y cuando no hay
   cobertura se sirve lo último conocido diciendo de cuándo es. Nunca se
   bloquea la app esperando a un servidor.
   ========================================================================= */
(function (global) {
  'use strict';

  const PREFIX = 'eclipse-cache:';

  /** Lee una entrada de la caché. `maxAgeMs` null = no caduca nunca. */
  function get(key, maxAgeMs) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (!raw) return null;
      const box = JSON.parse(raw);
      if (!box || typeof box.at !== 'number') return null;
      const age = Date.now() - box.at;
      if (maxAgeMs != null && age > maxAgeMs) return { value: box.v, at: box.at, stale: true };
      return { value: box.v, at: box.at, stale: false };
    } catch (e) { return null; }
  }

  function set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), v: value }));
    } catch (e) {
      // Cuota llena: tiramos lo más viejo de nuestra propia caché y reintentamos
      try {
        const mine = Object.keys(localStorage).filter(k => k.indexOf(PREFIX) === 0);
        mine.sort((a, b) => {
          const pa = JSON.parse(localStorage.getItem(a) || '{}').at || 0;
          const pb = JSON.parse(localStorage.getItem(b) || '{}').at || 0;
          return pa - pb;
        });
        for (let i = 0; i < Math.ceil(mine.length / 3); i++) localStorage.removeItem(mine[i]);
        localStorage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), v: value }));
      } catch (e2) {}
    }
  }

  // ---------------------------------------------------------------------
  // Presupuesto de peticiones
  // ---------------------------------------------------------------------
  /* Open-Meteo corta en seco a los 600 sondeos por minuto y devuelve un 429.
     Medido: seis peticiones de cien coordenadas y a la séptima te para.
     Preferimos contarlo nosotros y avisar («espera 20 segundos») a dispararle
     a ciegas y que el usuario vea medio resultado vacío sin saber por qué.
     El gasto se guarda porque el límite es por IP: recargar la página no lo
     reinicia. */
  const LIMIT = 550;                 // margen por debajo del 600 real
  const WINDOW = 62000;
  const SPEND_KEY = PREFIX + '__spend';

  function loadSpend() {
    try {
      const a = JSON.parse(localStorage.getItem(SPEND_KEY) || '[]');
      const cut = Date.now() - WINDOW;
      return Array.isArray(a) ? a.filter(x => x[0] > cut) : [];
    } catch (e) { return []; }
  }

  function saveSpend(a) {
    try { localStorage.setItem(SPEND_KEY, JSON.stringify(a)); } catch (e) {}
  }

  /** Unidades libres en la ventana actual */
  function spare() {
    const a = loadSpend();
    return LIMIT - a.reduce((s, x) => s + x[1], 0);
  }

  /** Segundos que faltan para poder gastar `units` */
  function waitFor(units) {
    const a = loadSpend();
    let used = a.reduce((s, x) => s + x[1], 0);
    if (LIMIT - used >= units) return 0;
    // Según van caducando las entradas más viejas se libera cuota
    for (const x of a) {
      used -= x[1];
      if (LIMIT - used >= units) {
        return Math.max(1, Math.ceil((x[0] + WINDOW - Date.now()) / 1000));
      }
    }
    return Math.ceil(WINDOW / 1000);
  }

  function spend(units) {
    const a = loadSpend();
    a.push([Date.now(), units]);
    saveSpend(a);
  }

  /** Error con el que los módulos distinguen «no hay cuota» de «no hay red» */
  function rateError(seconds) {
    const e = new Error('rate-limited');
    e.rate = true;
    e.retryAfter = seconds;
    return e;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /** GET de JSON con tiempo límite y un reintento. Rechaza en vez de colgarse. */
  async function getJSON(url, timeoutMs, retries) {
    retries = retries == null ? 1 : retries;
    for (let attempt = 0; ; attempt++) {
      try {
        const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = setTimeout(() => { if (ctl) ctl.abort(); }, timeoutMs || 12000);
        try {
          const r = await fetch(url, ctl ? { signal: ctl.signal } : undefined);
          if (!r.ok) {
            const err = new Error('HTTP ' + r.status);
            err.status = r.status;
            if (r.status === 429) { err.rate = true; err.retryAfter = 60; }
            throw err;
          }
          return await r.json();
        } finally { clearTimeout(timer); }
      } catch (e) {
        // Un 429 no se arregla reintentando en dos segundos: sube hacia arriba
        // para que la interfaz pueda decir cuánto hay que esperar.
        if (e.rate || attempt >= retries) throw e;
        await sleep(700);
      }
    }
  }

  /**
   * Devuelve lo cacheado si está fresco; si no, lo pide y lo guarda.
   * Si la petición falla pero hay algo viejo guardado, devuelve lo viejo
   * marcado como `stale` en vez de fallar: en el campo vale más un dato de
   * ayer que ninguno.
   * @returns {Promise<{value:*, at:number, stale:boolean, offline:boolean}>}
   */
  /* Peticiones en vuelo. Sin esto, tres sitios de la interfaz que pidan lo
     mismo a la vez (y pasa: al arrancar coinciden el pintado inicial, el
     cambio de ubicación y el de pestaña) lanzan tres descargas idénticas y
     gastan el triple de cuota para el mismo resultado. */
  const inflight = {};

  async function cached(key, maxAgeMs, fetcher) {
    const hit = get(key, maxAgeMs);
    if (hit && !hit.stale) return { value: hit.value, at: hit.at, stale: false, offline: false };
    if (inflight[key]) return inflight[key];

    const job = (async () => {
      const value = await fetcher();
      set(key, value);
      return { value, at: Date.now(), stale: false, offline: false };
    })();
    inflight[key] = job;

    try {
      return await job;
    } catch (e) {
      if (hit) return { value: hit.value, at: hit.at, stale: true, offline: true };
      throw e;
    } finally {
      delete inflight[key];
    }
  }

  /** Reparte una lista en trozos de como mucho `n` elementos */
  function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  global.Net = { get, set, getJSON, cached, chunk, spare, spend, waitFor, rateError, LIMIT };
})(window);
