// Service worker of the viewer: lets it open without a connection and be installed as an app.
//
// Every file of the viewer is asked from the network first, always revalidating with the server
// (a cheap "not modified" answer when unchanged), and a copy is kept. Without a connection — or
// when the network takes too long — the copy is used. So an update of the site is picked up at
// once and old and new files are never mixed; nothing here needs a version bump.
// Model files (data/, model/) are never stored: they are large and are read from the device.
const CACHE = "pvs-viewer";
const SLOW = 4000; // ms to wait for the network when a copy exists

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const rel = url.pathname.slice(scope.pathname.length);
  if (/^(data|model)\//.test(rel) || req.headers.has("range")) return;
  e.respondWith(answer(url));
});

async function answer(url) {
  const cache = await caches.open(CACHE);
  const key = url.origin + url.pathname; // "?v=..." only breaks the browser's own cache
  const saved = await cache.match(key);
  const fresh = fetch(url.href, { cache: "no-cache" }).then((r) => {
    if (r.ok) cache.put(key, r.clone()).catch(() => {});
    return r;
  });
  if (!saved) return fresh;
  fresh.catch(() => {}); // handled below; avoids an unhandled rejection when the copy wins
  const timeout = new Promise((ok) => setTimeout(() => ok(null), SLOW));
  try {
    const r = await Promise.race([fresh, timeout]);
    return r && r.ok ? r : saved;
  } catch { return saved; }
}
