/*
 * Service worker: caches the app shell so the map opens instantly and still opens
 * with no signal — showing the last known state rather than a browser error page,
 * which matters when the network is the first thing to go.
 *
 * Live data is never cached: a stale target map would be worse than an empty one.
 */
const CACHE = 'horizont-v26';
const SHELL = [
  '/',
  '/style.css',
  '/app.js',
  '/vendor/leaflet.js',
  '/vendor/leaflet.css',
  // Not the manifest: it is generated per request and carries the map token, so a
  // cached copy would outlive a token change and strand the installed app.
  '/icons/icon-192.png',
  '/icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Never serve live state from cache.
  if (url.pathname.startsWith('/api/')) return;

  /*
   * Boundaries: stale-while-revalidate.
   *
   * Plain cache-first looked right — the file is large and rarely changes — but it
   * pinned the browser to whatever version it saw first. While the gazetteer of
   * region outlines was still being built, clients kept serving a four-region file
   * from cache and the map showed alerts with no shading, with nothing in the page
   * to suggest why. Serve the cached copy instantly, refresh it in the background.
   */
  if (url.pathname.startsWith('/data/')) {
    event.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(event.request).then((hit) => {
          const fresh = fetch(event.request)
            .then((res) => {
              if (res.ok) cache.put(event.request, res.clone());
              return res;
            })
            .catch(() => hit);
          return hit || fresh;
        }),
      ),
    );
    return;
  }

  // Shell: network-first so a deploy is picked up, cache as the offline fallback.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('/'))),
  );
});
