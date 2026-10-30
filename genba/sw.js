/* もがみ 現場ノート：通知を受け取って表示する */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (x) { m = { body: e.data ? e.data.text() : "" }; }
  const title = m.title || "現場ノート";
  const alarm = m.alarm || "normal";            // normal＝ふつう / repeat＝しつこく / silent＝音なし
  e.waitUntil(self.registration.showNotification(title, {
    body: m.body || "開いて確認してください。",
    tag: m.tag || undefined,
    renotify: !!m.tag && alarm !== "silent",
    silent: alarm === "silent",
    requireInteraction: alarm === "repeat",
    vibrate: alarm === "silent" ? undefined : alarm === "repeat" ? [400, 150, 400, 150, 400, 150, 800] : [200, 100, 200],
    icon: "icon-192.png",
    badge: "icon-192.png",
    data: { url: m.url || self.registration.scope }
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope)) { c.postMessage({ url }); return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
