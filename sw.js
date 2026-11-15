/* 页面离线缓存：界面文件走“网络优先，失败用缓存”，离线模型（/offline/<包>/ 的模型分片与运行时）走缓存优先。 */
const SHELL_CACHE = "edgetts-shell-v2";
const SHELL = [
  "/", "/index.html", "/manifest.webmanifest", "/icon.svg",
  "/js/app.js", "/js/edge-tts.js", "/js/voices.js", "/js/offline-tts.js", "/js/vendor/lucide.min.js",
  "/offline/tts-worker.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("edgetts-shell-") && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (/^\/offline\/[^/]+\/(model\/|sherpa-onnx-)/.test(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
    return;
  }

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === "navigate" ? caches.match("/index.html") : Response.error())))
  );
});
