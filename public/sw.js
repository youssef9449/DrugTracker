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
 * strings like `/?tab=stock`) fall back to the cached `/index.html`
 * when the network fails, so the manifest shortcuts work offline.
 *
 * #23: the built JS/CSS bundles (content-hashed names) are pre-cached
 * on install by parsing `/index.html` for `<script src>` / `<link href>`
 * URLs and adding them to the cache. This makes the app work offline
 * on the first visit (not just the second).
 */

const CACHE_NAME = 'drug-tracker-v5';

// App shell — static files (no content hash) we want available offline.
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/assets/icons/icon.svg',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/icons/icon-maskable-192.png',
  '/assets/icons/icon-maskable-512.png',
];

/**
 * #23: fetch /index.html and parse out the built JS/CSS bundle URLs
 * (which have content-hashed names like `index-Cgs4Wuha.js` and are
 * unknown at SW-authoring time). Returns an array of absolute URL
 * strings to pre-cache. On failure returns an empty array (the SW
 * install continues; the bundles will be cached on first fetch via
 * the stale-while-revalidate path).
 */
async function discoverBuiltAssets(): Promise<string[]> {
  try {
    const resp = await fetch('/index.html', { cache: 'no-store' });
    if (!resp.ok) return [];
    const html = await resp.text();
    const assets: string[] = [];
    // Match <script src="/assets/index-XXXX.js"> (Vite's module entry).
    // The relative `./` base means the src may start with `./` or `/`.
    const scriptMatches = html.matchAll(
      /<script[^>]+src=["']([^"']+\.js)["']/g
    );
    for (const m of scriptMatches) {
      assets.push(new URL(m[1], self.location.origin).href);
    }
    // Match <link href="/assets/index-XXXX.css"> (Vite's CSS).
    const linkMatches = html.matchAll(
      /<link[^>]+href=["']([^"']+\.css)["']/g
    );
    for (const m of linkMatches) {
      assets.push(new URL(m[1], self.location.origin).href);
    }
    return assets;
  } catch {
    return [];
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Pre-cache the static app shell, tolerating individual failures.
      await Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] Failed to cache', url, err.message);
          })
        )
      );
      // #23: also pre-cache the built JS/CSS bundles so the app works
      // offline on the FIRST visit (not just the second). We discover
      // their hashed names by parsing /index.html.
      const builtAssets = await discoverBuiltAssets();
      await Promise.all(
        builtAssets.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] Failed to cache built asset', url, err.message);
          })
        )
      );
      // M10: do NOT skipWaiting() automatically. The new SW stays in
      // the "waiting" state until the app (UpdatePrompt) sends
      // SKIP_WAITING, so we can prompt the user before swapping.
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
  if (url.pathname.startsWith('/@vite') || url.pathname.startsWith('/__vite')) {
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
            cache.put('/index.html', netResp.clone()).catch(() => {});
            return netResp;
          }
        } catch {
          // Network failed — fall through to cache.
        }
        // Offline (or network error) → serve the cached app shell.
        const cache = await caches.open(CACHE_NAME);
        const cached =
          (await cache.match('/index.html')) || (await cache.match('/'));
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
