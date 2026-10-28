#!/usr/bin/env python3
"""
独立版（index.html）の不具合チェック。自動更新（商品データ同期）のあと、push する前に必ず実行する。

使い方:
  MOGAMI_PASS='今の合言葉' python3 tools/check.py [index.html]

出力:
  最後の行が "CHECK_OK" なら問題なし。
  "CHECK_FAIL" の行があれば不具合あり（その前の行に内容が出る）。終了コードも 1 になる。

チェック内容:
  1. 埋め込みデータ（pub-data）が正しいJSONか
  2. 画面のプログラムに文法エラーがないか
  3. 過去に起きた不具合の再発がないか（LINEボタンが反応しない作りなど）
  4. スマホ幅のブラウザで実際に開いて：
     - 合言葉で開けるか
     - 下のタブを全部押して、エラーが出ないか・画面が空にならないか
     - うなぎ診断を最後まで進めて、結果が出るか
     - 診断結果と原価計算の「LINEで送る」を押して、LINEの送信画面が文章つきで開くか
     - 営業記録：社員登録して訪問を1件記録し、送る中身が正しいか（本物のフォームには送らない）
合言葉は表示・保存しない。
"""
import json, os, re, subprocess, sys, tempfile, threading, http.server, functools, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(ROOT, "index.html")
problems = []
def bad(msg): problems.append(msg); print("NG:", msg)
def ok(msg): print("OK:", msg)

src = open(PAGE, encoding="utf8").read()

# 1. 埋め込みデータ
m = re.search(r'<script id="pub-data" type="application/json">(.*?)</script>', src, re.S)
if not m: bad("埋め込みデータ（pub-data）が見つからない")
else:
    try: json.loads(m.group(1)); ok("埋め込みデータ")
    except Exception as e: bad("埋め込みデータが壊れている: %s" % e)

# 2. 文法
blocks = [b for a, b in re.findall(r'<script((?![^>]*\bsrc=)[^>]*)>(.*?)</script>', src, re.S) if "json" not in a]
with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf8") as f:
    f.write("\n;\n".join(blocks)); js = f.name
r = subprocess.run(["node", "--check", js], capture_output=True, text=True)
os.unlink(js)
if r.returncode: bad("プログラムに文法エラー: " + (r.stderr.strip().splitlines() or ["?"])[-1])
else: ok("文法")

# 3. 再発チェック（過去の不具合）
RULES = [
    (r'window\.open\([^)]*noopener', "window.open に noopener を付けている（必ず失敗扱いになり、LINEボタンが反応しなくなる）"),
    (r'location\.href\s*=\s*(u|url|lineUrl)', "LINEなど外部リンクを location.href で開いている（アプリ内表示で止められる）"),
    (r'h\("button",\{class:"btn line[^\n]{0,300}lineUrl', "LINEボタンが button になっている（リンク a にすること）"),
]
for pat, msg in RULES:
    if re.search(pat, src): bad(msg)
if not any(re.search(p, src) for p, _ in RULES): ok("再発チェック")

# 4. ブラウザで実際に動かす
PASS = os.environ.get("MOGAMI_PASS", "")
try:
    from playwright.sync_api import sync_playwright
except Exception:
    sync_playwright = None
    bad("ブラウザでの確認ができない（playwright が入っていない）")

