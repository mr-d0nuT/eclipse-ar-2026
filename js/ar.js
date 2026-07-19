/* =========================================================================
   ar.js — Modo Realidad Aumentada
   Cámara + acelerómetro + brújula: superpone la posición real del Sol,
   su trayectoria hasta el eclipse y el disco eclipsado en tiempo real.
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
    orient: null,          // {alpha, beta, gamma, absolute, heading}
    haveOrientation: false,
    hfov: 63,              // campo de visión horizontal estimado (grados)
    showTrack: true,
    showDisk: true,
    calibrating: false,
    lastState: null
  };

  // ---------------------------------------------------------------------
  // Álgebra: matriz de rotación del dispositivo (spec W3C, Z-X'-Y'')
  // Marco mundial: X = Este, Y = Norte, Z = Arriba
  // ---------------------------------------------------------------------
  function deviceMatrix(alpha, beta, gamma) {
    const a = alpha * D2R, b = beta * D2R, g = gamma * D2R;
    const cA = Math.cos(a), sA = Math.sin(a);
    const cB = Math.cos(b), sB = Math.sin(b);
    const cG = Math.cos(g), sG = Math.sin(g);

    // R = Rz(alpha) · Rx(beta) · Ry(gamma)
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

  /** Dirección unitaria (Este, Norte, Arriba) a partir de azimut/altura */
  function skyVector(az, alt) {
    const ca = Math.cos(alt * D2R);
    return [ca * Math.sin(az * D2R), ca * Math.cos(az * D2R), Math.sin(alt * D2R)];
  }

  /** Ángulo de rotación de la pantalla */
  function screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
    return window.orientation || 0;
  }

  /** Base de la cámara en el marco mundial */
  function cameraBasis() {
    if (!ar.orient) return null;
    let { alpha, beta, gamma, heading } = ar.orient;
    if (typeof heading === 'number' && !isNaN(heading)) alpha = 360 - heading;   // iOS
    if (typeof alpha !== 'number') return null;

    const M = deviceMatrix(alpha, beta, gamma);
    // Ejes del dispositivo en coordenadas mundiales
    let right = mulVec(M, [1, 0, 0]);
    let up    = mulVec(M, [0, 1, 0]);
    const fwd = mulVec(M, [0, 0, -1]);          // la cámara trasera mira hacia -Z

    // Compensar la rotación de la pantalla
    const sa = screenAngle() * D2R;
    if (sa) {
      const c = Math.cos(sa), s = Math.sin(sa);
      const r2 = [right[0] * c + up[0] * s, right[1] * c + up[1] * s, right[2] * c + up[2] * s];
      const u2 = [-right[0] * s + up[0] * c, -right[1] * s + up[1] * c, -right[2] * s + up[2] * c];
      right = r2; up = u2;
    }
    return { right, up, fwd };
  }

  /** Proyecta una dirección del cielo a coordenadas de pantalla */
  function project(vec, basis, W, H) {
    const f = (W / 2) / Math.tan(ar.hfov / 2 * D2R);
    const z = dot(vec, basis.fwd);
    const x = dot(vec, basis.right);
    const y = dot(vec, basis.up);
    if (z <= 0.02) {
      // Detrás de la cámara: devolvemos solo la dirección para la flecha guía
      return { behind: true, dx: x, dy: y };
    }
    return { behind: false, x: W / 2 + x * f / z, y: H / 2 - y * f / z, z };
  }

  // ---------------------------------------------------------------------
  // Sensores
  // ---------------------------------------------------------------------
  function onOrient(e) {
    ar.haveOrientation = true;
    ar.orient = {
      alpha: e.alpha, beta: e.beta, gamma: e.gamma,
      absolute: e.absolute,
      heading: e.webkitCompassHeading
    };
    ar.accuracy = e.webkitCompassAccuracy;
  }

  async function requestSensors() {
    // iOS 13+ requiere permiso explícito
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
      // Estimar el campo de visión real si el navegador lo expone
      const track = ar.stream.getVideoTracks()[0];
      const s = track.getSettings ? track.getSettings() : {};
      if (s.width && s.height) {
        const caps = track.getCapabilities ? track.getCapabilities() : {};
        // Heurística: la mayoría de cámaras principales tienen ~63-70° horizontales
        ar.hfov = 65;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Dibujo
  // ---------------------------------------------------------------------
  function resizeCanvas() {
    const c = $('arCanvas');
    c.width = innerWidth * devicePixelRatio;
    c.height = innerHeight * devicePixelRatio;
    c.style.width = innerWidth + 'px';
    c.style.height = innerHeight + 'px';
  }

  /**
   * Direcciones «Este celeste» y «Norte celeste» proyectadas a la pantalla,
   * como vectores unitarios. Así la Luna se dibuja en su orientación real
   * sea cual sea la inclinación del móvil.
   */
  function skyAxesOnScreen(t, lat, lon, basis, W, H, sunScreen) {
    const jd = Astro.toJD(t);
    const sp = Astro.sunPosition(jd);
    const d = 0.3;                                     // paso en grados
    const at = (dra, ddec) => {
      const hz = Astro.equatorialToHorizontal(jd, sp.ra + dra, sp.dec + ddec, lat, lon, sp.dist);
      return project(skyVector(hz.az, hz.alt + Astro.refraction(hz.alt)), basis, W, H);
    };
    const p0 = at(0, 0);
    const pE = at(d / Math.cos(sp.dec * D2R), 0);
    const pN = at(0, d);
    if (p0.behind || pE.behind || pN.behind) return { e: [-1, 0], n: [0, -1] };
    const unit = p => {
      const vx = p.x - p0.x, vy = p.y - p0.y;
      const m = Math.hypot(vx, vy) || 1;
      return [vx / m, vy / m];
    };
    return { e: unit(pE), n: unit(pN) };
  }

  function drawEclipsedSun(g, x, y, r, st, axes) {
    // Halo
    const glow = g.createRadialGradient(x, y, r * .6, x, y, r * 6);
    const dark = st ? st.obscuration : 0;
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

    // Disco solar
    const sg = g.createRadialGradient(x - r * .25, y - r * .25, r * .1, x, y, r);
    sg.addColorStop(0, '#fffef6'); sg.addColorStop(.65, '#ffe6a0'); sg.addColorStop(1, '#ffab3d');
    g.fillStyle = sg; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();

    // Luna, orientada según los ejes celestes reales proyectados
    if (st && st.magnitude > 0) {
      const ax = axes || { e: [-1, 0], n: [0, -1] };
      const mr = r * st.moonOverSun;
      const mx = x + (ax.e[0] * st.offsetE + ax.n[0] * st.offsetN) * r;
      const my = y + (ax.e[1] * st.offsetE + ax.n[1] * st.offsetN) * r;
      g.fillStyle = st.phase === 'total' ? '#000' : 'rgba(6,7,14,.96)';
      g.beginPath(); g.arc(mx, my, mr, 0, 7); g.fill();
    }
  }

  function draw(t, appState) {
    const c = $('arCanvas'), g = c.getContext('2d');
    const W = c.width, H = c.height, dpr = devicePixelRatio;
    g.clearRect(0, 0, W, H);
    g.save(); g.scale(dpr, dpr);
    const w = W / dpr, h = H / dpr;

    const lat = appState.lat, lon = appState.lon;
    const sun = Astro.sunAltAz(t, lat, lon);
    const basis = cameraBasis();
    const lc = appState.lc;

    if (!basis) {
      g.restore();
      $('arHint').textContent = 'Esperando a los sensores de orientación… mueve un poco el móvil.';
      return;
    }

    const sunPix = w * 0.028;   // radio del Sol en pantalla (≈0.53° reales, ampliado x5 para verlo)
    const rSun = Math.max(11, (0.266 * D2R) * ((w / 2) / Math.tan(ar.hfov / 2 * D2R)) * 5);

    // ---- Línea del horizonte y brújula ----
    g.lineWidth = 1.5;
    g.strokeStyle = 'rgba(79,214,255,.5)';
    g.beginPath();
    let started = false;
    for (let az = 0; az <= 360; az += 3) {
      const p = project(skyVector(az, 0), basis, w, h);
      if (p.behind) { started = false; continue; }
      started ? g.lineTo(p.x, p.y) : (g.moveTo(p.x, p.y), started = true);
    }
    g.stroke();

    // Marcas de azimut
    g.font = '600 11px -apple-system, sans-serif'; g.textAlign = 'center';
    const NAMES = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SO', 270: 'O', 315: 'NO' };
    for (let az = 0; az < 360; az += 15) {
      const p = project(skyVector(az, 0), basis, w, h);
      if (p.behind) continue;
      const big = az % 45 === 0;
      g.strokeStyle = `rgba(79,214,255,${big ? .8 : .35})`;
      g.beginPath(); g.moveTo(p.x, p.y - (big ? 10 : 5)); g.lineTo(p.x, p.y + (big ? 10 : 5)); g.stroke();
      if (big) {
        g.fillStyle = az === 0 ? '#ff5f6d' : 'rgba(210,240,255,.95)';
        g.fillText(NAMES[az] || az + '°', p.x, p.y + 24);
      }
    }

    // ---- Trayectoria del Sol durante el eclipse ----
    if (ar.showTrack && lc) {
      const t0 = lc.c1.date.getTime(), t1 = lc.c4.date.getTime();
      g.lineWidth = 3; g.strokeStyle = 'rgba(255,171,61,.75)';
      g.beginPath(); started = false;
      for (let k = 0; k <= 80; k++) {
        const d = new Date(t0 + (t1 - t0) * k / 80);
        const s = Astro.sunAltAz(d, lat, lon);
        const p = project(skyVector(s.az, s.altRefracted), basis, w, h);
        if (p.behind) { started = false; continue; }
        started ? g.lineTo(p.x, p.y) : (g.moveTo(p.x, p.y), started = true);
      }
      g.stroke();

      // Hitos con etiqueta
      const marks = [['C1', lc.c1], ['C2', lc.c2], ['MÁX', lc.max], ['C3', lc.c3], ['C4', lc.c4]].filter(m => m[1]);
      g.font = '700 11px -apple-system, sans-serif';
      for (const [n, ev] of marks) {
        const s = Astro.sunAltAz(ev.date, lat, lon);
        const p = project(skyVector(s.az, s.altRefracted), basis, w, h);
        if (p.behind) continue;
        g.fillStyle = n === 'MÁX' ? '#fff' : '#ffd27d';
        g.beginPath(); g.arc(p.x, p.y, n === 'MÁX' ? 6 : 4, 0, 7); g.fill();
        g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 3;
        const lab = `${n} ${ev.date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
        g.textAlign = 'left';
        g.strokeText(lab, p.x + 9, p.y + 4);
        g.fillText(lab, p.x + 9, p.y + 4);
      }
    }

    // ---- El Sol ahora ----
    const sv = skyVector(sun.az, sun.altRefracted);
    const p = project(sv, basis, w, h);
    const st = ar.showDisk ? Eclipse.stateAt(t, lat, lon, appState.height) : null;

    if (!p.behind && p.x > -100 && p.x < w + 100 && p.y > -100 && p.y < h + 100) {
      const axes = st && st.magnitude > 0 ? skyAxesOnScreen(t, lat, lon, basis, w, h, p) : null;
      drawEclipsedSun(g, p.x, p.y, rSun, st, axes);
      // Retícula
      g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 2;
      g.beginPath(); g.arc(p.x, p.y, rSun * 2.1, 0, 7); g.stroke();
      g.setLineDash([4, 5]);
      g.beginPath(); g.arc(p.x, p.y, rSun * 3.4, 0, 7); g.stroke();
      g.setLineDash([]);
      g.font = '700 13px -apple-system, sans-serif'; g.textAlign = 'center';
      g.fillStyle = '#fff'; g.strokeStyle = 'rgba(0,0,0,.75)'; g.lineWidth = 3;
      const lbl = sun.altRefracted > 0 ? '☀ SOL' : '☀ SOL (bajo el horizonte)';
      g.strokeText(lbl, p.x, p.y - rSun * 3.8);
      g.fillText(lbl, p.x, p.y - rSun * 3.8);
    } else {
      // Flecha guía hacia el Sol
      const cx = w / 2, cy = h / 2;
      let ang;
      if (p.behind) ang = Math.atan2(-p.dy, p.dx);
      else ang = Math.atan2(p.y - cy, p.x - cx);
      const R = Math.min(w, h) * 0.3;
      const ax = cx + Math.cos(ang) * R, ay = cy + Math.sin(ang) * R;
      g.save();
      g.translate(ax, ay); g.rotate(ang);
      g.fillStyle = '#ffab3d';
      g.beginPath(); g.moveTo(26, 0); g.lineTo(-14, 16); g.lineTo(-6, 0); g.lineTo(-14, -16); g.closePath(); g.fill();
      g.restore();
      g.font = '700 13px -apple-system, sans-serif'; g.textAlign = 'center';
      g.fillStyle = '#fff'; g.strokeStyle = 'rgba(0,0,0,.75)'; g.lineWidth = 3;
      g.strokeText('Gira hacia aquí', cx + Math.cos(ang) * (R + 34), cy + Math.sin(ang) * (R + 34));
      g.fillText('Gira hacia aquí', cx + Math.cos(ang) * (R + 34), cy + Math.sin(ang) * (R + 34));
    }

    // ---- Barra de progreso del eclipse en la parte inferior ----
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

    g.restore();
    updateHud(t, sun, appState, st, basis);
  }

  function updateHud(t, sun, appState, st, basis) {
    const lc = appState.lc;
    const fmt = d => d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    let cd = '';
    if (lc) {
      const targets = [[lc.c1.date, 'C1'], lc.c2 && [lc.c2.date, 'C2'], [lc.max.date, 'MÁX'], lc.c3 && [lc.c3.date, 'C3'], [lc.c4.date, 'C4']].filter(Boolean);
      const nxt = targets.find(x => t < x[0]);
      if (nxt) {
        let s = Math.max(0, (nxt[0] - t) / 1000);
        const d = Math.floor(s / 86400); s -= d * 86400;
        const hh = Math.floor(s / 3600); s -= hh * 3600;
        const mm = Math.floor(s / 60); s -= mm * 60;
        cd = `${nxt[1]} en <b>${d ? d + 'd ' : ''}${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}</b>`;
      } else cd = 'Eclipse terminado';
    }

    $('arInfo').innerHTML =
      `<div>Az <b>${sun.az.toFixed(1)}°</b> · Alt <b>${sun.altRefracted.toFixed(1)}°</b></div>` +
      (st ? `<div>Cubierto <b>${(st.obscuration * 100).toFixed(1)} %</b></div>` : '') +
      `<div>${cd}</div>`;

    // Mensaje contextual / alarma
    const hint = $('arHint');
    hint.classList.remove('alarm');
    if (!ar.haveOrientation) {
      hint.textContent = 'Mueve el móvil para activar la brújula.';
    } else if (lc && lc.c2 && t >= lc.c2.date && t <= lc.c3.date) {
      hint.innerHTML = '🌑 <b>TOTALIDAD</b> — quítate el filtro y mira directamente';
      hint.classList.add('alarm');
    } else if (lc && lc.c2 && (lc.c2.date - t) > 0 && (lc.c2.date - t) < 120000) {
      hint.innerHTML = '⚡ Totalidad inminente — <b>prepárate</b>';
      hint.classList.add('alarm');
    } else if (st && st.magnitude > 0) {
      hint.innerHTML = '⛔ Eclipse parcial en curso — <b>NO mires sin filtro ISO 12312-2</b>';
    } else if (sun.altRefracted < 0) {
      hint.textContent = 'El Sol está bajo el horizonte. La retícula marca dónde estará.';
    } else {
      hint.innerHTML = 'La línea naranja es el recorrido del Sol durante el eclipse. ⛔ No mires al Sol sin filtro.';
    }
  }

  // ---------------------------------------------------------------------
  // API pública
  // ---------------------------------------------------------------------
  let raf = null;

  ar.open = async function (appState) {
    ar.lastState = appState;
    $('arView').classList.add('on');
    ar.active = true;
    resizeCanvas();
    addEventListener('resize', resizeCanvas);

    const okSensors = await requestSensors();
    const okCam = await startCamera();

    if (!okCam) {
      $('arInfo').innerHTML = '⚠️ Sin acceso a la cámara.<br>Se muestra solo la superposición.';
      $('arVideo').style.display = 'none';
    }
    if (!okSensors) {
      $('arHint').textContent = 'Sin permiso para los sensores de orientación. En iPhone, recarga y acepta el aviso de «Movimiento y orientación».';
    }

    function loop() {
      if (!ar.active) return;
      const t = new Date(Date.now() + (appState.offsetMs || 0));
      try { draw(t, appState); } catch (e) { console.error(e); }
      raf = requestAnimationFrame(loop);
    }
    loop();

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
  };

  ar.isActive = () => ar.active;
  ar.update = function () { /* el bucle propio ya redibuja a 60 fps */ };

  // Controles
  addEventListener('DOMContentLoaded', () => {
    const tb = $('arTrack'), db = $('arDisk'), cb = $('arCal');
    if (tb) tb.onclick = () => { ar.showTrack = !ar.showTrack; tb.classList.toggle('on', ar.showTrack); };
    if (db) db.onclick = () => { ar.showDisk = !ar.showDisk; db.classList.toggle('on', ar.showDisk); };
    if (cb) cb.onclick = () => {
      $('arHint').innerHTML = '🧭 <b>Calibrar:</b> dibuja un 8 en el aire con el móvil, lejos de metales, imanes y coches.';
      if (navigator.vibrate) navigator.vibrate(60);
    };
  });

  global.AR = ar;
})(window);
