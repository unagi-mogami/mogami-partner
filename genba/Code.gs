/**
 * もがみ 現場ノート ― 受付係（Google Apps Script）
 * 「やること」と「掃除当番」を保存し、期限を過ぎたら社員のスマホに通知します。
 * このファイルを丸ごと貼り付けて、ウェブアプリとしてデプロイするだけで動きます。
 * 設定（合言葉・社長の暗証番号）はアプリの画面から行います。ここは書き換えなくて大丈夫です。
 */
var APP_URL = "https://unagi-mogami.github.io/mogami-partner/genba/";
var LIB_URL = APP_URL + "webpush-lib.js";
var LIB_SHA = "95ce10bc14b5cffd1429aea43768595d4a24097acc88216bc540bcbc6479700e";
var TZ = "Asia/Tokyo";

var SCHEMA = {
  staff:    ["id:s", "name:s", "leader:b", "owner:b", "active:b"],
  tasks:    ["id:s", "what:s", "who:s", "due:n", "by:s", "at:n", "done:b", "doneBy:s", "doneAt:n", "n1:n", "n2:n"],
  areas:    ["id:s", "name:s", "ord:n", "deadline:s", "d0:s", "d1:s", "d2:s", "d3:s", "d4:s", "d5:s", "d6:s"],
  cleanlog: ["key:s", "date:s", "area:s", "by:s", "at:n"],
  subs:     ["endpoint:s", "staff:s", "p256dh:s", "auth:s", "at:n", "ua:s"],
  flags:    ["key:s", "at:n"]
};

