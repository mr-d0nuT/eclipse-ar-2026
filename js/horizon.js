/* =========================================================================
   horizon.js — ¿Te tapa el monte el eclipse?

   El 12 de agosto de 2026 el Sol estará a 3-10° sobre el horizonte oeste en
   toda la península. A esa altura el relieve manda por encima de todo: un
   cerro a 5 km, o Montserrat a 50, se comen la totalidad entera.

   Aquí se descarga el perfil de elevación del terreno en el abanico de
   azimuts que recorre el Sol durante el eclipse y se calcula, para cada
   dirección, a qué altura angular está el horizonte real.

   Fuente: API de elevación de Open-Meteo (DEM Copernicus GLO-90, ~90 m).
   Sin clave, CORS abierto, hasta 100 coordenadas por petición.
   ========================================================================= */
(function (global) {
  'use strict';

  const DEG = Math.PI / 180;
  const R_EARTH = 6371000;             // metros

  // Refracción atmosférica: los rayos rasantes se curvan hacia la Tierra, lo
  // que equivale a un planeta más grande y hace ver un poco «más allá».
  // k = 0.13 es el valor estándar para visibilidad óptica.
  const R_EF = R_EARTH / (1 - 0.13);

  /* El muestreo está calibrado contra el límite real de la API: 600 sondeos
     por minuto, medidos.

     Antes eran 14 rayos × 22 distancias = 309 sondeos, y como esto se calcula
     solo al abrir la app, un arranque se comía media cuota del minuto. Con 3°
     entre rayos y 18 distancias son 163: la silueta del terreno sale igual de
     bien —se interpola entre rayos— y queda sitio para todo lo demás. */
  const D_MIN = 200;                   // metros
  const D_MAX = 80000;                 // 80 km: Montserrat desde Barcelona cuenta
  const N_DIST = 18;
  const AZ_STEP = 3;

  // Respaldo cuando aún no se conocen las circunstancias locales. Cubre toda
  // la península: A Coruña empieza el eclipse en el 270° y Palma lo acaba en
  // el 296°.
  const AZ_FROM = 266, AZ_TO = 300;

  const API = 'https://api.open-meteo.com/v1/elevation';

  /** Distancias muestreadas, con paso logarítmico: fino cerca, grueso lejos */
  const DISTANCES = (function () {
    const out = [];
    const ratio = Math.pow(D_MAX / D_MIN, 1 / (N_DIST - 1));
    for (let i = 0; i < N_DIST; i++) out.push(D_MIN * Math.pow(ratio, i));
    return out;
  })();

  /**
   * Abanico de azimuts que hay que sondear en un sitio concreto: el que
   * recorre el Sol entre C1 y C4, con cuatro grados de margen a cada lado.
   * Fijarlo a mano no vale: desde Islandia el eclipse pasa por el 237°, y
   * desde Palma por el 296°.
   */
  function fanFor(lc) {
    let from = AZ_FROM, to = AZ_TO;
    if (lc) {
      const azs = [lc.c1.az, lc.max.az, lc.c4.az];
      if (lc.c2) azs.push(lc.c2.az);
      if (lc.c3) azs.push(lc.c3.az);
      from = Math.floor(Math.min.apply(null, azs)) - 4;
      to = Math.ceil(Math.max.apply(null, azs)) + 4;
    }
    const out = [];
    for (let a = from; a <= to; a += AZ_STEP) out.push(a);
    return out;
  }

  /** Punto a `d` metros de (lat, lon) siguiendo el rumbo `az` */
  function destPoint(lat, lon, az, d) {
    const ad = d / R_EARTH;
    const br = az * DEG, la1 = lat * DEG, lo1 = lon * DEG;
    const sinLa2 = Math.sin(la1) * Math.cos(ad) + Math.cos(la1) * Math.sin(ad) * Math.cos(br);
    const la2 = Math.asin(Math.max(-1, Math.min(1, sinLa2)));
    const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(ad) * Math.cos(la1),
                                 Math.cos(ad) - Math.sin(la1) * sinLa2);
    return { lat: la2 / DEG, lon: ((lo2 / DEG + 540) % 360) - 180 };
  }

  /**
   * Altura angular de un punto del terreno visto desde el observador.
   * Descuenta la caída por curvatura terrestre, corregida por refracción.
   * @param {number} dh  desnivel en metros (terreno − observador)
   * @param {number} d   distancia en metros
   */
  function elevationAngle(dh, d) {
    const drop = (d * d) / (2 * R_EF);
    return Math.atan2(dh - drop, d) / DEG;
  }

  /** Pide elevaciones en lotes de 100 y las devuelve en el mismo orden */
  async function fetchElevations(points) {
    const wait = Net.waitFor(points.length);
    if (wait > 0) throw Net.rateError(wait);

    const out = [];
    for (const lot of Net.chunk(points, 100)) {
      const la = lot.map(p => p.lat.toFixed(4)).join(',');
      const lo = lot.map(p => p.lon.toFixed(4)).join(',');
      Net.spend(lot.length);
      const j = await Net.getJSON(`${API}?latitude=${la}&longitude=${lo}`, 15000);
      if (!j || !Array.isArray(j.elevation) || j.elevation.length !== lot.length) {
        throw new Error('respuesta de elevación inesperada');
      }
      for (const v of j.elevation) out.push(v);
    }
    return out;
  }

  /**
   * Perfil de horizonte en el abanico del eclipse.
   * El terreno no cambia, así que se cachea para siempre por punto redondeado
   * a ~110 m.
   * @returns {Promise<object|null>} null si no hay red ni nada guardado
   */
  async function profile(lat, lon, lc) {
    const key = `horizon:${lat.toFixed(3)},${lon.toFixed(3)}`;
    const azimuths = fanFor(lc);
    try {
      const res = await Net.cached(key, null, async () => {
        // El primer punto es el propio observador
        const pts = [{ lat, lon }];
        for (const az of azimuths) {
          for (const d of DISTANCES) pts.push(destPoint(lat, lon, az, d));
        }
        const elev = await fetchElevations(pts);
        const obsElev = elev[0];

        const rays = [];
        let k = 1;
        for (const az of azimuths) {
          const samples = [];
          let horizon = -90, peakDist = 0, peakElev = obsElev;
          for (const d of DISTANCES) {
            const h = elev[k++];
            const a = elevationAngle(h - obsElev, d);
            samples.push([Math.round(d), Math.round(h)]);
            if (a > horizon) { horizon = a; peakDist = d; peakElev = h; }
          }
          // El horizonte nunca queda por debajo del plano del observador: si
          // todo alrededor baja, lo que se ve es el horizonte geométrico (0°).
          rays.push({
            az,
            horizon: Math.max(0, +horizon.toFixed(3)),
            peakDist: Math.round(peakDist),
            peakElev: Math.round(peakElev),
            samples
          });
        }
        return { lat, lon, obsElev, rays };
      });
      return Object.assign({}, res.value, { at: res.at, stale: res.stale });
    } catch (e) {
      // Quedarse sin cuota no es lo mismo que no tener red: la interfaz
      // necesita distinguirlo para poder decir cuántos segundos hay que esperar.
      if (e && e.rate) throw e;
      return null;
    }
  }

  /** Perfil ya guardado, sin tocar la red (para pintar al instante) */
  function cachedProfile(lat, lon) {
    const hit = Net.get(`horizon:${lat.toFixed(3)},${lon.toFixed(3)}`, null);
    return hit ? Object.assign({}, hit.value, { at: hit.at, stale: false }) : null;
  }

  /** Altura del horizonte en un azimut cualquiera, interpolando entre rayos */
  function horizonAt(prof, az) {
    if (!prof || !prof.rays || !prof.rays.length) return 0;
    const rays = prof.rays;
    if (az <= rays[0].az) return rays[0].horizon;
    if (az >= rays[rays.length - 1].az) return rays[rays.length - 1].horizon;
    for (let i = 1; i < rays.length; i++) {
      if (az <= rays[i].az) {
        const a = rays[i - 1], b = rays[i];
        const k = (az - a.az) / (b.az - a.az);
        return a.horizon + (b.horizon - a.horizon) * k;
      }
    }
    return 0;
  }

  /**
   * Cruza el perfil con la trayectoria real del Sol durante el eclipse.
   *
   * Devuelve el veredicto que importa: cuánto margen hay en el máximo, si la
   * totalidad entera queda por encima del terreno, y a qué hora desaparece el
   * Sol tras el relieve (que en el este peninsular pasa antes de C4).
   */
  function analyse(prof, lc, lat, lon) {
    if (!prof || !lc) return null;

    const at = date => {
      const s = Astro.sunAltAz(date, lat, lon);
      const hz = horizonAt(prof, s.az);
      return { date, az: s.az, alt: s.altRefracted, horizon: hz, margin: s.altRefracted - hz };
    };

    const max = at(lc.max.date);
    const c1 = at(lc.c1.date);

    // Momento en que el Sol se esconde tras el terreno, buscado a pasos de 30 s
    let blocked = null;
    const t0 = lc.c1.date.getTime(), t1 = lc.c4.date.getTime();
    let prev = c1;
    for (let t = t0 + 30000; t <= t1; t += 30000) {
      const cur = at(new Date(t));
      if (prev.margin > 0 && cur.margin <= 0) {
        // Afinado por bisección
        let lo = prev.date.getTime(), hi = cur.date.getTime();
        for (let i = 0; i < 20; i++) {
          const mid = (lo + hi) / 2;
          if (at(new Date(mid)).margin > 0) lo = mid; else hi = mid;
        }
        blocked = at(new Date((lo + hi) / 2));
        break;
      }
      prev = cur;
    }

    // ¿Se ve la totalidad entera?
    let totalityVisible = null;
    if (lc.c2 && lc.c3) {
      const a = at(lc.c2.date), b = at(lc.c3.date);
      totalityVisible = a.margin > 0 && b.margin > 0 && max.margin > 0;
    }

    const verdict = max.margin <= 0 ? 'blocked' : max.margin < 2 ? 'tight' : 'clear';

    return {
      horizonAtMax: max.horizon,
      sunAltAtMax: max.alt,
      azAtMax: max.az,
      margin: max.margin,
      marginAtC1: c1.margin,
      blocked,                 // {date, az, alt, horizon} o null
      totalityVisible,
      verdict,                 // 'clear' | 'tight' | 'blocked'
      obsElev: prof.obsElev,
      stale: !!prof.stale,
      at: prof.at
    };
  }

  /**
   * Serie (azimut, altura) del Sol durante el eclipse, para dibujar su
   * trayectoria sobre la silueta del terreno.
   */
  function sunTrack(lc, lat, lon, steps) {
    if (!lc) return [];
    steps = steps || 90;
    const t0 = lc.c1.date.getTime(), t1 = lc.c4.date.getTime();
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const d = new Date(t0 + (t1 - t0) * i / steps);
      const s = Astro.sunAltAz(d, lat, lon);
      out.push({ date: d, az: s.az, alt: s.altRefracted });
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Versión ligera para el planificador
  // ---------------------------------------------------------------------
  /* Un perfil completo son ~290 sondeos. Para veinte candidatos serían casi
     6.000 puntos y sesenta peticiones: demasiado, y de mala educación con una
     API gratuita. Para el ranking basta con la ventana de la totalidad, así
     que se muestrean 3 azimuts y 14 distancias por candidato y se meten TODOS
     los candidatos en las mismas peticiones de 100. Veinte sitios salen por
     nueve peticiones. */
  const COARSE_D = (function () {
    const out = [], n = 10, dmin = 300, dmax = 60000;
    const ratio = Math.pow(dmax / dmin, 1 / (n - 1));
    for (let i = 0; i < n; i++) out.push(dmin * Math.pow(ratio, i));
    return out;
  })();

  /** Sondeos que cuesta mirar el horizonte de un sitio, y de `n` sitios */
  const COARSE_PER_SPOT = 1 + 3 * COARSE_D.length;
  const coarseCost = n => n * COARSE_PER_SPOT;

  /** ¿Ya tenemos guardado el horizonte de este sitio? (no cuesta red) */
  function isCached(s) {
    return !!Net.get(`hz1:${s.lat.toFixed(4)},${s.lon.toFixed(4)},${Math.round(s.azMax || 286)}`, null);
  }

  /**
   * Elevación de una lista de puntos, en lotes de 100 y de tres en tres.
   * Devuelve null en las posiciones que no se hayan podido resolver.
   *
   * Sirve además para distinguir mar de tierra: este DEM da exactamente 0 en
   * el agua, mientras que la costa real da 1 m o más (el delta del Ebro sale
   * a 1 m, la playa de Castelldefels a 4). Sin esto el planificador acaba
   * recomendando un punto excelente… en mitad del Mediterráneo.
   */
  async function elevations(points, onProgress) {
    if (!points.length) return [];
    const wait = Net.waitFor(points.length);
    if (wait > 0) throw Net.rateError(wait);

    const lots = Net.chunk(points, 100);
    const out = [];
    let done = 0;
    // De dos en dos: rápido sin abrir seis conexiones a la vez
    for (const group of Net.chunk(lots, 2)) {
      const res = await Promise.all(group.map(lot => {
        const la = lot.map(p => p.lat.toFixed(4)).join(',');
        const lo = lot.map(p => p.lon.toFixed(4)).join(',');
        Net.spend(lot.length);
        return Net.getJSON(`${API}?latitude=${la}&longitude=${lo}`, 20000)
          .then(j => (j && Array.isArray(j.elevation) && j.elevation.length === lot.length)
            ? j.elevation : new Array(lot.length).fill(null))
          .catch(e => { if (e && e.rate) throw e; return new Array(lot.length).fill(null); });
      }));
      for (const arr of res) for (const v of arr) out.push(v);
      done += group.length;
      if (onProgress) onProgress(done, lots.length);
    }
    return out;
  }

  /** ¿Está este punto en el agua, según el DEM? */
  const isSea = elev => elev === 0;

  /**
   * Horizonte aproximado de varios puntos a la vez.
   * @param {Array<{lat:number,lon:number}>} spots
   * @param {function} [onProgress] recibe (hechas, totales) de peticiones
   * @returns {Promise<Array<{horizon:number, obsElev:number}|null>>}
   */
  async function horizonMany(spots, onProgress) {
    if (!spots.length) return [];

    /* El relieve no cambia nunca, así que cada sitio ya calculado se guarda y
       no se vuelve a pedir. Sin esto, comparar las cuatro bandas de distancia
       era imposible: cada búsqueda gastaba la cuota entera del minuto y las
       tres siguientes fallaban. Con la caché, repetir una búsqueda o mirar una
       banda que solapa con otra ya mirada no cuesta ni una petición. */
    const keyOf = s => `hz1:${s.lat.toFixed(4)},${s.lon.toFixed(4)},${Math.round(s.azMax || 286)}`;

    const out = new Array(spots.length).fill(null);
    const need = [];
    spots.forEach((s, i) => {
      const hit = Net.get(keyOf(s), null);
      if (hit) out[i] = hit.value; else need.push({ i, s });
    });
    if (!need.length) {
      if (onProgress) onProgress(1, 1);
      return out;
    }

    // Tres rayos alrededor del azimut del máximo de cada sitio: es la
    // dirección que de verdad decide si se ve la totalidad.
    const azsOf = s => { const c = s.azMax || 286; return [c - 2, c, c + 2]; };

    const perSpot = 1 + 3 * COARSE_D.length;
    const pts = [];
    for (const n of need) {
      pts.push({ lat: n.s.lat, lon: n.s.lon });
      for (const az of azsOf(n.s)) {
        for (const d of COARSE_D) pts.push(destPoint(n.s.lat, n.s.lon, az, d));
      }
    }

    const elev = await elevations(pts, onProgress);

    for (let j = 0; j < need.length; j++) {
      const base = j * perSpot;
      const obsElev = elev[base];
      if (obsElev == null) continue;
      let horizon = 0, ok = false;
      for (let k = 1; k < perSpot; k++) {
        const h = elev[base + k];
        if (h == null) continue;
        ok = true;
        const d = COARSE_D[(k - 1) % COARSE_D.length];
        const a = elevationAngle(h - obsElev, d);
        if (a > horizon) horizon = a;
      }
      if (!ok) continue;
      const val = { horizon: +horizon.toFixed(3), obsElev };
      out[need[j].i] = val;
      Net.set(keyOf(need[j].s), val);
    }
    return out;
  }

  /** Extremos del abanico de un perfil ya calculado, para dibujarlo */
  function fanOf(prof) {
    if (!prof || !prof.rays || !prof.rays.length) return { from: AZ_FROM, to: AZ_TO };
    return { from: prof.rays[0].az, to: prof.rays[prof.rays.length - 1].az };
  }

  global.Horizon = {
    profile, cachedProfile, horizonAt, analyse, sunTrack, horizonMany,
    elevations, isSea, elevationAngle, destPoint, fanFor, fanOf, coarseCost, isCached,
    AZ_FROM, AZ_TO, DISTANCES, COARSE_PER_SPOT
  };
})(window);
