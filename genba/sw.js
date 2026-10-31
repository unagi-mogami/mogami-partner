/* もがみ 現場ノート：通知を受け取って表示する */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (x) { m = { body: e.data ? e.data.text() : "" }; }
  const title = m.title || "現場ノート";
  const alarm = m.alarm || "normal";            // normal＝ふつう / repeat＝アラーム / silent＝音なし
  // アプリを開いている時は、画面側でも音を鳴らす
  const tell = self.clients.matchAll({ type: "window" }).then(list => list.forEach(c => c.postMessage({ type: "push", title, alarm })));
  // iPhoneは同じtagの通知を「上書き」すると音を鳴らさないので、通知ごとに別のtagにする（毎回鳴らす）
  const opt = {
    body: m.body || "開いて確認してください。",
    tag: (m.tag || "g") + "-" + Date.now(),
    icon: "icon-192.png",
    badge: "icon-192.png",
    data: { url: m.url || self.registration.scope }
  };
  if (alarm === "silent") opt.silent = true;
  else opt.vibrate = alarm === "repeat" ? [400, 150, 400, 150, 400, 150, 800] : [200, 100, 200];
  if (alarm === "repeat") opt.requireInteraction = true;
  e.waitUntil(Promise.all([tell, self.registration.showNotification(title, opt)]));
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
