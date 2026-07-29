/* =========================================================================
   weather.js — ¿Habrá nubes?

   La pregunta que decide todo y que la app no respondía. Con el Sol a 4° de
   altura, la nubosidad BAJA es la asesina: se apoya justo en el horizonte,
   donde va a estar el eclipse. Los cirros altos dejan ver la totalidad, más
   apagada. Por eso aquí no se da un solo número, sino el desglose.

   Fuente: Open-Meteo (previsión y archivo histórico). Sin clave, CORS abierto.

   A 14 días vista una previsión no es accionable, y la app no debe fingir que
   sí: cada dato lleva su etiqueta de fiabilidad. Lo que SÍ sirve hoy es la
   climatología — qué pasó en ese punto los últimos diez 12 de agosto.
   ========================================================================= */
(function (global) {
  'use strict';

  const FORECAST = 'https://api.open-meteo.com/v1/forecast';
  const ARCHIVE  = 'https://archive-api.open-meteo.com/v1/archive';
  const HOURLY   = 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,visibility';

  const CLIMA_YEARS = 10;
  const TTL = 3 * 3600 * 1000;         // la previsión se refresca cada 3 h

  /** Fecha del eclipse en UTC, tal como la define el motor besseliano */
  function eclipseDates() {
    const d = Eclipse.EL.dateUTC;
    const p = n => String(n).padStart(2, '0');
    const day = `${d.y}-${p(d.m)}-${p(d.d)}`;
    const next = new Date(Date.UTC(d.y, d.m - 1, d.d + 1));
    const dayAfter = `${next.getUTCFullYear()}-${p(next.getUTCMonth() + 1)}-${p(next.getUTCDate())}`;
    return { day, dayAfter, year: d.y, month: d.m, dayNum: d.d };
  }

  /** Días que faltan para el eclipse (puede ser negativo) */
  function daysToEclipse() {
    return (Eclipse.EL.greatestEclipseUT - Date.now()) / 86400000;
  }

  /**
   * Fiabilidad de una previsión a N días. Los modelos globales pierden casi
   * todo su valor pasada la semana; decirlo es parte de informar bien.
   */
  function confidenceOf(days) {
    if (days > 10) return 'vague';       // orientativa
    if (days > 4)  return 'fair';        // razonable
    if (days > 1)  return 'good';        // fiable
    return 'high';                       // muy fiable
  }

  /**
   * Calidad de cielo 0..1 ponderando por tipo de nube.
   * La baja pesa mucho más que la alta: a 4° de altura, un estrato a 800 m
   * tapa el Sol por completo, mientras que un cirro solo lo atenúa.
   */
  function skyScore(low, mid, high) {
    const v = (low || 0) * 0.70 + (mid || 0) * 0.25 + (high || 0) * 0.05;
    return Math.max(0, Math.min(1, 1 - v / 100));
  }

  /**
   * Convierte la respuesta horaria en instantes UTC reales.
   * Se pide todo en UTC (así `start_hour` no depende de husos) y la hora que
   * se enseña se compone luego con el reloj del dispositivo, igual que hace
   * el resto de la app.
   */
  function toHours(j) {
    const off = (j.utc_offset_seconds || 0) * 1000;
    const H = j.hourly || {};
    const out = [];
    for (let i = 0; i < (H.time || []).length; i++) {
      out.push({
        t: Date.parse(H.time[i] + ':00Z') - off,
        total: H.cloud_cover ? H.cloud_cover[i] : null,
        low:   H.cloud_cover_low ? H.cloud_cover_low[i] : null,
        mid:   H.cloud_cover_mid ? H.cloud_cover_mid[i] : null,
        high:  H.cloud_cover_high ? H.cloud_cover_high[i] : null,
        vis:   H.visibility ? H.visibility[i] : null
      });
    }
    return out;
  }

  /** La hora prevista más cercana a un instante dado */
  function hourNear(hours, when) {
    if (!hours || !hours.length) return null;
    const ms = when instanceof Date ? when.getTime() : when;
    let best = null, bd = Infinity;
    for (const h of hours) {
      const d = Math.abs(h.t - ms);
      if (d < bd) { bd = d; best = h; }
    }
    return bd <= 3600000 * 1.5 ? best : null;
  }

  /**
   * Open-Meteo cobra por volumen de datos, y el límite por minuto es real:
   * pedir dos días enteros de cinco variables para veinte puntos devuelve un
   * 429. Acotando a las horas que interesan se gasta doce veces menos.
   * @param {string} vars variables horarias
   * @param {[number,number]} [span] instantes UTC a cubrir; por defecto, una
   *        ventana amplia que vale desde Groenlandia hasta Baleares
   */
  function forecastURL(lats, lons, vars, span) {
    const D = eclipseDates();
    const fmt = ms => new Date(ms).toISOString().slice(0, 13) + ':00';
    const from = span ? fmt(span[0] - 3600000) : `${D.day}T15:00`;
    const to = span ? fmt(span[1] + 3600000) : `${D.day}T21:00`;
    return `${FORECAST}?latitude=${lats}&longitude=${lons}&hourly=${vars || HOURLY}` +
           `&timezone=UTC&start_hour=${from}&end_hour=${to}`;
  }

  /**
   * Previsión de nubosidad para un punto, en la ventana del eclipse.
   * @returns {Promise<object|null>} null si aún está fuera del alcance del
   *          modelo (>16 días) y no hay nada cacheado
   */
  async function forecast(lat, lon) {
    const key = `wx:${lat.toFixed(2)},${lon.toFixed(2)}`;
    try {
      const res = await Net.cached(key, TTL, async () => {
        Net.spend(6);
        const j = await Net.getJSON(forecastURL(lat.toFixed(4), lon.toFixed(4)), 15000);
        if (!j || !j.hourly) throw new Error('sin datos horarios');
        return { hours: toHours(j), elevation: j.elevation };
      });
      return {
        hours: res.value.hours,
        elevation: res.value.elevation,
        at: res.at,
        stale: res.stale,
        offline: res.offline,
        confidence: confidenceOf(daysToEclipse())
      };
    } catch (e) {
      if (e && e.rate) throw e;
      return null;
    }
  }

  /**
   * Previsión para varios puntos de golpe. Open-Meteo acepta listas de
   * coordenadas y devuelve un array, así que el ranking del planificador
   * cuesta una sola petición.
   */
  async function forecastMany(points) {
    if (!points.length) return [];

    // Solo las nubes y solo las horas del máximo de estos puntos: para el
    // ranking no hace falta nada más, y así la búsqueda entera cabe en la cuota.
    const VARS = 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high';
    const times = points.map(p => p.maxDate ? p.maxDate.getTime() : Eclipse.EL.greatestEclipseUT);
    const span = [Math.min.apply(null, times), Math.max.apply(null, times)];

    const out = [];
    for (const lot of Net.chunk(points, 25)) {
      const lats = lot.map(p => p.lat.toFixed(4)).join(',');
      const lons = lot.map(p => p.lon.toFixed(4)).join(',');
      let arr;
      try {
        Net.spend(lot.length * 3);
        const j = await Net.getJSON(forecastURL(lats, lons, VARS, span), 20000);
        arr = Array.isArray(j) ? j : [j];
      } catch (e) {
        for (let i = 0; i < lot.length; i++) out.push(null);
        continue;
      }
      for (let i = 0; i < lot.length; i++) {
        out.push(arr[i] && arr[i].hourly ? { hours: toHours(arr[i]) } : null);
      }
    }
    return out;
  }

  /**
   * Climatología: qué hizo el cielo en ese punto los últimos diez 12 de
   * agosto, a la misma hora. El histórico no cambia nunca, así que se cachea
   * sin caducidad.
   * @param {Date} when instante del máximo, para clavar la hora del día
   */
  async function climatology(lat, lon, when) {
    const D = eclipseDates();
    const key = `clima:${lat.toFixed(1)},${lon.toFixed(1)}`;
    const p = n => String(n).padStart(2, '0');
    const md = `${p(D.month)}-${p(D.dayNum)}`;

    try {
      const res = await Net.cached(key, null, async () => {
        const years = [];
        for (let i = 1; i <= CLIMA_YEARS; i++) years.push(D.year - i);
        const wait = Net.waitFor(CLIMA_YEARS * 3);
        if (wait > 0) throw Net.rateError(wait);
        Net.spend(CLIMA_YEARS * 3);
        const reqs = years.map(y =>
          Net.getJSON(`${ARCHIVE}?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
                      `&start_date=${y}-${md}&end_date=${y}-${md}` +
                      `&hourly=cloud_cover,cloud_cover_low&timezone=auto`, 20000)
            .then(j => ({ year: y, j }))
            .catch(() => null)
        );
        const got = await Promise.all(reqs);

        const rows = [];
        for (const g of got) {
          if (!g || !g.j || !g.j.hourly) continue;
          const hours = toHours(g.j);
          // Misma hora del día que el máximo del eclipse, ese año
          const ref = new Date(when);
          const target = Date.UTC(g.year, ref.getUTCMonth(), ref.getUTCDate(),
                                  ref.getUTCHours(), ref.getUTCMinutes());
          const h = hourNear(hours, target);
          if (h && h.total != null) rows.push({ year: g.year, total: h.total, low: h.low });
        }
        return rows;
      });

      const rows = res.value || [];
      if (!rows.length) return null;
      const clear = rows.filter(r => r.total <= 25).length;
      const mean = rows.reduce((a, r) => a + r.total, 0) / rows.length;
      return {
        rows, n: rows.length, clearYears: clear,
        meanCloud: mean,
        at: res.at, stale: res.stale
      };
    } catch (e) {
      if (e && e.rate) throw e;
      return null;
    }
  }

  /** Resumen de la ventana del eclipse: la hora del máximo y el peor momento */
  function summarise(fc, lc) {
    if (!fc || !lc) return null;
    const atMax = hourNear(fc.hours, lc.max.date);
    if (!atMax) return null;
    // Una hora de margen por delante: interesa ver cómo evoluciona el cielo
    // desde antes de que empiece, no solo el instante del máximo.
    const window = fc.hours.filter(h =>
      h.t >= lc.c1.date.getTime() - 3600000 && h.t <= lc.c4.date.getTime() + 1800000);
    return {
      atMax,
      window,
      score: skyScore(atMax.low, atMax.mid, atMax.high),
      confidence: fc.confidence,
      stale: fc.stale,
      at: fc.at
    };
  }

  global.Weather = {
    forecast, forecastMany, climatology, summarise,
    skyScore, hourNear, confidenceOf, daysToEclipse, eclipseDates
  };
})(window);
