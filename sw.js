// Service worker: saves the app's files on the phone so it opens without internet.
// IMPORTANT: when you change any file, bump CACHE_VERSION so phones get the new copy.
const CACHE_VERSION = "planner-v8";

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

// First install: download and store every file. cache: "reload" skips the
// browser's own short-term cache, so a new version never stores old files.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: "reload" }))))
  );
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

// The app's own files: try the internet first (so updates show at once), and use
// the stored copy when offline or if the internet takes over 4 seconds.
// Other addresses (the laptop sync) are not touched.
const NETWORK_WAIT_MS = 4000;

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  const fromNetwork = fetch(req, { cache: "no-cache" }).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_WAIT_MS, null));
  try {
    const res = await Promise.race([fromNetwork, timeout]);
    if (res) return res;
  } catch (e) { /* offline: use the stored copy */ }
  const hit = await cache.match(req, { ignoreSearch: true });
  return hit || fromNetwork;
}
