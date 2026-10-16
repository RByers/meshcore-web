/*
 * MeshCore Web service worker: offline app shell.
 *
 * Registered from src/pwa.ts as `./sw.js?v=<build id>` (production builds only). The build id
 * comes from vite's `define` (__BUILD_ID__), so every deploy registers a new script URL, installs
 * a fresh worker and gets a fresh cache; old caches are deleted on activate.
 *
 * - install: fetch `./` (index.html), cache it together with every `./assets/…` URL it
 *   references and the manifest / icons, so the first visit already works offline afterwards.
 * - navigations: network-first, falling back to the cached index.html.
 * - `assets/` (content-hashed): cache-first, with a background refresh of the cached copy.
 * - everything else (map tiles, other origins, non-GET): passed through, never cached.
 */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const PREFIX = 'meshcore-web-';
const CACHE = `${PREFIX}${VERSION}`;
const SCOPE = new URL('./', self.location.href);
const INDEX = SCOPE.href;
const STATIC = ['manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

/** `./assets/…` URLs referenced from index.html (script src, link href, modulepreload). */
function assetUrls(html) {
  const urls = new Set();
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["']((?:\.\/)?assets\/[^"'?#]+)["']/g)) {
    urls.add(new URL(m[1], SCOPE).href);
  }
  return [...urls];
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const res = await fetch(INDEX, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`index.html: HTTP ${res.status}`);
      const html = await res.clone().text();
      await cache.put(INDEX, res);
      await cache.addAll([...assetUrls(html), ...STATIC.map((p) => new URL(p, SCOPE).href)]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    // keep the shell fresh: only the app's own index (the scope root) is stored
    const url = new URL(request.url);
    if (res.ok && url.origin === SCOPE.origin && (url.pathname === SCOPE.pathname || url.pathname === `${SCOPE.pathname}index.html`)) {
      await cache.put(INDEX, res.clone());
    }
    return res;
  } catch (err) {
    const cached = await cache.match(INDEX);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirstAsset(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request);
  const refresh = fetch(event.request).then(
    async (res) => {
      if (res.ok) await cache.put(event.request, res.clone());
      return res;
    },
    () => undefined,
  );
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  const res = await refresh;
  return res ?? Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin) return; // tiles (tile.openstreetmap.org etc.), CDNs: pass through
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (url.pathname.startsWith(`${SCOPE.pathname}assets/`)) {
    event.respondWith(cacheFirstAsset(event));
  }
});
