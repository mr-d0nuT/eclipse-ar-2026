/* =========================================================================
   eclipse.js — Motor de circunstancias locales del eclipse
   Eclipse Solar Total del 12 de agosto de 2026

   Elementos besselianos: Fred Espenak, NASA/GSFC
   https://eclipse.gsfc.nasa.gov/SEbeselm/SEbeselm2001/SE2026Aug12Tbeselm.html
   Efemérides VSOP87/ELP2000-85 · ΔT = 71.4 s

   Método: Explanatory Supplement to the Astronomical Almanac /
           Meeus, "Elements of Solar Eclipses", cap. de circunstancias locales.
   ========================================================================= */
(function (global) {
  'use strict';

  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;
  const sin = a => Math.sin(a * DEG);
  const cos = a => Math.cos(a * DEG);
  const tan = a => Math.tan(a * DEG);

  // ---------------------------------------------------------------------
  // ELEMENTOS BESSELIANOS (NASA/Espenak) — t0 = 2026 Ago 12, 18:00:00.0 TDT
  // ---------------------------------------------------------------------
  const EL = {
    // Fecha de referencia t0 en UT (= TDT - ΔT)
    t0Hour: 18.0,
    dateUTC: { y: 2026, m: 8, d: 12 },
    deltaT: 71.4,                      // segundos (valor usado por la NASA)

    //        n=0          n=1           n=2           n=3
    x:  [ 0.475593,   0.5189288,  -0.0000773,  -0.0000088],
    y:  [ 0.771161,  -0.2301664,  -0.0001245,   0.0000037],
    d:  [14.79667,   -0.012065,   -0.000003,    0.0],
    l1: [ 0.537954,   0.0000940,  -0.0000121,   0.0],
    l2: [-0.008142,   0.0000935,  -0.0000121,   0.0],
    mu: [88.74776,   15.003093,    0.0,         0.0],

    tanF1: 0.0046141,
    tanF2: 0.0045911,

    // Metadatos publicados
    greatestEclipseUT: Date.UTC(2026, 7, 12, 17, 45, 53, 800),
    gamma: 0.8978,
    magnitudeGeo: 1.0386,
    saros: 126,
    maxDurationCentral: 138.2,          // segundos (2m 18.2s)
    validFrom: 15.0, validTo: 21.0      // horas TDT
  };

  const E2 = 0.00669454;                // excentricidad² del elipsoide terrestre
  const EARTH_R = 6378.137;             // km

  /** Fecha UT del eclipse a una hora TDT dada (decimal) */
  function tdtHourToDate(tHours) {
    const ms = Date.UTC(EL.dateUTC.y, EL.dateUTC.m - 1, EL.dateUTC.d, 0, 0, 0)
             + tHours * 3600000 - EL.deltaT * 1000;
    return new Date(ms);
  }
  /** Date (UT) -> hora TDT decimal del día del eclipse */
  function dateToTdtHour(date) {
    const base = Date.UTC(EL.dateUTC.y, EL.dateUTC.m - 1, EL.dateUTC.d, 0, 0, 0);
    return (date.getTime() - base + EL.deltaT * 1000) / 3600000;
  }

  /** Evalúa todos los elementos besselianos en t (horas desde t0, TDT) */
  function elements(t) {
    const p = (c) => c[0] + c[1] * t + c[2] * t * t + c[3] * t * t * t;
    const dp = (c) => c[1] + 2 * c[2] * t + 3 * c[3] * t * t;
    return {
      x: p(EL.x), y: p(EL.y), d: p(EL.d),
      l1: p(EL.l1), l2: p(EL.l2), mu: p(EL.mu),
      dx: dp(EL.x), dy: dp(EL.y), dd: dp(EL.d), dmu: dp(EL.mu)
    };
  }

  /** Coordenadas geocéntricas del observador (rho·sin φ', rho·cos φ') */
  function observerRho(latDeg, heightM) {
    const h = (heightM || 0) / 6378140;
    const u = Math.atan(0.99664719 * tan(latDeg)) * RAD;
    return {
      rhoSin: 0.99664719 * sin(u) + h * sin(latDeg),
      rhoCos: cos(u) + h * cos(latDeg)
    };
  }

  /**
   * Calcula (u, v, a, b, L1', L2') para un instante y observador dados.
   * u,v = posición del observador respecto al eje de sombra (radios terrestres)
   */
  function fundamental(t, latDeg, lonDeg, heightM) {
    const e = elements(t);
    const { rhoSin, rhoCos } = observerRho(latDeg, heightM);

    // Ángulo horario del eje de sombra en el lugar del observador.
    // μ está referido al meridiano de Greenwich en TDT; la Tierra ha girado
    // 1.002738·ΔT segundos menos en UT, de ahí la corrección de 0.00417807·ΔT.
    const Hc = e.mu + lonDeg - 0.00417807 * EL.deltaT;

    const xi = rhoCos * sin(Hc);
    const eta = rhoSin * cos(e.d) - rhoCos * cos(Hc) * sin(e.d);
    const zeta = rhoSin * sin(e.d) + rhoCos * cos(Hc) * cos(e.d);

    const dmuRad = e.dmu * DEG;   // rad/hora
    const ddRad = e.dd * DEG;

    const dxi = dmuRad * rhoCos * cos(Hc);
    const deta = dmuRad * xi * sin(e.d) - zeta * ddRad;

    const u = e.x - xi;
    const v = e.y - eta;
    const a = e.dx - dxi;
    const b = e.dy - deta;

    const L1 = e.l1 - zeta * EL.tanF1;
    const L2 = e.l2 - zeta * EL.tanF2;

    return { e, u, v, a, b, L1, L2, xi, eta, zeta, H: Hc };
  }

  /** Fracción de área del disco solar cubierta, dada magnitud geométrica */
  function obscuration(sepSunRadii, moonOverSun) {
    const d = sepSunRadii, r = moonOverSun;   // en unidades de radio solar
    if (d >= 1 + r) return 0;
    if (d <= r - 1) return 1;
    if (d <= 1 - r) return r * r;             // anular / tránsito completo
    const d2 = d * d, r2 = r * r;
    const c1 = Math.acos((d2 + 1 - r2) / (2 * d));
    const c2 = Math.acos((d2 + r2 - 1) / (2 * d * r));
    const c3 = Math.sqrt(Math.max(0, (-d + 1 + r) * (d + 1 - r) * (d - 1 + r) * (d + 1 + r)));
    return (c1 + r2 * c2 - 0.5 * c3) / Math.PI;
  }

  /**
   * Estado instantáneo del eclipse para un observador en una fecha concreta.
   * Devuelve la geometría exacta Sol/Luna para dibujar el disco en tiempo real.
   */
  const EMPTY_STATE = {
    magnitude: 0, obscuration: 0, moonOverSun: 1, sepSunRadii: 99,
    offsetE: 0, offsetN: 0, phase: 'none', inShadow: false,
    L1: 0, L2: 0, u: 0, v: 0, outOfRange: true
  };

  function stateAt(date, latDeg, lonDeg, heightM) {
    const tAbs = dateToTdtHour(date);
    // Los polinomios besselianos solo son válidos en su ventana; fuera de ella
    // extrapolan a valores sin sentido físico.
    if (tAbs < EL.validFrom || tAbs > EL.validTo) return EMPTY_STATE;
    const t = tAbs - EL.t0Hour;
    const f = fundamental(t, latDeg, lonDeg, heightM);

    const m = Math.sqrt(f.u * f.u + f.v * f.v);
    const sumL = f.L1 + f.L2;                 // = 2·k·R_sol
    const magnitude = sumL !== 0 ? (f.L1 - m) / sumL : 0;

    // Radio lunar / radio solar aparentes, y separación en radios solares
    const moonOverSun = (f.L1 - f.L2) / sumL;
    const sepSunRadii = 2 * m / sumL;

    const covered = magnitude > 0 ? obscuration(sepSunRadii, moonOverSun) : 0;

    // Dirección del centro lunar respecto al del Sol, en el plano (Este, Norte)
    const offsetE = sepSunRadii > 0 ? f.u / m * sepSunRadii : 0;
    const offsetN = sepSunRadii > 0 ? f.v / m * sepSunRadii : 0;

    // Fase
    let phase = 'none';
    if (magnitude > 0) phase = (f.L2 < 0 && m < Math.abs(f.L2)) ? 'total'
                             : (f.L2 > 0 && m < f.L2) ? 'annular'
                             : 'partial';

    return {
      magnitude: Math.max(0, magnitude),
      obscuration: covered,
      moonOverSun,
      sepSunRadii,
      offsetE: isFinite(offsetE) ? offsetE : 0,
      offsetN: isFinite(offsetN) ? offsetN : 0,
      phase,
      inShadow: magnitude > 0,
      L1: f.L1, L2: f.L2, u: f.u, v: f.v
    };
  }

  /**
   * Circunstancias locales completas: C1, C2, máximo, C3, C4.
   * @returns {object|null} null si el eclipse no es visible desde ese punto
   */
  function localCircumstances(latDeg, lonDeg, heightM) {
    heightM = heightM || 0;

    // --- Instante del máximo (iteración de Newton sobre τ) ---
    let t = 0;              // horas desde t0 (TDT)
    for (let i = 0; i < 8; i++) {
      const f = fundamental(t, latDeg, lonDeg, heightM);
      const n2 = f.a * f.a + f.b * f.b;
      const tau = -(f.u * f.a + f.v * f.b) / n2;
      t += tau;
      if (Math.abs(tau) < 1e-9) break;
      if (t < EL.validFrom - EL.t0Hour - 1 || t > EL.validTo - EL.t0Hour + 1) return null;
    }
    const tMax = t;
    const fMax = fundamental(tMax, latDeg, lonDeg, heightM);
    const mMax = Math.sqrt(fMax.u * fMax.u + fMax.v * fMax.v);
    if (mMax > fMax.L1) return null;         // ni siquiera eclipse parcial

    // --- Contactos ---
    function contact(which) {
      // which: 'C1'(-,L1) 'C4'(+,L1) 'C2'(-,L2) 'C3'(+,L2)
      const useL2 = (which === 'C2' || which === 'C3');
      const sign = (which === 'C1' || which === 'C2') ? -1 : +1;
      let tt = tMax;
      for (let i = 0; i < 40; i++) {
        const f = fundamental(tt, latDeg, lonDeg, heightM);
        const n = Math.sqrt(f.a * f.a + f.b * f.b);
        const L = useL2 ? Math.abs(f.L2) : f.L1;
        const delta = (f.u * f.b - f.v * f.a) / n;
        const rad = L * L - delta * delta;
        if (rad < 0) return null;
        const tau = -(f.u * f.a + f.v * f.b) / (n * n) + sign * Math.sqrt(rad) / n;
        const next = tt + tau;
        if (Math.abs(next - tt) < 1e-9) { tt = next; break; }
        tt = next;
      }
      return tt;
    }

    const tC1 = contact('C1');
    const tC4 = contact('C4');
    let tC2 = null, tC3 = null;
    const isCentral = mMax < Math.abs(fMax.L2);
    if (isCentral) { tC2 = contact('C2'); tC3 = contact('C3'); }

    const stMax = stateAt(tdtHourToDate(EL.t0Hour + tMax), latDeg, lonDeg, heightM);

    function pack(tt) {
      if (tt === null || !isFinite(tt)) return null;
      const date = tdtHourToDate(EL.t0Hour + tt);
      const sun = Astro.sunAltAz(date, latDeg, lonDeg);
      return { date, alt: sun.alt, altRefracted: sun.altRefracted, az: sun.az };
    }

    const c1 = pack(tC1), c2 = pack(tC2), max = pack(tMax), c3 = pack(tC3), c4 = pack(tC4);
    if (!c1 || !c4) return null;

    const totalityDuration = (tC2 !== null && tC3 !== null) ? (tC3 - tC2) * 3600 : 0;

    // ¿Está el Sol sobre el horizonte en cada momento?
    const visible = {
      c1: c1.altRefracted > 0,
      c2: c2 ? c2.altRefracted > 0 : false,
      max: max.altRefracted > 0,
      c3: c3 ? c3.altRefracted > 0 : false,
      c4: c4.altRefracted > 0
    };

    return {
      lat: latDeg, lon: lonDeg, height: heightM,
      type: isCentral ? (fMax.L2 < 0 ? 'total' : 'annular') : (stMax.magnitude > 0 ? 'partial' : 'none'),
      c1, c2, max, c3, c4,
      totalityDuration,
      magnitude: stMax.magnitude,
      obscuration: stMax.obscuration,
      moonOverSun: stMax.moonOverSun,
      duration: (tC4 - tC1) * 3600,
      visible,
      anyVisible: visible.c1 || visible.max || visible.c4,
      sunsetDuringEclipse: !visible.c4 && visible.c1
    };
  }

  // ---------------------------------------------------------------------
  // Trazado de la banda de totalidad (línea central + límites)
  // ---------------------------------------------------------------------

  /** Punto sub-sombra (intersección del eje con la superficie terrestre) */
  function shadowAxisPoint(t) {
    const e = elements(t);
    const rho1 = Math.sqrt(1 - E2 * cos(e.d) * cos(e.d));
    const rho2 = Math.sqrt(1 - E2 * sin(e.d) * sin(e.d));
    const sinD1 = sin(e.d) / rho1;
    const cosD1 = Math.sqrt(1 - E2) * cos(e.d) / rho1;

    const xi = e.x;
    const eta1 = e.y / rho1;
    const z2 = 1 - xi * xi - eta1 * eta1;
    if (z2 < 0) return null;                 // el eje no toca la Tierra
    const zeta1 = Math.sqrt(z2);

    const sinPhi1 = eta1 * cosD1 + zeta1 * sinD1;
    const phi1 = Math.asin(Math.max(-1, Math.min(1, sinPhi1))) * RAD;
    const latGeodetic = Math.atan(tan(phi1) / Math.sqrt(1 - E2)) * RAD;

    const H = Math.atan2(xi, zeta1 * cosD1 - eta1 * sinD1) * RAD;
    let lon = H - e.mu + 0.00417807 * EL.deltaT;   // longitud Este positiva
    lon = ((lon + 180) % 360 + 360) % 360 - 180;

    return { lat: latGeodetic, lon, t };
  }

  /** Línea central de totalidad, muestreada cada `stepMin` minutos */
  function centralLine(stepMin) {
    stepMin = stepMin || 2;
    const pts = [];
    for (let h = EL.validFrom; h <= EL.validTo; h += stepMin / 60) {
      const p = shadowAxisPoint(h - EL.t0Hour);
      if (p) { p.date = tdtHourToDate(h); pts.push(p); }
    }
    return pts;
  }

  /** ¿Hay totalidad en este punto? (test rápido para calcular límites) */
  function isTotal(lat, lon) {
    const lc = localCircumstances(lat, lon, 0);
    return !!(lc && lc.type === 'total');
  }

  /** Límites norte y sur de la banda de totalidad (búsqueda binaria perpendicular) */
  function totalityLimits(stepMin) {
    const centre = centralLine(stepMin || 4);
    const north = [], south = [];
    for (let i = 0; i < centre.length; i++) {
      const p = centre[i];
      // Dirección perpendicular al avance de la sombra
      const q = centre[Math.min(i + 1, centre.length - 1)];
      const r = centre[Math.max(i - 1, 0)];
      let dLat = q.lat - r.lat;
      let dLon = (q.lon - r.lon) * cos(p.lat);
      const nrm = Math.hypot(dLat, dLon) || 1;
      const pLat = -dLon / nrm, pLon = dLat / nrm;    // perpendicular unitaria

      for (const side of [1, -1]) {
        let lo = 0, hi = 4.0;                          // grados de búsqueda
        // Asegurar que hi está fuera de la totalidad
        for (let k = 0; k < 6 && isTotal(p.lat + side * hi * pLat, p.lon + side * hi * pLon / (cos(p.lat) || 1)); k++) hi *= 1.6;
        for (let k = 0; k < 18; k++) {
          const mid = (lo + hi) / 2;
          const la = p.lat + side * mid * pLat;
          const lo2 = p.lon + side * mid * pLon / (cos(p.lat) || 1);
          if (isTotal(la, lo2)) lo = mid; else hi = mid;
        }
        const la = p.lat + side * lo * pLat;
        const lo2 = p.lon + side * lo * pLon / (cos(p.lat) || 1);
        (side > 0 ? north : south).push({ lat: la, lon: ((lo2 + 180) % 360 + 360) % 360 - 180 });
      }
    }
    return { north, south, centre };
  }

  /** Distancia ortodrómica en km */
  function haversine(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * DEG, dLon = (lon2 - lon1) * DEG;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** Punto más cercano de la línea central + rumbo hacia él */
  function nearestCentralPoint(lat, lon, line) {
    line = line || centralLine(1);
    let best = null, bestD = Infinity;
    for (const p of line) {
      const d = haversine(lat, lon, p.lat, p.lon);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best) return null;
    const y = sin(best.lon - lon) * cos(best.lat);
    const x = cos(lat) * sin(best.lat) - sin(lat) * cos(best.lat) * cos(best.lon - lon);
    const bearing = (Math.atan2(y, x) * RAD + 360) % 360;
    return { point: best, distanceKm: bestD, bearing };
  }

  global.Eclipse = {
    EL, elements, stateAt, localCircumstances,
    centralLine, totalityLimits, shadowAxisPoint,
    nearestCentralPoint, haversine, isTotal,
    tdtHourToDate, dateToTdtHour, obscuration
  };
})(window);
