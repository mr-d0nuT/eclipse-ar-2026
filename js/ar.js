/* =========================================================================
   ar.js — Modo Realidad Aumentada
   Cámara + acelerómetro + brújula: superpone la posición real del Sol,
   su trayectoria hasta el eclipse y el disco eclipsado en tiempo real.

   Notas de rendimiento (por qué esto va fluido):
   · La geometría del cielo (horizonte, trayectoria, hitos) se calcula UNA vez
     por ubicación, no en cada fotograma.
   · La astronomía (posición solar, estado del eclipse) se refresca 5 veces por
     segundo: el Sol se mueve 0.004°/s, así que es imperceptible.
   · La orientación del móvil se suaviza con un filtro paso bajo sobre la base
     de la cámara, con re-ortonormalización. Sin él, el ruido del giroscopio
     hace temblar todo.
   · El HUD (DOM) solo se reescribe cuando su texto cambia de verdad.
   ========================================================================= */
(function (global) {
  'use strict';

  const $ = id => document.getElementById(id);
  const D2R = Math.PI / 180;

  // Polyfill mínimo de roundRect para navegadores algo antiguos
  if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      this.beginPath();
      this.moveTo(x + r, y);
      this.arcTo(x + w, y, x + w, y + h, r);
      this.arcTo(x + w, y + h, x, y + h, r);
      this.arcTo(x, y + h, x, y, r);
      this.arcTo(x, y, x + w, y, r);
      this.closePath();
      return this;
    };
  }

  const ar = {
    active: false,
    stream: null,
    orient: null,
    haveOrientation: false,
    hfov: 65,
    showTrack: true,
    showDisk: true,
    calibrating: false,
    headingOffset: 0,      // corrección manual de la brújula, en grados
    source: 'none'         // 'ios' | 'absolute' | 'relative'
  };
  try { ar.headingOffset = parseFloat(localStorage.getItem('eclipse-heading-offset')) || 0; } catch (e) {}

  // ---------------------------------------------------------------------
  // Álgebra
  // ---------------------------------------------------------------------
  function deviceMatrix(alpha, beta, gamma) {
    const a = alpha * D2R, b = beta * D2R, g = gamma * D2R;
    const cA = Math.cos(a), sA = Math.sin(a);
    const cB = Math.cos(b), sB = Math.sin(b);
    const cG = Math.cos(g), sG = Math.sin(g);
    // R = Rz(alpha) · Rx(beta) · Ry(gamma)   (especificación W3C)
    return [
      [cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG],
      [sA * cG + cA * sB * sG,  cA * cB, sA * sG - cA * sB * cG],
      [-cB * sG,                sB,      cB * cG]
    ];
  }

  const mulVec = (M, v) => [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]
  ];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
  function norm(v) {
    const m = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / m, v[1] / m, v[2] / m];
  }
  const lerpVec = (a, b, k) => [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k
  ];

  /** Dirección unitaria (Este, Norte, Arriba) a partir de azimut/altura */
  function skyVector(az, alt) {
    const ca = Math.cos(alt * D2R);
    return [ca * Math.sin(az * D2R), ca * Math.cos(az * D2R), Math.sin(alt * D2R)];
  }

  function screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
    return window.orientation || 0;
  }

  // ---------------------------------------------------------------------
  // Base de la cámara, con suavizado temporal
  // ---------------------------------------------------------------------
  /* Cuaterniones: suavizar la orientación como rotación (slerp) es estable.
     Interpolar los vectores de la base por separado los desalinea y obliga a
     re-ortonormalizar, lo que puede oscilar de signo y hacer temblar la escena. */
  function quatFromMatrix(m) {
    const tr = m[0][0] + m[1][1] + m[2][2];
    let s;
    if (tr > 0) {
      s = Math.sqrt(tr + 1) * 2;
      return [(m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s, 0.25 * s];
    }
    if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
      s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
      return [0.25 * s, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s, (m[2][1] - m[1][2]) / s];
    }
    if (m[1][1] > m[2][2]) {
      s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
      return [(m[0][1] + m[1][0]) / s, 0.25 * s, (m[1][2] + m[2][1]) / s, (m[0][2] - m[2][0]) / s];
    }
    s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
    return [(m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, 0.25 * s, (m[1][0] - m[0][1]) / s];
  }

  function matFromQuat(q) {
    const [x, y, z, w] = q;
    return [
      [1 - 2 * (y * y + z * z), 2 * (x * y - z * w),     2 * (x * z + y * w)],
      [2 * (x * y + z * w),     1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
      [2 * (x * z - y * w),     2 * (y * z + x * w),     1 - 2 * (x * x + y * y)]
    ];
  }

  function slerp(a, b, t) {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    let bb = b;
    if (d < 0) { bb = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }   // camino corto
    if (d > 0.9995) {
      const r = [a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t,
                 a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t];
      const m = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
      return [r[0] / m, r[1] / m, r[2] / m, r[3] / m];
    }
    const th0 = Math.acos(Math.min(1, d)), th = th0 * t;
    const s0 = Math.cos(th) - d * Math.sin(th) / Math.sin(th0);
    const s1 = Math.sin(th) / Math.sin(th0);
    return [a[0] * s0 + bb[0] * s1, a[1] * s0 + bb[1] * s1,
            a[2] * s0 + bb[2] * s1, a[3] * s0 + bb[3] * s1];
  }

  /** Gira un vector (Este, Norte, Arriba) un incremento de azimut */
  function rotAz(v, deg) {
    const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R);
    return [v[0] * c + v[1] * s, v[1] * c - v[0] * s, v[2]];
  }

  let smoothQ = null;    // salida final (segunda etapa)
  let stage1Q = null;    // primera etapa del filtro en cascada
  let slowQ = null;      // referencia lenta, solo para estimar si hay movimiento real

  /** Ángulo entre dos cuaterniones, en grados */
  function quatAngle(a, b) {
    const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
    return 2 * Math.acos(Math.min(1, d)) / D2R;
  }

  function rawQuat() {
    if (!ar.orient) return null;
    let { alpha, beta, gamma, heading } = ar.orient;
    if (typeof heading === 'number' && !isNaN(heading)) alpha = 360 - heading;  // iOS
    if (typeof alpha !== 'number' || typeof beta !== 'number' || typeof gamma !== 'number') return null;
    return quatFromMatrix(deviceMatrix(alpha, beta, gamma));
  }

  /**
   * Orientación suavizada. tau bajo = respuesta rápida pero más ruido;
   * tau alto = suave pero con retraso. 70 ms es un buen término medio.
   */
  function updateBasis(dt) {
    const raw = rawQuat();
    if (raw) {
      if (!smoothQ) { smoothQ = stage1Q = slowQ = raw; }
      else {
        dt = Math.max(0.001, Math.min(0.1, dt));

        // Referencia lenta. El ruido del sensor no la desplaza (se promedia a
        // cero); un giro de verdad sí. Por eso mide movimiento real, mientras
        // que el residuo instantáneo se deja engañar por el propio ruido.
        slowQ = slerp(slowQ, raw, 1 - Math.exp(-dt / 0.45));
        const motion = quatAngle(raw, slowQ);      // grados de desvío sostenido

        // Con el móvil quieto -> filtrado fuerte. Girando -> respuesta directa.
        let tau;
        if (motion < 1.2)      tau = 0.30;         // prácticamente inmóvil
        else if (motion < 4)   tau = 0.14;         // deriva lenta
        else if (motion < 15)  tau = 0.05;         // panorámica
        else                   tau = 0.012;        // giro brusco

        const k = Math.min(1, 1 - Math.exp(-dt / tau));

        // Cascada de dos etapas: atenúa el ruido mucho más que una sola pasada
        // sin añadir apenas retraso perceptible.
        stage1Q = slerp(stage1Q, raw, k);
        smoothQ = slerp(smoothQ, stage1Q, k);

        // Zona muerta final: cambios por debajo de esto no llegan a un píxel
        // en pantalla, así que congelamos para que la imagen quede clavada.
        if (quatAngle(smoothQ, stage1Q) < 0.04 && motion < 1.2) smoothQ = stage1Q;
      }
    }
    if (!smoothQ) return null;

    const M = matFromQuat(smoothQ);
    let right = mulVec(M, [1, 0, 0]);
    let up    = mulVec(M, [0, 1, 0]);
    let fwd   = mulVec(M, [0, 0, -1]);      // la cámara trasera mira hacia -Z

    // Rotación de la pantalla (discreta: no se suaviza)
    const sa = screenAngle() * D2R;
    if (sa) {
      const c = Math.cos(sa), s = Math.sin(sa);
      const r2 = [right[0] * c + up[0] * s, right[1] * c + up[1] * s, right[2] * c + up[2] * s];
      const u2 = [-right[0] * s + up[0] * c, -right[1] * s + up[1] * c, -right[2] * s + up[2] * c];
      right = r2; up = u2;
    }

    // Corrección manual de la brújula
    if (ar.headingOffset) {
      right = rotAz(right, ar.headingOffset);
      up    = rotAz(up, ar.headingOffset);
      fwd   = rotAz(fwd, ar.headingOffset);
    }
    return { right, up, fwd };
  }

  /** Azimut al que apunta la cámara, en grados */
  function cameraAzimuth(basis) {
    return (Math.atan2(basis.fwd[0], basis.fwd[1]) / D2R + 360) % 360;
  }

  /** Proyecta una dirección del cielo a coordenadas de pantalla */
  function project(vec, basis, W, H, f) {
    const z = dot(vec, basis.fwd);
    const x = dot(vec, basis.right);
    const y = dot(vec, basis.up);
    if (z <= 0.02) return { behind: true, dx: x, dy: y };
    return { behind: false, x: W / 2 + x * f / z, y: H / 2 - y * f / z, z };
  }

  // ---------------------------------------------------------------------
  // Sensores
  // ---------------------------------------------------------------------
  /* -------------------------------------------------------------------
     Sensores. CRÍTICO: en Android se disparan a la vez
     'deviceorientationabsolute' (alfa referido al norte real) y
     'deviceorientation' (alfa con origen arbitrario). Si se mezclan, la
     escena salta entre dos rumbos distintos en cada fotograma: eso produce
     un parpadeo brutal y coloca el Sol donde no está.
     Por eso clasificamos las fuentes por calidad y nos quedamos SOLO con la
     mejor que haya aparecido.
     ------------------------------------------------------------------- */
  const RANK = { none: 0, relative: 1, absolute: 2, ios: 3 };
  let bestRank = 0;

  function classify(e) {
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) return 'ios';
    if (e.absolute === true) return 'absolute';
    return 'relative';
  }

  function makeHandler(forcedKind) {
    return function (e) {
      if (e.alpha === null && typeof e.webkitCompassHeading !== 'number') return;
      const kind = forcedKind === 'absolute' ? classify(e) === 'ios' ? 'ios' : 'absolute' : classify(e);
      if (RANK[kind] < bestRank) return;                 // llega una fuente peor: se ignora
      bestRank = RANK[kind];
      ar.source = kind;
      ar.haveOrientation = true;
      ar.orient = {
        alpha: e.alpha, beta: e.beta, gamma: e.gamma,
        heading: typeof e.webkitCompassHeading === 'number' ? e.webkitCompassHeading : null
      };
    };
  }

  const onAbsolute = makeHandler('absolute');
  const onRelative = makeHandler(null);

  async function requestSensors() {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== 'granted') return false;
      } catch (e) { return false; }
    }
    if ('ondeviceorientationabsolute' in window) {
      addEventListener('deviceorientationabsolute', onAbsolute, true);
    }
    addEventListener('deviceorientation', onRelative, true);
    return true;
  }

  function releaseSensors() {
    removeEventListener('deviceorientationabsolute', onAbsolute, true);
    removeEventListener('deviceorientation', onRelative, true);
    bestRank = 0; ar.source = 'none'; ar.haveOrientation = false; ar.orient = null;
  }

  async function startCamera() {
    try {
      ar.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
      const v = $('arVideo');
      v.srcObject = ar.stream;
      await v.play().catch(() => {});
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Caché de geometría del cielo
  // ---------------------------------------------------------------------
  const cache = {
    key: null,
    horizon: [],      // vectores del horizonte
    ticks: [],        // {vec, label, big}
    track: [],        // trayectoria del Sol durante el eclipse
    marks: [],        // {label, vec}
    tAstro: 0,
    sunVec: null, sunAz: 0, sunAlt: 0,
    eVec: null, nVec: null,      // ejes celestes Este/Norte en el marco local
    st: null
  };

  const NAMES = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SO', 270: 'O', 315: 'NO' };

  function buildSky(app) {
    const key = app.lat.toFixed(5) + ',' + app.lon.toFixed(5);
    if (cache.key === key) return;
    cache.key = key;

    cache.horizon = [];
    for (let az = 0; az <= 360; az += 3) cache.horizon.push(skyVector(az, 0));

    cache.ticks = [];
    for (let az = 0; az < 360; az += 15) {
      cache.ticks.push({ vec: skyVector(az, 0), label: NAMES[az], big: az % 45 === 0, north: az === 0 });
    }

    cache.track = [];
    cache.marks = [];
    const lc = app.lc;
    if (lc) {
      const t0 = lc.c1.date.getTime(), t1 = lc.c4.date.getTime();
      for (let k = 0; k <= 80; k++) {
        const d = new Date(t0 + (t1 - t0) * k / 80);
        const s = Astro.sunAltAz(d, app.lat, app.lon);
        cache.track.push(skyVector(s.az, s.altRefracted));
      }
      const defs = [['C1', lc.c1], ['C2', lc.c2], ['MÁX', lc.max], ['C3', lc.c3], ['C4', lc.c4]];
      for (const [n, ev] of defs) {
        if (!ev) continue;
        const s = Astro.sunAltAz(ev.date, app.lat, app.lon);
        cache.marks.push({
          label: `${n} ${ev.date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`,
          big: n === 'MÁX',
          vec: skyVector(s.az, s.altRefracted)
        });
      }
    }
  }

  /** Refresca la astronomía (5 Hz basta: el Sol se mueve 0.004°/s) */
  function updateAstro(t, app, force) {
    const now = performance.now();
    if (!force && now - cache.tAstro < 200) return;
    cache.tAstro = now;

    const sun = Astro.sunAltAz(t, app.lat, app.lon);
    cache.sunAz = sun.az;
    cache.sunAlt = sun.altRefracted;
    cache.sunVec = skyVector(sun.az, sun.altRefracted);
    cache.st = ar.showDisk ? Eclipse.stateAt(t, app.lat, app.lon, app.height) : null;

    // Ejes celestes Este / Norte en el sitio del Sol, como vectores del marco local
    const jd = Astro.toJD(t);
    const sp = Astro.sunPosition(jd);
    const d = 0.3;
    const at = (dra, ddec) => {
      const hz = Astro.equatorialToHorizontal(jd, sp.ra + dra, sp.dec + ddec, app.lat, app.lon, sp.dist);
      return skyVector(hz.az, hz.alt + Astro.refraction(hz.alt));
    };
    const p0 = cache.sunVec;
    const pE = at(d / Math.cos(sp.dec * D2R), 0);
    const pN = at(0, d);
    cache.eVec = [pE[0] - p0[0], pE[1] - p0[1], pE[2] - p0[2]];
    cache.nVec = [pN[0] - p0[0], pN[1] - p0[1], pN[2] - p0[2]];
  }

  // ---------------------------------------------------------------------
  // Dibujo
  // ---------------------------------------------------------------------
  let lastW = 0, lastH = 0;
  let lastBasis = null, lastF = 1, lastW2 = 0, lastH2 = 0;

  function resizeCanvas() {
    const c = $('arCanvas');
    const w = Math.round(innerWidth), h = Math.round(innerHeight);
    const dpr = Math.min(devicePixelRatio || 1, 2.5);
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (W === lastW && H === lastH) return;      // evita reasignar el búfer sin necesidad
    lastW = W; lastH = H;
    c.width = W; c.height = H;
    c.style.width = w + 'px';
    c.style.height = h + 'px';
  }

  function drawEclipsedSun(g, x, y, r, st, eScr, nScr) {
    const dark = st ? st.obscuration : 0;
    const glow = g.createRadialGradient(x, y, r * .6, x, y, r * 6);
    glow.addColorStop(0, `rgba(255,214,140,${.55 * (1 - dark * .9)})`);
    glow.addColorStop(1, 'rgba(255,180,80,0)');
    g.fillStyle = glow; g.beginPath(); g.arc(x, y, r * 6, 0, 7); g.fill();

    if (st && st.phase === 'total') {
      for (let i = 0; i < 2; i++) {
        const cg = g.createRadialGradient(x, y, r, x, y, r * (2.6 + i * 2));
        cg.addColorStop(0, `rgba(255,245,220,${.5 - i * .2})`);
        cg.addColorStop(1, 'rgba(255,220,180,0)');
        g.fillStyle = cg; g.beginPath(); g.arc(x, y, r * (2.6 + i * 2), 0, 7); g.fill();
      }
    }

    const sg = g.createRadialGradient(x - r * .25, y - r * .25, r * .1, x, y, r);
    sg.addColorStop(0, '#fffef6'); sg.addColorStop(.65, '#ffe6a0'); sg.addColorStop(1, '#ffab3d');
    g.fillStyle = sg; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();

    if (st && st.magnitude > 0 && eScr && nScr) {
      const mr = r * st.moonOverSun;
      const mx = x + (eScr[0] * st.offsetE + nScr[0] * st.offsetN) * r;
      const my = y + (eScr[1] * st.offsetE + nScr[1] * st.offsetN) * r;
      g.fillStyle = st.phase === 'total' ? '#000' : 'rgba(6,7,14,.96)';
      g.beginPath(); g.arc(mx, my, mr, 0, 7); g.fill();
    }
  }

  function draw(t, app, dt) {
    const c = $('arCanvas'), g = c.getContext('2d');
    const dpr = c.width / (parseFloat(c.style.width) || innerWidth);
    const w = c.width / dpr, h = c.height / dpr;

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const basis = updateBasis(dt);
    if (!basis) {
      setHint('Esperando a los sensores de orientación… mueve un poco el móvil.', false);
      return;
    }
    lastBasis = basis; lastW2 = w; lastH2 = h;

    const f = (w / 2) / Math.tan(ar.hfov / 2 * D2R);
    lastF = f;
    const P = v => project(v, basis, w, h, f);

    // ---- Horizonte ----
    g.lineWidth = 1.5;
    g.strokeStyle = 'rgba(79,214,255,.5)';
    g.beginPath();
    let started = false;
    for (const v of cache.horizon) {
      const p = P(v);
      if (p.behind) { started = false; continue; }
      started ? g.lineTo(p.x, p.y) : (g.moveTo(p.x, p.y), started = true);
    }
    g.stroke();

    // ---- Marcas de azimut ----
    g.font = '600 11px -apple-system, sans-serif';
    g.textAlign = 'center';
    for (const tk of cache.ticks) {
      const p = P(tk.vec);
      if (p.behind || p.x < -60 || p.x > w + 60) continue;
      g.strokeStyle = `rgba(79,214,255,${tk.big ? .8 : .35})`;
      g.beginPath(); g.moveTo(p.x, p.y - (tk.big ? 10 : 5)); g.lineTo(p.x, p.y + (tk.big ? 10 : 5)); g.stroke();
      if (tk.big && tk.label) {
        g.fillStyle = tk.north ? '#ff5f6d' : 'rgba(210,240,255,.95)';
        g.fillText(tk.label, p.x, p.y + 24);
      }
    }

    // ---- Trayectoria del Sol ----
    if (ar.showTrack && cache.track.length) {
      g.lineWidth = 3; g.strokeStyle = 'rgba(255,171,61,.75)';
      g.beginPath(); started = false;
      for (const v of cache.track) {
        const p = P(v);
        if (p.behind) { started = false; continue; }
        started ? g.lineTo(p.x, p.y) : (g.moveTo(p.x, p.y), started = true);
      }
      g.stroke();

      g.font = '700 11px -apple-system, sans-serif';
      g.lineWidth = 3; g.textAlign = 'left';
      // Los puntos se dibujan siempre; las etiquetas solo si no se pisan entre
      // sí (C2, máximo y C3 están separados por segundos, no por píxeles).
      const placed = [];
      const ordered = cache.marks.slice().sort((a, b) => (b.big ? 1 : 0) - (a.big ? 1 : 0));
      for (const m of ordered) {
        const p = P(m.vec);
        if (p.behind || p.x < -120 || p.x > w + 120) continue;
        g.fillStyle = m.big ? '#fff' : '#ffd27d';
        g.beginPath(); g.arc(p.x, p.y, m.big ? 6 : 4, 0, 7); g.fill();

        const clash = placed.some(q => Math.abs(q.x - p.x) < 78 && Math.abs(q.y - p.y) < 15);
        if (clash) continue;
        placed.push({ x: p.x, y: p.y });
        g.strokeStyle = 'rgba(0,0,0,.7)';
        g.strokeText(m.label, p.x + 9, p.y + 4);
        g.fillText(m.label, p.x + 9, p.y + 4);
      }
    }

    // ---- El Sol ahora ----
    const rSun = Math.max(11, (0.266 * D2R) * f * 5);
    const p = cache.sunVec ? P(cache.sunVec) : { behind: true, dx: 0, dy: 0 };

    if (!p.behind && p.x > -120 && p.x < w + 120 && p.y > -120 && p.y < h + 120) {
      // Ejes celestes proyectados: así la Luna sale en su orientación real
      let eScr = null, nScr = null;
      if (cache.eVec && cache.nVec) {
        const pe = P([cache.sunVec[0] + cache.eVec[0], cache.sunVec[1] + cache.eVec[1], cache.sunVec[2] + cache.eVec[2]]);
        const pn = P([cache.sunVec[0] + cache.nVec[0], cache.sunVec[1] + cache.nVec[1], cache.sunVec[2] + cache.nVec[2]]);
        const unit = q => {
          if (q.behind) return null;
          const vx = q.x - p.x, vy = q.y - p.y, m = Math.hypot(vx, vy) || 1;
          return [vx / m, vy / m];
        };
        eScr = unit(pe) || [-1, 0];
        nScr = unit(pn) || [0, -1];
      }

      drawEclipsedSun(g, p.x, p.y, rSun, cache.st, eScr, nScr);

      g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 2;
      g.beginPath(); g.arc(p.x, p.y, rSun * 2.1, 0, 7); g.stroke();
      g.setLineDash([4, 5]);
      g.beginPath(); g.arc(p.x, p.y, rSun * 3.4, 0, 7); g.stroke();
      g.setLineDash([]);

      g.font = '700 13px -apple-system, sans-serif'; g.textAlign = 'center';
      g.fillStyle = '#fff'; g.strokeStyle = 'rgba(0,0,0,.75)'; g.lineWidth = 3;
      const lbl = cache.sunAlt > 0 ? '☀ SOL' : '☀ SOL (bajo el horizonte)';
      g.strokeText(lbl, p.x, p.y - rSun * 3.8);
      g.fillText(lbl, p.x, p.y - rSun * 3.8);
    } else {
      // Flecha guía
      const cx = w / 2, cy = h / 2;
      const ang = p.behind ? Math.atan2(-p.dy, p.dx) : Math.atan2(p.y - cy, p.x - cx);
      const R = Math.min(w, h) * 0.3;
      const ax = cx + Math.cos(ang) * R, ay = cy + Math.sin(ang) * R;
      g.save();
      g.translate(ax, ay); g.rotate(ang);
      g.fillStyle = '#ffab3d';
      g.beginPath(); g.moveTo(26, 0); g.lineTo(-14, 16); g.lineTo(-6, 0); g.lineTo(-14, -16); g.closePath(); g.fill();
      g.restore();
      g.font = '700 13px -apple-system, sans-serif'; g.textAlign = 'center';
      g.fillStyle = '#fff'; g.strokeStyle = 'rgba(0,0,0,.75)'; g.lineWidth = 3;
      const tx = cx + Math.cos(ang) * (R + 34), ty = cy + Math.sin(ang) * (R + 34);
      g.strokeText('Gira hacia aquí', tx, ty);
      g.fillText('Gira hacia aquí', tx, ty);
    }

    // ---- Modo calibración: retícula central ----
    if (ar.calibrating) {
      const cx = w / 2, cy = h / 2;
      g.strokeStyle = '#46e39b'; g.lineWidth = 2;
      g.beginPath(); g.arc(cx, cy, 34, 0, 7); g.stroke();
      g.beginPath();
      g.moveTo(cx - 52, cy); g.lineTo(cx - 12, cy);
      g.moveTo(cx + 12, cy); g.lineTo(cx + 52, cy);
      g.moveTo(cx, cy - 52); g.lineTo(cx, cy - 12);
      g.moveTo(cx, cy + 12); g.lineTo(cx, cy + 52);
      g.stroke();
    }

    // ---- Barra de progreso ----
    const lc = app.lc;
    if (lc) {
      const t0 = lc.c1.date.getTime(), t1 = lc.c4.date.getTime();
      const pct = Math.max(0, Math.min(1, (t.getTime() - t0) / (t1 - t0)));
      const bw = w - 60, bx = 30, by = h - 118;
      g.fillStyle = 'rgba(0,0,0,.5)';
      g.beginPath(); g.roundRect(bx, by, bw, 7, 4); g.fill();
      const grd = g.createLinearGradient(bx, 0, bx + bw, 0);
      grd.addColorStop(0, '#4fd6ff'); grd.addColorStop(.6, '#ffab3d'); grd.addColorStop(1, '#9b7bff');
      g.fillStyle = grd;
      g.beginPath(); g.roundRect(bx, by, Math.max(2, bw * pct), 7, 4); g.fill();
      if (lc.c2 && lc.c3) {
        const a = (lc.c2.date - t0) / (t1 - t0), b = (lc.c3.date - t0) / (t1 - t0);
        g.fillStyle = 'rgba(255,255,255,.9)';
        g.fillRect(bx + bw * a, by - 4, Math.max(2, bw * (b - a)), 15);
      }
    }
  }

  // ---------------------------------------------------------------------
  // HUD: solo se toca el DOM cuando el texto cambia de verdad
  // ---------------------------------------------------------------------
  let lastInfo = '', lastHint = '', lastAlarm = null, hudAt = 0;

  function setHint(html, alarm) {
    if (html === lastHint && alarm === lastAlarm) return;
    lastHint = html; lastAlarm = alarm;
    const el = $('arHint');
    el.innerHTML = html;
    el.classList.toggle('alarm', !!alarm);
  }

  function updateHud(t, app) {
    const now = performance.now();
    if (now - hudAt < 200) return;
    hudAt = now;

    const lc = app.lc, st = cache.st;
    let cd = '';
    if (lc) {
      const targets = [[lc.c1.date, 'C1'], lc.c2 && [lc.c2.date, 'C2'], [lc.max.date, 'MÁX'],
                       lc.c3 && [lc.c3.date, 'C3'], [lc.c4.date, 'C4']].filter(Boolean);
      const nxt = targets.find(x => t < x[0]);
      if (nxt) {
        let s = Math.max(0, (nxt[0] - t) / 1000);
        const d = Math.floor(s / 86400); s -= d * 86400;
        const hh = Math.floor(s / 3600); s -= hh * 3600;
        const mm = Math.floor(s / 60); s -= mm * 60;
        cd = `${nxt[1]} en <b>${d ? d + 'd ' : ''}${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}</b>`;
      } else cd = 'Eclipse terminado';
    }

    const srcTag = ar.source === 'ios' || ar.source === 'absolute' ? ''
                 : ar.source === 'relative' ? ' <span style="color:#ffca4a">brújula relativa</span>' : '';
    const offTag = ar.headingOffset ? ` <span style="color:#46e39b">${ar.headingOffset > 0 ? '+' : ''}${ar.headingOffset.toFixed(0)}°</span>` : '';
    const info =
      `<div>Az <b>${cache.sunAz.toFixed(1)}°</b> · Alt <b>${cache.sunAlt.toFixed(1)}°</b>${offTag}</div>` +
      (st && !st.outOfRange ? `<div>Cubierto <b>${(st.obscuration * 100).toFixed(1)} %</b></div>` : '') +
      `<div>${cd}${srcTag}</div>`;
    if (info !== lastInfo) { lastInfo = info; $('arInfo').innerHTML = info; }

    if (ar.calibrating) {
      setHint('🎯 Apunta con la retícula al <b>Sol de verdad</b> y toca la pantalla. Si no lo ves, usa una referencia conocida.', false);
    } else if (!ar.haveOrientation) {
      setHint('Mueve el móvil para activar la brújula.', false);
    } else if (ar.source === 'relative') {
      setHint('⚠️ Tu móvil no da <b>brújula absoluta</b>: el rumbo puede estar girado. Pulsa <b>Calibrar</b> y marca dónde está el Sol.', false);
    } else if (lc && lc.c2 && t >= lc.c2.date && t <= lc.c3.date) {
      setHint('🌑 <b>TOTALIDAD</b> — quítate el filtro y mira directamente', true);
    } else if (lc && lc.c2 && (lc.c2.date - t) > 0 && (lc.c2.date - t) < 120000) {
      setHint('⚡ Totalidad inminente — <b>prepárate</b>', true);
    } else if (st && st.magnitude > 0) {
      setHint('⛔ Eclipse parcial en curso — <b>NO mires sin filtro ISO 12312-2</b>', false);
    } else if (cache.sunAlt < 0) {
      setHint('El Sol está bajo el horizonte. La retícula marca dónde estará.', false);
    } else {
      setHint('La línea naranja es el recorrido del Sol durante el eclipse. ⛔ No mires al Sol sin filtro.', false);
    }
  }

  // ---------------------------------------------------------------------
  // API pública
  // ---------------------------------------------------------------------
  let raf = null, lastFrame = 0;

  ar.open = async function (app) {
    $('arView').classList.add('on');
    ar.active = true;
    smoothQ = null; lastInfo = ''; lastHint = ''; lastAlarm = null;
    lastW = lastH = 0;
    resizeCanvas();
    addEventListener('resize', resizeCanvas);
    if (screen.orientation) screen.orientation.addEventListener('change', resizeCanvas);

    const okSensors = await requestSensors();
    const okCam = await startCamera();

    if (!okCam) {
      $('arInfo').innerHTML = '⚠️ Sin acceso a la cámara.<br>Se muestra solo la superposición.';
      $('arVideo').style.display = 'none';
    }
    if (!okSensors) {
      setHint('Sin permiso para los sensores de orientación. En iPhone, recarga y acepta el aviso de «Movimiento y orientación».', false);
    }

    cache.key = null;
    buildSky(app);
    updateAstro(new Date(Date.now() + (app.offsetMs || 0)), app, true);

    lastFrame = performance.now();
    function loop(ts) {
      if (!ar.active) return;
      const dt = Math.min(0.1, (ts - lastFrame) / 1000);
      lastFrame = ts;
      const t = new Date(Date.now() + (app.offsetMs || 0));
      try {
        resizeCanvas();
        buildSky(app);
        updateAstro(t, app);
        draw(t, app, dt);
        updateHud(t, app);
      } catch (e) { console.error(e); }
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);

    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('portrait').catch(() => {});
    }
  };

  ar.close = function () {
    ar.active = false;
    ar.calibrating = false;
    if (raf) cancelAnimationFrame(raf);
    if (ar.stream) { ar.stream.getTracks().forEach(t => t.stop()); ar.stream = null; }
    $('arVideo').srcObject = null;
    $('arVideo').style.display = '';
    $('arView').classList.remove('on');
    removeEventListener('resize', resizeCanvas);
    if (screen.orientation) screen.orientation.removeEventListener('change', resizeCanvas);
    releaseSensors();
    smoothQ = null;
    const cb = $('arCal'); if (cb) cb.classList.remove('on');
  };

  /**
   * Calibración manual: el usuario apunta al Sol real y toca la pantalla.
   * Calculamos el azimut del rayo que pasa por ese píxel y ajustamos el
   * desfase de la brújula para que el Sol calculado caiga justo ahí.
   */
  function calibrateAt(clientX, clientY) {
    if (!lastBasis || !cache.sunVec) return;
    const c = $('arCanvas');
    const rect = c.getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;

    const dx = (px - lastW2 / 2) / lastF;
    const dy = -(py - lastH2 / 2) / lastF;
    const b = lastBasis;
    const dir = norm([
      b.fwd[0] + b.right[0] * dx + b.up[0] * dy,
      b.fwd[1] + b.right[1] * dx + b.up[1] * dy,
      b.fwd[2] + b.right[2] * dx + b.up[2] * dy
    ]);
    const azTapped = (Math.atan2(dir[0], dir[1]) / D2R + 360) % 360;

    let delta = cache.sunAz - azTapped;
    delta = ((delta + 180) % 360 + 360) % 360 - 180;
    ar.headingOffset = ((ar.headingOffset + delta + 180) % 360 + 360) % 360 - 180;
    try { localStorage.setItem('eclipse-heading-offset', String(ar.headingOffset)); } catch (e) {}

    ar.calibrating = false;
    const cb = $('arCal'); if (cb) cb.classList.remove('on');
    lastHint = '';
    setHint(`✅ Brújula corregida <b>${ar.headingOffset > 0 ? '+' : ''}${ar.headingOffset.toFixed(1)}°</b>. Se recuerda para la próxima vez.`, false);
    if (navigator.vibrate) navigator.vibrate(80);
  }

  ar.isActive = () => ar.active;
  ar.update = function () { /* el bucle propio ya redibuja a 60 fps */ };

  // Controles
  addEventListener('DOMContentLoaded', () => {
    const tb = $('arTrack'), db = $('arDisk'), cb = $('arCal');
    if (tb) tb.onclick = () => { ar.showTrack = !ar.showTrack; tb.classList.toggle('on', ar.showTrack); };
    if (db) db.onclick = () => {
      ar.showDisk = !ar.showDisk;
      db.classList.toggle('on', ar.showDisk);
      cache.tAstro = 0;
    };
    if (cb) cb.onclick = () => {
      ar.calibrating = !ar.calibrating;
      cb.classList.toggle('on', ar.calibrating);
      lastHint = '';
      if (!ar.calibrating) setHint('Calibración cancelada.', false);
      if (navigator.vibrate) navigator.vibrate(60);
    };

    // Doble toque en el botón de calibrar = reiniciar la corrección
    if (cb) cb.ondblclick = () => {
      ar.headingOffset = 0;
      try { localStorage.removeItem('eclipse-heading-offset'); } catch (e) {}
      ar.calibrating = false; cb.classList.remove('on');
      lastHint = ''; setHint('Corrección de brújula reiniciada.', false);
    };

    const cv = $('arCanvas');
    if (cv) {
      cv.style.pointerEvents = 'auto';
      cv.addEventListener('click', e => {
        if (ar.calibrating) calibrateAt(e.clientX, e.clientY);
      });
    }
  });

  global.AR = ar;
})(window);
