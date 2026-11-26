// Service worker: saves the app's files on the phone so it opens without internet.
// IMPORTANT: when you change any file, bump CACHE_VERSION so phones get the new copy.
const CACHE_VERSION = "planner-v7";

const FILES = [
  "./",
  "index.html",
  "css/styles.css",
  "js/store.js",
  "js/plan.js",
  "js/today.js",
  "js/sync.js",
  "js/settings.js",
  "js/app.js",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

// First install: download and store every file.
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(FILES)));
  self.skipWaiting();
});

// New version: delete old stored copies.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Every request: use the stored copy if we have it, otherwise go to the network.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true })
      .then((hit) => hit || fetch(event.request))
  );
});
