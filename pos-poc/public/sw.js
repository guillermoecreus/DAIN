// Service worker: la app abre sin red (shell en caché). La API nunca se cachea:
// los datos offline viven en IndexedDB y viajan por la cola de sincronización.
const VERSION = 'pos-poc-v1';
const SHELL = [
  '/', '/index.html', '/styles.css', '/manifest.webmanifest', '/icon.svg',
  '/js/app.js', '/js/api.js', '/js/store.js', '/js/syncer.js', '/js/util.js',
  '/js/views/pos.js', '/js/views/cash.js', '/js/views/products.js', '/js/views/customers.js',
  '/js/views/reports.js', '/js/views/fiscal.js', '/js/views/notices.js',
  '/lib/uuidv7.js', '/lib/scale.js', '/lib/money.js',
];

self.addEventListener('install', e => e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()),
));

// Red primero para el shell (así se ven los cambios), caché si no hay red.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('/index.html'))),
  );
});
