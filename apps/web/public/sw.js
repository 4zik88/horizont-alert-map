/* Horizont service worker — hand-written, no build step.
 *
 * - App shell: precached on install (index + the hashed assets it references), and
 *   /assets/* is cache-first at runtime (hashed names never change content).
 * - /api/snapshot, /api/me, /api/regions.geojson: network-first, cache fallback, so the
 *   app opens offline with the last state it saw.
 * - Basemap (tiles.openfreemap.org): cache-first with a bounded entry count.
 * - Everything else (history, login, logout, /auth, /ws) goes straight to the network.
 */
const VERSION = 'v2';
const SHELL = `horizont-shell-${VERSION}`;
const API = 'horizont-api-v1';
const TILES = 'horizont-tiles-v1';
const TILE_LIMIT = 1500;
const API_PATHS = new Set(['/api/snapshot', '/api/me', '/api/regions.geojson']);
const STATIC = ['/', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // One by one and tolerant: a missing icon must not stop the worker installing.
      await Promise.all(STATIC.map((u) => cache.add(u).catch(() => undefined)));
      // The built index names its hashed bundles; cache whatever it references.
      const res = await cache.match('/');
      if (res) {
        const html = await res.text();
        const assets = [...new Set(html.match(/\/assets\/[^"'\s)]+/g) ?? [])];
        await Promise.all(assets.map((u) => cache.add(u).catch(() => undefined)));
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, API, TILES]);
      for (const key of await caches.keys()) {
        if (key.startsWith('horizont-') && !keep.has(key)) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    // Only good answers are remembered: a 401 must never be replayed as "logged in".
    if (res.ok) await cache.put(request, res.clone());
    else if (res.status === 401) await cache.delete(request);
    return res;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request, cacheName, limit) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) {
    await cache.put(request, res.clone());
    if (limit) trim(cache, limit);
  }
  return res;
}

let trimming = false;
async function trim(cache, limit) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    // Insertion order: the oldest entries go first.
    for (let i = 0; i < keys.length - limit; i++) await cache.delete(keys[i]);
  } finally {
    trimming = false;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === 'https://tiles.openfreemap.org') {
    // The style names the current tile set, so it must stay fresh; tiles and glyphs
    // under a versioned path never change.
    event.respondWith(
      url.pathname.startsWith('/styles/') ? networkFirst(request, TILES) : cacheFirst(request, TILES, TILE_LIMIT),
    );
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (API_PATHS.has(url.pathname)) {
    event.respondWith(networkFirst(request, API));
    return;
  }
  if (url.pathname.startsWith('/api/') || url.pathname === '/auth' || url.pathname === '/ws') return;

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(request, SHELL));
    return;
  }
  if (request.mode === 'navigate') {
    // Fresh index when online (new deploys), the cached shell when not.
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(request);
          if (res.ok && url.pathname === '/') (await caches.open(SHELL)).put('/', res.clone());
          return res;
        } catch {
          return (await caches.match('/')) ?? Response.error();
        }
      })(),
    );
    return;
  }
  if (url.pathname === '/manifest.webmanifest') {
    event.respondWith(networkFirst(request, SHELL));
  }
});

/* ── Web Push: the same warnings as the Telegram bot ──────────────────── */

self.addEventListener('push', (event) => {
  let data = { title: 'Horizont', body: '', url: '/' };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    /* a payload we cannot read still deserves a notification */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url },
      // Each warning stands alone: a later one must not silently replace an earlier one.
      tag: `w-${Date.now()}`,
      requireInteraction: false,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
