/**
 * Service Worker for النغنغة (Drug Tracker)
 *
 * Caches the app shell (HTML + JS + CSS + icons) so the app keeps
 * working offline after the first load. Uses a stale-while-revalidate
 * strategy: serve from cache when available, and refresh in the
 * background for next time.
 *
 * The cache name includes the version so a deploy invalidates the
 * old cache automatically.
 */

const CACHE_NAME = 'naghnagha-v1';

// App shell — files we want available offline.
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-192.png',
  '/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Use addAll but tolerate individual failures (e.g., when an
      // icon is missing). The catch() per-request ensures the install
      // doesn't fail entirely if one asset is missing.
      await Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] Failed to cache', url, err.message);
          })
        )
      );
      // Activate immediately without waiting for old SW to die.
      self.skipWaiting();
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
      // Take control of all clients immediately.
      self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests. Other methods (POST, PUT, etc.) bypass
  // the service worker.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Skip cross-origin requests (e.g., Google Fonts CDN) — let the
  // browser handle them. The app still works without them offline
  // because Tailwind + Cairo font loading is progressive enhancement.
  if (url.origin !== self.location.origin) return;

  // Skip the Vite HMR WebSocket and dev-only endpoints in dev mode.
  if (url.pathname.startsWith('/@vite') || url.pathname.startsWith('/__vite')) {
    return;
  }

  // Stale-while-revalidate strategy.
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
