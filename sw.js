/* COSMOS Arogya — Service Worker v5
 * v4 bug: the fetch handler did `cached || network` for EVERY request,
 * including index.html — so once a page was cached, every future visit kept
 * serving that same stale copy forever (bug fixes could ship and never be
 * seen until the user manually cleared site data). Fixed below: the app
 * shell (navigations + this file) is now network-first, falling back to
 * cache only when truly offline. Static assets (icons, manifest) stay
 * cache-first since they rarely change and don't block seeing fixes.
 */
const CACHE = 'cosmos-arogya-v5';
const CORE = ['/', '/index.html', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).catch(()=>{}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isAppShell(req, url) {
  // The HTML document itself (full-page navigation) or a same-origin
  // request for index.html directly.
  return req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('/index.html');
}

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;

  // Never touch API calls or third-party services — always go straight to
  // the network for these, no caching either direction.
  if (url.pathname.startsWith('/api/') || url.origin !== self.location.origin) return;

  if (isAppShell(req, url)) {
    // Network-first: always try to get the latest app shell. Only fall back
    // to the cached copy if the network is genuinely unavailable (offline).
    e.respondWith(
      fetch(req).then(res => {
        if (res.ok) { const clone = res.clone(); caches.open(CACHE).then(c => c.put('/index.html', clone)); }
        return res;
      }).catch(() => caches.match('/index.html').then(c => c || caches.match(req)))
    );
    return;
  }

  // Static assets (icons, manifest, etc.) — cache-first with a background
  // refresh, since these change rarely and speed matters more than
  // freshness here.
  e.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(res => {
        if (res.ok && res.type === 'basic') { const clone = res.clone(); caches.open(CACHE).then(c => c.put(req, clone)); }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