/* ---------- 入口 ---------- */
function doGet() {
  return ContentService.createTextOutput("もがみ現場ノート 受付係は動いています。");
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    out = handle(req);
  } catch (err) {
    out = { ok: false, err: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function handle(req) {
  var P = props();
  var a = req.action;
  if (a === "ping") return { ok: true, ready: !!P.SHEET_ID };
  if (a === "init") return init(req, P);
  if (!P.SHEET_ID) return { ok: false, err: "notready" };
  if (tooMany()) return { ok: false, err: "locked" };
  if (String(req.code || "") !== P.TEAM_CODE) { fail(); return { ok: false, err: "code" }; }

  var admin = /^admin|^save/.test(a);
  if (admin && String(req.pin || "") !== P.ADMIN_PIN) { fail(); return { ok: false, err: "pin" }; }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var db = open(P);
    var now = Date.now();
    switch (a) {
      case "state": break;
      case "adminCheck": break;
      case "addTask": {
        var what = clean(req.what, 80), who = String(req.who || ""), due = Number(req.due);
        if (!what || !who || !(due > 0)) return { ok: false, err: "input" };
        if (!staffById(db, who)) return { ok: false, err: "input" };
        var t = { id: Utilities.getUuid().slice(0, 8), what: what, who: who, due: due, by: String(req.by || ""), at: now, done: false, doneBy: "", doneAt: 0, n1: 0, n2: 0 };
        db.tasks.push(t); save(db, "tasks");
        if (t.who !== t.by) {
          var byName = (staffById(db, t.by) || {}).name || "";
          try { push(db, P, [t.who], { title: "📝 新しいやること", body: t.what + "（期限 " + hm(t.due) + "）" + (byName ? " ／ " + byName + "さんから" : ""), tag: "t" + t.id, url: APP_URL + "#task-" + t.id }); } catch (x) {}
        }
        break;
      }
      case "doneTask": case "undoTask": case "delTask": {
        var i = indexBy(db.tasks, "id", req.id);
        if (i < 0) break;
        if (a === "delTask") db.tasks.splice(i, 1);
        else if (a === "doneTask") { db.tasks[i].done = true; db.tasks[i].doneBy = String(req.by || ""); db.tasks[i].doneAt = now; }
        else { db.tasks[i].done = false; db.tasks[i].doneAt = 0; }
        save(db, "tasks");
        break;
      }
      case "cleanDone": case "cleanUndo": {
        var key = today() + "_" + req.area;
        var j = indexBy(db.cleanlog, "key", key);
        if (a === "cleanDone" && j < 0) db.cleanlog.push({ key: key, date: today(), area: String(req.area), by: String(req.by || ""), at: now });
        if (a === "cleanUndo" && j >= 0) db.cleanlog.splice(j, 1);
        save(db, "cleanlog");
        break;
      }
      case "subscribe": {
        var s = req.sub || {}, k = s.keys || {};
        if (!/^https:\/\//.test(s.endpoint || "") || !k.p256dh || !k.auth || !staffById(db, req.staff)) return { ok: false, err: "input" };
        var si = indexBy(db.subs, "endpoint", s.endpoint);
        var row = { endpoint: s.endpoint, staff: String(req.staff), p256dh: k.p256dh, auth: k.auth, at: now, ua: clean(req.ua, 60) };
        if (si >= 0) db.subs[si] = row; else db.subs.push(row);
        save(db, "subs");
        break;
      }
      case "unsubscribe": {
        var ui = indexBy(db.subs, "endpoint", req.endpoint);
        if (ui >= 0) { db.subs.splice(ui, 1); save(db, "subs"); }
        break;
      }
      case "testPush": {
        var r = push(db, P, [String(req.staff)], { title: "🔔 通知のテスト", body: "この通知が見えていれば設定は完了です。", tag: "test", url: APP_URL });
        return { ok: true, sent: r.sent, failed: r.failed, state: state(db, P) };
      }
      case "saveStaff": {
        var list = (req.staff || []).slice(0, 60).map(function (x) {
          return { id: String(x.id || Utilities.getUuid().slice(0, 8)), name: clean(x.name, 20), leader: !!x.leader, owner: !!x.owner, active: x.active !== false };
        }).filter(function (x) { return x.name; });
        if (!list.some(function (x) { return x.owner && x.active; })) return { ok: false, err: "noowner" };
        db.staff = list; save(db, "staff");
        break;
      }
      case "saveAreas": {
        db.areas = (req.areas || []).slice(0, 40).map(function (x, n) {
          var r = { id: String(x.id || Utilities.getUuid().slice(0, 8)), name: clean(x.name, 20), ord: n, deadline: /^\d{2}:\d{2}$/.test(x.deadline || "") ? x.deadline : "06:00" };
          for (var d = 0; d < 7; d++) r["d" + d] = String((x.days || [])[d] || "");
          return r;
        }).filter(function (x) { return x.name; });
        save(db, "areas");
        break;
      }
      case "saveConfig": {
        var sp = PropertiesService.getScriptProperties();
        var esc = Math.round(Number(req.escMin));
        if (esc >= 5 && esc <= 240) sp.setProperty("ESC_MIN", String(esc));
        if (/^\d{2}:\d{2}$/.test(req.summaryTime || "")) sp.setProperty("SUMMARY_TIME", req.summaryTime);
        if (/^\d{4}$/.test(req.newPin || "")) sp.setProperty("ADMIN_PIN", req.newPin);
        if (String(req.newCode || "").length >= 4) sp.setProperty("TEAM_CODE", clean(req.newCode, 40));
        P = props();
        break;
      }
      default: return { ok: false, err: "action" };
    }
    return { ok: true, state: state(db, P) };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 最初の設定（アプリの「社長の初期設定」から1回だけ） ---------- */
function init(req, P) {
  if (P.SHEET_ID) return { ok: false, err: "already" };
  var code = clean(req.code, 40), pin = String(req.pin || ""), name = clean(req.name, 20);
  if (code.length < 4 || !/^\d{4}$/.test(pin) || !name) return { ok: false, err: "input" };
  lib();
  var keys = WP.genKeys();
  var ss = SpreadsheetApp.create("もがみ現場ノート（データ）");
  var sp = PropertiesService.getScriptProperties();
  sp.setProperties({ SHEET_ID: ss.getId(), TEAM_CODE: code, ADMIN_PIN: pin, VAPID_PUB: keys.publicKey, VAPID_PRIV: keys.privateKey, ESC_MIN: "30", SUMMARY_TIME: "07:00" });
  P = props();
  var db = open(P);
  var ownerId = Utilities.getUuid().slice(0, 8);
  db.staff = [{ id: ownerId, name: name, leader: true, owner: true, active: true }];
  save(db, "staff");
  db.areas = ["トイレ", "ゴミ箱", "配達車"].map(function (n, i) { return { id: "a" + (i + 1), name: n, ord: i, deadline: "06:00", d0: "", d1: "", d2: "", d3: "", d4: "", d5: "", d6: "" }; });
  save(db, "areas");
  var trig = true;
  try { setupTrigger(); } catch (x) { trig = false; }
  return { ok: true, ownerId: ownerId, trigger: trig, state: state(db, P) };
}

/** 自動チェックが動いていない時だけ、エディタでこの関数を1回実行してください */
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "tick") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("tick").timeBased().everyMinutes(5).create();
}

/* ---------- 5分ごとの自動チェック ---------- */
function tick() {
  var P = props();
  if (!P.SHEET_ID) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    var db = open(P), now = Date.now(), esc = Number(P.ESC_MIN || 30) * 60000;
    var leaders = db.staff.filter(function (s) { return s.active && s.leader; }).map(function (s) { return s.id; });
    var owners = db.staff.filter(function (s) { return s.active && s.owner; }).map(function (s) { return s.id; });
    var nm = function (id) { return (staffById(db, id) || {}).name || "（不明）"; };
    var dirtyT = false, dirtyF = false;

    db.tasks.forEach(function (t) {
      if (t.done) return;
      if (!t.n1 && t.due <= now) {
        push(db, P, [t.who], { title: "⏰ 期限です：" + t.what, body: "期限 " + hm(t.due) + "。終わったら「終わった」を押してください。", tag: "t" + t.id, url: APP_URL + "#task-" + t.id });
        t.n1 = now; dirtyT = true;
      }
      if (!t.n2 && t.due + esc <= now) {
        var to = leaders.filter(function (id) { return id !== t.who; });
        if (to.length) push(db, P, to, { title: "【未完了】" + nm(t.who) + "さん：" + t.what, body: "期限 " + hm(t.due) + " から" + P.ESC_MIN + "分過ぎています。", tag: "t2" + t.id, url: APP_URL + "#task-" + t.id });
        t.n2 = now; dirtyT = true;
      }
    });

    var d = today(), wd = weekday();
    db.areas.forEach(function (a) {
      var who = a["d" + wd];
      if (!who || cleanDone(db, d, a.id)) return;
      var dl = at(d, a.deadline);
      if (now >= dl && !flag(db, "c1_" + d + "_" + a.id)) {
        push(db, P, [who], { title: "🧹 掃除の時間を過ぎました：" + a.name, body: "今日の担当です（期限 " + a.deadline + "）。終わったら「掃除した」を押してください。", tag: "c" + a.id, url: APP_URL + "#clean" });
        setFlag(db, "c1_" + d + "_" + a.id, now); dirtyF = true;
      }
      if (now >= dl + esc && !flag(db, "c2_" + d + "_" + a.id)) {
        var to2 = leaders.filter(function (id) { return id !== who; });
        if (to2.length) push(db, P, to2, { title: "【未完了】" + nm(who) + "さん：" + a.name + "の掃除", body: "期限 " + a.deadline + " から" + P.ESC_MIN + "分過ぎています。", tag: "c2" + a.id, url: APP_URL + "#clean" });
        setFlag(db, "c2_" + d + "_" + a.id, now); dirtyF = true;
      }
    });

    if (now >= at(d, P.SUMMARY_TIME || "07:00") && !flag(db, "sum_" + d)) {
      var lateT = db.tasks.filter(function (t) { return !t.done && t.due <= now; });
      var lateC = db.areas.filter(function (a) { var w = a["d" + wd]; return w && !cleanDone(db, d, a.id) && now >= at(d, a.deadline); });
      var n = lateT.length + lateC.length;
      var lines = lateT.map(function (t) { return nm(t.who) + "：" + t.what; }).concat(lateC.map(function (a) { return nm(a["d" + wd]) + "：" + a.name + "の掃除"; }));
      push(db, P, owners, n ? { title: "【朝のまとめ】未完了 " + n + "件", body: lines.slice(0, 5).join(" ／ ") + (n > 5 ? " ほか" : ""), tag: "sum", url: APP_URL }
                            : { title: "【朝のまとめ】全部完了しています", body: "期限を過ぎたやること・掃除はありません。", tag: "sum", url: APP_URL });
      setFlag(db, "sum_" + d, now); dirtyF = true;

      // 1日1回、古い記録を片付ける（60日より前）
      var old = now - 60 * 864e5;
      db.tasks = db.tasks.filter(function (t) { return !(t.done && t.doneAt < old); }); dirtyT = true;
      db.cleanlog = db.cleanlog.filter(function (c) { return c.at >= old; }); save(db, "cleanlog");
      db.flags = db.flags.filter(function (f) { return f.at >= now - 7 * 864e5; });
    }
    if (dirtyT) save(db, "tasks");
    if (dirtyF) save(db, "flags");
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 通知を送る ---------- */
function push(db, P, staffIds, msg) {
  var subs = db.subs.filter(function (s) { return staffIds.indexOf(s.staff) >= 0; });
  var res = { sent: 0, failed: 0 };
  if (!subs.length) return res;
  lib();
  var exp = Math.floor(Date.now() / 1000) + 12 * 3600, gone = [];
  subs.forEach(function (s) {
    try {
      var body = WP.toSigned(WP.encrypt(JSON.stringify(msg), s.p256dh, s.auth));
      var r = UrlFetchApp.fetch(s.endpoint, {
        method: "post", payload: body, contentType: "application/octet-stream", muteHttpExceptions: true,
        headers: { "Content-Encoding": "aes128gcm", "TTL": "43200", "Urgency": "high", "Authorization": WP.vapidHeader(s.endpoint, APP_URL, P.VAPID_PUB, P.VAPID_PRIV, exp) }
      });
      var c = r.getResponseCode();
      if (c >= 200 && c < 300) res.sent++;
      else { res.failed++; if (c === 404 || c === 410) gone.push(s.endpoint); }
    } catch (x) { res.failed++; }
  });
  if (gone.length) { db.subs = db.subs.filter(function (s) { return gone.indexOf(s.endpoint) < 0; }); save(db, "subs"); }
  return res;
}

function lib() {
  if (globalThis.WP) return;
  globalThis.crypto = globalThis.crypto || {
    getRandomValues: function (a) {
      var i = 0;
      while (i < a.length) {
        var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid() + Date.now());
        for (var j = 0; j < d.length && i < a.length; j++, i++) a[i] = d[j] & 255;
      }
      return a;
    }
  };
  var cache = CacheService.getScriptCache();
  var txt = cache.get("wplib");
  if (!txt || sha(txt) !== LIB_SHA) {
    txt = UrlFetchApp.fetch(LIB_URL).getContentText("UTF-8");
    if (sha(txt) !== LIB_SHA) throw new Error("通知部品の確認に失敗しました");
    try { cache.put("wplib", txt, 21600); } catch (x) {}
  }
  (0, eval)(txt);
}

function sha(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ("0" + (b & 255).toString(16)).slice(-2); }).join("");
}

