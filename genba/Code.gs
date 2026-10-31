/**
 * もがみ 現場ノート ― 受付係（Google Apps Script）
 * 「やること」と「掃除当番」を保存し、期限の前と、期限を過ぎた時に社員のスマホへ通知します。
 * このファイルを丸ごと貼り付けて、ウェブアプリとしてデプロイするだけで動きます。
 * 設定（合言葉・社長の暗証番号）はアプリの画面から行います。ここは書き換えなくて大丈夫です。
 * 直したあとは「デプロイを管理」→ 鉛筆 → バージョン「新バージョン」→「デプロイ」で更新します（URLは変わりません）。
 */
var APP_URL = "https://unagi-mogami.github.io/mogami-partner/genba/";
var LIB_URL = APP_URL + "webpush-lib.js";
var LIB_SHA = "95ce10bc14b5cffd1429aea43768595d4a24097acc88216bc540bcbc6479700e";
var TZ = "Asia/Tokyo";
var STAMPS = { arigato: "🙏 ありがとう", otsukare: "💪 おつかれ！", sugoi: "✨ すごい！", tasukatta: "🙌 助かった", nice: "👍 ナイス", unagi: "🐟 うなぎのぼり！", odaiji: "🍵 お大事に", ryokai: "👌 了解", ganbare: "📣 がんばって！", yoroshiku: "🤝 よろしく！" };
var LEAD = 12 * 3600e3;          // 繰り返しのやることを、期限の何時間前に出すか
var DAY = 864e5;

