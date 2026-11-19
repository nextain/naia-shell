/* Cache only the public app shell and fingerprinted build assets. */
const SW_BUILD_VERSION = "__NAIA_SW_VERSION__";
const CACHE_VERSION = SW_BUILD_VERSION.startsWith("__") ? "dev" : SW_BUILD_VERSION;
const CACHE = `naia-shell-${CACHE_VERSION}`;
const rawSwPath = typeof self.location?.pathname === "string" ? self.location.pathname : "/sw.js";
const baseDir = rawSwPath.endsWith("/sw.js") ? rawSwPath.slice(0, -5) || "/" : "/";
const normalizedBase = baseDir.endsWith("/") ? baseDir : `${baseDir}/`;
const shellUrl = new URL(normalizedBase === "/" ? "/" : `${normalizedBase}index.html`, self.location.origin).href;
const escapedBase = normalizedBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const assetPath = new RegExp(`^${escapedBase}assets\\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\\.(?:js|mjs|css|woff2?)$`);
const htmlAssetRe = new RegExp(`(?:src|href)=["'](${escapedBase}assets\\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\\.(?:js|mjs|css|woff2?))["']`, "g");

function cacheable(response, expectedUrl) {
  const policy = response.headers.get("cache-control") || "";
  return response.ok && response.type === "basic" && response.url === expectedUrl &&
    !/\b(?:private|no-store)\b/i.test(policy);
}
function isRetiredWorker() {
  return Boolean(self.serviceWorker && self.serviceWorker.state === "redundant");
}
async function savePublic(url, cache, cacheMode = "default") {
  const response = await fetch(url, {
    credentials: "omit",
    redirect: "error",
    cache: cacheMode,
  });
  if (cache && !isRetiredWorker() && cacheable(response, url)) {
    await cache.put(url, response.clone());
  }
  return response;
}
function isShellNavigation(request, url) {
  if (request.mode !== "navigate") return false;
  if (url.pathname.startsWith("/e2e/") || url.pathname.startsWith("/hosted-apps/")) return false;
  // Mini-app bundles shipped under the shell base (`/app/hosted-apps/...`) are their own pages (R35).
  if (url.pathname.startsWith(`${normalizedBase}hosted-apps/`)) return false;
  if (normalizedBase !== "/") {
    const prefixNoSlash = normalizedBase.slice(0, -1);
    if (url.pathname !== prefixNoSlash && !url.pathname.startsWith(normalizedBase)) return false;
  }
  return url.pathname === "/" || url.pathname === "/index.html" || !/\.[^/]+$/.test(url.pathname) || url.pathname.endsWith("/index.html");
}
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const shell = await savePublic(shellUrl, cache, "no-cache");
    const html = await shell.text();
    const urls = [...html.matchAll(htmlAssetRe)]
      .map((match) => new URL(match[1], self.location.origin).href);
    await Promise.all(urls.map((url) => savePublic(url, cache)));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const staleKeys = keys.filter((key) => key !== CACHE);
    const deleted = await Promise.all(staleKeys.map((key) => caches.delete(key)));
    await self.clients.claim();
    if (deleted.some(Boolean)) {
      const windows = await self.clients.matchAll({ type: "window" });
      // Do not await navigate() inside waitUntil(): navigation fetch waits for
      // this worker to transition from "activating" to "activated", which would deadlock.
      for (const client of windows) {
        if (typeof client.navigate === "function" && client.url) {
          client.navigate(client.url).catch(() => {});
        }
      }
    }
  })());
});
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || req.headers.has("authorization")) return;
  if (isShellNavigation(req, url)) {
    event.respondWith((async () => {
      const cache = isRetiredWorker() ? null : await caches.open(CACHE);
      try {
        const response = await savePublic(shellUrl, cache, "no-cache");
        if (response.ok) return response;
        return (cache && (await cache.match(shellUrl))) || response;
      } catch {
        return (cache && (await cache.match(shellUrl))) || Response.error();
      }
    })());
    return;
  }
  if (url.search || !assetPath.test(url.pathname)) return;
  event.respondWith((async () => {
    const cache = isRetiredWorker() ? null : await caches.open(CACHE);
    const cached = cache ? await cache.match(url.href) : undefined;
    return cached || savePublic(url.href, cache);
  })());
});

// Capture chunks requested before this worker took control on the first visit.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "CACHE_PUBLIC_ASSETS" || !Array.isArray(event.data.urls)) return;
  if (isRetiredWorker() || self.registration?.installing || self.registration?.waiting) return;
  const urls = event.data.urls.slice(0, 500).filter((value) => {
    try {
      const url = new URL(value);
      return url.origin === self.location.origin && !url.search && assetPath.test(url.pathname);
    } catch { return false; }
  });
  event.waitUntil((async () => {
    if (isRetiredWorker() || self.registration?.installing || self.registration?.waiting) return;
    const cache = await caches.open(CACHE);
    await Promise.all(urls.map(async (url) => {
      if (isRetiredWorker()) return;
      if (!(await cache.match(url))) await savePublic(url, cache);
    }));
  })());
});
