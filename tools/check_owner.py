#!/usr/bin/env python3
"""
社長の画面（claude.ai版でログインした時だけ出る画面）の不具合チェック。
check.py はログインなしの画面しか動かせないので、こちらで社長の画面をブラウザで実際に開いて確かめる。

使い方:
  python3 tools/check_owner.py <claude.ai版の index.html>
  （build_claude.py で作ったファイル、または Artifact の read で保存したファイル）

やり方:
  claude.ai のデータベース・ログインの代わりに「テスト用のにせもの」をページに入れて開く。
  商品は埋め込みデータ（pub-data）から、営業記録・顧客カルテはテスト用に作ったものを使う。
  本物のデータベースには一切つながない（外への通信は全部止める）。

出力:
  最後の行が "CHECK_OK" なら問題なし。"CHECK_FAIL" なら不具合あり（その前の NG 行が内容）。

チェック内容:
  - 社長として開けるか
  - 下のタブ（社長だけのタブを含む）を全部押して、エラーが出ないか・画面が空にならないか
  - 実績：記録の一覧の各記録を開いて、エラーが出ないか・同じボタンが2つ並んでいないか
    （2026-10：見積の記録で「見積書を見る」が2つ並んだ不具合の再発防止）
  - 実績：見積の件数がテスト記録の数と合うか（同じ見積の送り直しは1件）
  - 顧客カルテ：テスト用のカルテを開いて、エラーが出ないか・同じボタンが2つ並んでいないか
  - 商品マスタ：最初の商品を開いて、エラーが出ないか
"""
import json, os, re, sys, threading, http.server, functools

PAGE = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else ""
problems = []
def bad(msg): problems.append(msg); print("NG:", msg)
def ok(msg): print("OK:", msg)
def finish():
    print("CHECK_FAIL" if problems else "CHECK_OK"); sys.exit(1 if problems else 0)

if not PAGE or not os.path.exists(PAGE):
    bad("claude.ai版のファイルを指定してください"); finish()
src = open(PAGE, encoding="utf-8").read()
if "window.MOGAMI_STANDALONE=true" in src.replace(" ", ""):
    bad("独立版のファイルです。claude.ai版（build_claude.py の出力か Artifact の read で保存したもの）を指定してください"); finish()
m = re.search(r'<script id="pub-data" type="application/json">(.*?)</script>', src, re.S)
try:
    pub = json.loads(m.group(1)) if m else {}
except Exception:
    pub = {}
if pub.get("enc"):
    bad("埋め込みデータが暗号化されています（claude.ai版は暗号化しない）"); finish()

