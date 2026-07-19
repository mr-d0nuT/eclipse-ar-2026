/* Service worker — funcionamiento sin conexión.
   Importante: el día del eclipse puede que no haya cobertura en el campo. */
const CACHE = 'eclipse-ar-2026-v2';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/astro.js',
  './js/eclipse.js',
  './js/ar.js',
  './js/app.js',
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
  e.respondWith(
    fetch(req).then(r => {
      if (r.ok && new URL(req.url).origin === location.origin) {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return r;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});
