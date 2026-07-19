/* =========================================================================
   app.js — Lógica principal de la PWA
   ========================================================================= */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const T = (k, p) => I18N.t(k, p);
  const pad = n => String(Math.floor(Math.abs(n))).padStart(2, '0');

  // ---------------------------------------------------------------------
  // Ciudades de referencia (España + franja mundial)
  // ---------------------------------------------------------------------
  const CITIES = [
    { n: 'Oviedo',      lat: 43.3619, lon: -5.8494, h: 232 },
    { n: 'Gijón',       lat: 43.5322, lon: -5.6611, h: 12 },
    { n: 'Santander',   lat: 43.4623, lon: -3.8100, h: 15 },
    { n: 'Bilbao',      lat: 43.2630, lon: -2.9350, h: 19 },
    { n: 'A Coruña',    lat: 43.3623, lon: -8.4115, h: 5 },
    { n: 'Lugo',        lat: 43.0121, lon: -7.5559, h: 454 },
    { n: 'León',        lat: 42.5987, lon: -5.5671, h: 837 },
    { n: 'Palencia',    lat: 42.0096, lon: -4.5288, h: 749 },
    { n: 'Burgos',      lat: 42.3439, lon: -3.6969, h: 856 },
    { n: 'Logroño',     lat: 42.4627, lon: -2.4450, h: 384 },
    { n: 'Vitoria',     lat: 42.8467, lon: -2.6716, h: 525 },
    { n: 'Valladolid',  lat: 41.6523, lon: -4.7245, h: 698 },
    { n: 'Soria',       lat: 41.7665, lon: -2.4790, h: 1063 },
    { n: 'Segovia',     lat: 40.9429, lon: -4.1088, h: 1005 },
    { n: 'Zaragoza',    lat: 41.6488, lon: -0.8891, h: 208 },
    { n: 'Lleida',      lat: 41.6176, lon:  0.6200, h: 155 },
    { n: 'Tarragona',   lat: 41.1189, lon:  1.2445, h: 68 },
    { n: 'Teruel',      lat: 40.3456, lon: -1.1065, h: 915 },
    { n: 'Guadalajara', lat: 40.6329, lon: -3.1669, h: 685 },
    { n: 'Cuenca',      lat: 40.0704, lon: -2.1374, h: 946 },
    { n: 'Valencia',    lat: 39.4699, lon: -0.3763, h: 15 },
    { n: 'Castellón',   lat: 39.9864, lon: -0.0513, h: 30 },
    { n: 'Palma',       lat: 39.5696, lon:  2.6502, h: 13 },
    { n: 'Madrid',      lat: 40.4168, lon: -3.7038, h: 667 },
    { n: 'Barcelona',   lat: 41.3874, lon:  2.1686, h: 12 },
    { n: 'Sevilla',     lat: 37.3891, lon: -5.9845, h: 7 },
    { n: 'Reikiavik',   lat: 64.1466, lon: -21.9426, h: 0 },
    { n: 'Lisboa',      lat: 38.7223, lon: -9.1393, h: 2 }
  ];

  // ---------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------
  const state = {
    lat: 43.3619, lon: -5.8494, height: 232,
    label: 'Oviedo',
    lc: null,               // circunstancias locales
    offsetMs: 0,            // desplazamiento del "cursor temporal"
    live: true,
    map: null, mapLayers: {},
    notified: {},
    deferredInstall: null
  };
  window.__eclipseState = state;

  const fmtTime = d => d ? d.toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
  const fmtHM   = d => d ? d.toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit' }) : '—';

  function fmtDur(s) {
    s = Math.round(s);
    if (s <= 0) return '—';
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${pad(s % 60)}s` : `${s}s`;
  }

  const cardinal = az => I18N.cardinal(az);

  // =====================================================================
  // FONDO ESTELAR
  // =====================================================================
  (function stars() {
    const c = $('stars'), x = c.getContext('2d');
    let pts = [];
    function resize() {
      c.width = innerWidth * devicePixelRatio; c.height = innerHeight * devicePixelRatio;
      c.style.width = innerWidth + 'px'; c.style.height = innerHeight + 'px';
      pts = Array.from({ length: 150 }, () => ({
        x: Math.random() * c.width, y: Math.random() * c.height,
        r: Math.random() * 1.4 * devicePixelRatio + .3,
        p: Math.random() * Math.PI * 2, s: .4 + Math.random() * 1.4
      }));
    }
    function draw(t) {
      x.clearRect(0, 0, c.width, c.height);
      for (const p of pts) {
        const a = .25 + .55 * (0.5 + 0.5 * Math.sin(t / 1000 * p.s + p.p));
        x.globalAlpha = a; x.fillStyle = '#fff';
        x.beginPath(); x.arc(p.x, p.y, p.r, 0, 7); x.fill();
      }
      requestAnimationFrame(draw);
    }
    addEventListener('resize', resize); resize(); requestAnimationFrame(draw);
  })();

  // =====================================================================
  // CÁLCULO PARA LA UBICACIÓN ACTUAL
  // =====================================================================
  function recompute() {
    state.lc = Eclipse.localCircumstances(state.lat, state.lon, state.height);
    const DIRS = I18N.t('dir');            // 0=N 4=E 8=S 12=O/W, según idioma
    $('locChip').textContent = `${state.label} · ${Math.abs(state.lat).toFixed(3)}°${state.lat >= 0 ? DIRS[0] : DIRS[8]} ${Math.abs(state.lon).toFixed(3)}°${state.lon >= 0 ? DIRS[4] : DIRS[12]}`;
    renderAlerts();
    renderPhases();
    renderStats();
    renderProgressMarks();
    renderCities();
    updateMap();
    setScrubRange();
    tick();
  }

  function now() { return new Date(Date.now() + state.offsetMs); }

  /** Ocaso de hoy en la ubicación actual (informativo) */
  function refreshSunset() {
    try {
      const rs = Astro.sunRiseSet(new Date(), state.lat, state.lon);
      $('sunSet').textContent = rs.set ? fmtHM(rs.set) : '—';
    } catch (e) { $('sunSet').textContent = '—'; }
  }

  // =====================================================================
  // AVISOS
  // =====================================================================
  function renderAlerts() {
    const el = $('alerts'); el.innerHTML = '';
    const lc = state.lc;
    if (!lc) {
      el.innerHTML = `<div class="alert danger"><span class="alert-ico">🌍</span>
        <div>${T('alert.notVisible', { place: state.label })}</div></div>`;
      return;
    }

    const add = (cls, ico, html) => {
      el.insertAdjacentHTML('beforeend', `<div class="alert ${cls}"><span class="alert-ico">${ico}</span><div>${html}</div></div>`);
    };

    if (lc.type === 'total') {
      add('ok', '🌑', T('alert.total', { dur: fmtDur(lc.totalityDuration), time: fmtTime(lc.max.date) }));
    } else {
      const near = Eclipse.nearestCentralPoint(state.lat, state.lon);
      if (near) {
        add('warn', '🚗', T('alert.partial', {
          pct: (lc.obscuration * 100).toFixed(1),
          km: Math.round(near.distanceKm),
          dir: cardinal(near.bearing)
        }));
      }
    }

    // Sol bajo / puesta durante el eclipse
    const altMax = lc.max.altRefracted;
    if (!lc.visible.max) {
      add('danger', '🌇', T('alert.belowHorizon'));
    } else if (altMax < 5) {
      add('danger', '⛰️', T('alert.veryLow', { alt: altMax.toFixed(1) }));
    } else if (altMax < 12) {
      add('warn', '⛰️', T('alert.low', { alt: altMax.toFixed(1) }));
    }

    if (lc.visible.c1 && !lc.visible.c4) {
      add('info', '🌆', T('alert.sunset'));
    }
  }

  // =====================================================================
  // FASES
  // =====================================================================
  const PHASE_DEFS = [
    { k: 'c1',  ico: '🌒', n: 'phase.c1',  d: 'phase.c1d' },
    { k: 'c2',  ico: '💍', n: 'phase.c2',  d: 'phase.c2d' },
    { k: 'max', ico: '🌑', n: 'phase.max', d: 'phase.maxd' },
    { k: 'c3',  ico: '💎', n: 'phase.c3',  d: 'phase.c3d' },
    { k: 'c4',  ico: '🌘', n: 'phase.c4',  d: 'phase.c4d' }
  ];

  function renderPhases() {
    const el = $('phases'); el.innerHTML = '';
    const lc = state.lc; if (!lc) return;
    const t = now();

    for (const p of PHASE_DEFS) {
      const ev = lc[p.k]; if (!ev) continue;
      const done = t > ev.date;
      let cls = done ? 'done' : '';
      const altCls = ev.altRefracted <= 0 ? 'below' : ev.altRefracted < 8 ? 'low' : '';
      const altTxt = ev.altRefracted <= 0 ? T('sun.below')
        : `Alt ${ev.altRefracted.toFixed(1)}° · Az ${ev.az.toFixed(0)}° ${cardinal(ev.az)}`;
      el.insertAdjacentHTML('beforeend', `
        <div class="phase ${cls}" data-k="${p.k}">
          <div class="phase-ico">${p.ico}</div>
          <div>
            <div class="phase-name">${T(p.n)}</div>
            <div class="phase-desc">${T(p.d)}</div>
          </div>
          <div class="phase-time">
            <b>${fmtTime(ev.date)}</b>
            <span class="alt ${altCls}">${altTxt}</span>
          </div>
        </div>`);
    }
    if (!lc.c2) {
      el.insertAdjacentHTML('beforeend',
        `<div class="muted" style="padding:10px 4px">${T('phases.noTotality')}</div>`);
    }
  }

  // =====================================================================
  // ESTADÍSTICAS
  // =====================================================================
  function renderStats() {
    const el = $('stats'); el.innerHTML = '';
    const lc = state.lc;
    if (!lc) { el.innerHTML = `<div class="muted">${T('stat.noData')}</div>`; return; }
    const badge = lc.type === 'total' ? `<span class="badge total">${T('badge.total')}</span>`
                : lc.type === 'annular' ? `<span class="badge partial">${T('badge.annular')}</span>`
                : `<span class="badge partial">${T('badge.partial')}</span>`;
    const items = [
      [T('stat.type'), badge],
      [T('stat.totality'), `<b>${fmtDur(lc.totalityDuration)}</b>`],
      [T('stat.mag'), lc.magnitude.toFixed(4)],
      [T('stat.obs'), (lc.obscuration * 100).toFixed(2) + ' <small>%</small>'],
      [T('stat.duration'), fmtDur(lc.duration)],
      [T('stat.altMax'), lc.max.altRefracted.toFixed(1) + ' <small>°</small>'],
      [T('stat.azMax'), lc.max.az.toFixed(1) + ' <small>° ' + cardinal(lc.max.az) + '</small>'],
      [T('stat.ratio'), lc.moonOverSun.toFixed(4)]
    ];
    for (const [l, v] of items) {
      el.insertAdjacentHTML('beforeend', `<div class="stat"><div class="stat-l">${l}</div><div class="stat-v">${v}</div></div>`);
    }
  }

  // =====================================================================
  // BARRA DE PROGRESO
  // =====================================================================
  function renderProgressMarks() {
    const el = $('progMarks'); el.innerHTML = '';
    const lc = state.lc; if (!lc) return;
    const t0 = lc.c1.date.getTime(), t1 = lc.c4.date.getTime(), span = t1 - t0;
    const marks = [['C1', lc.c1], ['MÁX', lc.max], ['C4', lc.c4]];
    if (lc.c2) marks.splice(1, 0, ['C2', lc.c2]);
    if (lc.c3) marks.splice(3, 0, ['C3', lc.c3]);

    // Si la totalidad es corta, C2/MÁX/C3 se solapan: dejamos solo el máximo
    const pctOf = ev => ((ev.date.getTime() - t0) / span) * 100;
    const crowded = lc.c2 && lc.c3 && (pctOf(lc.c3) - pctOf(lc.c2)) < 9;
    const visibles = crowded ? marks.filter(m => m[0] !== 'C2' && m[0] !== 'C3') : marks;

    for (const [n, ev] of visibles) {
      const pos = Math.min(94, Math.max(6, pctOf(ev)));
      const label = crowded && n === 'MÁX' ? T('mark.totality') : n;
      el.insertAdjacentHTML('beforeend',
        `<div class="pmark" style="left:${pos}%" data-ts="${ev.date.getTime()}"><b>${label}</b>${fmtHM(ev.date)}</div>`);
    }
    if (lc.c2 && lc.c3) {
      const a = ((lc.c2.date - t0) / span) * 100, b = ((lc.c3.date - t0) / span) * 100;
      const pt = $('progTot');
      pt.classList.remove('hidden');
      pt.style.left = a + '%';
      pt.style.width = Math.max(0.8, b - a) + '%';
    } else {
      $('progTot').classList.add('hidden');
    }
  }

  function updateProgress(t) {
    const lc = state.lc; if (!lc) return;
    const t0 = lc.c1.date.getTime(), t1 = lc.c4.date.getTime();
    const pct = Math.max(0, Math.min(100, ((t.getTime() - t0) / (t1 - t0)) * 100));
    $('progFill').style.width = pct + '%';
    document.querySelectorAll('.pmark').forEach(m => {
      m.classList.toggle('passed', t.getTime() >= +m.dataset.ts);
    });
  }

  // =====================================================================
  // CUENTA ATRÁS
  // =====================================================================
  function updateCountdown(t) {
    const lc = state.lc;
    if (!lc) { $('cdLabel').textContent = T('cd.notVisible'); return; }

    const targets = [
      [lc.c1.date, T('cd.c1')],
      lc.c2 ? [lc.c2.date, T('cd.c2')] : null,
      [lc.max.date, T('cd.max')],
      lc.c3 ? [lc.c3.date, T('cd.c3')] : null,
      [lc.c4.date, T('cd.c4')]
    ].filter(Boolean);

    let target = null, label = '';
    for (const [d, l] of targets) { if (t < d) { target = d; label = l; break; } }

    if (!target) {
      $('cdLabel').textContent = T('cd.done');
      ['cdD', 'cdH', 'cdM', 'cdS'].forEach(i => $(i).textContent = '0');
      $('countdown').classList.remove('urgent');
      return;
    }

    let s = Math.max(0, (target - t) / 1000);
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;

    $('cdLabel').textContent = label;
    $('cdD').textContent = d;
    $('cdH').textContent = pad(h);
    $('cdM').textContent = pad(m);
    $('cdS').textContent = pad(Math.floor(s));
    $('countdown').classList.toggle('urgent', (target - t) < 5 * 60000);

    checkAlarms(t, lc);
  }

  // =====================================================================
  // ALARMAS (vibración + notificación)
  // =====================================================================
  function checkAlarms(t, lc) {
    if (!state.live) return;
    const fire = (key, title, body, pattern) => {
      if (state.notified[key]) return;
      state.notified[key] = true;
      if (navigator.vibrate) navigator.vibrate(pattern || [200, 100, 200]);
      if ('Notification' in window && Notification.permission === 'granted') {
        try { new Notification(title, { body, icon: 'icons/icon-192.png' }); } catch (e) {}
      }
    };
    const secTo = d => (d - t) / 1000;
    if (lc.c1 && Math.abs(secTo(lc.c1.date)) < 30) fire('c1', T('notif.c1'), T('notif.c1b'));
    if (lc.c2) {
      if (secTo(lc.c2.date) > 0 && secTo(lc.c2.date) < 60) fire('c2pre', T('notif.c2pre'), T('notif.c2preb'), [300, 150, 300, 150, 300]);
      if (Math.abs(secTo(lc.c2.date)) < 20) fire('c2', T('notif.c2'), T('notif.c2b'), [500, 200, 500]);
    }
    if (lc.c3) {
      if (secTo(lc.c3.date) > 0 && secTo(lc.c3.date) < 15) fire('c3pre', T('notif.c3'), T('notif.c3b'), [500, 100, 500, 100, 500]);
    }
    if (lc.c4 && Math.abs(secTo(lc.c4.date)) < 30) fire('c4', T('notif.c4'), T('notif.c4b'));
  }

  // =====================================================================
  // SIMULACIÓN DEL DISCO
  // =====================================================================
  function drawSim(t) {
    const c = $('simCanvas'), g = c.getContext('2d');
    const W = c.width, H = c.height, cx = W / 2, cy = H / 2;
    const st = Eclipse.stateAt(t, state.lat, state.lon, state.height);
    const R = W * 0.19;                                  // radio solar en píxeles

    // Fondo del cielo, oscureciéndose con la obscuración
    const dark = Math.pow(Math.max(0, st.obscuration), 3);
    const skyTop = `rgb(${Math.round(12 + 30 * (1 - dark))},${Math.round(16 + 34 * (1 - dark))},${Math.round(40 + 60 * (1 - dark))})`;
    const grad = g.createRadialGradient(cx, cy, R * 0.5, cx, cy, W * 0.7);
    grad.addColorStop(0, dark > 0.985 ? '#05060d' : skyTop);
    grad.addColorStop(1, '#04050b');
    g.fillStyle = grad; g.fillRect(0, 0, W, H);

    // Estrellas si está muy oscuro
    if (dark > 0.97) {
      g.save(); g.globalAlpha = Math.min(1, (dark - 0.97) / 0.03);
      for (let i = 0; i < 90; i++) {
        const a = (i * 2.399), r = (i % 17) / 17 * W * 0.48 + 40;
        g.fillStyle = '#fff';
        g.beginPath(); g.arc(cx + Math.cos(a) * r * 1.3, cy + Math.sin(a * 1.7) * r, (i % 3) * .6 + .5, 0, 7); g.fill();
      }
      g.restore();
    }

    const totalNow = st.phase === 'total';

    // Corona durante la totalidad
    if (totalNow) {
      g.save();
      for (let i = 0; i < 3; i++) {
        const cg = g.createRadialGradient(cx, cy, R, cx, cy, R * (1.8 + i * 1.2));
        cg.addColorStop(0, `rgba(255,240,210,${0.34 - i * 0.09})`);
        cg.addColorStop(0.4, `rgba(255,215,170,${0.14 - i * 0.04})`);
        cg.addColorStop(1, 'rgba(255,200,150,0)');
        g.fillStyle = cg; g.beginPath(); g.arc(cx, cy, R * (1.8 + i * 1.2), 0, 7); g.fill();
      }
      // Serpentinas de la corona
      g.globalAlpha = .5;
      for (let i = 0; i < 40; i++) {
        const a = i / 40 * Math.PI * 2 + 0.3;
        const len = R * (1.4 + 1.6 * Math.abs(Math.sin(i * 2.7)));
        g.strokeStyle = 'rgba(255,236,205,.35)'; g.lineWidth = 1.4;
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * R * 1.02, cy + Math.sin(a) * R * 1.02);
        g.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
        g.stroke();
      }
      g.restore();
    } else {
      // Resplandor normal
      const gl = g.createRadialGradient(cx, cy, R * .9, cx, cy, R * 2.4);
      gl.addColorStop(0, `rgba(255,200,110,${.30 * (1 - dark)})`);
      gl.addColorStop(1, 'rgba(255,180,80,0)');
      g.fillStyle = gl; g.beginPath(); g.arc(cx, cy, R * 2.4, 0, 7); g.fill();
    }

    // Disco solar
    const sg = g.createRadialGradient(cx - R * .2, cy - R * .2, R * .1, cx, cy, R);
    sg.addColorStop(0, '#fffdf2'); sg.addColorStop(.7, '#ffdf8a'); sg.addColorStop(1, '#ff9d2e');
    g.fillStyle = sg;
    g.beginPath(); g.arc(cx, cy, R, 0, 7); g.fill();

    // Disco lunar. Orientación estándar del cielo: Norte arriba, ESTE a la IZQUIERDA.
    const mr = R * st.moonOverSun;
    const mx = cx - st.offsetE * R, my = cy - st.offsetN * R;
    if (st.magnitude > 0) {
      g.fillStyle = totalNow ? '#000' : '#0b0c14';
      g.beginPath(); g.arc(mx, my, mr, 0, 7); g.fill();
    }

    // Anillo de diamante justo antes / después de la totalidad
    if (st.magnitude > 0.99 && !totalNow) {
      const ang = Math.atan2(my - cy, mx - cx) + Math.PI;   // limbo opuesto a la Luna
      const dx = cx + Math.cos(ang) * R, dy = cy + Math.sin(ang) * R;
      const dg = g.createRadialGradient(dx, dy, 0, dx, dy, R * .5);
      dg.addColorStop(0, 'rgba(255,255,255,1)'); dg.addColorStop(.2, 'rgba(255,244,205,.8)');
      dg.addColorStop(1, 'rgba(255,220,150,0)');
      g.fillStyle = dg; g.beginPath(); g.arc(dx, dy, R * .5, 0, 7); g.fill();
    }

    // Etiquetas (orientación del cielo)
    g.fillStyle = 'rgba(255,255,255,.35)';
    g.font = `600 ${Math.round(W * 0.028)}px -apple-system, sans-serif`;
    g.textAlign = 'center';
    g.fillText('N', cx, cy - R * 2.9);
    g.fillText('S', cx, cy + R * 3.05);
    g.textAlign = 'right'; g.fillText('E', cx - R * 2.75, cy + 5);
    g.textAlign = 'left';  g.fillText('O', cx + R * 2.75, cy + 5);

    // Lecturas
    const before = state.lc && t < state.lc.c1.date;
    $('roMag').textContent = st.outOfRange ? '—' : st.magnitude.toFixed(3);
    $('roObs').textContent = st.outOfRange ? '—' : (st.obscuration * 100).toFixed(1) + ' %';
    $('roPhase').textContent = st.phase === 'total' ? T('ro.total')
      : st.phase === 'partial' ? T('ro.partial')
      : before ? T('ro.before') : T('ro.after');
  }

  // =====================================================================
  // BRÚJULA / POSICIÓN DEL SOL
  // =====================================================================
  function drawCompass(t) {
    const c = $('compass'), g = c.getContext('2d');
    const W = c.width, cx = W / 2, cy = W / 2, R = W * 0.42;
    g.clearRect(0, 0, W, W);

    const sun = Astro.sunAltAz(t, state.lat, state.lon);

    // Anillo
    g.strokeStyle = 'rgba(255,255,255,.16)'; g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cy, R, 0, 7); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.07)';
    g.beginPath(); g.arc(cx, cy, R * .6, 0, 7); g.stroke();
    g.beginPath(); g.arc(cx, cy, R * .3, 0, 7); g.stroke();

    // Marcas cardinales
    g.font = `700 ${Math.round(W * .075)}px -apple-system, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const DIRS = I18N.t('dir');
    [[DIRS[0], 0], [DIRS[4], 90], [DIRS[8], 180], [DIRS[12], 270]].forEach(([n, a], i) => {
      const rr = R * 1.14, rad = (a - 90) * Math.PI / 180;
      g.fillStyle = i === 0 ? '#ff5f6d' : 'rgba(255,255,255,.55)';
      g.fillText(n, cx + Math.cos(rad) * rr, cy + Math.sin(rad) * rr);
    });
    for (let a = 0; a < 360; a += 15) {
      const rad = (a - 90) * Math.PI / 180, big = a % 45 === 0;
      g.strokeStyle = `rgba(255,255,255,${big ? .3 : .13})`; g.lineWidth = big ? 2 : 1;
      g.beginPath();
      g.moveTo(cx + Math.cos(rad) * R, cy + Math.sin(rad) * R);
      g.lineTo(cx + Math.cos(rad) * R * (big ? .88 : .93), cy + Math.sin(rad) * R * (big ? .88 : .93));
      g.stroke();
    }

    // Trayectoria del Sol durante el eclipse
    const lc = state.lc;
    if (lc) {
      g.beginPath(); let started = false;
      for (let k = 0; k <= 60; k++) {
        const d = new Date(lc.c1.date.getTime() + (lc.c4.date - lc.c1.date) * k / 60);
        const s = Astro.sunAltAz(d, state.lat, state.lon);
        const rr = R * (1 - Math.max(0, Math.min(90, s.alt)) / 90);
        const rad = (s.az - 90) * Math.PI / 180;
        const px = cx + Math.cos(rad) * rr, py = cy + Math.sin(rad) * rr;
        started ? g.lineTo(px, py) : (g.moveTo(px, py), started = true);
      }
      g.strokeStyle = 'rgba(255,171,61,.75)'; g.lineWidth = 3; g.stroke();

      // Punto del máximo
      const sm = Astro.sunAltAz(lc.max.date, state.lat, state.lon);
      const rr = R * (1 - Math.max(0, sm.alt) / 90), rad = (sm.az - 90) * Math.PI / 180;
      g.fillStyle = '#fff'; g.beginPath();
      g.arc(cx + Math.cos(rad) * rr, cy + Math.sin(rad) * rr, 4.5, 0, 7); g.fill();
    }

    // Sol actual
    const rr = R * (1 - Math.max(-10, Math.min(90, sun.alt)) / 90);
    const rad = (sun.az - 90) * Math.PI / 180;
    const sx = cx + Math.cos(rad) * rr, sy = cy + Math.sin(rad) * rr;
    const gl = g.createRadialGradient(sx, sy, 0, sx, sy, 18);
    gl.addColorStop(0, 'rgba(255,220,120,.95)'); gl.addColorStop(1, 'rgba(255,180,60,0)');
    g.fillStyle = gl; g.beginPath(); g.arc(sx, sy, 18, 0, 7); g.fill();
    g.fillStyle = sun.alt > 0 ? '#ffd27d' : '#7a6a8f';
    g.beginPath(); g.arc(sx, sy, 6, 0, 7); g.fill();

    // Centro
    g.fillStyle = 'rgba(255,255,255,.3)';
    g.beginPath(); g.arc(cx, cy, 2.5, 0, 7); g.fill();

    // Panel de datos
    $('sunAz').textContent = sun.az.toFixed(1) + '°';
    $('sunAlt').textContent = sun.altRefracted.toFixed(1) + '°';
    $('sunDir').textContent = cardinal(sun.az) + (sun.alt <= 0 ? ' ' + T('sun.below') : '');
  }

  // =====================================================================
  // MAPA
  // =====================================================================
  let pathCache = null;
  function buildPath() {
    if (pathCache) return pathCache;
    const limits = Eclipse.totalityLimits(1.5);
    pathCache = limits;
    return limits;
  }

  function updateMap() {
    const near = Eclipse.nearestCentralPoint(state.lat, state.lon);
    $('mapNote').innerHTML = near
      ? T('map.note', {
          km: Math.round(near.distanceKm), dir: cardinal(near.bearing),
          lat: near.point.lat.toFixed(2), lon: near.point.lon.toFixed(2)
        })
      : T('map.noteSimple');

    if (typeof L === 'undefined') { $('map').innerHTML = `<div style="padding:20px" class="muted">${T('map.offline')}</div>`; return; }
    if (!state.map) {
      state.map = L.map('map', { zoomControl: true, attributionControl: false })
        .setView([state.lat, state.lon], 5);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 12, subdomains: 'abcd'
      }).addTo(state.map);

      const lim = buildPath();
      const band = lim.north.concat(lim.south.slice().reverse()).map(p => [p.lat, p.lon]);
      L.polygon(band, { color: '#ffab3d', weight: 1, fillColor: '#ffab3d', fillOpacity: .22 }).addTo(state.map);
      L.polyline(lim.centre.map(p => [p.lat, p.lon]), { color: '#ffab3d', weight: 2.5, dashArray: '6 5' }).addTo(state.map);

      // Etiquetas horarias sobre la línea central
      lim.centre.forEach((p, i) => {
        if (i % 6 !== 0) return;
        L.marker([p.lat, p.lon], {
          icon: L.divIcon({
            className: '', html: `<div style="font-size:10px;color:#ffd27d;text-shadow:0 0 4px #000;white-space:nowrap;transform:translate(-50%,-50%)">${fmtHM(p.date)}</div>`
          })
        }).addTo(state.map);
      });
      state.map.on('click', e => setLocation(e.latlng.lat, e.latlng.lng, 0, T('app.mapPoint'), 'app.mapPoint'));
    }

    if (state.mapLayers.me) state.map.removeLayer(state.mapLayers.me);
    state.mapLayers.me = L.circleMarker([state.lat, state.lon], {
      radius: 8, color: '#4fd6ff', weight: 3, fillColor: '#4fd6ff', fillOpacity: .55
    }).addTo(state.map).bindPopup(state.label);
    state.map.setView([state.lat, state.lon], Math.max(state.map.getZoom(), 5));
  }

  // =====================================================================
  // CIUDADES
  // =====================================================================
  function renderCities() {
    const el = $('cities'); el.innerHTML = '';
    for (const c of CITIES) {
      const lc = Eclipse.localCircumstances(c.lat, c.lon, c.h);
      const total = lc && lc.type === 'total';
      const active = Math.abs(c.lat - state.lat) < 1e-4 && Math.abs(c.lon - state.lon) < 1e-4;
      const b = document.createElement('button');
      b.className = 'city-btn' + (total ? ' total' : '') + (active ? ' active' : '');
      b.textContent = c.n + (total ? ` · ${fmtDur(lc.totalityDuration)}` : '');
      b.onclick = () => setLocation(c.lat, c.lon, c.h, c.n);
      el.appendChild(b);
    }
  }

  /** @param {string} [labelKey] clave i18n, si la etiqueta es texto de la app */
  function setLocation(lat, lon, h, label, labelKey) {
    state.lat = lat; state.lon = lon; state.height = h || 0;
    state.label = label || T('app.myLocation');
    state.labelKey = labelKey || null;
    state.notified = {};
    try {
      localStorage.setItem('eclipse-loc', JSON.stringify({
        lat, lon, h: state.height, label: state.label, labelKey: state.labelKey
      }));
    } catch (e) {}
    recompute();
  }
  window.__setLocation = setLocation;

  // =====================================================================
  // BUCLE PRINCIPAL
  // =====================================================================
  function tick() {
    // Mientras el modo AR está abierto, la página de debajo no se ve: pararla
    // libera CPU para que la superposición vaya a 60 fps sin tirones.
    if (window.AR && AR.isActive()) return;
    const t = now();
    updateCountdown(t);
    updateProgress(t);
    drawSim(t);
    drawCompass(t);
  }

  // =====================================================================
  // CURSOR TEMPORAL
  // =====================================================================
  function setScrubRange() {
    const lc = state.lc; if (!lc) return;
    const s = $('scrub');
    s.min = -100; s.max = 100; s.step = .05;
  }
  $('scrub').addEventListener('input', e => {
    const v = +e.target.value;
    const lc = state.lc; if (!lc) return;
    // Mapeo no lineal: el centro del recorrido cubre el eclipse completo
    const centre = lc.max.date.getTime();
    const half = (lc.c4.date - lc.c1.date) / 2 * 1.15;
    const target = centre + (v / 100) * half;
    state.offsetMs = target - Date.now();
    state.live = false;
    $('scrubTime').textContent = fmtTime(new Date(target));
    tick();
  });
  $('scrubReset').onclick = () => {
    state.offsetMs = 0; state.live = true;
    $('scrub').value = 0; $('scrubTime').textContent = T('scrub.live');
    tick();
  };

  // =====================================================================
  // GEOLOCALIZACIÓN
  // =====================================================================
  /**
   * Pide la ubicación al navegador.
   * @param {boolean} silent en el arranque automático no molestamos con
   *        alertas si el usuario deniega el permiso o no hay señal.
   */
  function requestGeo(silent) {
    if (!navigator.geolocation) {
      if (!silent) alert(T('app.geoUnsupported'));
      return;
    }
    $('geoLabel').innerHTML = `<span class="spinner"></span> ${T('app.geoLocating')}`;
    navigator.geolocation.getCurrentPosition(
      p => {
        state.usingGeo = true;
        $('geoLabel').textContent = T('app.geoActive');
        setLocation(p.coords.latitude, p.coords.longitude, p.coords.altitude || 0,
                    T('app.myLocation'), 'app.myLocation');
      },
      err => {
        $('geoLabel').textContent = T('app.geo');
        if (!silent) alert(T('app.geoError') + err.message + '\n\n' + T('app.geoHttps'));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  }

  $('btnGeo').onclick = () => requestGeo(false);

  /**
   * Arranque: intentamos el GPS solo, sin esperar a que el usuario lo pida.
   * Si el permiso ya está denegado no volvemos a preguntar (evita el aviso
   * del navegador en cada visita); si aún no se ha decidido, sí preguntamos.
   */
  function autoGeo() {
    if (!navigator.geolocation) return;
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'geolocation' })
        .then(st => { if (st.state !== 'denied') requestGeo(true); })
        .catch(() => requestGeo(true));
    } else {
      requestGeo(true);
    }
  }

  // =====================================================================
  // HERRAMIENTAS
  // =====================================================================
  $('btnICS').onclick = () => {
    const lc = state.lc; if (!lc) return;
    const z = d => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const ev = (uid, title, d, desc) =>
      `BEGIN:VEVENT\r\nUID:${uid}@eclipse2026\r\nDTSTAMP:${z(new Date())}\r\nDTSTART:${z(d)}\r\nDTEND:${z(new Date(+d + 300000))}\r\nSUMMARY:${title}\r\nDESCRIPTION:${desc}\r\nBEGIN:VALARM\r\nTRIGGER:-PT15M\r\nACTION:DISPLAY\r\nDESCRIPTION:${title}\r\nEND:VALARM\r\nEND:VEVENT\r\n`;
    let ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Eclipse AR 2026//EU\r\nCALSCALE:GREGORIAN\r\n';
    ics += ev('c1', T('ics.c1'), lc.c1.date, T('ics.c1d', { place: state.label }));
    if (lc.c2) ics += ev('c2', T('ics.c2'), lc.c2.date, T('ics.c2d', { dur: fmtDur(lc.totalityDuration) }));
    ics += ev('max', T('ics.max'), lc.max.date, T('ics.maxd', {
      mag: lc.magnitude.toFixed(3), pct: (lc.obscuration * 100).toFixed(1)
    }));
    ics += ev('c4', T('ics.c4'), lc.c4.date, T('ics.c4d'));
    ics += 'END:VCALENDAR\r\n';
    const blob = new Blob([ics], { type: 'text/calendar' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `eclipse-2026-${state.label.replace(/\s+/g, '-').toLowerCase()}.ics`;
    a.click();
  };

  $('btnNotify').onclick = async () => {
    if (!('Notification' in window)) { alert(T('tools.notifyUnsupported')); return; }
    const p = await Notification.requestPermission();
    if (p === 'granted') {
      new Notification(T('tools.notifyOn'), { body: T('tools.notifyOnBody'), icon: 'icons/icon-192.png' });
    }
  };

  $('btnShare').onclick = async () => {
    const lc = state.lc;
    const txt = lc && lc.type === 'total'
      ? T('share.total', { place: state.label, time: fmtTime(lc.c2.date), dur: fmtDur(lc.totalityDuration) })
      : T('share.other', { place: state.label });
    if (navigator.share) { try { await navigator.share({ title: 'Eclipse AR 2026', text: txt, url: location.href }); } catch (e) {} }
    else { try { await navigator.clipboard.writeText(txt + ' ' + location.href); alert(T('tools.copied')); } catch (e) {} }
  };

  addEventListener('beforeinstallprompt', e => { e.preventDefault(); state.deferredInstall = e; });
  $('btnInstall').onclick = async () => {
    if (state.deferredInstall) { state.deferredInstall.prompt(); state.deferredInstall = null; }
    else alert(T('tools.installHelp'));
  };

  $('btnTop').onclick = () => scrollTo({ top: 0, behavior: 'smooth' });
  $('btnAR').onclick = () => AR.open(state);
  $('arClose').onclick = () => AR.close();

  // =====================================================================
  // ARRANQUE
  // =====================================================================
  // --- Selector de idioma ---
  document.querySelectorAll('.lang-btn').forEach(b => {
    b.addEventListener('click', () => I18N.setLang(b.dataset.lang));
  });

  I18N.onChange(() => {
    // Las etiquetas guardadas que puso la propia app se retraducen; los
    // nombres de ciudad y los puntos del mapa se quedan como están.
    if (state.labelKey) state.label = T(state.labelKey);
    recompute();
    refreshSunset();
  });

  I18N.applyStatic();

  try {
    const saved = JSON.parse(localStorage.getItem('eclipse-loc') || 'null');
    if (saved) {
      state.lat = saved.lat; state.lon = saved.lon;
      state.height = saved.h; state.label = saved.label;
      state.labelKey = saved.labelKey || null;
    }
  } catch (e) {}

  recompute();
  refreshSunset();
  autoGeo();

  setInterval(tick, 1000);
  setInterval(() => { if (state.live) refreshSunset(); }, 600000);

  // Service worker
  if ('serviceWorker' in navigator) {
    addEventListener('load', () => {
      navigator.serviceWorker
        .register('sw.js', { updateViaCache: 'none' })
        .then(reg => reg.update().catch(() => {}))
        .catch(() => {});
    });
  }
})();