var SCHEMA = {
  staff:    ["id:s", "name:s", "leader:b", "owner:b", "active:b", "icon:s", "bio:s"],
  tasks:    ["id:s", "what:s", "who:s", "due:n", "by:s", "at:n", "done:b", "doneBy:s", "doneAt:n", "n1:n", "n2:n", "mode:s", "doneMap:j", "remind:n", "n0:n", "series:s", "alarm:s", "nrep:n", "note:s", "lastNudge:j", "cat:s"],
  series:   ["id:s", "what:s", "who:s", "mode:s", "remind:n", "rule:j", "start:n", "last:n", "by:s", "at:n", "active:b", "alarm:s", "note:s", "rot:j", "cat:s", "duty:b"],
  areas:    ["id:s", "name:s", "ord:n", "deadline:s", "d0:s", "d1:s", "d2:s", "d3:s", "d4:s", "d5:s", "d6:s"],
  cleanlog: ["key:s", "date:s", "area:s", "by:s", "at:n"],
  notices:  ["id:s", "kind:s", "who:s", "from:s", "to:s", "note:s", "notifyAt:n", "notifyTo:s", "sent:n", "by:s", "at:n", "to2:s"],
  comments: ["id:s", "target:s", "from:s", "text:s", "at:n"],
  stamps:   ["id:s", "target:s", "stamp:s", "from:s", "to:s", "at:n"],
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
    if (db.areas.length) { migrateAreas(db); generate(db, Date.now()); save(db, "tasks"); }
    var now = Date.now(), by = String(req.by || "");
    switch (a) {
      case "state": case "adminCheck": break;

      case "addTask": {
        var f = taskFields(db, req);
        if (!f) return { ok: false, err: "input" };
        var t = { cat: f.cat, id: uid(), what: f.what, who: f.rot ? f.dayWho : f.who.join(","), due: f.due, by: by, at: now, done: false, doneBy: "", doneAt: 0, n1: 0, n2: 0, mode: f.mode, doneMap: {}, remind: f.remind, n0: 0, series: "", alarm: f.alarm, nrep: 0, note: f.note, lastNudge: {} };
        if (f.rule) {
          var s = { duty: !!f.rot, rot: f.rot, cat: f.cat, id: uid(), what: f.what, who: f.who.join(","), mode: f.mode, remind: f.remind, rule: f.rule, start: f.due, last: f.due, by: by, at: now, active: true, alarm: f.alarm, note: f.note };
          db.series.push(s); save(db, "series");
          t.series = s.id; t.id = s.id + "-" + f.due.toString(36);
        }
        db.tasks.push(t); save(db, "tasks");
        notifyAssigned(db, P, t, by, "📝 新しいやること");
        break;
      }

      case "editTask": {
        var i = indexBy(db.tasks, "id", req.id);
        if (i < 0) return { ok: false, err: "gone" };
        var g = taskFields(db, req);
        if (!g) return { ok: false, err: "input" };
        var t2 = db.tasks[i], newWho = g.rot ? [g.rot[wdOf(g.due)] || g.who[0]] : g.who, added = newWho.filter(function (w) { return whoList(t2).indexOf(w) < 0; });
        if (t2.due !== g.due || t2.remind !== g.remind) { t2.n0 = 0; t2.n1 = 0; t2.n2 = 0; t2.nrep = 0; }
        t2.cat = g.cat; t2.what = g.what; t2.who = newWho.join(","); t2.mode = g.mode; t2.due = g.due; t2.remind = g.remind; t2.alarm = g.alarm; t2.note = g.note;
        var si = t2.series ? indexBy(db.series, "id", t2.series) : -1;
        if (si >= 0) {
          var s2 = db.series[si];
          if (!g.rule) s2.active = false;
          else { s2.duty = !!g.rot; s2.rot = g.rot; s2.cat = g.cat; s2.what = g.what; s2.who = g.who.join(","); s2.mode = g.mode; s2.remind = g.remind; s2.alarm = g.alarm; s2.note = g.note; s2.rule = g.rule; s2.start = g.due; s2.last = Math.max(g.due, s2.last); }
          db.tasks.forEach(function (x) { if (x.series === s2.id && !x.done && x.id !== t2.id && g.rule) { x.cat = g.cat; x.what = g.what; x.who = g.rot ? (g.rot[wdOf(x.due)] || x.who) : g.who.join(","); x.mode = g.mode; x.remind = g.remind; x.alarm = g.alarm; x.note = g.note; } });
          save(db, "series");
        } else if (g.rule) {
          var s3 = { duty: !!g.rot, rot: g.rot, cat: g.cat, id: uid(), what: g.what, who: g.who.join(","), mode: g.mode, remind: g.remind, rule: g.rule, start: g.due, last: g.due, by: by, at: now, active: true, alarm: g.alarm, note: g.note };
          db.series.push(s3); save(db, "series"); t2.series = s3.id;
        }
        save(db, "tasks");
        if (added.length) notifyAssigned(db, P, { id: t2.id, what: t2.what, who: added.join(","), due: t2.due }, by, "📝 やることの担当になりました");
        break;
      }

      case "doneTask": case "undoTask": case "delTask": {
        var k = indexBy(db.tasks, "id", req.id);
        if (k < 0) break;
        var t3 = db.tasks[k];
        if (a === "delTask") {
          db.tasks.splice(k, 1);
          if (req.stop && t3.series) stopSeries(db, t3.series);
        } else if (a === "doneTask") {
          if (t3.mode === "all" && whoList(t3).indexOf(by) >= 0) {
            t3.doneMap = t3.doneMap || {}; t3.doneMap[by] = now;
            if (pending(t3).length === 0) { t3.done = true; t3.doneBy = by; t3.doneAt = now; }
          } else { t3.done = true; t3.doneBy = by; t3.doneAt = now; }
        } else {
          t3.done = false; t3.doneAt = 0;
          if (t3.mode === "all" && t3.doneMap && t3.doneMap[by]) delete t3.doneMap[by];
          else if (t3.mode !== "all") t3.doneMap = {};
        }
        save(db, "tasks");
        break;
      }

      case "setRotDay": {
        var ri = indexBy(db.series, "id", req.id), day = String(req.day);
        if (ri < 0 || !/^[0-6]$/.test(day)) return { ok: false, err: "input" };
        var sr = db.series[ri], nwho = String(req.who || "");
        if (nwho && !staffById(db, nwho)) return { ok: false, err: "input" };
        sr.rot = sr.rot || {}; var prev = sr.rot[day] || "";
        if (nwho) sr.rot[day] = nwho; else delete sr.rot[day];
        var days = Object.keys(sr.rot).map(Number).sort();
        sr.rule = { type: "weekly", every: 1, days: days, dom: 1 }; sr.duty = true;
        sr.who = days.map(function (d) { return sr.rot[d]; }).filter(function (w, i, arr) { return arr.indexOf(w) === i; }).join(",");
        if (!prev && nwho) {           // その曜日が新しく増えた時は、今週分から出す
          var st0 = at(today(), Utilities.formatDate(new Date(sr.start), TZ, "HH:mm"));
          sr.last = Math.min(sr.last, now - 60000);
          if (sr.start > now) sr.start = st0;
        }
        db.tasks = db.tasks.filter(function (x) {
          if (x.series !== sr.id || x.done || String(wdOf(x.due)) !== day) return true;
          if (!nwho) return false;          // その曜日の当番をなくしたら、出ている分も消す
          x.who = nwho; return true;
        });
        generate(db, now);
        save(db, "series"); save(db, "tasks");
        if (nwho && nwho !== prev && nwho !== by) push(db, P, [nwho], { title: "🔄 当番になりました：" + sr.what, body: "毎週" + "日月火水木金土".charAt(+day) + "曜日 " + Utilities.formatDate(new Date(sr.start), TZ, "H:mm") + (by ? "（" + nameOf(db, by) + "さんが設定）" : ""), tag: "r" + sr.id + day, url: APP_URL + "#duty" });
        break;
      }

      case "stopSeries": {
        stopSeries(db, String(req.id));
        break;
      }

      case "nudge": {
        var n = indexBy(db.tasks, "id", req.id);
        if (n < 0) break;
        if (!staffById(db, by)) return { ok: false, err: "input" };
        var t4 = db.tasks[n], key = "nudge_" + t4.id + "_" + by, fi = indexBy(db.flags, "key", key);
        if (fi >= 0 && now - db.flags[fi].at < 10 * 60000) return { ok: false, err: "nudged" };
        var to = pending(t4).filter(function (w) { return w !== by; });
        var msg = clean(req.msg, 100);
        var r0 = push(db, P, to, { title: "📣 " + nameOf(db, by) + "さんから催促：" + t4.what, body: (msg ? "「" + msg + "」 " : "") + "期限 " + when(t4.due), tag: "t" + t4.id, url: APP_URL + "#task-" + t4.id, alarm: t4.alarm === "silent" ? "normal" : t4.alarm });
        if (fi >= 0) db.flags[fi].at = now; else db.flags.push({ key: key, at: now });
        t4.lastNudge = { by: by, at: now, msg: msg };
        if (msg) db.comments.push({ id: uid(), target: t4.id, from: by, text: "📣 " + msg, at: now });
        save(db, "flags"); save(db, "tasks"); if (msg) save(db, "comments");
        return { ok: true, sent: r0.sent, state: state(db, P, by) };
      }

      case "comment": {
        var text = clean(req.text, 300), tg2 = String(req.target || "");
        if (!text || !staffById(db, by)) return { ok: false, err: "input" };
        var tk = indexBy(db.tasks, "id", tg2), nk = indexBy(db.notices, "id", tg2), rc = [], about2 = "";
        if (tk >= 0) { rc = whoList(db.tasks[tk]).concat([db.tasks[tk].by]); about2 = db.tasks[tk].what; }
        else if (nk >= 0) { var no = db.notices[nk]; rc = [no.by, no.who].concat(String(no.to2 || "").split(",")); about2 = no.kind === "連絡" || no.kind === "メッセージ" ? no.note : nameOf(db, no.who) + "さんの" + no.kind; }
        else return { ok: false, err: "gone" };
        db.comments.forEach(function (c) { if (c.target === tg2) rc.push(c.from); });
        rc = rc.filter(function (w, i, arr) { return w && w !== by && staffById(db, w) && arr.indexOf(w) === i; });
        db.comments.push({ id: uid(), target: tg2, from: by, text: text, at: now });
        save(db, "comments");
        push(db, P, rc, { title: "💬 " + nameOf(db, by) + "さん：" + about2.slice(0, 30), body: text, tag: "m" + tg2, url: APP_URL + (tk >= 0 ? "#task-" + tg2 : "#board") });
        break;
      }
      case "delComment": {
        var dc = indexBy(db.comments, "id", req.id);
        if (dc >= 0 && db.comments[dc].from === by) { db.comments.splice(dc, 1); save(db, "comments"); }
        break;
      }

      case "addNotice": {
        var kind = ["欠勤", "遅刻", "早退", "休み", "連絡", "メッセージ"].indexOf(req.kind) >= 0 ? req.kind : "連絡";
        var from = /^\d{4}-\d{2}-\d{2}$/.test(req.from || "") ? req.from : today();
        var toD = /^\d{4}-\d{2}-\d{2}$/.test(req.to || "") && req.to >= from ? req.to : from;
        var nw = String(req.who || "");
        var isMsg = kind === "連絡" || kind === "メッセージ";
        if (!isMsg && !staffById(db, nw)) return { ok: false, err: "input" };
        var note = clean(req.note, 300);
        if (isMsg && !note) return { ok: false, err: "input" };
        var to2 = kind === "メッセージ" ? (Array.isArray(req.to2) ? req.to2 : []).map(String).filter(function (w, i, arr) { return staffById(db, w) && arr.indexOf(w) === i; }) : [];
        if (kind === "メッセージ" && !to2.length) return { ok: false, err: "input" };
        var na = Number(req.notifyAt) > now ? Number(req.notifyAt) : 0;
        var nt = { id: uid(), kind: kind, to2: to2.join(","), who: isMsg ? "" : nw, from: from, to: toD, note: note, notifyAt: na, notifyTo: kind === "メッセージ" ? "to2" : req.notifyTo === "leaders" ? "leaders" : req.notifyTo === "none" ? "none" : "all", sent: 0, by: by, at: now };
        db.notices.push(nt);
        if (!na) sendNotice(db, P, nt, now);
        save(db, "notices");
        break;
      }
      case "delNotice": {
        var di = indexBy(db.notices, "id", req.id);
        if (di >= 0) { db.notices.splice(di, 1); save(db, "notices"); }
        break;
      }

      case "stamp": {
        if (!STAMPS[req.stamp] || !staffById(db, by)) return { ok: false, err: "input" };
        var tg = String(req.target || ""), rcpt = [], about = "";
        var ti = indexBy(db.tasks, "id", tg), ni = indexBy(db.notices, "id", tg);
        if (ti >= 0) { var tt = db.tasks[ti]; about = tt.what; rcpt = !tt.done ? pending(tt) : tt.mode === "all" ? Object.keys(tt.doneMap || {}) : [tt.doneBy]; }
        else if (ni >= 0) { var nn = db.notices[ni]; about = nn.kind === "連絡" || nn.kind === "メッセージ" ? nn.note : nn.kind; rcpt = [nn.who || nn.by]; }
        else if (/^c:/.test(tg)) { var ci = indexBy(db.cleanlog, "key", tg.slice(2)); if (ci < 0) return { ok: false, err: "gone" }; rcpt = [db.cleanlog[ci].by]; var ar0 = db.areas[indexBy(db.areas, "id", db.cleanlog[ci].area)]; about = (ar0 ? ar0.name : "") + "の掃除"; }
        else return { ok: false, err: "gone" };
        var ex = -1;
        db.stamps.forEach(function (x, q) { if (x.target === tg && x.stamp === req.stamp && x.from === by) ex = q; });
        if (ex >= 0) db.stamps.splice(ex, 1);
        else {
          rcpt.forEach(function (to) { db.stamps.push({ id: uid(), target: tg, stamp: req.stamp, from: by, to: to, at: now }); });
          if (!rcpt.length) db.stamps.push({ id: uid(), target: tg, stamp: req.stamp, from: by, to: "", at: now });
          var others = rcpt.filter(function (w) { return w !== by; });
          if (others.length) push(db, P, others, { title: STAMPS[req.stamp] + "（" + nameOf(db, by) + "さんから）", body: about, tag: "s" + tg + by, url: APP_URL + "#all", alarm: "silent" });
        }
        save(db, "stamps");
        break;
      }

      case "cleanDone": case "cleanUndo": {
        var ck = today() + "_" + req.area;
        var j = indexBy(db.cleanlog, "key", ck);
        if (a === "cleanDone" && j < 0) db.cleanlog.push({ key: ck, date: today(), area: String(req.area), by: by, at: now });
        if (a === "cleanUndo" && j >= 0) db.cleanlog.splice(j, 1);
        save(db, "cleanlog");
        break;
      }

      case "subscribe": {
        var sb = req.sub || {}, kk = sb.keys || {};
        if (!/^https:\/\//.test(sb.endpoint || "") || !kk.p256dh || !kk.auth || !staffById(db, req.staff)) return { ok: false, err: "input" };
        var ui = indexBy(db.subs, "endpoint", sb.endpoint);
        var row = { endpoint: sb.endpoint, staff: String(req.staff), p256dh: kk.p256dh, auth: kk.auth, at: now, ua: clean(req.ua, 60) };
        if (ui >= 0) db.subs[ui] = row; else db.subs.push(row);
        save(db, "subs");
        break;
      }
      case "unsubscribe": {
        var ux = indexBy(db.subs, "endpoint", req.endpoint);
        if (ux >= 0) { db.subs.splice(ux, 1); save(db, "subs"); }
        break;
      }
      case "testPush": {
        var r = push(db, P, [String(req.staff)], { title: "🔔 通知のテスト", body: "この通知が見えていれば設定は完了です。", tag: "test", url: APP_URL });
        return { ok: true, sent: r.sent, failed: r.failed, state: state(db, P, by) };
      }

      case "saveStaff": {
        var list = (req.staff || []).slice(0, 60).map(function (x) {
          var old = staffById(db, x.id) || {};
          return { id: String(x.id || uid()), name: clean(x.name, 20), leader: !!x.leader, owner: !!x.owner, active: x.active !== false, icon: old.icon || "", bio: old.bio || "" };
        }).filter(function (x) { return x.name; });
        if (!list.some(function (x) { return x.owner && x.active; })) return { ok: false, err: "noowner" };
        db.staff = list; save(db, "staff");
        break;
      }
      case "saveAreas": {
        db.areas = (req.areas || []).slice(0, 40).map(function (x, q) {
          var ar = { id: String(x.id || uid()), name: clean(x.name, 20), ord: q, deadline: /^\d{2}:\d{2}$/.test(x.deadline || "") ? x.deadline : "06:00" };
          for (var d = 0; d < 7; d++) ar["d" + d] = String((x.days || [])[d] || "");
          return ar;
        }).filter(function (x) { return x.name; });
        save(db, "areas");
        break;
      }
      case "myProfile": {
        var me0 = staffById(db, by);
        if (!me0) return { ok: false, err: "input" };
        var nn0 = clean(req.name, 20);
        if (!nn0) return { ok: false, err: "input" };
        if (db.staff.some(function (x) { return x.active && x.id !== by && x.name === nn0; })) return { ok: false, err: "samename" };
        me0.name = nn0; me0.icon = clean(req.icon, 4); me0.bio = clean(req.bio, 40);
        save(db, "staff");
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
    return { ok: true, state: state(db, P, by) };
  } finally {
    lock.releaseLock();
  }
}

/* 画面から届いた「やること」の中身を確かめる */
function taskFields(db, req) {
  var what = clean(req.what, 80), due = Number(req.due);
  var rot = {};
  if (req.rot && typeof req.rot === "object") Object.keys(req.rot).forEach(function (d) { if (/^[0-6]$/.test(d) && staffById(db, req.rot[d])) rot[d] = String(req.rot[d]); });
  var rule = cleanRule(req.repeat);
  var useRot = !!rule && (rule.type === "weekly" || rule.type === "daily" || rule.type === "weekdays") && Object.keys(rot).length > 0;
  var who = (useRot ? Object.keys(rot).map(function (d) { return rot[d]; }) : (Array.isArray(req.who) ? req.who : String(req.who || "").split(","))).map(String).filter(function (w, i, arr) { return staffById(db, w) && arr.indexOf(w) === i; });
  if (!what || !who.length || !(due > 0)) return null;
  var cat = ["掃除", "事務", "配達", "仕込み", "その他"].indexOf(req.cat) >= 0 ? req.cat : "";
  var remind = [0, 5, 10, 15, 30, 60, 120, 180, 1440].indexOf(Number(req.remind)) >= 0 ? Number(req.remind) : 0;
  return { cat: cat, rot: useRot ? rot : null, dayWho: useRot ? (rot[wdOf(due)] || who[0]) : "", what: what, who: who, due: due, mode: !useRot && req.mode === "all" && who.length > 1 ? "all" : "any", remind: remind, rule: rule, note: clean(req.note, 300), alarm: ["normal", "repeat", "silent"].indexOf(req.alarm) >= 0 ? req.alarm : "normal" };
}
function cleanRule(r) {
  if (!r || !r.type || r.type === "none") return null;
  var type = ["daily", "weekdays", "weekly", "monthly"].indexOf(r.type) >= 0 ? r.type : null;
  if (!type) return null;
  var every = Math.min(99, Math.max(1, Math.round(Number(r.every) || 1)));
  var days = (r.days || []).map(Number).filter(function (d) { return d >= 0 && d <= 6; });
  if (type === "weekly" && !days.length) return null;
  var dom = Math.min(31, Math.max(1, Math.round(Number(r.dom) || 1)));
  return { type: type, every: every, days: days, dom: dom };
}

/* ---------- 繰り返しの計算 ---------- */
function dayIdx(ms) { var s = Utilities.formatDate(new Date(ms), TZ, "yyyy-MM-dd").split("-"); return Date.UTC(+s[0], +s[1] - 1, +s[2]) / DAY; }
function nextAfter(s, after) {
  var rule = s.rule, start = s.start, sIdx = dayIdx(start), time = Utilities.formatDate(new Date(start), TZ, "HH:mm");
  var sDate = new Date(sIdx * DAY), sWd = sDate.getUTCDay(), sMon = sDate.getUTCFullYear() * 12 + sDate.getUTCMonth();
  var begin = Math.max(sIdx, dayIdx(after));
  for (var i = 0; i < 800; i++) {
    var idx = begin + i, d = new Date(idx * DAY), wd = d.getUTCDay(), ok = false;
    if (rule.type === "daily") ok = (idx - sIdx) % rule.every === 0;
    else if (rule.type === "weekdays") ok = wd >= 1 && wd <= 5;
    else if (rule.type === "weekly") ok = rule.days.indexOf(wd) >= 0 && Math.floor((idx - (sIdx - sWd)) / 7) % rule.every === 0;
    else if (rule.type === "monthly") {
      var y = d.getUTCFullYear(), m = d.getUTCMonth(), last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      ok = d.getUTCDate() === Math.min(rule.dom, last) && (y * 12 + m - sMon) % rule.every === 0;
    }
    if (!ok) continue;
    var ds = d.getUTCFullYear() + "-" + ("0" + (d.getUTCMonth() + 1)).slice(-2) + "-" + ("0" + d.getUTCDate()).slice(-2);
    var due = at(ds, time);
    if (due > after && due >= start) return due;
  }
  return 0;
}
/* 期限が近づいた繰り返しを、やることとして出す。出したら true */
function generate(db, now) {
  var made = false;
  db.series.forEach(function (s) {
    if (!s.active) return;
    for (var guard = 0; guard < 400; guard++) {
      var nx = nextAfter(s, s.last);
      if (!nx || nx - now > LEAD) break;
      s.last = nx; made = true;
      if (nx < now - 6 * 3600e3) continue;          // 長く止まっていた分は、さかのぼって出さない
      var id = s.id + "-" + nx.toString(36);
      if (indexBy(db.tasks, "id", id) >= 0) continue;
      var rw = s.rot && s.rot[wdOf(nx)];
      db.tasks.push({ cat: s.cat || "", id: id, what: s.what, who: rw || s.who, due: nx, by: s.by, at: now, done: false, doneBy: "", doneAt: 0, n1: 0, n2: 0, mode: s.mode, doneMap: {}, remind: s.remind, n0: 0, series: s.id, alarm: s.alarm || "normal", nrep: 0, note: s.note || "", lastNudge: {} });
    }
  });
  return made;
}
/* 以前の「掃除当番」を、曜日ごとの当番つきの繰り返しやることに移す（1回だけ） */
function migrateAreas(db, ownerId) {
  var now = Date.now(), made = false;
  var ow = ownerId || (db.staff.filter(function (x) { return x.owner && x.active; })[0] || {}).id || "";
  var defs = db.areas.length ? db.areas : [];
  defs.forEach(function (a) {
    var rot = {}, days = [];
    for (var d = 0; d < 7; d++) if (a["d" + d] && staffById(db, a["d" + d])) { rot[String(d)] = a["d" + d]; days.push(d); }
    if (!days.length) return;
    var start = at(today(), a.deadline || "06:00");
    var who = Object.keys(rot).map(function (k) { return rot[k]; }).filter(function (w, i, arr) { return arr.indexOf(w) === i; });
    db.series.push({ id: uid(), what: a.name + "の掃除", who: who.join(","), mode: "any", remind: 0, rule: { type: "weekly", every: 1, days: days, dom: 1 }, start: start, last: start - 60000, by: ow, at: now, active: true, alarm: "normal", note: "", rot: rot, cat: "掃除", duty: true });
    made = true;
  });
  if (db.areas.length) { db.areas = []; save(db, "areas"); }
  if (made) save(db, "series");
  return made;
}
function stopSeries(db, id) {
  var i = indexBy(db.series, "id", id);
  if (i >= 0) { db.series[i].active = false; save(db, "series"); }
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
  var ownerId = uid();
  db.staff = [{ id: ownerId, name: name, leader: true, owner: true, active: true }];
  save(db, "staff");
  migrateAreas(db, ownerId);
  var trig = true;
  try { setupTrigger(); } catch (x) { trig = false; }
  return { ok: true, ownerId: ownerId, trigger: trig, state: state(db, P, ownerId) };
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
    var dirtyT = false, dirtyF = false;

    if (generate(db, now)) { dirtyT = true; save(db, "series"); }

    var dirtyN = false;
    db.notices.forEach(function (nt) { if (!nt.sent && nt.notifyAt && nt.notifyAt <= now) { sendNotice(db, P, nt, now); dirtyN = true; } });
    if (dirtyN) save(db, "notices");

    db.tasks.forEach(function (t) {
      if (t.done) return;
      var pend = pending(t), link = APP_URL + "#task-" + t.id;
      if (t.remind && !t.n0 && now >= t.due - t.remind * 60000 && now < t.due) {
        push(db, P, pend, { title: "🔔 まもなく期限：" + t.what, body: "期限 " + hm(t.due) + "（あと" + span(t.due - now) + "）", tag: "t" + t.id, url: link, alarm: t.alarm === "silent" ? "silent" : "normal" });
        t.n0 = now; dirtyT = true;
      }
      if (!t.n1 && t.due <= now) {
        push(db, P, pend, { title: "⏰ 期限です：" + t.what, body: "期限 " + hm(t.due) + "。終わったら「終わった」を押してください。", tag: "t" + t.id, url: link, alarm: t.alarm });
        t.n1 = now; t.n0 = t.n0 || now; dirtyT = true;
      } else if (t.n1 && t.alarm === "repeat" && (t.nrep || 0) < 3 && now - t.n1 >= ((t.nrep || 0) + 1) * 5 * 60000 - 30000) {
        t.nrep = (t.nrep || 0) + 1;
        push(db, P, pend, { title: "⏰ まだ終わっていません（" + t.nrep + "回目）：" + t.what, body: "期限 " + hm(t.due) + " を過ぎています。終わったら「終わった」を押してください。", tag: "t" + t.id, url: link, alarm: "repeat" });
        dirtyT = true;
      }
      if (!t.n2 && t.due + esc <= now) {
        var to = leaders.filter(function (id) { return whoList(t).indexOf(id) < 0; });
        if (to.length) push(db, P, to, { title: "【未完了】" + names(db, pend) + "：" + t.what, body: "期限 " + hm(t.due) + " から" + P.ESC_MIN + "分過ぎています。", tag: "t2" + t.id, url: link });
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
        if (to2.length) push(db, P, to2, { title: "【未完了】" + nameOf(db, who) + "さん：" + a.name + "の掃除", body: "期限 " + a.deadline + " から" + P.ESC_MIN + "分過ぎています。", tag: "c2" + a.id, url: APP_URL + "#clean" });
        setFlag(db, "c2_" + d + "_" + a.id, now); dirtyF = true;
      }
    });

    if (now >= at(d, P.SUMMARY_TIME || "07:00") && !flag(db, "sum_" + d)) {
      var lateT = db.tasks.filter(function (t) { return !t.done && t.due <= now; });
      var lateC = db.areas.filter(function (a) { var w = a["d" + wd]; return w && !cleanDone(db, d, a.id) && now >= at(d, a.deadline); });
      var n = lateT.length + lateC.length;
      var lines = lateT.map(function (t) { return names(db, pending(t)) + "：" + t.what; }).concat(lateC.map(function (a) { return nameOf(db, a["d" + wd]) + "さん：" + a.name + "の掃除"; }));
      push(db, P, owners, n ? { title: "【朝のまとめ】未完了 " + n + "件", body: lines.slice(0, 5).join(" ／ ") + (n > 5 ? " ほか" : ""), tag: "sum", url: APP_URL }
                            : { title: "【朝のまとめ】全部完了しています", body: "期限を過ぎたやること・掃除はありません。", tag: "sum", url: APP_URL });
      setFlag(db, "sum_" + d, now); dirtyF = true;

      // 1日1回、古い記録を片付ける（60日より前）
      var old = now - 60 * DAY;
      db.tasks = db.tasks.filter(function (t) { return !(t.done && t.doneAt < old); }); dirtyT = true;
      db.cleanlog = db.cleanlog.filter(function (c) { return c.at >= old; }); save(db, "cleanlog");
      db.series = db.series.filter(function (s) { return s.active || s.at >= old; }); save(db, "series");
      db.flags = db.flags.filter(function (f) { return f.at >= now - 7 * DAY; });
      db.stamps = db.stamps.filter(function (x) { return x.at >= old; }); save(db, "stamps");
      db.comments = db.comments.filter(function (x) { return x.at >= old; }); save(db, "comments");
      db.notices = db.notices.filter(function (nt) { return nt.to >= Utilities.formatDate(new Date(old), TZ, "yyyy-MM-dd"); }); save(db, "notices");
    }
    if (dirtyT) save(db, "tasks");
    if (dirtyF) save(db, "flags");
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 通知を送る ---------- */
function sendNotice(db, P, nt, now) {
  nt.sent = now;
  if (nt.notifyTo === "none") return;
  var to = (nt.notifyTo === "to2" ? String(nt.to2 || "").split(",") : db.staff.filter(function (s) { return s.active && (nt.notifyTo === "all" || s.leader || s.owner); }).map(function (s) { return s.id; }))
    .filter(function (id) { return id && id !== nt.by && id !== nt.who; });
  var md = function (d) { var p = d.split("-"); var w = "日月火水木金土".charAt(new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay()); return (+p[1]) + "/" + (+p[2]) + "(" + w + ")"; };
  var days = nt.from === nt.to ? md(nt.from) : md(nt.from) + "〜" + md(nt.to);
  var title = nt.kind === "メッセージ" ? "💬 " + nameOf(db, nt.by) + "さんからメッセージ" : nt.kind === "連絡" ? "📢 連絡（" + nameOf(db, nt.by) + "さん）" : "🏠 " + nameOf(db, nt.who) + "さん：" + nt.kind + "（" + days + "）";
  var body = nt.kind === "連絡" || nt.kind === "メッセージ" ? nt.note : (nt.note || "") + (nt.by && nt.by !== nt.who ? (nt.note ? " ／ " : "") + "登録：" + nameOf(db, nt.by) + "さん" : "");
  push(db, P, to, { title: title, body: body || "連絡板で確認してください。", tag: "n" + nt.id, url: APP_URL + "#board" });
}

function notifyAssigned(db, P, t, by, title) {
  var to = whoList(t).filter(function (w) { return w !== by; });
  if (!to.length) return;
  var from = by ? nameOf(db, by) : "";
  try { push(db, P, to, { title: title, body: t.what + "（期限 " + when(t.due) + "）" + (from ? " ／ " + from + "さんから" : ""), tag: "t" + t.id, url: APP_URL + "#task-" + t.id }); } catch (x) {}
}

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
function state(db, P, viewer) {
  var now = Date.now(), recent = now - 3 * DAY, d = today();
  var notif = {};
  db.subs.forEach(function (s) { notif[s.staff] = (notif[s.staff] || 0) + 1; });
  var series = db.series.filter(function (s) { return s.active; }).map(function (s) { var o = JSON.parse(JSON.stringify(s)); o.next = nextAfter(s, s.last); return o; });
  return {
    now: now, today: d, weekday: weekday(),
    staff: db.staff,
    tasks: db.tasks.filter(function (t) { return !t.done || t.doneAt >= recent; }),
    series: series,
    notices: db.notices.filter(function (nt) { return nt.to >= d && canSee(db, nt, viewer); }).sort(function (a, b) { return a.from < b.from ? -1 : a.from > b.from ? 1 : a.at - b.at; }),
    areas: db.areas.slice().sort(function (a, b) { return a.ord - b.ord; }),
    clean: db.cleanlog.filter(function (c) { return c.date === d; }),
    notif: notif,
    comments: db.comments.filter(function (c) { if (c.at < now - 14 * DAY) return false; var ni = indexBy(db.notices, "id", c.target); return ni < 0 || canSee(db, db.notices[ni], viewer); }),
    stamps: db.stamps.filter(function (x) { return x.at >= now - 7 * DAY; }),
    stats: stats(db, now), statsP: statsAll(db, now),
    config: { escMin: Number(P.ESC_MIN || 30), summaryTime: P.SUMMARY_TIME || "07:00", vapid: P.VAPID_PUB }
  };
}

/* メッセージは、送った人・宛先・社長だけに見せる（スプレッドシートには残ります） */
function canSee(db, nt, viewer) {
  if (nt.kind !== "メッセージ") return true;
  var v = staffById(db, viewer);
  return !!v && (v.owner || nt.by === viewer || String(nt.to2 || "").split(",").indexOf(viewer) >= 0);
}

/* この7日間のがんばり（完了数・期限内・掃除・もらったスタンプ） */
function stats(db, now, since) {
  var w = since || now - 7 * DAY, out = {};
  var get = function (id) { return out[id] || (out[id] = { done: 0, ontime: 0, clean: 0, stamps: 0, asked: 0, late: 0, open: 0 }); };
  db.tasks.forEach(function (t) {
    var dm = t.doneMap || {};
    var col = t.cat === "掃除" ? "clean" : "done";
    if (t.mode === "all") Object.keys(dm).forEach(function (k) { if (dm[k] >= w) { get(k)[col]++; if (dm[k] <= t.due) get(k).ontime++; } });
    else if (t.done && t.doneAt >= w && t.doneBy) { get(t.doneBy)[col]++; if (t.doneAt <= t.due) get(t.doneBy).ontime++; }
    if (t.at >= w && t.by && !t.series && whoList(t).some(function (x) { return x !== t.by; })) get(t.by).asked++;
    if (!t.done) pending(t).forEach(function (k) { get(k).open++; if (t.due < now) get(k).late++; });
  });
  db.cleanlog.forEach(function (c) { if (c.at >= w && c.by) get(c.by).clean++; });
  db.stamps.forEach(function (x) { if (x.at >= w && x.to && x.to !== x.from) get(x.to).stamps++; });
  return out;
}
function statsAll(db, now) {
  var d0 = at(today(), "00:00");
  return { d1: stats(db, now, d0), d7: stats(db, now, now - 7 * DAY), d30: stats(db, now, now - 30 * DAY) };
}

/* ---------- スプレッドシートの読み書き ---------- */
function open(P) {
  var ss = SpreadsheetApp.openById(P.SHEET_ID), db = { _ss: ss };
  Object.keys(SCHEMA).forEach(function (name) { db[name] = readTable(ss, name); });
  return db;
}
function cols(name) { return SCHEMA[name].map(function (c) { return c.split(":")[0]; }); }
function sheet(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols(name).length).setValues([cols(name)]).setFontWeight("bold");
    sh.setFrozenRows(1);
    var first = ss.getSheetByName("シート1") || ss.getSheetByName("Sheet1");
    if (first && ss.getSheets().length > 1) ss.deleteSheet(first);
  }
  return sh;
}
function readTable(ss, name) {
  var sh = sheet(ss, name), sc = SCHEMA[name];
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, sc.length).getValues().map(function (r) {
    var o = {};
    sc.forEach(function (c, i) {
      var p = c.split(":"), v = r[i];
      if (p[1] === "n") o[p[0]] = Number(v) || 0;
      else if (p[1] === "b") o[p[0]] = v === true || v === "TRUE" || v === "true";
      else if (p[1] === "j") { try { o[p[0]] = v ? JSON.parse(v) : (p[0] === "rule" ? null : {}); } catch (x) { o[p[0]] = p[0] === "rule" ? null : {}; } }
      else o[p[0]] = String(v);
    });
    return o;
  }).filter(function (o) { return o[sc[0].split(":")[0]]; });
}
function save(db, name) {
  var sh = sheet(db._ss, name), sc = SCHEMA[name];
  var rows = db[name].map(function (o) {
    return sc.map(function (c) {
      var p = c.split(":"), v = o[p[0]];
      if (p[1] === "b") return v ? "TRUE" : "FALSE";
      if (p[1] === "j") return v == null ? "" : JSON.stringify(v);
      return String(v == null ? "" : v);
    });
  });
  sh.getRange(1, 1, 1, sc.length).setValues([cols(name)]);
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, sc.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, sc.length).setNumberFormat("@").setValues(rows);
}