/* ---------- 画面に返す内容 ---------- */
function state(db, P) {
  var now = Date.now(), recent = now - 3 * 864e5, d = today();
  var notif = {};
  db.subs.forEach(function (s) { notif[s.staff] = (notif[s.staff] || 0) + 1; });
  return {
    now: now, today: d, weekday: weekday(),
    staff: db.staff,
    tasks: db.tasks.filter(function (t) { return !t.done || t.doneAt >= recent; }),
    areas: db.areas.slice().sort(function (a, b) { return a.ord - b.ord; }),
    clean: db.cleanlog.filter(function (c) { return c.date === d; }),
    notif: notif,
    config: { escMin: Number(P.ESC_MIN || 30), summaryTime: P.SUMMARY_TIME || "07:00", vapid: P.VAPID_PUB }
  };
}

/* ---------- スプレッドシートの読み書き ---------- */
function open(P) {
  var ss = SpreadsheetApp.openById(P.SHEET_ID), db = { _ss: ss };
  Object.keys(SCHEMA).forEach(function (name) { db[name] = readTable(ss, name); });
  return db;
}
function sheet(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    var cols = SCHEMA[name].map(function (c) { return c.split(":")[0]; });
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight("bold");
    sh.setFrozenRows(1);
    var first = ss.getSheetByName("シート1") || ss.getSheetByName("Sheet1");
    if (first && ss.getSheets().length > 1) ss.deleteSheet(first);
  }
  return sh;
}
function readTable(ss, name) {
  var sh = sheet(ss, name), cols = SCHEMA[name];
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, cols.length).getValues().map(function (r) {
    var o = {};
    cols.forEach(function (c, i) {
      var p = c.split(":"), v = r[i];
      o[p[0]] = p[1] === "n" ? (Number(v) || 0) : p[1] === "b" ? (v === true || v === "TRUE" || v === "true") : String(v);
    });
    return o;
  }).filter(function (o) { return o[cols[0].split(":")[0]]; });
}
function save(db, name) {
  var sh = sheet(db._ss, name), cols = SCHEMA[name];
  var rows = db[name].map(function (o) {
    return cols.map(function (c) { var p = c.split(":"), v = o[p[0]]; return p[1] === "b" ? (v ? "TRUE" : "FALSE") : String(v == null ? "" : v); });
  });
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, cols.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, cols.length).setNumberFormat("@").setValues(rows);
}

