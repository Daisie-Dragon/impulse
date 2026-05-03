/* ═══════════════════════════════════════════════════════
   IMPULSE — sw.js  (Service Worker)

   This file runs silently in the background.
   Its job: cache all the app's files the first time
   you load it, so that every time after — even with
   no internet — the app loads instantly from your phone.

   You never need to edit this file directly.
   Just bump the CACHE_NAME version when we push updates.
═══════════════════════════════════════════════════════ */

const CACHE_NAME = 'impulse-v5.1';

// All the files that make up the app
const ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.json',
  // Icons are added here once we have them
];

/* ── Install ──────────────────────────────────────────
   Fires once when the service worker is first installed.
   Downloads and caches all the app files.
─────────────────────────────────────────────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

/* ── Activate ─────────────────────────────────────────
   Fires after install. Cleans up any old caches from
   previous versions of the app.
─────────────────────────────────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

/* ── Fetch ────────────────────────────────────────────
   Intercepts every network request the app makes.
   Serves the cached version if available (offline-first),
   falls back to the network if not.
─────────────────────────────────────────────────────── */
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(cached => cached || fetch(event.request))
  );
});
