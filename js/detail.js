/* =========================================================================
   detail.js — Detalle del punto, al estilo del visualizador del IGN

   Replica la vista del visualizador oficial
   (https://visualizadores.ign.es/eclipses/2026): ortofoto, el punto con un
   círculo que marca hacia dónde estará el Sol y con cuántos grados de azimut,
   y al lado todas las circunstancias, incluido el perfil de visibilidad.

   Dos diferencias con el original, ambas a favor:
     · La ortofoto es la del PNOA del propio IGN, así que es la misma imagen.
     · El perfil de visibilidad se calcula con el modelo de elevaciones
       Copernicus y sale de datos que la app ya tiene cacheados.

   El punto es SIEMPRE la ubicación de la app: tocar el mapa la cambia, y con
   ella se actualiza todo lo demás. Así no hay dos «posiciones» que puedan
   contradecirse.
   ========================================================================= */
(function (global) {
  'use strict';

  const $ = id => document.getElementById(id);
  const T = (k, p) => I18N.t(k, p);
  const App = () => global.EclipseApp;

  const R_EF = 6371000 / (1 - 0.13);     // radio terrestre efectivo con refracción

  /* El círculo NO tiene un radio fijo: crece al alejar el zoom para ocupar
     siempre la misma parte de la pantalla. Un círculo de 150 m es perfecto
     para ver qué tienes en el jardín, pero al alejarte se convierte en un
     punto y ya no dice nada. Escalándolo, la línea hacia el Sol llega hasta
     donde llegue el mapa, y de un vistazo ves si hay una sierra a veinte
     kilómetros justo en esa dirección. */
  /* 0,34 y no mas: el circulo se calcula sobre el ANCHO del mapa, que es mas
     alto que ancho, y con 0,40 el icono del Sol se salia por el borde cuando
     el azimut apuntaba de lado. */
  const CIRCLE_FRAC = 0.34;              // fracción del ancho visible del mapa
  const CIRCLE_MIN = 60;                 // metros
  const SUN_COLOR = '#ffd60a';           // amarillo del cercle d'escala
  const RAY_COLOR = '#ff1e1e';           // vermell de la línia cap al Sol

  function circleRadius() {
    if (!map) return CIRCLE_MIN;
    const b = map.getBounds();
    const w = map.distance(b.getNorthWest(), b.getNorthEast());
    return Math.max(CIRCLE_MIN, w * CIRCLE_FRAC);
  }

  /** 8400 -> «8,4 km» · 150 -> «150 m» */
  function distLabel(m) {
    return m >= 1000 ? (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km' : Math.round(m) + ' m';
  }

  let map = null, layers = {};
  let placeCache = {};

  /* Instante que se está mirando en el perfil. null = el máximo.
     El punto naranja del gráfico es el Sol, y su altura cambia mucho a lo
     largo del eclipse: de unos 14° en C1 a 0° en el ocaso. Con la línea de
     visión clavada en el máximo no se podía ver a qué hora, exactamente,
     empieza a taparlo el terreno. */
  let chartAt = null;

  // ---------------------------------------------------------------------
  // Formato
  // ---------------------------------------------------------------------
  /** 41.132278 -> 41°7'56.2"N */
  function dms(v, pos, neg) {
    const hemi = v < 0 ? neg : pos;
    v = Math.abs(v);
    const d = Math.floor(v);
    const m = Math.floor((v - d) * 60);
    const s = ((v - d) * 60 - m) * 60;
    return `${d}°${m}'${s.toFixed(1)}"${hemi}`;
  }

  /** 4926 -> «1h 22min 6s», como lo escribe el IGN */
  function dur(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return `${h}h ${m}min ${s}s`;
  }

  // ---------------------------------------------------------------------
  // Mapa
  // ---------------------------------------------------------------------
  function ensureMap() {
    if (map || typeof L === 'undefined' || !$('dtMap')) return map;
    const st = App().state;
    map = L.map('dtMap', { zoomControl: true, attributionControl: false })
      .setView([st.lat, st.lon], 16);

    /* Ortofoto del PNOA: la misma imagen que usa el visualizador oficial.
       Fuera de España no hay cobertura, así que debajo va el mapa oscuro que
       ya usa el resto de la app y que sí es mundial. */
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19, subdomains: 'abcd'
    }).addTo(map);
    L.tileLayer('https://www.ign.es/wmts/pnoa-ma?service=WMTS&request=GetTile&version=1.0.0' +
                '&layer=OI.OrthoimageCoverage&style=default&tilematrixset=GoogleMapsCompatible' +
                '&format=image/jpeg&tilematrix={z}&tilerow={y}&tilecol={x}', {
      maxZoom: 19, opacity: 1
    }).addTo(map);

    /* PULSACIÓN MANTENIDA para mover el punto, no un toque simple.
       Con un toque, arrastrar el mapa o hacer zoom con dos dedos te cambiaba
       la posición sin querer, y con ella todos los cálculos. Manteniendo
       pulsado es un gesto deliberado: sale un aro que crece mientras aguantas
       y vibra al soltarse, así se ve que ha registrado. */
    let pressTimer = null, pressAt = null, pressRing = null;

    const clearRing = () => {
      if (pressRing) { map.removeLayer(pressRing); pressRing = null; }
    };
    const cancelPress = () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      clearRing();
    };

    map.on('mousedown', e => {
      cancelPress();
      pressAt = e.latlng;
      pressRing = L.marker(e.latlng, {
        interactive: false,
        icon: L.divIcon({ className: '', iconSize: [54, 54],
          html: '<div class="dt-press"></div>' })
      }).addTo(map);

      pressTimer = setTimeout(() => {
        pressTimer = null;
        clearRing();
        if (navigator.vibrate) navigator.vibrate(28);
        App().setLocation(pressAt.lat, pressAt.lng, 0, T('dt.mapPoint'));
      }, 550);
    });

    // Cualquier cosa que no sea aguantar quieto lo cancela
    ['mouseup', 'mouseout', 'movestart', 'zoomstart', 'dragstart'].forEach(ev =>
      map.on(ev, cancelPress));

    // En escritorio, el clic derecho hace lo mismo sin esperar
    map.on('contextmenu', e => {
      cancelPress();
      App().setLocation(e.latlng.lat, e.latlng.lng, 0, T('dt.mapPoint'));
    });

    // Al alejar o acercar, el círculo se reescala para seguir siendo útil
    map.on('zoomend', () => drawMarkers(false));
    return map;
  }

  /**
   * El punto, el círculo y hacia dónde estará el Sol.
   * El círculo no es decoración: al ponerle el Sol encima en su azimut real,
   * de un vistazo sabes qué tienes delante en esa dirección —una casa, un
   * monte, el mar— sin tener que interpretar un número de grados.
   */
  function drawMarkers(recenter) {
    const st = App().state;
    if (!map || !st.lc) return;
    const CIRCLE_M = circleRadius();

    for (const k in layers) { if (layers[k]) map.removeLayer(layers[k]); }
    layers = {};

    const az = st.lc.max.az, alt = st.lc.max.altRefracted;
    const here = [st.lat, st.lon];

    /* Amarillo intenso con un reborde negro debajo.
       El blanco se perdia sobre la ortofoto: hay campos claros, tejados y
       espuma de mar que lo hacen desaparecer. La tecnica cartografica de
       siempre —una linea oscura mas gruesa debajo y la de color encima— hace
       que se lea sobre cualquier fondo, y el amarillo mantiene la asociacion
       con el Sol que ya usa el resto de la app. */
    /* El circulo es solo la referencia de escala, asi que va fino y a trazos,
       parpadeando despacio: se ve sin competir con la linea, que es la que
       lleva la informacion. Sin reborde negro debajo, que rellenaria los
       huecos del trazo discontinuo. */
    layers.circle = L.circle(here, {
      radius: CIRCLE_M, color: SUN_COLOR, weight: 1.5, opacity: .95,
      dashArray: '5 7', fill: false, interactive: false, className: 'dt-ring'
    }).addTo(map);

    // Marca del Norte, para leer el círculo como una rosa de los vientos
    const n = Horizon.destPoint(st.lat, st.lon, 0, CIRCLE_M);
    layers.north = L.marker([n.lat, n.lon], {
      interactive: false,
      icon: L.divIcon({ className: '', iconSize: [16, 16], html:
        '<div style="transform:translate(-50%,-50%);color:#fff;font:800 12px -apple-system,sans-serif;' +
        'text-shadow:0 0 3px #000,0 0 6px #000">N</div>' })
    }).addTo(map);

    // Línea hacia el Sol y el Sol sobre la circunferencia
    const s = Horizon.destPoint(st.lat, st.lon, az, CIRCLE_M);
    /* La linea hacia el Sol, en rojo: es el dato, y tiene que cantar. El
       reborde negro debajo la mantiene legible sobre campos claros y espuma. */
    layers.rayCase = L.polyline([here, [s.lat, s.lon]], {
      color: '#000', weight: 5.5, opacity: .5, interactive: false
    }).addTo(map);
    layers.ray = L.polyline([here, [s.lat, s.lon]], {
      color: RAY_COLOR, weight: 2.5, opacity: 1, interactive: false
    }).addTo(map);

    layers.sun = L.marker([s.lat, s.lon], {
      interactive: false,
      icon: L.divIcon({ className: '', iconSize: [32, 32], html:
        '<div style="transform:translate(-50%,-50%);font-size:26px;line-height:1;' +
        'filter:drop-shadow(0 0 3px #000) drop-shadow(0 0 7px rgba(0,0,0,.95))">☀️</div>' })
    }).addTo(map);

    // La etiqueta de grados, a media línea, como en el visualizador oficial
    /* Solo el azimut, y a un tercio de la linea.
       Con «286.08° · 186 m» la etiqueta medía siglo y medio de pixeles y, con
       el Sol casi horizontal, acababa encima del icono. El alcance no se
       pierde: sigue en la insignia de la esquina, junto a la altura. */
    const mid = Horizon.destPoint(st.lat, st.lon, az, CIRCLE_M * 0.34);
    layers.label = L.marker([mid.lat, mid.lon], {
      interactive: false,
      icon: L.divIcon({ className: '', iconSize: [56, 18], html:
        `<div style="transform:translate(-50%,-165%);white-space:nowrap;` +
        `background:rgba(0,0,0,.68);color:${SUN_COLOR};border-radius:6px;padding:2px 6px;` +
        `font:700 11px -apple-system,sans-serif">${az.toFixed(1)}°</div>` })
    }).addTo(map);

    layers.me = L.marker(here, {
      interactive: false,
      icon: L.divIcon({ className: '', iconSize: [22, 22], html:
        '<div style="transform:translate(-50%,-50%);width:14px;height:14px;border-radius:50%;' +
        'background:#4fd6ff;border:3px solid #fff;box-shadow:0 0 8px rgba(0,0,0,.8)"></div>' })
    }).addTo(map);

    /* Solo se recentra cuando cambia la ubicación, y SIN tocar el zoom. Antes
       forzaba un mínimo de 15 y eso echaba a perder justo lo que se busca al
       alejarse: si te vas a 20 km para ver si hay una sierra en medio, el
       mapa no puede devolverte al jardín en el siguiente refresco. */
    if (recenter) map.panTo(here, { animate: false });

    const badge = $('dtAz');
    if (badge) badge.textContent = `${az.toFixed(2)}° · ${alt.toFixed(2)}° · ${distLabel(CIRCLE_M)}`;
  }

  // ---------------------------------------------------------------------
  // Panel de datos
  // ---------------------------------------------------------------------
  function render() {
    const panel = $('dtPanel');
    const st = App() && App().state;
    if (!panel || !st) return;
    const F = App(), lc = st.lc;

    if (!lc) {
      panel.innerHTML = `<div class="muted">${T('alert.notVisible', { place: st.label })}</div>`;
      return;
    }

    const isTotal = lc.type === 'total' && !!lc.c2;
    const set = Astro.sunRiseSet(lc.max.date, st.lat, st.lon).set;
    // El IGN mide la duración hasta el ocaso cuando el Sol se pone antes de C4,
    // que en el este peninsular es lo que pasa siempre.
    const endVisible = (set && set < lc.c4.date) ? set : lc.c4.date;

    const rows = [
      [T('dt.type'), isTotal ? T('dt.typeTotal') : T('dt.typePartial'), 'strong'],
      [T('dt.c1'), F.fmtTime(lc.c1.date)],
      [T('dt.c2'), lc.c2 ? F.fmtTime(lc.c2.date) : '—'],
      [T('dt.max'), F.fmtTime(lc.max.date), 'strong'],
      [T('dt.c3'), lc.c3 ? F.fmtTime(lc.c3.date) : '—'],
      [T('dt.sunset'), set ? F.fmtTime(set) : '—'],
      [T('dt.duration'), dur((endVisible - lc.c1.date) / 1000)],
      [T('dt.durTotal'), dur(lc.totalityDuration)],
      [T('dt.sunAlt'), lc.max.altRefracted.toFixed(4) + '°'],
      [T('dt.sunAz'), lc.max.az.toFixed(4) + '°']
    ];

    const pct = (lc.obscuration * 100);
    panel.innerHTML =
      `<div class="dt-bar"><i style="width:${Math.min(100, pct).toFixed(2)}%"></i>
         <b>${pct.toFixed(2)} %</b></div>
       <div class="dt-rows">` +
      rows.map(r => `<div class="dt-row"><span>${r[0]}</span>` +
        `<b class="${r[2] || ''}">${r[1]}</b></div>`).join('') +
      `</div>`;
  }

  const key = s => s.lat.toFixed(4) + ',' + s.lon.toFixed(4);

  /** Municipio y provincia, con el geocodificador inverso del IGN */
  async function loadPlace() {
    const st = App().state;
    const k = key(st);
    if (placeCache[k] !== undefined) { updateChip(); return; }
    placeCache[k] = null;
    placeCache[k] = await Geocode.reverse(st.lat, st.lon);
    updateChip();
  }

  /**
   * El chip de arriba: etiqueta, municipio y coordenadas.
   *
   * Las coordenadas estaban repetidas —en el chip y otra vez bajo el mapa—, y
   * en ninguno de los dos sitios salia el municipio, que es lo primero que
   * quieres reconocer. Ahora van juntos y una sola vez.
   *
   * app.js escribe el chip en cada recompute; esto lo completa despues, cuando
   * el geocodificador responde.
   */
  function updateChip() {
    const el = $('locChip'), st = App() && App().state;
    if (!el || !st) return;
    const D = I18N.t('dir');
    const coords = `${Math.abs(st.lat).toFixed(3)}°${st.lat >= 0 ? D[0] : D[8]} ` +
                   `${Math.abs(st.lon).toFixed(3)}°${st.lon >= 0 ? D[4] : D[12]}`;
    const p = placeCache[key(st)];
    const parts = [];
    if (st.label) parts.push(st.label);
    // No repetir el municipio si la etiqueta ya lo dice (buscador, punt oficial)
    if (p && p.muni && (st.label || '').toLowerCase().indexOf(p.muni.toLowerCase()) < 0) {
      parts.push(p.muni);
    }
    el.innerHTML = `<b>${parts.join(' · ')}</b><small>${coords}</small>`;
  }

  // ---------------------------------------------------------------------
  // Perfil de visibilidad
  // ---------------------------------------------------------------------
  /* El corte del terreno en la dirección del Sol, con la línea de visibilidad
     encima. Es el mismo gráfico del visualizador del IGN y responde a la
     pregunta de golpe: si el rojo cruza la línea de puntos, no lo ves.

     La línea de visibilidad sube tan(altura) por metro, más la corrección por
     curvatura terrestre: a 20 km el suelo ya se ha ido 27 m por debajo. */
  const MAX_D = 20000;

  function sightAt(d, obsElev, altDeg) {
    return obsElev + d * Math.tan(altDeg * Math.PI / 180) + (d * d) / (2 * R_EF);
  }

  /* El perfil se PIDE aquí si no está.
     Antes solo se dibujaba cuando ya estaba en la caché, esperando a que lo
     bajara la tarjeta del veredicto; si aquella fallaba por cuota, esto se
     quedaba en «calculando el relieve» para siempre. Net.cached() deduplica
     las peticiones en vuelo, así que pedirlo desde los dos sitios no lo baja
     dos veces. */
  let asking = false, askedFor = null, retryStop = false;

  async function ensureProfile() {
    const st = App() && App().state;
    if (!st || !st.lc || asking) return;
    const k = st.lat.toFixed(3) + ',' + st.lon.toFixed(3);
    if (askedFor === k) return;              // ya se intentó para este punto
    askedFor = k;
    asking = true;
    retryStop = false;
    const verdict = $('dtVerdict');
    try {
      // Un solo rayo, el del azimut del máximo: 21 sondeos en vez de 163.
      // Es lo que hace viable ir probando sitios uno detrás de otro.
      await Horizon.ray(st.lat, st.lon, st.lc.max.az);
      asking = false;
      drawChart();
    } catch (e) {
      asking = false;
      if (e && e.rate) {
        // Sin cuota: se vuelve solo, con la cuenta atrás a la vista
        let left = Math.max(1, e.retryAfter);
        retryStop = false;
        (function tick() {
          if (retryStop || !$('dtVerdict')) return;
          if (left <= 0) { askedFor = null; ensureProfile(); return; }
          $('dtVerdict').innerHTML = `<span class="dt-v-wait">${T('pl.retrying', { s: left })}</span>`;
          left--;
          setTimeout(tick, 1000);
        })();
      } else if (verdict) {
        verdict.innerHTML = `<span class="dt-v-wait">${T('hz.fail')}</span>`;
      }
    }
  }

  function drawChart() {
    const cv = $('dtChart');
    const st = App() && App().state;
    if (!cv || !st || !st.lc) return;

    const lc = st.lc;
    const when = chartAt || lc.max.date;
    const sun = Astro.sunAltAz(when, st.lat, st.lon);
    const az = sun.az, alt = sun.altRefracted;
    const verdict = $('dtVerdict');

    // El deslizador recorre desde C1 hasta el ocaso, que es la parte que se ve
    const set = Astro.sunRiseSet(lc.max.date, st.lat, st.lon).set;
    const t0 = lc.c1.date.getTime();
    const t1 = (set && set < lc.c4.date ? set : lc.c4.date).getTime();
    const sl = $('dtSlider');
    if (sl && !sl.dataset.dragging) {
      sl.value = Math.round(((when.getTime() - t0) / (t1 - t0)) * 1000);
    }
    const tEl = $('dtTime'), sEl = $('dtSunAt');
    if (tEl) tEl.textContent = App().fmtTime(when) + (chartAt ? '' : ' · ' + T('dt.isMax'));
    if (sEl) sEl.textContent = T('dt.sunAtLine', { alt: alt.toFixed(2), az: az.toFixed(1) });

    /* Dos orígenes posibles, y se prefiere el que ya esté descargado:
       el abanico completo si la tarjeta del horizonte lo bajó, y si no, el
       rayo suelto del azimut del máximo, que cuesta ocho veces menos. */
    let obs = null, pts = null;
    const prof = Horizon.cachedProfile(st.lat, st.lon);
    if (prof) {
      let ray = prof.rays[0];
      for (const r of prof.rays) if (Math.abs(r.az - az) < Math.abs(ray.az - az)) ray = r;
      obs = prof.obsElev;
      pts = ray.samples.filter(s => s[0] <= MAX_D);
    } else {
      const r = Horizon.cachedRay(st.lat, st.lon, az) ||
                Horizon.cachedRay(st.lat, st.lon, lc.max.az);
      if (r) { obs = r.obsElev; pts = r.samples.filter(s => s[0] <= MAX_D); }
    }

    if (!pts || !pts.length) {
      cv.style.display = 'none';
      if (verdict && !asking) verdict.innerHTML = `<span class="dt-v-wait">${T('dt.visWait')}</span>`;
      ensureProfile();
      return;
    }
    cv.style.display = '';
    // Ya hay datos: se corta cualquier cuenta atrás de reintento pendiente,
    // que si no acaba pisando el veredicto recién calculado.
    asking = false; retryStop = true;

    // ¿Cruza el terreno la línea de visibilidad?
    let blocked = null;
    for (const [d, h] of pts) {
      if (h > sightAt(d, obs, alt)) { blocked = { d, h }; break; }
    }

    const cssW = cv.clientWidth || 320;
    const H = Math.round(Math.min(220, Math.max(150, cssW * 0.5)));
    const dpr = Math.min(devicePixelRatio || 1, 2.5);
    cv.width = Math.round(cssW * dpr); cv.height = Math.round(H * dpr);
    cv.style.height = H + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, H);

    const padL = 44, padR = 10, padT = 10, padB = 30;
    const pw = cssW - padL - padR, ph = H - padT - padB;

    const topSight = sightAt(MAX_D, obs, alt);
    let yMax = Math.max(topSight, ...pts.map(p => p[1])) * 1.08;
    yMax = Math.ceil(yMax / 250) * 250 || 500;
    const yMin = Math.min(0, obs, ...pts.map(p => p[1]));

    const X = d => padL + (d / MAX_D) * pw;
    const Y = h => padT + (1 - (h - yMin) / (yMax - yMin)) * ph;

    // Rejilla
    g.font = '600 9.5px -apple-system, sans-serif';
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let i = 0; i <= 3; i++) {
      const h = yMin + (yMax - yMin) * i / 3, y = Y(h);
      g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(padL, y); g.lineTo(cssW - padR, y); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.45)';
      g.fillText(Math.round(h) + '', padL - 6, y);
    }
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (let d = 0; d <= MAX_D; d += 5000) {
      g.fillStyle = 'rgba(255,255,255,.45)';
      g.fillText((d / 1000) + 'k', X(d), padT + ph + 6);
    }
    g.save();
    g.translate(11, padT + ph / 2); g.rotate(-Math.PI / 2);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(255,255,255,.4)';
    g.fillText(T('dt.axisAlt'), 0, 0);
    g.restore();

    // Línea de visibilidad
    g.strokeStyle = '#ffab3d'; g.lineWidth = 1.8; g.setLineDash([5, 4]);
    g.beginPath();
    for (let i = 0; i <= 40; i++) {
      const d = MAX_D * i / 40, x = X(d), y = Y(sightAt(d, obs, alt));
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke(); g.setLineDash([]);

    // Terreno
    g.beginPath();
    g.moveTo(X(0), Y(obs));
    for (const [d, h] of pts) g.lineTo(X(d), Y(h));
    g.lineTo(X(pts.length ? pts[pts.length - 1][0] : MAX_D), Y(yMin));
    g.lineTo(X(0), Y(yMin)); g.closePath();
    g.fillStyle = 'rgba(255,95,109,.16)'; g.fill();
    g.strokeStyle = '#ff5f6d'; g.lineWidth = 1.8;
    g.beginPath(); g.moveTo(X(0), Y(obs));
    for (const [d, h] of pts) g.lineTo(X(d), Y(h));
    g.stroke();

    // Observador y Sol
    g.fillStyle = '#4fd6ff';
    g.beginPath(); g.arc(X(0), Y(obs), 4.5, 0, 7); g.fill();
    g.fillStyle = '#ffab3d';
    g.beginPath(); g.arc(X(MAX_D), Y(topSight), 4.5, 0, 7); g.fill();

    if (blocked) {
      g.strokeStyle = '#ff5f6d'; g.lineWidth = 2;
      g.beginPath(); g.arc(X(blocked.d), Y(blocked.h), 7, 0, 7); g.stroke();
    }

    /* ¿A qué hora, exactamente, se lo come el terreno?
       Un cerro de 300 m a 5 km sube 3,4°. Con el Sol a 4,3° en el máximo lo
       salvas, pero el Sol sigue cayendo y doce minutos después ya está a 2°:
       verías empezar la totalidad y perderías el resto. Preguntar solo por el
       instante del máximo se deja fuera ese caso, que es de los peores.

       El corte es de un azimut fijo, así que el ángulo del horizonte en esta
       dirección es un solo número; el resto es buscar cuándo el Sol baja de él. */
    let hzAngle = 0;
    for (const [d, h] of pts) hzAngle = Math.max(hzAngle, Horizon.elevationAngle(h - obs, d));

    let hides = null;
    if (hzAngle > 0) {
      const altAt = ms => Astro.sunAltAz(new Date(ms), st.lat, st.lon).altRefracted;
      let lo = lc.c1.date.getTime(), hi = t1;
      if (altAt(lo) > hzAngle && altAt(hi) < hzAngle) {
        for (let i = 0; i < 30; i++) {
          const mid = (lo + hi) / 2;
          if (altAt(mid) > hzAngle) lo = mid; else hi = mid;
        }
        hides = new Date((lo + hi) / 2);
      }
    }
    const hidesEl = $('dtHides');
    /* Cuándo merece un aviso y cuándo no.
       Un horizonte llano SIEMPRE «tapa» el Sol unos minutos antes del ocaso:
       con el observador a 3 m y el terreno a 8 m, el ángulo sale 0,4°, y el
       Sol pasa por 0,4° cuatro minutos antes de ponerse. Avisar de eso es dar
       la alarma en vano, y quien recibe alarmas en vano deja de mirarlas.
       Solo cuenta si hay relieve de verdad (≥ 1°) y además te quita tiempo. */
    const costsTime = hides && hzAngle >= 1 && (t1 - hides.getTime()) > 3 * 60000;
    if (hidesEl) {
      if (hides && costsTime) {
        const dm = Math.round((hides - lc.max.date) / 60000);
        hidesEl.className = 'dt-hides warn';
        hidesEl.innerHTML = T('dt.hidesAt', {
          time: App().fmtTime(hides), hz: hzAngle.toFixed(1),
          rel: dm >= 0 ? T('dt.afterMax', { m: dm }) : T('dt.beforeMax', { m: -dm })
        });
      } else {
        hidesEl.className = 'dt-hides ok';
        hidesEl.innerHTML = T('dt.hidesNever', { hz: hzAngle.toFixed(1) });
      }
    }

    if (verdict) {
      const hhmm = App().fmtTime(when);
      verdict.innerHTML = blocked
        ? `<span class="dt-v-bad">${T('dt.visNoAt', { time: hhmm, km: (blocked.d / 1000).toFixed(1) })}</span>`
        : `<span class="dt-v-ok">${T('dt.visYesAt', { time: hhmm })}</span>`;
    }
  }

  // ---------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------
  function refresh() {
    if (!App() || !$('dtPanel')) return;
    const st = App().state;
    const k = st.lat.toFixed(3) + ',' + st.lon.toFixed(3);
    if (askedFor && askedFor !== k) { askedFor = null; chartAt = null; }  // punto nuevo
    render();
    ensureMap();
    drawMarkers(true);
    drawChart();
    updateChip();
    loadPlace();
  }

  function shown() {
    if (map) setTimeout(() => { map.invalidateSize(); drawMarkers(true); }, 60);
    drawChart();
  }

  (function scrubber() {
    const sl = $('dtSlider'), bt = $('dtToMax');
    if (!sl) return;
    const onMove = () => {
      const st = App() && App().state;
      if (!st || !st.lc) return;
      const lc = st.lc;
      const set = Astro.sunRiseSet(lc.max.date, st.lat, st.lon).set;
      const t0 = lc.c1.date.getTime();
      const t1 = (set && set < lc.c4.date ? set : lc.c4.date).getTime();
      chartAt = new Date(t0 + (t1 - t0) * (+sl.value / 1000));
      drawChart();
    };
    sl.addEventListener('pointerdown', () => { sl.dataset.dragging = '1'; });
    sl.addEventListener('pointerup', () => { delete sl.dataset.dragging; });
    sl.addEventListener('input', onMove);
    if (bt) bt.addEventListener('click', () => { chartAt = null; drawChart(); });
  })();

  addEventListener('resize', () => drawChart());

  global.Detail = { refresh, shown, drawChart, dms, dur, get map() { return map; } };
})(window);
