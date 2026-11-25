/**
 * sw.js — "service worker": lets the app open without internet.
 *
 * The browser runs this file in the background. It keeps a copy of the app
 * and the field data on the device:
 *  - the app's own files: try the internet first (so updates arrive), use the
 *    saved copy when offline or when the internet takes longer than 4 seconds;
 *  - the libraries from the CDN (fixed versions that never change): use the
 *    saved copy first, it is always correct;
 *  - map tiles and place search: never saved (they need the internet anyway).
 *
 * After changing app files, raise VERSION so old copies are thrown away.
 */
const VERSION = 'drought-watch-v7';

const APP_FILES = [
  './', './index.html', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/apple-touch-icon.png', './css/style.css',
  './js/app.js', './js/data.js', './js/analysis.js', './js/visuals.js', './js/charts.js',
  './js/map.js', './js/geocode.js', './js/i18n.js', './js/lang.js', './js/charts-lite.js',
  './js/summary.js', './summary.html',
  './data/fields.json', './data/de-uelzen.csv', './data/it-mantova.csv', './data/us-illinois.csv',
];
// Libraries are saved the first time they are used (see cacheFirst), not up front,
// so light mode never downloads them.
const LIBRARIES = [];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll([...APP_FILES, ...LIBRARIES])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  } else if (url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'unpkg.com') {
    event.respondWith(cacheFirst(request));
  }
  // Everything else (map tiles, place search) goes straight to the internet.
});

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  // 'no-cache' = always ask the server if there is a newer version (cheap when
  // nothing changed), so an update never mixes old and new files.
  const fromNetwork = fetch(request, { cache: 'no-cache' }).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, 4000));
  try {
    const response = await Promise.race([fromNetwork, timeout]);
    if (response) return response;
    return (await cache.match(request, { ignoreSearch: true })) || (await fromNetwork);
  } catch {
    const saved = await cache.match(request, { ignoreSearch: true });
    if (saved) return saved;
    throw new Error('Offline and not saved: ' + request.url);
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const saved = await cache.match(request);
  if (saved) return saved;
  const response = await fetch(request);
  if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
  return response;
}
