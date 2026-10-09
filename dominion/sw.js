// DOOMSTAR: DOMINION — offline cache. Every file the game needs is cached
// on install; requests are answered from the cache first and refreshed
// from the network behind it. Bump VERSION when files are added or renamed.
const VERSION = "dominion-v1";
const FILES = ["./", "index.html", "sim.js", "ai.js", "campaign.js", "online.js", "holo.js", "sounds.js",
  "vendor/howler.core.min.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then((c) => c.match(e.request).then((hit) => {
    const net = fetch(e.request).then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  })));
});