/* ---------- 小さな道具 ---------- */
function props() { return PropertiesService.getScriptProperties().getProperties(); }
function uid() { return Utilities.getUuid().replace(/-/g, "").slice(0, 10); }
function clean(s, n) { return String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n); }
function indexBy(arr, k, v) { for (var i = 0; i < arr.length; i++) if (arr[i][k] === String(v)) return i; return -1; }
function staffById(db, id) { for (var i = 0; i < db.staff.length; i++) if (db.staff[i].id === String(id) && db.staff[i].active) return db.staff[i]; return null; }
function nameOf(db, id) { return (staffById(db, id) || {}).name || "（不明）"; }
function names(db, ids) { return ids.length ? ids.map(function (i) { return nameOf(db, i); }).join("・") + "さん" : "担当者"; }
function whoList(t) { return String(t.who || "").split(",").filter(Boolean); }
function pending(t) { var dm = t.doneMap || {}; return t.mode === "all" ? whoList(t).filter(function (w) { return !dm[w]; }) : whoList(t); }
function cleanDone(db, d, area) { return indexBy(db.cleanlog, "key", d + "_" + area) >= 0; }
function flag(db, k) { return indexBy(db.flags, "key", k) >= 0; }
function setFlag(db, k, t) { db.flags.push({ key: k, at: t }); }
function today() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd"); }
function wdOf(ms) { return Number(Utilities.formatDate(new Date(ms), TZ, "u")) % 7; }
function weekday() { return Number(Utilities.formatDate(new Date(), TZ, "u")) % 7; }
function at(d, t) { return new Date(d + "T" + t + ":00+09:00").getTime(); }
function hm(ms) { return Utilities.formatDate(new Date(ms), TZ, "H:mm"); }
function when(ms) { return dayIdx(ms) === dayIdx(Date.now()) ? hm(ms) : Utilities.formatDate(new Date(ms), TZ, "M/d H:mm"); }
function span(ms) { var m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? m + "分" : Math.round(m / 60) + "時間"; }
function tooMany() { return Number(CacheService.getScriptCache().get("fails") || 0) >= 15; }
function fail() { var c = CacheService.getScriptCache(); c.put("fails", String(Number(c.get("fails") || 0) + 1), 900); }