UID = "u_testowner000000000000"
TODAY_SQL = "new Date().toISOString().slice(0,10)"
# テスト用の記録：種類ごとに1件。見積は「同じ番号の送り直し（古い・新しい）」と別の見積を入れる → 見積は2件と数えるのが正しい
SEED_JS = r"""
(() => {
  const UID = %(uid)s, PUB = %(pub)s;
  const today = new Date().toISOString().slice(0,10), now = Date.now();
  const iso = m => new Date(now - m*60000).toISOString();
  const store = new Map();
  const clone = v => v===undefined ? undefined : JSON.parse(JSON.stringify(v));
  const put = (p, d) => store.set(p, clone(d));
  (PUB.products||[]).forEach(p => { const {id, ...rest} = p; put("products/"+id, rest); });
  ["pricing","weights","extras"].forEach(k => { if (PUB[k]) put("settings/"+k, PUB[k]); });
  const line = (name, qty, up) => ({name, qty, unit:"kg", up, amount:qty*up, rate:"8%%"});
  const quote = (no, shop, total, lines) => ({no, date:today, shop, person:"", memo:"", kg:2, delivery:"", lines, base8:total, base10:0, tax8:0, tax10:0, total, disc:0, appr:false});
  const rec = (id, min, f) => put("records/"+id, {v:1, id, at:iso(min), date:today, name:"社長", src:"app", uid:UID, ...f});
  rec("t-visit", 60, {kind:"visit", shop:"テスト鰻店", memo:"テストの訪問"});
  rec("t-diag", 55, {kind:"diag", shop:"テスト鰻店", detail:"診断結果のテスト", detailLabel:"診断結果"});
  rec("t-q1a", 50, {kind:"quote", shop:"テスト鰻店", quote:quote("QTEST-0001", "テスト鰻店", 10000, [line("テスト商品", 2, 5000)])});
  rec("t-q1b", 45, {kind:"quote", shop:"テスト鰻店", quote:quote("QTEST-0001", "テスト鰻店", 12000, [line("テスト商品", 2, 6000)])});
  rec("t-q2", 40, {kind:"quote", shop:"テスト割烹", quote:quote("QTEST-0002", "テスト割烹", 8000, [line("テスト商品", 1, 8000), line("別の商品", 0, 0)])});
  rec("t-sample", 35, {kind:"sample", shop:"テスト割烹", memo:"サンプルのテスト"});
  rec("t-deal", 30, {kind:"deal", shop:"テスト割烹", product:(PUB.products&&PUB.products[0]||{}).name||"", size:"any", kg:3, price:4000, newDeal:true});
  put("customers/t-cust", {name:"テスト鰻店", memo:"テスト用のカルテ"});

  const listeners = new Set();
  let pending = false;
  const notify = () => { if (pending) return; pending = true; setTimeout(() => { pending = false; [...listeners].forEach(l => { try { l(); } catch(e){ console.error(e); } }); }, 0); };
  const kids = col => { const n = col.split("/").length; return [...store.keys()].filter(k => k.startsWith(col+"/") && k.split("/").length===n+1).sort(); };
  const dsnap = p => { const d = store.get(p); return {id:p.split("/").pop(), exists:d!==undefined, data:() => clone(d), ref:dref(p)}; };
  const qsnap = col => { const docs = kids(col).map(dsnap); return {docs, empty:!docs.length, size:docs.length, forEach:f => docs.forEach(f)}; };
  const watch = fn => { listeners.add(fn); setTimeout(fn, 0); return () => listeners.delete(fn); };
  function dref(p){ return {id:p.split("/").pop(), path:p,
    get: async () => dsnap(p),
    set: async (d, o) => { store.set(p, o && o.merge ? {...(store.get(p)||{}), ...clone(d)} : clone(d)); notify(); },
    update: async d => { if (!store.has(p)) { const e = new Error("not-found"); e.code = "not-found"; throw e; } store.set(p, {...store.get(p), ...clone(d)}); notify(); },
    delete: async () => { store.delete(p); notify(); },
    onSnapshot: (cb) => watch(() => cb(dsnap(p))),
    collection: c => cref(p+"/"+c)}; }
  function cref(col){ const r = {id:col.split("/").pop(), path:col,
    doc: id => dref(col+"/"+(id || Math.random().toString(36).slice(2))),
    add: async d => { const x = dref(col+"/"+Math.random().toString(36).slice(2)); await x.set(d); return x; },
    get: async () => qsnap(col),
    onSnapshot: (cb) => watch(() => cb(qsnap(col)))};
    r.where = () => r; r.orderBy = () => r; r.limit = () => r; return r; }
  const db = {collection: cref, doc: dref};
  const user = {id: async () => UID, isOwner: async () => true, can: async () => true};
  const caps = {db, user,
    assets: {upload: async () => ({url:"about:blank"}), delete: async () => {}},
    downloads: {save: async () => ({ok:true})},
    permissions: {state: async () => "granted", manage: async () => {}},
    mcp: null, artifact: null};
  window.claude = {use: async name => (name in caps ? caps[name] : null)};
  window.__testStore = store;
})();
""" % {"uid": json.dumps(UID), "pub": json.dumps(pub, ensure_ascii=False)}

try:
    from playwright.sync_api import sync_playwright
except Exception:
    bad("ブラウザでの確認ができない（playwright が入っていない）"); finish()

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=os.path.dirname(PAGE)))
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d/%s" % (srv.server_port, os.path.basename(PAGE))

