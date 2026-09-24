/**
 * Service Worker for Drug Tracker.
 *
 * Caches the app shell (HTML + JS + CSS + icons) so the app keeps
 * working offline after the first load. Uses a stale-while-revalidate
 * strategy: serve from cache when available, and refresh in the
 * background for next time.
 *
 * The cache name includes the version so a deploy invalidates the
 * old cache automatically.
 *
 * Update flow (M10): a new SW installs in the background but does NOT
 * `skipWaiting()` automatically — it waits until the app (main.tsx +
 * UpdatePrompt) sends a `SKIP_WAITING` message. This lets us show a
 * "تحديث جديد متاح" toast with a refresh button instead of silently
 * swapping the code under the user (which could break a running alarm
 * or lose in-progress form state).
 *
 * #16: navigation requests (HTML page loads, including those with query
 * strings like `/?tab=stock`) fall back to the cached `index.html` within
 * the current deployment scope when the network fails, so the manifest
 * shortcuts work offline.
 *
 * #23: Vite injects the complete emitted JS/CSS asset list into
 * `PRECACHE_ASSETS` during `generateBundle()`, including dynamic-import
 * chunks that are not directly referenced by index.html.
 */

const CACHE_NAME = 'drug-tracker-v5';
const PRECACHE_ASSETS = [];

// App shell — static files (no content hash) we want available offline.
const APP_BASE_URL = new URL('./', self.location.href);
const APP_BASE_PATH = APP_BASE_URL.pathname;

function appUrl(path) {
  return new URL(path.replace(/^\/+/, ''), APP_BASE_URL).href;
}

// Static files that are independent of Vite's content hashing.
const APP_SHELL = [
  appUrl(''),
  appUrl('index.html'),
  appUrl('manifest.json'),
  appUrl('assets/icons/icon.svg'),
  appUrl('assets/icons/icon-192.png'),
  appUrl('assets/icons/icon-512.png'),
  appUrl('assets/icons/icon-maskable-192.png'),
  appUrl('assets/icons/icon-maskable-512.png'),
];


self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] Failed to cache', url, err.message);
          })
        )
      );

      // Vite injects every emitted JS/CSS file into this list during
      // generateBundle, including content-hashed dynamic-import chunks.
      await Promise.all(
        PRECACHE_ASSETS.map((relativePath) => {
          const url = appUrl(relativePath);
          return cache.add(url).catch((err) => {
            console.warn('[SW] Failed to cache built asset', url, err.message);
          });
        })
      );
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Delete old caches from previous versions.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
      // Take control of all clients immediately once activated.
      self.clients.claim();
    })()
  );
});

// M10: allow the page to trigger the new SW to activate immediately.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests. Other methods (POST, PUT, etc.) bypass
  // the service worker.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Skip cross-origin requests — let the browser handle them.
  if (url.origin !== self.location.origin) return;

  // Skip the Vite HMR WebSocket and dev-only endpoints. (These never
  // run in production since the SW is only registered in prod, but kept
  // as defensive code in case the SW is accidentally registered in dev.)
  const relativePath = url.pathname.startsWith(APP_BASE_PATH)
    ? url.pathname.slice(APP_BASE_PATH.length)
    : url.pathname;
  if (relativePath.startsWith('@vite') || relativePath.startsWith('__vite')) {
    return;
  }

  // #16: navigation requests (HTML page loads, including those with query
  // strings like /?tab=stock) need a cache fallback that ignores the
  // query string — the cached /index.html serves the same app shell
  // regardless of the query. Without this, an offline navigation to
  // /?tab=logs would be a cache miss (the cache has / and /index.html
  // but not /?tab=logs) and the browser would show a network error.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          // Try the network first so a real online navigation gets the
          // freshest HTML.
          const netResp = await fetch(request);
          if (netResp && netResp.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(appUrl('index.html'), netResp.clone()).catch(() => {});
            return netResp;
          }
        } catch {
          // Network failed — fall through to cache.
        }
        // Offline (or network error) → serve the cached app shell.
        const cache = await caches.open(CACHE_NAME);
        const cached =
          (await cache.match(appUrl('index.html'))) || (await cache.match(appUrl('')));
        if (cached) return cached;
        // Nothing cached — this is a genuine offline-first-visit failure.
        return new Response(
          '<h1>Offline</h1><p>The app is not cached yet. Go online once to enable offline use.</p>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      })()
    );
    return;
  }

  // Stale-while-revalidate strategy for all other GET requests (JS, CSS,
  // icons, manifest, etc.).
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);

      // Refresh the cache in the background.
      const fetchPromise = fetch(request)
        .then((response) => {
          // Only cache successful responses.
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            cache.put(request, clone).catch((err) => {
              console.warn('[SW] Failed to update cache for', request.url, err.message);
            });
          }
          return response;
        })
        .catch(() => {
          // Network failed — fall back to cache (already returned below).
          return null;
        });

      // Return cached version immediately if available; otherwise wait
      // for the network fetch.
      return cached || fetchPromise;
    })()
  );
});
