/* Offline app-shell cache for the web app.
 *
 * The DATA layer is already offline-capable (OPFS SQLite + op-log). This makes the
 * APP ITSELF load offline: it caches the shell (index.html, the JS bundle, the WASM
 * engines, the workers, fonts) so a second visit renders with no network.
 *
 * Strategy: NETWORK-FIRST with a cache fallback. Online, you always get fresh code
 * (no stale bundle during development) and the cache is refreshed in passing.
 * Offline, same-origin GETs are served from the cache, and any navigation falls back
 * to the cached shell so the SPA boots and runs entirely from local data.
 *
 * Only same-origin GETs are touched — the sync server (a different origin) and all
 * POSTs go straight to the network, so sync is never intercepted.
 */

const CACHE = 'things3-shell-v1';
const SHELL_KEY = '__app_shell__'; // stable key for the HTML document

self.addEventListener('install', () => {
  self.skipWaiting(); // activate this SW immediately
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim(); // control open tabs right away
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }
  // Only same-origin GETs. Cross-origin (the sync server) and non-GET (push/pull)
  // are left to the network untouched.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Navigations → the app shell. Network-first, fall back to the cached shell so the
  // SPA renders offline (React then runs on local OPFS data).
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const net = await fetch(req);
          cache.put(SHELL_KEY, net.clone());
          return net;
        } catch (_) {
          return (await cache.match(SHELL_KEY)) || (await cache.match(req)) || Response.error();
        }
      })()
    );
    return;
  }

  // Everything else same-origin (JS bundle, wasm, workers, fonts, assets):
  // network-first, cache fallback.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const net = await fetch(req);
        if (net && net.ok && net.type === 'basic') cache.put(req, net.clone());
        return net;
      } catch (_) {
        const cached = await cache.match(req);
        return cached || Response.error();
      }
    })()
  );
});
