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
    showDisk: true
  };

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
  let smooth = null;       // {right, up, fwd} suavizados

  function rawBasis() {
    if (!ar.orient) return null;
    let { alpha, beta, gamma, heading } = ar.orient;
    if (typeof heading === 'number' && !isNaN(heading)) alpha = 360 - heading;  // iOS
    if (typeof alpha !== 'number' || typeof beta !== 'number' || typeof gamma !== 'number') return null;

    const M = deviceMatrix(alpha, beta, gamma);
    let right = mulVec(M, [1, 0, 0]);
    let up    = mulVec(M, [0, 1, 0]);
    const fwd = mulVec(M, [0, 0, -1]);          // la cámara trasera mira hacia -Z

    const sa = screenAngle() * D2R;
    if (sa) {
      const c = Math.cos(sa), s = Math.sin(sa);
      const r2 = [right[0] * c + up[0] * s, right[1] * c + up[1] * s, right[2] * c + up[2] * s];
      const u2 = [-right[0] * s + up[0] * c, -right[1] * s + up[1] * c, -right[2] * s + up[2] * c];
      right = r2; up = u2;
    }
    return { right, up, fwd };
  }

  /**
   * Suaviza la base con un filtro paso bajo dependiente del tiempo y la
   * re-ortonormaliza (interpolar vectores por separado los desalinea).
   * tau bajo = respuesta rápida pero más ruido; tau alto = suave pero con retraso.
   */
  function updateBasis(dt) {
    const raw = rawBasis();
    if (!raw) return smooth;
    if (!smooth) { smooth = raw; return smooth; }

    const TAU = 0.09;                                  // segundos
    const k = 1 - Math.exp(-Math.max(0.001, dt) / TAU);

    // Si el giro es muy grande (el usuario ha girado de golpe), saltamos
    // directamente para no arrastrar el retraso.
    const angle = Math.acos(Math.max(-1, Math.min(1, dot(smooth.fwd, raw.fwd))));
    const kk = angle > 0.6 ? 1 : k;

    let fwd = norm(lerpVec(smooth.fwd, raw.fwd, kk));
    let up = lerpVec(smooth.up, raw.up, kk);
    let right = norm(cross(fwd, up));                  // ortonormalización de Gram-Schmidt
    up = norm(cross(right, fwd));
    // cross(fwd, up) da la izquierda o la derecha según el convenio; lo fijamos
    // comparando con el valor crudo.
    if (dot(right, raw.right) < 0) { right = [-right[0], -right[1], -right[2]]; up = norm(cross(right, fwd)); }
    if (dot(up, raw.up) < 0) up = [-up[0], -up[1], -up[2]];

    smooth = { right, up, fwd };
    return smooth;
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
  function onOrient(e) {
    if (e.alpha === null && e.webkitCompassHeading === undefined) return;
    ar.haveOrientation = true;
    ar.orient = {
      alpha: e.alpha, beta: e.beta, gamma: e.gamma,
      absolute: e.absolute,
      heading: e.webkitCompassHeading
    };
  }

  async function requestSensors() {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== 'granted') return false;
      } catch (e) { return false; }
    }
    if ('ondeviceorientationabsolute' in window) {
      addEventListener('deviceorientationabsolute', onOrient, true);
    }
    addEventListener('deviceorientation', onOrient, true);
    return true;
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

    const f = (w / 2) / Math.tan(ar.hfov / 2 * D2R);
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

    const info =
      `<div>Az <b>${cache.sunAz.toFixed(1)}°</b> · Alt <b>${cache.sunAlt.toFixed(1)}°</b></div>` +
      (st && !st.outOfRange ? `<div>Cubierto <b>${(st.obscuration * 100).toFixed(1)} %</b></div>` : '') +
      `<div>${cd}</div>`;
    if (info !== lastInfo) { lastInfo = info; $('arInfo').innerHTML = info; }

    if (!ar.haveOrientation) {
      setHint('Mueve el móvil para activar la brújula.', false);
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
    smooth = null; lastInfo = ''; lastHint = ''; lastAlarm = null;
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
    if (raf) cancelAnimationFrame(raf);
    if (ar.stream) { ar.stream.getTracks().forEach(t => t.stop()); ar.stream = null; }
    $('arVideo').srcObject = null;
    $('arVideo').style.display = '';
    $('arView').classList.remove('on');
    removeEventListener('resize', resizeCanvas);
    if (screen.orientation) screen.orientation.removeEventListener('change', resizeCanvas);
  };

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
      lastHint = '';
      setHint('🧭 <b>Calibrar:</b> dibuja un 8 en el aire con el móvil, lejos de metales, imanes y coches.', false);
      if (navigator.vibrate) navigator.vibrate(60);
    };
  });

  global.AR = ar;
})(window);