/* ---------- 小さな道具 ---------- */
function props() { return PropertiesService.getScriptProperties().getProperties(); }
function clean(s, n) { return String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n); }
function indexBy(arr, k, v) { for (var i = 0; i < arr.length; i++) if (arr[i][k] === String(v)) return i; return -1; }
function staffById(db, id) { for (var i = 0; i < db.staff.length; i++) if (db.staff[i].id === String(id) && db.staff[i].active) return db.staff[i]; return null; }
function cleanDone(db, d, area) { return indexBy(db.cleanlog, "key", d + "_" + area) >= 0; }
function flag(db, k) { return indexBy(db.flags, "key", k) >= 0; }
function setFlag(db, k, t) { db.flags.push({ key: k, at: t }); }
function today() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd"); }
function weekday() { return Number(Utilities.formatDate(new Date(), TZ, "u")) % 7; }
function at(d, t) { return new Date(d + "T" + t + ":00+09:00").getTime(); }
function hm(ms) { return Utilities.formatDate(new Date(ms), TZ, "H:mm"); }
function tooMany() { return Number(CacheService.getScriptCache().get("fails") || 0) >= 15; }
function fail() { var c = CacheService.getScriptCache(); c.put("fails", String(Number(c.get("fails") || 0) + 1), 900); }