if sync_playwright:
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    handler = functools.partial(Quiet, directory=os.path.dirname(PAGE))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d/%s" % (srv.server_port, os.path.basename(PAGE))
    errors = []; sent = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, locale="ja-JP")
        def route(rt):
            u = rt.request.url
            if u.startswith("http://127.0.0.1"): return rt.continue_()
            if u.startswith("https://line.me/"): return rt.fulfill(status=200, content_type="text/html", body="<p>LINE</p>")
            if "/formResponse" in u:  # 営業記録の送信は本物のフォームに届けず、ここで受け取って中身だけ確かめる
                sent.append(rt.request.post_data or ""); return rt.fulfill(status=200, body="ok")
            return rt.abort()  # フォントなど外部は読まない（オフラインでも判定できるように）
        ctx.route("**/*", route)
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text and "ERR_FAILED" not in m.text else None)

        def line_popup(locator, where):
            """LINEボタンを押して、LINEの送信画面が文章つきで開くか"""
            try:
                with ctx.expect_page(timeout=5000) as info:
                    locator.click()
                pop = info.value; url = pop.url; pop.close()
                q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
                if not url.startswith("https://line.me/R/share") or not (q.get("text") or [""])[0].strip():
                    bad("%s：LINEは開いたが文章が入っていない（%s）" % (where, url[:60])); return False
                ok("%s：LINEボタン" % where); return True
            except Exception:
                bad("%s：「LINEで送る」を押してもLINEが開かない" % where); return False

        pg.goto(base + ("#k=" + urllib.parse.quote(PASS) if PASS else ""))
        try:
            pg.wait_for_selector("nav.tabs a", timeout=15000); ok("合言葉で開けた")
        except Exception:
            bad("アプリが開かない（合言葉が違う／表示が止まっている）" + ("" if PASS else "。MOGAMI_PASS が未指定"))
        else:
            # タブを全部押す
            tabs = pg.eval_on_selector_all("nav.tabs a", "els=>els.map(e=>[e.getAttribute('href'), e.textContent.trim()])")
            for href, label in tabs:
                n = len(errors)
                pg.click('nav.tabs a[href="%s"]' % href); pg.wait_for_timeout(400)
                txt = pg.inner_text("main").strip()
                if len(errors) > n: bad("「%s」タブでエラー: %s" % (label, errors[n][:120]))
                elif len(txt) < 20: bad("「%s」タブの画面が空" % label)
                else: ok("「%s」タブ" % label)
            # 診断を最後まで
            if any(h == "#diagnose" for h, _ in tabs):
                pg.click('nav.tabs a[href="#diagnose"]'); pg.wait_for_timeout(300)
                for _ in range(20):
                    done = pg.locator("button", has_text=re.compile("結果を見る"))
                    if done.count(): done.first.click(); pg.wait_for_timeout(400); break
                    opt = pg.locator("main .opt")
                    if not opt.count(): break
                    opt.first.click(); pg.wait_for_timeout(250)
                lines = pg.locator("main a.btn.line")
                if not lines.count(): bad("診断結果が出ない、または結果に「LINEで送る」がない")
                else:
                    ok("診断を最後まで進めた")
                    line_popup(lines.first, "診断結果")
            # 原価計算
            if any(h == "#simulator" for h, _ in tabs):
                pg.click('nav.tabs a[href="#simulator"]'); pg.wait_for_timeout(500)
                top = pg.locator("main .panel a.btn.line.sm").first
                if not pg.locator("main .panel a.btn.line.sm").count(): bad("原価計算：上の「LINEで送る」が見つからない")
                else:
                    has_result = pg.evaluate("()=>!!currentSendText()")
                    if has_result: line_popup(top, "原価計算（上のボタン）")
                    else:
                        n = len(ctx.pages); top.click(); pg.wait_for_timeout(500)
                        if len(ctx.pages) > n: bad("原価計算：結果がないのにLINEが開いた")
                        elif "数字を入れて" not in pg.inner_text("#toastHost"): bad("原価計算：結果がない時の案内が出ない")
                        else: ok("原価計算（結果なし時の案内）")
                for i in range(pg.locator("main a.btn.line:not(.sm)").count()):
                    line_popup(pg.locator("main a.btn.line:not(.sm)").nth(i), "原価計算（下のボタン%d）" % (i + 1))
            # 営業記録（社員登録 → 訪問を1件記録 → フォームへの送信内容を確認。本物には送らない）
            share = [h for h, l in tabs if h == "#share"]
            if share:
                pg.click('nav.tabs a[href="#share"]'); pg.wait_for_timeout(300)
                entry = pg.locator("main button", has_text=re.compile("社員として登録|営業記録を開く"))
                if not entry.count(): bad("共有画面に「営業記録」の入口がない")
                else:
                    entry.first.click(); pg.wait_for_timeout(300)
                    pg.fill("#rec-name", "チェック 太郎"); pg.fill("#rec-pin", "0000")
                    pg.locator("main button[type=submit]").first.click(); pg.wait_for_timeout(400)
                    if not pg.locator('nav.tabs a[href="#record"]').count(): bad("営業記録：登録しても「営業記録」タブが出ない")
                    else:
                        ok("営業記録：社員登録")
                        pg.fill("#rec-shop", "チェック用の店")
                        pg.locator("main .seg button", has_text="訪問").first.click(); pg.wait_for_timeout(200)
                        pg.locator("main button", has_text="記録する").first.click(); pg.wait_for_timeout(1500)
                        recs = []
                        for body in sent:
                            for k, v in urllib.parse.parse_qsl(body):
                                if k.startswith("entry."):
                                    try: recs.append(json.loads(v))
                                    except Exception: pass
                        r0 = recs[-1] if recs else None
                        if not r0: bad("営業記録：「記録する」を押してもフォームに送られない")
                        elif not (r0.get("kind") == "visit" and r0.get("name") == "チェック 太郎" and r0.get("pin") == "0000" and r0.get("shop") == "チェック用の店" and r0.get("id")):
                            bad("営業記録：送った中身が足りない（%s）" % json.dumps(r0, ensure_ascii=False)[:120])
                        elif any(k in json.dumps(r0, ensure_ascii=False) for k in ("cost", "原価")):
                            bad("営業記録：送る中身に原価が入っている")
                        else:
                            ok("営業記録：訪問を記録して送信")
                            if "まだ送れていない" in pg.inner_text("main"): bad("営業記録：送ったのに「未送信」のまま")
            if errors and not any("エラー" in x for x in problems):
                bad("画面でエラーが出ている: " + errors[0][:160])
        b.close()
    srv.shutdown()

if problems:
    print("CHECK_FAIL %d件" % len(problems)); sys.exit(1)
print("CHECK_OK")
