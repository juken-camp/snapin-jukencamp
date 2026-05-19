// SnapIn Service Worker
// Strategy: cache the app shell on install; serve from cache, update in background.
const CACHE = 'snapin-v1';
const SHELL = ['./index.html', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Only cache GET requests for our origin
  if (e.request.method !== 'GET') return;
  // Let API calls (Anthropic) go straight to network
  if (e.request.url.includes('anthropic.com')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request).then(res => {
        // Update cache with fresh response
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached); // network failed → serve cached
      // Serve cached immediately if available, else wait for network
      return cached || networkFetch;
    })
  );
});
