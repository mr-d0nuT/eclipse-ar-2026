/* Service worker — funcionamiento sin conexión.
   Importante: el día del eclipse puede que no haya cobertura en el campo. */
const CACHE = 'eclipse-ar-2026-v25';
const ASSETS = [
  './',
  './index.html',
  './css/style.css?v=23',
  './js/i18n.js?v=23',
  './js/i18n2.js?v=23',
  './js/netcache.js?v=23',
  './js/places.js?v=23',
  './js/official.js?v=23',
  './js/geocode.js?v=23',
  './js/detail.js?v=23',
  './js/spots.js?v=23',
  './js/voice.js?v=23',
  './js/astro.js?v=23',
  './js/eclipse.js?v=23',
  './js/horizon.js?v=23',
  './js/weather.js?v=23',
  './js/planner.js?v=23',
  './js/ar.js?v=23',
  './js/app.js?v=23',
  './js/panels.js?v=23',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // Las APIs (elevación, nubes) van directas a la red y punto. Sin esto caen
  // en el respaldo genérico de abajo, que ante un fallo devuelve el index.html
  // y le entrega al cliente una página HTML donde esperaba JSON.
  // Quien decide qué hacer sin cobertura es Net.cached(), no el worker.
  if (/open-meteo\.com|overpass-api\.de/.test(req.url)) return;

  // Los tiles del mapa y Leaflet: red primero, caché como respaldo
  if (/basemaps|unpkg\.com/.test(req.url)) {
    e.respondWith(
      fetch(req).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return r;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Recursos propios: RED PRIMERO, caché como respaldo.
  // Así la app siempre sirve la última versión cuando hay cobertura,
  // y sigue funcionando entera cuando no la hay (que es el caso el día D).
  //
  // `cache: 'no-cache'` es imprescindible: sin él, este fetch se sirve de la
  // caché HTTP del navegador, y GitHub Pages manda max-age=600 en el HTML.
  // Resultado: hasta 10 minutos sirviendo un index.html viejo junto a JS nuevo,
  // que es justo la combinación que rompe la página. Así se revalida siempre
  // contra el servidor (respuesta 304 si no ha cambiado: cuesta casi nada).
  e.respondWith(
    fetch(req, { cache: 'no-cache' }).then(r => {
      if (r.ok && new URL(req.url).origin === location.origin) {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return r;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});
