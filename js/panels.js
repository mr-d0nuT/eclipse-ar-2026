/* =========================================================================
   panels.js — Pestañas, pronóstico, nubes, horizonte y planificador

   Todo lo que necesita de la app va por EclipseApp (estado, formateadores y
   cambio de ubicación). Así app.js sigue siendo el dueño del estado y esto
   solo pinta y pregunta.
   ========================================================================= */
(function (global) {
  'use strict';

  const $ = id => document.getElementById(id);
  const T = (k, p) => I18N.t(k, p);
  const App = () => global.EclipseApp;

  // Datos descargados para la ubicación actual
  let data = { key: null, horizon: null, analysis: null, weather: null, summary: null, clima: null };
  let busy = { verdict: false, horizon: false, weather: false, clima: false, plan: false };
  // Una sola búsqueda, de 0 a 25 km, partida en «al lado» y «más lejos»
  const RANGE = { min: 0, max: 25, nearKm: 1 };
  let planState = { results: null, heatLayer: null, doneFor: null };

  /* Reintento automático. Cuando la API gratuita corta por cuota, la espera es
     de un minuto: pedirle al usuario que vuelva a darle a un botón que ya no
     existe sería absurdo. Se reintenta solo, con la cuenta atrás a la vista. */
  let retryTimer = null;
  function retryIn(seconds, fn, el) {
    clearTimeout(retryTimer);
    let left = Math.max(1, seconds);
    (function tick() {
      if (left <= 0) { if (el) el.textContent = ''; fn(); return; }
      if (el) el.innerHTML = T('pl.retrying', { s: left });
      left--;
      retryTimer = setTimeout(tick, 1000);
    })();
  }

  const locKey = s => s.lat.toFixed(3) + ',' + s.lon.toFixed(3);
  const num = (v, d) => (v == null || !isFinite(v)) ? '—' : v.toFixed(d == null ? 1 : d);

  /** Mensaje de un fallo, distinguiendo «sin cuota» de «sin red» */
  const failMsg = (e, fallbackKey) =>
    (e && e.rate) ? T('net.rate', { s: e.retryAfter }) : T(fallbackKey);

  // =====================================================================
  // PESTAÑAS
  // =====================================================================
  const TABS = ['now', 'plan', 'sky'];

  function setTab(name) {
    if (TABS.indexOf(name) < 0) name = 'now';
    for (const t of TABS) {
      const pane = $('pane-' + t);
      if (pane) pane.classList.toggle('on', t === name);
    }
    document.querySelectorAll('.tabbtn[data-pane]').forEach(b => {
      const on = b.dataset.pane === name;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
    document.body.classList.remove('tab-now', 'tab-plan', 'tab-sky');
    document.body.classList.add('tab-' + name);
    try { localStorage.setItem('eclipse-tab', name); } catch (e) {}
    scrollTo({ top: 0 });

    // Leaflet mide el contenedor al crearlo, y al crearse estaba oculto:
    // sin esto el mapa sale en blanco la primera vez que se abre la pestaña.
    if (name === 'plan') {
      const m = App() && App().state.map;
      if (m) setTimeout(() => m.invalidateSize(), 60);
      if (App()) { refreshNearby(); autoPlan(); }
    }
    if (name === 'now' && data.analysis) drawHorizonChart();
  }

  document.querySelectorAll('.tabbtn[data-pane]').forEach(b => {
    b.addEventListener('click', () => setTab(b.dataset.pane));
  });

  // =====================================================================
  // LIENZOS NÍTIDOS
  // =====================================================================
  /** Ajusta un canvas a su tamaño real en pantalla y devuelve el contexto */
  function fitCanvas(cv, cssH) {
    const cssW = cv.clientWidth || cv.parentNode.clientWidth || 320;
    const dpr = Math.min(devicePixelRatio || 1, 2.5);
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    cv.style.height = cssH + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w: cssW, h: cssH };
  }

  // =====================================================================
  // GRÁFICA DEL HORIZONTE
  // =====================================================================
  /* La pieza visual de todo esto: la silueta del terreno con el recorrido
     real del Sol dibujado encima. De un vistazo se ve si el monte se lo come,
     y a qué hora. */
  function drawHorizonChart() {
    const cv = $('hzCanvas');
    const st = App() && App().state;
    if (!cv || !data.horizon || !st || !st.lc) return;

    const wrap = $('hzWrap');
    if (wrap) wrap.classList.remove('hidden');

    const cssW = cv.clientWidth || 320;
    const { g, w, h } = fitCanvas(cv, Math.round(Math.min(300, Math.max(190, cssW * 0.62))));

    const padL = 34, padR = 12, padT = 14, padB = 26;
    const plotW = w - padL - padR, plotH = h - padT - padB;

    const fan = Horizon.fanOf(data.horizon);
    const AZ0 = fan.from, AZ1 = fan.to;
    const track = Horizon.sunTrack(st.lc, st.lat, st.lon, 140);

    // Escala vertical: que quepan el Sol y el terreno, con un mínimo digno
    let altMax = 6;
    for (const p of track) if (p.az >= AZ0 && p.az <= AZ1) altMax = Math.max(altMax, p.alt);
    for (const r of data.horizon.rays) altMax = Math.max(altMax, r.horizon);
    altMax = Math.ceil((altMax + 1) / 2) * 2;

    const X = az => padL + (az - AZ0) / (AZ1 - AZ0) * plotW;
    /* Raíz cuadrada, no lineal. Todo lo que importa pasa entre 0° y 5°: con
       escala lineal y un C1 a 20° de altura, la franja decisiva quedaba
       aplastada en cuatro píxeles contra el suelo. */
    const Y = alt => padT + (1 - Math.sqrt(Math.max(0, alt) / altMax)) * plotH;

    g.clearRect(0, 0, w, h);

    // --- Rejilla ---
    g.font = '600 10px -apple-system, sans-serif';
    g.textAlign = 'right'; g.textBaseline = 'middle';
    const ticks = [0, 1, 2, 3, 5, 8, 12, 18, 25, 35].filter(a => a <= altMax);
    for (const a of ticks) {
      const y = Y(a);
      g.strokeStyle = a === 0 ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.08)';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(padL, y); g.lineTo(w - padR, y); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.42)';
      g.fillText(a + '°', padL - 6, y);
    }
    g.textAlign = 'center'; g.textBaseline = 'top';
    const azStep = (AZ1 - AZ0) > 26 ? 8 : 6;
    for (let az = AZ0; az <= AZ1; az += azStep) {
      const x = X(az);
      g.strokeStyle = 'rgba(255,255,255,.07)';
      g.beginPath(); g.moveTo(x, padT); g.lineTo(x, padT + plotH); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.42)';
      g.fillText(az + '°', x, padT + plotH + 7);
    }

    // --- Silueta del terreno ---
    g.beginPath();
    g.moveTo(X(AZ0), Y(0));
    for (let az = AZ0; az <= AZ1; az += 0.5) g.lineTo(X(az), Y(Horizon.horizonAt(data.horizon, az)));
    g.lineTo(X(AZ1), Y(0));
    g.closePath();
    const tg = g.createLinearGradient(0, padT, 0, padT + plotH);
    tg.addColorStop(0, 'rgba(107,122,153,.75)');
    tg.addColorStop(1, 'rgba(60,70,95,.95)');
    g.fillStyle = tg; g.fill();
    g.strokeStyle = '#8a9ab8'; g.lineWidth = 1.5;
    g.beginPath();
    for (let az = AZ0, first = true; az <= AZ1; az += 0.5, first = false) {
      const x = X(az), y = Y(Horizon.horizonAt(data.horizon, az));
      first ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();

    // --- Recorrido del Sol ---
    g.strokeStyle = 'rgba(255,171,61,.9)'; g.lineWidth = 2.5;
    g.beginPath();
    let started = false;
    for (const p of track) {
      if (p.az < AZ0 || p.az > AZ1 || p.alt < 0) { started = false; continue; }
      const x = X(p.az), y = Y(p.alt);
      started ? g.lineTo(x, y) : (g.moveTo(x, y), started = true);
    }
    g.stroke();

    // --- Hitos ---
    const lc = st.lc;
    // C2, C3 y el máximo caen a segundos unos de otros: en pantalla son el
    // mismo píxel. Se dibujan todos los puntos, pero la etiqueta se la queda
    // el hito más importante de cada grupo.
    const PRIO = { MAX: 0, C2: 1, C3: 2, C1: 3, C4: 4 };
    const marks = [['C1', lc.c1], ['C2', lc.c2], ['MAX', lc.max], ['C3', lc.c3], ['C4', lc.c4]]
      .filter(m => m[1]).sort((a, b) => PRIO[a[0]] - PRIO[b[0]]);
    g.font = '700 10px -apple-system, sans-serif';
    const placed = [];
    for (const [name, ev] of marks) {
      const s = Astro.sunAltAz(ev.date, st.lat, st.lon);
      if (s.az < AZ0 || s.az > AZ1 || s.altRefracted < 0) continue;
      const x = X(s.az), y = Y(s.altRefracted);
      const big = name === 'MAX' || name === 'C2';
      g.fillStyle = big ? '#fff' : '#ffd27d';
      g.beginPath(); g.arc(x, y, big ? 4.5 : 3, 0, 7); g.fill();
      if (placed.some(q => Math.abs(q - x) < 30)) continue;
      placed.push(x);
      g.textAlign = 'center'; g.textBaseline = 'bottom';
      g.strokeStyle = 'rgba(0,0,0,.75)'; g.lineWidth = 3;
      g.strokeText(name, x, y - 7); g.fillText(name, x, y - 7);
    }

    // --- Punto donde el relieve se lo traga ---
    const an = data.analysis;
    if (an && an.blocked && an.blocked.az >= AZ0 && an.blocked.az <= AZ1) {
      const x = X(an.blocked.az), y = Y(an.blocked.alt);
      g.strokeStyle = '#ff5f6d'; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, 7, 0, 7); g.stroke();
      g.beginPath(); g.moveTo(x, y); g.lineTo(x, padT + plotH); g.stroke();
    }
  }

  // =====================================================================
  // HORIZONTE
  // =====================================================================
  function renderHorizon() {
    const body = $('hzBody'), btn = $('btnHorizon');
    const st = App() && App().state;
    if (!body || !st) return;
    const an = data.analysis;

    if (!an) {
      body.innerHTML = '';
      if (btn) { btn.textContent = T(busy.horizon ? 'hz.calculating' : 'hz.calc'); btn.disabled = busy.horizon; }
      const wrap = $('hzWrap'); if (wrap) wrap.classList.add('hidden');
      return;
    }

    const F = App();
    const label = an.verdict === 'clear' ? T('hz.clear') : an.verdict === 'tight' ? T('hz.tight') : T('hz.blocked');
    const key = an.margin > 0 ? 'hz.summary' : 'hz.summaryBad';
    const lines = [T(key, {
      az: num(an.azAtMax, 0), hz: num(an.horizonAtMax, 2),
      alt: num(an.sunAltAtMax, 1), margin: num(an.margin, 1)
    })];
    if (an.totalityVisible === true) lines.push(T('hz.totalityOk'));
    if (an.totalityVisible === false) lines.push(T('hz.totalityBad'));
    lines.push(an.blocked ? T('hz.hides', { time: F.fmtTime(an.blocked.date) }) : T('hz.hidesOk'));
    if (an.obsElev != null) lines.push(T('hz.elev', { m: Math.round(an.obsElev) }));

    body.innerHTML =
      `<div class="hz-verdict ${an.verdict}"><span class="dotbig"></span>${label}</div>` +
      `<div class="hz-lines">${lines.join('<br>')}</div>`;

    if (btn) { btn.textContent = T('vd.recalc'); btn.disabled = false; }
    drawHorizonChart();
  }

  async function loadHorizon() {
    const st = App().state;
    if (busy.horizon || !st.lc) return;
    busy.horizon = true;
    renderHorizon();
    const btn = $('btnHorizon');
    if (btn) { btn.textContent = T('hz.calculating'); btn.disabled = true; }

    let prof = null, err = null;
    try { prof = await Horizon.profile(st.lat, st.lon, st.lc); }
    catch (e) { err = e; }
    busy.horizon = false;

    if (!prof) {
      const body = $('hzBody');
      if (body) body.innerHTML = `<div class="hz-lines">${failMsg(err, 'hz.fail')}</div>`;
      if (btn) { btn.textContent = T('hz.calc'); btn.disabled = false; }
      return;
    }
    data.horizon = prof;
    data.analysis = Horizon.analyse(prof, st.lc, st.lat, st.lon);
    renderHorizon();
    renderVerdict();
  }

  // =====================================================================
  // NUBES
  // =====================================================================
  function renderWeather() {
    const body = $('wxBody'), btn = $('btnWeather');
    const st = App() && App().state;
    if (!body || !st) return;
    const sm = data.summary;

    if (!sm) {
      const days = Weather.daysToEclipse();
      body.innerHTML = days > 16
        ? `<div class="hz-lines">${T('wx.notYet', { days: Math.ceil(days) })}</div>` : '';
      if (btn) {
        btn.textContent = T(busy.weather ? 'wx.loading' : 'wx.load');
        btn.disabled = busy.weather || days > 16;
      }
      return;
    }

    const peak = sm.atMax;
    const F = App();
    const rows = sm.window.map(hh => {
      const isPeak = hh.t === peak.t;
      // La hora se compone aquí, con el reloj del dispositivo: los datos
      // vienen en UTC para que la petición no dependa del huso del punto.
      return `<div class="wx-row${isPeak ? ' peak' : ''}">
        <span class="wx-h">${F.fmtHM(new Date(hh.t))}</span>
        <div class="wx-bars">
          <div class="wx-track"><i class="tot" style="width:${hh.total || 0}%"></i></div>
          <div class="wx-track"><i class="lo" style="width:${hh.low || 0}%"></i></div>
        </div>
        <span class="wx-num"><b>${hh.total == null ? '—' : hh.total + ' %'}</b>
          <small>${T('wx.low')} ${hh.low == null ? '—' : hh.low + ' %'}</small></span>
      </div>`;
    }).join('');

    const note = sm.stale
      ? `<div class="muted">${T('wx.stale', { date: new Date(sm.at).toLocaleString(I18N.locale) })}</div>`
      : `<div class="muted">${T('wx.confNote', {
            conf: T('wx.conf.' + sm.confidence), days: Math.max(0, Math.ceil(Weather.daysToEclipse())) })}</div>`;

    body.innerHTML = rows + note;
    if (btn) { btn.textContent = T('vd.recalc'); btn.disabled = false; }
  }

  async function loadWeather() {
    const st = App().state;
    if (busy.weather || !st.lc) return;
    busy.weather = true;
    renderWeather();

    let fc = null, err = null;
    try { fc = await Weather.forecast(st.lat, st.lon); }
    catch (e) { err = e; }
    busy.weather = false;

    if (!fc) {
      const body = $('wxBody');
      if (body) body.innerHTML = `<div class="hz-lines">${failMsg(err, 'wx.fail')}</div>`;
      const btn = $('btnWeather'); if (btn) { btn.textContent = T('wx.load'); btn.disabled = false; }
      return;
    }
    data.weather = fc;
    data.summary = Weather.summarise(fc, st.lc);
    renderWeather();
    renderVerdict();
  }

  async function loadClima() {
    const st = App().state;
    if (busy.clima || !st.lc) return;
    busy.clima = true;
    const btn = $('btnClima'), body = $('climaBody');
    if (btn) { btn.textContent = T('wx.climaLoading'); btn.disabled = true; }

    let cl = null, err = null;
    try { cl = await Weather.climatology(st.lat, st.lon, st.lc.max.date); }
    catch (e) { err = e; }
    busy.clima = false;
    if (btn) { btn.textContent = T('wx.climaBtn'); btn.disabled = false; }

    if (!cl) { if (body) body.innerHTML = `<div class="muted">${failMsg(err, 'wx.climaFail')}</div>`; return; }
    data.clima = cl;
    renderClima();
  }

  function renderClima() {
    const body = $('climaBody');
    const cl = data.clima;
    if (!body) return;
    if (!cl) { body.innerHTML = ''; return; }
    const years = cl.rows.slice().sort((a, b) => b.year - a.year).map(r => {
      const cls = r.total <= 25 ? 'clear' : r.total >= 70 ? 'cloudy' : '';
      return `<span class="clima-y ${cls}">${r.year} · ${r.total} %</span>`;
    }).join('');
    body.innerHTML =
      `<div class="hz-lines" style="margin-top:12px">${T('wx.climaResult', { clear: cl.clearYears, n: cl.n })}<br>` +
      `${T('wx.climaMean', { mean: Math.round(cl.meanCloud) })}</div>` +
      `<div class="clima-years">${years}</div>` +
      `<div class="muted">${T('wx.climaNote')}</div>`;
  }

  // =====================================================================
  // VEREDICTO
  // =====================================================================
  function renderVerdict() {
    const st = App() && App().state;
    if (!st || !$('vdBadge')) return;
    const F = App();
    const lc = st.lc;
    const an = data.analysis, sm = data.summary;

    const head = $('vdHeadline'), badge = $('vdBadge');
    const rowH = $('vdHorizon'), rowC = $('vdClouds');

    if (!lc) {
      badge.className = 'vd-badge bad';
      badge.textContent = T('vd.bad');
      head.innerHTML = T('alert.notVisible', { place: st.label });
      rowH.textContent = '—'; rowC.textContent = '—';
      return;
    }

    const isTotal = lc.type === 'total' && !!lc.c2;
    head.innerHTML =
      (isTotal
        ? T('vd.totalityYes', { dur: F.fmtDur(lc.totalityDuration), time: F.fmtHM(lc.c2.date) })
        : T('vd.totalityNo', { pct: (lc.obscuration * 100).toFixed(1) })) +
      '<br>' + T('vd.sunAt', { alt: num(lc.max.altRefracted, 1), dir: I18N.cardinal(lc.max.az) });

    // --- Horizonte ---
    if (an) {
      const cls = an.verdict === 'clear' ? 'ok' : an.verdict === 'tight' ? 'warn' : 'bad';
      rowH.className = 'vd-v ' + cls;
      rowH.innerHTML = an.verdict === 'blocked'
        ? T('vd.hzBlocked', { hz: num(an.horizonAtMax, 1), alt: num(an.sunAltAtMax, 1) })
        : T(an.verdict === 'clear' ? 'vd.hzClear' : 'vd.hzTight', { margin: num(an.margin, 1) });
    } else {
      rowH.className = 'vd-v'; rowH.textContent = T('vd.hzUnknown');
    }

    // --- Nubes ---
    if (sm) {
      const lo = sm.atMax.low, tot = sm.atMax.total;
      const cls = lo >= 60 ? 'bad' : lo >= 25 || tot >= 70 ? 'warn' : 'ok';
      rowC.className = 'vd-v ' + cls;
      rowC.textContent = T('vd.cloudsValue', { total: tot == null ? '—' : tot, low: lo == null ? '—' : lo });
    } else {
      rowC.className = 'vd-v'; rowC.textContent = T('vd.cloudsUnknown');
    }

    // --- Semáforo global ---
    let cls = 'unknown', key = 'vd.unknown';
    if (an || sm) {
      const q = Planner.baseValue(isTotal, lc.totalityDuration, lc.obscuration) *
                Planner.extFactor(lc.max.altRefracted) *
                Planner.horizonFactor(an ? an.margin : null) *
                Planner.skyFactor(sm ? sm.score : null);
      if (q >= 0.45) cls = 'good';
      else if (q >= 0.22) cls = 'fair';
      else cls = 'bad';

      /* Dos vetos por encima de la puntuación. La media ponderada sirve para
         ORDENAR sitios entre sí, pero como titular engaña: un eclipse de dos
         minutos con el Sol alto puntúa tan bien que se traga cualquier otro
         factor. Y estas dos cosas no se compensan con nada. */
      if (an && an.verdict === 'blocked') cls = 'bad';
      if (sm && sm.atMax.low != null) {
        if (sm.atMax.low >= 60) cls = 'bad';
        else if (sm.atMax.low >= 30 && cls === 'good') cls = 'fair';
      }
      key = 'vd.' + cls;
    }
    badge.className = 'vd-badge ' + (cls === 'unknown' ? '' : cls);
    badge.textContent = T(key);

    const btn = $('btnVerdict');
    if (btn) {
      btn.textContent = T(busy.verdict ? 'vd.calculating' : (an && sm) ? 'vd.recalc' : 'vd.calc');
      btn.disabled = busy.verdict;
    }
    const note = $('vdNote');
    if (note) note.innerHTML = (an || sm) ? T('vd.intro') : T('vd.intro') + ' ' + T('vd.needNet');
  }

  async function computeAll() {
    if (busy.verdict) return;
    busy.verdict = true;
    renderVerdict();
    await Promise.all([loadHorizon(), loadWeather()]);
    busy.verdict = false;
    renderVerdict();
    if (!data.clima) loadClima();
  }

  /**
   * Se calcula solo al abrir, sin que haya que pulsar nada. Cuesta una vez por
   * ubicación: el relieve se guarda para siempre y la previsión tres horas, así
   * que volver a la app no gasta nada.
   */
  function autoNow() {
    const st = App() && App().state;
    if (!st || !st.lc || busy.verdict) return;
    if (data.analysis && data.summary) return;
    computeAll();
  }

  // =====================================================================
  // PLANIFICADOR
  // =====================================================================
  function heatColor(q) {
    const t = Math.max(0, Math.min(1, (q - 0.12) / 0.55));
    return `hsl(${(220 - 200 * t).toFixed(0)}, ${(45 + 40 * t).toFixed(0)}%, ${(34 + 22 * t).toFixed(0)}%)`;
  }

  function drawHeat(g) {
    const st = App().state;
    if (!st.map || typeof L === 'undefined') return;
    if (planState.heatLayer) { st.map.removeLayer(planState.heatLayer); planState.heatLayer = null; }
    if (!g) return;

    const half = g.step / 2;
    const dLat = half / 111.32;
    const layer = L.layerGroup();
    for (const p of g.points) {
      if (p.sea) continue;
      const dLon = half / (111.32 * Math.max(0.15, Math.cos(p.lat * Math.PI / 180)));
      L.rectangle([[p.lat - dLat, p.lon - dLon], [p.lat + dLat, p.lon + dLon]], {
        stroke: false, fillColor: heatColor(p.q), fillOpacity: 0.45, interactive: false
      }).addTo(layer);
    }
    layer.addTo(st.map);
    planState.heatLayer = layer;
    if (st.mapLayers && st.mapLayers.me && st.mapLayers.me.bringToFront) st.mapLayers.me.bringToFront();
  }

  function renderPlan() {
    const list = $('plResults');
    const rows = planState.results;
    if (!list) return;
    if (!rows || !rows.length) { list.innerHTML = ''; return; }
    const F = App();

    list.innerHTML = rows.map((p, i) => {
      const tags = [];
      tags.push(`<span class="pl-tag ok">${T('pl.dur', { dur: F.fmtDur(p.dur) })}</span>`);
      if (p.alt != null) tags.push(`<span class="pl-tag">${T('pl.sunAlt', { alt: num(p.alt, 1) })}</span>`);
      if (p.cloud) {
        const bad = p.cloud.low >= 40;
        tags.push(`<span class="pl-tag ${bad ? 'warn' : 'ok'}">` +
          `${T('pl.clouds', { total: p.cloud.total, low: p.cloud.low })}</span>`);
      }
      if (p.people) tags.push(`<span class="pl-tag">${T('pl.capacity', { people: p.people, cars: p.cars })}</span>`);

      const maps = `https://www.google.com/maps/search/?api=1&query=${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;

      return `<div class="pl-item${i === 0 ? ' top' : ''}" data-i="${i}">
        <div class="pl-rank">${i + 1}</div>
        <div class="pl-main">
          <div class="pl-title">${p.n}</div>
          <div class="pl-sub">${p.m} · ${T('pl.where', {
            km: p.fromKm < 10 ? p.fromKm.toFixed(1) : Math.round(p.fromKm),
            dir: I18N.cardinal(p.fromBearing) })}</div>
          <div class="pl-tags">${tags.join('')}</div>
          <div class="pl-actions">
            <button class="pl-act" data-act="use">${T('pl.use')}</button>
            <a class="pl-act" href="${maps}" target="_blank" rel="noopener">${T('pl.openMap')}</a>
          </div>
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('[data-act="use"]').forEach(el => {
      el.addEventListener('click', ev => {
        ev.preventDefault();
        const p = rows[+el.closest('.pl-item').dataset.i];
        if (!p) return;
        App().setLocation(p.lat, p.lon, 0, p.n + ' (' + p.m + ')');
        Panels.setTab('now');
      });
    });
  }

  /**
   * Los puntos oficiales, ordenados de más cerca a más lejos.
   *
   * El cálculo es local e instantáneo, así que la lista aparece sola al abrir
   * la pestaña, sin botones y sin esperar. Lo único que necesita red son las
   * nubes, y van en UNA petición para los dieciocho: si falla, la lista sigue
   * estando ahí, solo que sin ese dato.
   */
  async function runPlan() {
    const st = App().state;
    if (busy.plan || !st.lc) return;
    busy.plan = true;

    const status = $('plStatus');
    planState.results = Official.nearest(st.lat, st.lon);
    planState.doneFor = locKey(st);
    renderPlan();
    if (status) status.innerHTML = T('pl.official', { n: planState.results.length });

    try {
      const wx = await Weather.forecastMany(planState.results);
      let any = false;
      for (let i = 0; i < planState.results.length; i++) {
        if (!wx[i] || !wx[i].hours) continue;
        const h = Weather.hourNear(wx[i].hours, planState.results[i].maxDate);
        if (h) { planState.results[i].cloud = h; any = true; }
      }
      if (any) renderPlan();
    } catch (e) { /* sin nubes, pero la lista vale igual */ }

    busy.plan = false;
  }

  /** Al abrir la pestaña, si no está ya hecho para esta ubicación */
  function autoPlan() {
    const st = App() && App().state;
    if (!st || !st.lc) return;
    if (busy.plan || planState.doneFor === locKey(st)) return;
    runPlan();
  }

  // =====================================================================
  // AVISO DE DESTINO (sustituye al «a X km de la línea central»)
  // =====================================================================
  const NEARBY_R = 250;

  function renderNearby(bn) {
    const el = $('mapNote');
    if (!el) return;
    if (!bn) { el.innerHTML = T('nb.none', { radius: NEARBY_R }); return; }
    const F = App();

    const parts = [T('nb.closest', {
      km: Math.round(bn.closest.fromKm), dir: I18N.cardinal(bn.closest.fromBearing),
      dur: F.fmtDur(bn.closest.dur), place: bn.closest.near.place.n
    })];
    if (bn.closest.dur < 25) parts.push(T('nb.short', { dur: F.fmtDur(bn.closest.dur) }));
    if (bn.best) {
      parts.push(T('nb.best', {
        radius: NEARBY_R, km: Math.round(bn.best.fromKm), dir: I18N.cardinal(bn.best.fromBearing),
        dur: F.fmtDur(bn.best.dur), place: bn.best.near.place.n
      }));
    }
    if (bn.landChecked === false) parts.push(T('pl.noLandCheck'));
    el.innerHTML = parts.join(' ');
  }

  /**
   * El cálculo local es instantáneo, así que se pinta ya. La comprobación de
   * que el destino es tierra firme necesita red, y esa solo se pide cuando el
   * usuario está mirando la pestaña: no tiene sentido gastar una petición al
   * abrir la app para algo que quizá no llegue a ver.
   */
  async function refreshNearby() {
    const st = App().state;
    const el = $('mapNote');
    if (!el || !st) return;

    if (st.lc && st.lc.type === 'total') {
      el.innerHTML = T('nb.inside') + ' ' + T('map.noteSimple');
      return;
    }

    renderNearby(Planner.bestNearby(st.lat, st.lon, NEARBY_R, null));

    const pane = $('pane-plan');
    if (!pane || !pane.classList.contains('on')) return;
    const bn = await Planner.bestNearbyChecked(st.lat, st.lon, NEARBY_R);
    if (bn) renderNearby(bn);
  }

  // =====================================================================
  // ENGANCHES
  // =====================================================================
  /** La ubicación ha cambiado: lo descargado ya no vale */
  function refresh() {
    const st = App() && App().state;
    if (!st) return;
    const key = locKey(st);
    if (key !== data.key) {
      data = { key, horizon: null, analysis: null, weather: null, summary: null, clima: null };
      // Lo que ya estuviera guardado se pinta al instante, sin pedir red
      const prof = Horizon.cachedProfile(st.lat, st.lon);
      if (prof && st.lc) {
        data.horizon = prof;
        data.analysis = Horizon.analyse(prof, st.lc, st.lat, st.lon);
      }
      planState.results = null;
      const list = $('plResults'); if (list) list.innerHTML = '';
      const status = $('plStatus'); if (status) status.textContent = '';
      drawHeat(null);
      renderClima();
    } else if (data.horizon && st.lc) {
      data.analysis = Horizon.analyse(data.horizon, st.lc, st.lat, st.lon);
    }
    if (data.weather && st.lc) data.summary = Weather.summarise(data.weather, st.lc);

    renderVerdict();
    renderHorizon();
    renderWeather();
    renderPlan();
    refreshNearby();
    autoNow();
    if ($('pane-plan') && $('pane-plan').classList.contains('on')) autoPlan();
  }

  // =====================================================================
  // BUSCADOR DE LUGARES
  // =====================================================================
  /* Escribes dónde vas a estar y listo. Faltaba lo más obvio: hasta ahora la
     ubicación solo se podía poner con el GPS, tocando el mapa o con los
     botones de ciudades. */
  (function findBox() {
    const inp = $('findInput'), list = $('findList');
    if (!inp || !list) return;
    let timer = null, seq = 0;

    const close = () => { list.innerHTML = ''; list.classList.remove('on'); };

    inp.addEventListener('input', () => {
      clearTimeout(timer);
      const q = inp.value;
      if (q.trim().length < 3) { close(); return; }
      // Se espera a que pare de teclear: una petición por pulsación sobraría
      timer = setTimeout(async () => {
        const mine = ++seq;
        const items = await Geocode.suggest(q);
        if (mine !== seq) return;                 // llegó tarde, ya hay otra
        if (!items.length) { close(); return; }
        list.innerHTML = items.map((c, i) =>
          `<button class="find-item" data-i="${i}">${c.label}` +
          (c.province ? `<small>${c.province}</small>` : '') + `</button>`).join('');
        list.classList.add('on');
        list.querySelectorAll('.find-item').forEach(el => {
          el.addEventListener('click', async () => {
            const c = items[+el.dataset.i];
            el.textContent = T('find.loading');
            const hit = await Geocode.resolve(c.label);
            close();
            if (!hit) { inp.value = ''; inp.placeholder = T('find.fail'); return; }
            inp.value = '';
            inp.blur();
            App().setLocation(hit.lat, hit.lon, 0, hit.muni || hit.label);
            setTab('now');
          });
        });
      }, 320);
    });

    inp.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    document.addEventListener('click', e => {
      if (!e.target.closest('.findbar')) close();
    });
  })();

  // Botones
  const bind = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  bind('btnVerdict', computeAll);
  bind('btnHorizon', loadHorizon);
  bind('btnWeather', loadWeather);
  bind('btnClima', loadClima);
  bind('btnPlan', runPlan);

  const seg = $('plRadius');
  if (seg) {
    seg.addEventListener('click', e => {
      const b = e.target.closest('button[data-max]');
      if (!b) return;
      planState.range = { min: +b.dataset.min, max: +b.dataset.max };
      planState.rangeLabel = b.textContent.trim();
      seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    });
  }

  addEventListener('resize', () => { if (data.analysis) drawHorizonChart(); });

  // Arranque
  let saved = 'now';
  try { saved = localStorage.getItem('eclipse-tab') || 'now'; } catch (e) {}
  setTab(saved);

  global.Panels = { refresh, setTab, renderVerdict, drawHorizonChart };
  refresh();
})(window);
