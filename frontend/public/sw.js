/* SVKD COIR offline service worker.
 * Cache the Expo single-page app shell and same-origin assets as they are used.
 */
const CACHE_PREFIX = "svkd-coir-offline-";
const CACHE_VERSION = "v2";
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const APP_SHELL = ["./", "./index.html", "./manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(APP_SHELL.map(async (path) => {
      try {
        const response = await fetch(path, { cache: "reload" });
        if (response.ok) await cache.put(path, response);
      } catch (_) {
        // Installation can still complete; runtime requests will be cached later.
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function cacheResponse(request, response) {
  if (!response || !response.ok || response.type === "opaque") return response;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Do not pretend backend/API requests succeeded while offline.
  if (url.pathname.includes("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put("./index.html", response.clone());
        }
        return response;
      } catch (_) {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match(request))
          || (await cache.match("./index.html"))
          || (await cache.match("./"))
          || new Response(
            "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><title>SVKD COIR</title></head><body><h2>SVKD COIR</h2><p>This page is not available offline yet. Connect once to the internet, open the app, and try again.</p></body></html>",
            { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 200 }
          );
      }
    })());
    return;
  }

  // Cache-first for versioned app assets; cache successful first-use requests.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;

    try {
      const response = await fetch(request);
      return await cacheResponse(request, response);
    } catch (_) {
      return new Response("", { status: 503, statusText: "Offline and resource not cached" });
    }
  })());
});
