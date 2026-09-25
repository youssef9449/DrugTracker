/**
 * Service Worker for Drug Tracker.
 *
 * The build plugin in vite.config.ts replaces the explicit cache-version and
 * precache placeholders with content derived from the emitted production asset
 * graph. If that template contract is broken, the build fails rather than
 * silently shipping stale cache metadata.
 *
 * Update flow (M10): a new SW installs in the background but does NOT
 * skipWaiting() automatically. The page sends SKIP_WAITING after showing the
 * update prompt.
 */

const CACHE_NAME = 'drug-tracker-__CACHE_VERSION__';
const PRECACHE_ASSETS = /* __PRECACHE_ASSETS__ */ [];

const APP_BASE_URL = new URL('./', self.location.href);
const APP_BASE_PATH = APP_BASE_URL.pathname;

function appUrl(path) {
  return new URL(path.replace(/^\/+/, ''), APP_BASE_URL).href;
}

// HTML entry points and emitted JS/CSS are critical: any failure aborts
// installation so an incomplete worker cannot replace the active worker.
const CRITICAL_APP_SHELL = [
  appUrl(''),
  appUrl('index.html'),
  ...PRECACHE_ASSETS.map((relativePath) => appUrl(relativePath)),
];

// Decorative/installability resources are optional. Their failure is logged
// but must not prevent the worker from becoming active.
const OPTIONAL_APP_SHELL = [
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

      // No catch here: cache.addAll() rejection aborts the install transaction.
      await cache.addAll(CRITICAL_APP_SHELL);

      await Promise.all(
        OPTIONAL_APP_SHELL.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] Optional asset could not be cached', url, err?.message);
          })
        )
      );
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
      self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const relativePath = url.pathname.startsWith(APP_BASE_PATH)
    ? url.pathname.slice(APP_BASE_PATH.length)
    : url.pathname;
  if (relativePath.startsWith('@vite') || relativePath.startsWith('__vite')) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const netResp = await fetch(request);
          if (netResp && netResp.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(appUrl('index.html'), netResp.clone()).catch(() => {});
            return netResp;
          }
        } catch {
          // Network failed — fall through to cache.
        }

        const cache = await caches.open(CACHE_NAME);
        const cached =
          (await cache.match(appUrl('index.html'))) || (await cache.match(appUrl('')));
        if (cached) return cached;

        return new Response(
          '<h1>Offline</h1><p>The app is not cached yet. Go online once to enable offline use.</p>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);

      const fetchPromise = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            cache.put(request, clone).catch((err) => {
              console.warn(
                '[SW] Failed to update cache for',
                request.url,
                err?.message
              );
            });
          }
          return response;
        })
        .catch(() => null);

      return cached || fetchPromise;
    })()
  );
});