# 同じ記録・カルテの中で、同じ名前のボタンが2つ以上あるか（「削除」など確認のための2段目は除く）
DUP_JS = r"""
(sel) => {
  const box = document.querySelector(sel); if (!box) return null;
  const c = {};
  box.querySelectorAll("button, a.btn").forEach(b => { if (!b.offsetParent) return; const t = b.textContent.trim(); if (t) c[t] = (c[t]||0) + 1; });
  return Object.entries(c).filter(([,n]) => n > 1).map(([t,n]) => t+"×"+n);
}
"""

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, locale="ja-JP")
    ctx.route("**/*", lambda rt: rt.continue_() if rt.request.url.startswith("http://127.0.0.1") else rt.abort())
    ctx.add_init_script(SEED_JS)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text and "ERR_FAILED" not in m.text else None)
    def new_err(n): return errors[n][:140] if len(errors) > n else None

    pg.goto(base)
    try:
        pg.wait_for_selector("nav.tabs a", timeout=15000); ok("社長として開けた")
    except Exception:
        bad("社長の画面が開かない" + ((": " + errors[0][:120]) if errors else "")); b.close(); finish()

    tabs = pg.eval_on_selector_all("nav.tabs a", "els=>els.map(e=>[e.getAttribute('href'), e.textContent.trim()])")
    hrefs = [h for h, _ in tabs]
    for need in ("#results", "#customers", "#products"):
        if need not in hrefs: bad("社長のタブ（%s）が出ていない" % need)
    for href, label in tabs:
        n = len(errors)
        pg.click('nav.tabs a[href="%s"]' % href); pg.wait_for_timeout(500)
        txt = pg.inner_text("main").strip()
        if new_err(n): bad("「%s」タブでエラー: %s" % (label, new_err(n)))
        elif len(txt) < 20: bad("「%s」タブの画面が空" % label)
        else: ok("「%s」タブ" % label)

    # 実績：記録を全部開く
    if "#results" in hrefs:
        pg.click('nav.tabs a[href="#results"]'); pg.wait_for_timeout(800)
        try:
            pg.wait_for_function("()=>!/読み込み中/.test(document.querySelector('main').innerText)", timeout=8000)
        except Exception:
            bad("実績：読み込みが終わらない")
        # 期間を「全期間」に
        allp = pg.locator("main .tabbar button", has_text="全期間")
        if allp.count(): allp.first.click(); pg.wait_for_timeout(300)
        kpi = pg.evaluate("""()=>{ const o={}; document.querySelectorAll('main .kpi').forEach(k=>{ const l=k.querySelector('.l'), v=k.querySelector('.v'); if(l&&v) o[l.textContent.trim()]=v.textContent.trim(); }); return o; }""")
        if kpi.get("見積") != "2": bad("実績：見積の件数が %s（テストでは2件。同じ見積の送り直しは1件に数える）" % kpi.get("見積"))
        else: ok("実績：見積の件数（送り直しは1件）")
        rows = pg.locator("main .rrow .rsum")
        cnt = rows.count()
        if cnt < 6: bad("実績：記録の一覧に出る数が少ない（%d件。テストでは6件）" % cnt)
        dups = []; errs = []
        for i in range(cnt):
            n = len(errors)
            row = pg.locator("main .rrow .rsum").nth(i)
            row.scroll_into_view_if_needed(); row.click(); pg.wait_for_timeout(250)
            name = row.inner_text().split("\n")[0:2]
            if new_err(n): errs.append("%s: %s" % (" ".join(name), new_err(n)))
            d = pg.evaluate(DUP_JS, "main .rrow.open")
            if d: dups.append("%s（%s）" % (" ".join(name), "、".join(d)))
            # 見積の記録は「見積書を見る」を押して、見積書が開くか
            if pg.locator("main .rrow.open button", has_text="見積書を見る").count() == 1:
                pg.locator("main .rrow.open button", has_text="見積書を見る").click(); pg.wait_for_timeout(250)
                if not pg.locator("main .rrow.open .qdoc").count(): errs.append("%s: 「見積書を見る」を押しても見積書が出ない" % " ".join(name))
                if new_err(n): errs.append("%s: %s" % (" ".join(name), new_err(n)))
            pg.locator("main .rrow.open .rsum").first.click(); pg.wait_for_timeout(150)
        for e in errs: bad("実績：記録を開くとエラー " + e)
        for d in dups: bad("実績：同じボタンが2つ以上並んでいる " + d)
        if cnt >= 6 and not errs and not dups: ok("実績：記録を全部開いた（%d件・ボタンの重複なし）" % cnt)

    # 顧客カルテ：テスト用のカルテを開く
    if "#customers" in hrefs:
        n = len(errors)
        pg.click('nav.tabs a[href="#customers"]'); pg.wait_for_timeout(500)
        card = pg.locator("main", has_text="テスト鰻店").locator("button, .card, .shophead", has_text="テスト鰻店")
        if card.count():
            card.first.click(); pg.wait_for_timeout(1200)
            if new_err(n): bad("顧客カルテ：開くとエラー " + new_err(n))
            else:
                d = pg.evaluate(DUP_JS, "main")
                d = [x for x in (d or []) if not re.match(r"^(削除|消す|開く|閉じる|見積書を見る|PDFにする)×", x)]
                # カルテの中の営業記録も開く
                rs = pg.locator("main .rrow .rsum"); dd = []
                for i in range(rs.count()):
                    pg.locator("main .rrow .rsum").nth(i).click(); pg.wait_for_timeout(200)
                    x = pg.evaluate(DUP_JS, "main .rrow.open")
                    if x: dd.append("、".join(x))
                    pg.locator("main .rrow.open .rsum").first.click(); pg.wait_for_timeout(100)
                if new_err(n): bad("顧客カルテ：営業記録を開くとエラー " + new_err(n))
                elif dd: bad("顧客カルテ：営業記録の中で同じボタンが2つ以上並んでいる（%s）" % " / ".join(dd))
                else: ok("顧客カルテ：開いた（営業記録 %d 件）" % rs.count())
        else:
            bad("顧客カルテ：テスト用のカルテが一覧に出ない")

    # 商品マスタ：最初の商品を開く
    if "#products" in hrefs:
        n = len(errors)
        pg.click('nav.tabs a[href="#products"]'); pg.wait_for_timeout(500)
        first = pg.locator("main button:visible", has_text="編集").first
        if first.count():
            first.click(); pg.wait_for_timeout(500)
            if new_err(n): bad("商品マスタ：商品を開くとエラー " + new_err(n))
            elif not pg.locator("main button", has_text="一覧へ").count(): bad("商品マスタ：「編集」を押しても商品の画面が開かない")
            else: ok("商品マスタ：商品を開いた")
        else:
            bad("商品マスタ：「編集」ボタンが見つからない")

    if errors and not problems:
        bad("画面のどこかでエラー: " + errors[0][:140])
    b.close()
finish()
