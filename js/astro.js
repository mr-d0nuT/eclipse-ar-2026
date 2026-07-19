/* =========================================================================
   astro.js — Posición del Sol, tiempo sidéreo, refracción y utilidades
   Algoritmos: Meeus, "Astronomical Algorithms" (2ª ed.), caps. 12, 22, 25, 16
   Precisión de la posición solar: ~0.01° (más que suficiente para AR)
   ========================================================================= */
(function (global) {
  'use strict';

  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;

  const sin = a => Math.sin(a * DEG);
  const cos = a => Math.cos(a * DEG);
  const tan = a => Math.tan(a * DEG);
  const asin = x => Math.asin(x) * RAD;
  const atan2 = (y, x) => Math.atan2(y, x) * RAD;

  /** Normaliza un ángulo a [0, 360) */
  function norm360(a) { a = a % 360; return a < 0 ? a + 360 : a; }
  /** Normaliza un ángulo a (-180, 180] */
  function norm180(a) { a = norm360(a); return a > 180 ? a - 360 : a; }

  /** Date -> Día Juliano (UT) */
  function toJD(date) { return date.getTime() / 86400000 + 2440587.5; }
  /** Día Juliano -> Date */
  function fromJD(jd) { return new Date((jd - 2440587.5) * 86400000); }

  /**
   * Posición geocéntrica aparente del Sol.
   * @param {number} jd Día juliano (UT; la diferencia con TT es despreciable aquí)
   * @returns {{ra:number, dec:number, dist:number, lambda:number, eps:number, sd:number}}
   *          ra/dec en grados, dist en UA, sd = semidiámetro aparente en grados
   */
  function sunPosition(jd) {
    const T = (jd - 2451545.0) / 36525.0;

    // Longitud media y anomalía media
    const L0 = norm360(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
    const M = norm360(357.52911 + 35999.05029 * T - 0.0001537 * T * T);
    const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;

    // Ecuación del centro
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sin(M)
            + (0.019993 - 0.000101 * T) * sin(2 * M)
            + 0.000289 * sin(3 * M);

    const trueLong = L0 + C;              // longitud verdadera
    const v = M + C;                      // anomalía verdadera
    const R = (1.000001018 * (1 - e * e)) / (1 + e * cos(v)); // distancia en UA

    // Corrección por nutación y aberración -> longitud aparente
    const omega = 125.04 - 1934.136 * T;
    const lambda = trueLong - 0.00569 - 0.00478 * sin(omega);

    // Oblicuidad de la eclíptica
    const eps0 = 23.439291111 - 0.0130041667 * T - 1.6389e-7 * T * T + 5.036e-7 * T * T * T;
    const eps = eps0 + 0.00256 * cos(omega);

    const ra = norm360(atan2(cos(eps) * sin(lambda), cos(lambda)));
    const dec = asin(sin(eps) * sin(lambda));

    // Semidiámetro aparente: 959.63" a 1 UA
    const sd = (959.63 / R) / 3600;

    return { ra, dec, dist: R, lambda, eps, sd };
  }

  /** Tiempo sidéreo aparente en Greenwich, en grados */
  function greenwichSiderealTime(jd) {
    const T = (jd - 2451545.0) / 36525.0;
    let theta = 280.46061837 + 360.98564736629 * (jd - 2451545.0)
              + 0.000387933 * T * T - (T * T * T) / 38710000.0;
    return norm360(theta);
  }

  /**
   * Convierte ecuatoriales -> horizontales (topocéntricas, con paralaje).
   * @param {number} ra grados, @param {number} dec grados
   * @param {number} lat grados N+, @param {number} lon grados E+
   * @param {number} dist distancia en UA (para paralaje; opcional)
   * @returns {{alt:number, az:number, ha:number}} az medido desde el Norte hacia el Este
   */
  function equatorialToHorizontal(jd, ra, dec, lat, lon, dist) {
    const gst = greenwichSiderealTime(jd);
    let H = norm180(gst + lon - ra);

    // Paralaje diurna (para el Sol ~8.8", casi irrelevante, pero es gratis)
    if (dist) {
      const pi = 8.794 / 3600 / dist; // paralaje horizontal en grados
      const u = Math.atan(0.99664719 * tan(lat)) * RAD;
      const rhoSin = 0.99664719 * sin(u);
      const rhoCos = cos(u);
      const dRa = atan2(-rhoCos * sin(pi) * sin(H), cos(dec) - rhoCos * sin(pi) * cos(H));
      const decP = atan2((sin(dec) - rhoSin * sin(pi)) * cos(dRa), cos(dec) - rhoCos * sin(pi) * cos(H));
      H = H - dRa;
      dec = decP;
    }

    const alt = asin(sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(H));
    const az = norm360(atan2(sin(H), cos(H) * sin(lat) - tan(dec) * cos(lat)) + 180);
    return { alt, az, ha: H };
  }

  /** Posición aparente del Sol en el cielo para un observador */
  function sunAltAz(date, lat, lon) {
    const jd = toJD(date);
    const s = sunPosition(jd);
    const h = equatorialToHorizontal(jd, s.ra, s.dec, lat, lon, s.dist);
    return {
      alt: h.alt,
      altRefracted: h.alt + refraction(h.alt),
      az: h.az,
      ra: s.ra,
      dec: s.dec,
      sd: s.sd,
      dist: s.dist
    };
  }

  /** Refracción atmosférica en grados (Bennett), para altura aparente h en grados */
  function refraction(h) {
    if (h < -2) return 0;
    const hh = Math.max(h, -0.5);
    return (1.02 / tan(hh + 10.3 / (hh + 5.11))) / 60;
  }

  /** Orto/ocaso del Sol (algoritmo iterativo simple). Devuelve Dates o null. */
  function sunRiseSet(date, lat, lon) {
    const h0 = -0.833; // altura del centro del disco en el orto/ocaso
    function altAt(t) { return sunAltAz(t, lat, lon).alt; }
    const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0));
    let rise = null, set = null;
    let prev = altAt(day);
    for (let m = 10; m <= 24 * 60; m += 10) {
      const t = new Date(day.getTime() + m * 60000);
      const cur = altAt(t);
      if (prev < h0 && cur >= h0) rise = refine(t, -10);
      if (prev >= h0 && cur < h0) set = refine(t, -10);
      prev = cur;
    }
    function refine(t, backMin) {
      let a = new Date(t.getTime() + backMin * 60000), b = new Date(t.getTime());
      for (let i = 0; i < 30; i++) {
        const mid = new Date((a.getTime() + b.getTime()) / 2);
        if ((altAt(a) - h0) * (altAt(mid) - h0) <= 0) b = mid; else a = mid;
      }
      return new Date((a.getTime() + b.getTime()) / 2);
    }
    return { rise, set };
  }

  global.Astro = {
    DEG, RAD, sin, cos, tan, asin, atan2,
    norm360, norm180, toJD, fromJD,
    sunPosition, greenwichSiderealTime, equatorialToHorizontal,
    sunAltAz, refraction, sunRiseSet
  };
})(window);
