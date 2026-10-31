/* Cache only the public app shell and fingerprinted build assets. */
const CACHE = "naia-shell-v1";
const shellUrl = new URL("/", self.location.origin).href;
const assetPath = /^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?)$/;

function cacheable(response, expectedUrl) {
  const policy = response.headers.get("cache-control") || "";
  return response.ok && response.type === "basic" && response.url === expectedUrl &&
    !/\b(?:private|no-store)\b/i.test(policy);
}
async function savePublic(url, cache) {
  const response = await fetch(url, { credentials: "omit", redirect: "error" });
  if (cacheable(response, url)) await cache.put(url, response.clone());
  return response;
}
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const shell = await savePublic(shellUrl, cache);
    const html = await shell.text();
    const urls = [...html.matchAll(/(?:src|href)=["'](\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?))["']/g)]
      .map((match) => new URL(match[1], self.location.origin).href);
    await Promise.all(urls.map((url) => savePublic(url, cache)));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("naia-shell-") && key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.search || req.headers.has("authorization")) return;
  if (req.mode === "navigate" && url.pathname === "/") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try { return await savePublic(shellUrl, cache); }
      catch { return (await cache.match(shellUrl)) || Response.error(); }
    })());
    return;
  }
  if (!assetPath.test(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    return (await cache.match(url.href)) || savePublic(url.href, cache);
  })());
});

// Capture chunks requested before this worker took control on the first visit.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "CACHE_PUBLIC_ASSETS" || !Array.isArray(event.data.urls)) return;
  const urls = event.data.urls.slice(0, 500).filter((value) => {
    try {
      const url = new URL(value);
      return url.origin === self.location.origin && !url.search && assetPath.test(url.pathname);
    } catch { return false; }
  });
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(urls.map(async (url) => {
      if (!(await cache.match(url))) await savePublic(url, cache);
    }));
  })());
});
