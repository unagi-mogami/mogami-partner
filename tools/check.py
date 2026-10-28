#!/usr/bin/env python3
"""
独立版（index.html）の不具合チェック。自動更新（商品データ同期）のあと、push する前に必ず実行する。

使い方:
  MOGAMI_MASTER='親鍵' python3 tools/check.py [index.html]   （今月の合言葉を親鍵から計算）
  MOGAMI_PASS='今の合言葉' python3 tools/check.py [index.html]   （合言葉を直接渡す場合。両方あれば両方試す）

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
     - ボタン周り：入力した直後の1回目のタップで「PDFで保存」「LINEで送る」が反応するか、
       「PDFで保存」が2回目以降も固まらずに反応するか
     - 独立版：新しい版を正しく見分けられるか
     - 見積書：白焼1枚の単価と合計の計算、値引き時に承認なしで出せないこと
     - 見積書：うなぎ以外（付属品）・運賃の税率別計算と、運賃なし・付属品値引きの承認
     - 営業記録：社員コードが違うと登録できないこと。正しいコードで社員登録して訪問を1件記録し、送る中身が正しいか（本物のフォームには送らない）
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
# なければ困る作り（消えると再発する）
MUST = [
    (r'function flushRender\(', "入力を確定した瞬間に画面を作り直す作りに戻っている（入力直後のボタンが1回目で空振りする）"),
    (r'c===\"declined\"\) toast\(', "PDF保存の確認で「やめる」を押したときに何も表示されない作りに戻っている"),
]
for pat, msg in MUST:
    if not re.search(pat, src): bad(msg)
for pat, msg in RULES:
    if re.search(pat, src): bad(msg)
if not any(re.search(p, src) for p, _ in RULES) and all(re.search(p, src) for p, _ in MUST): ok("再発チェック")

# 4. ブラウザで実際に動かす
PASS = os.environ.get("MOGAMI_PASS", "")
# 親鍵（MOGAMI_MASTER）があれば、ページに書かれた月の合言葉を sync.js と同じ方法で計算する（合言葉を直接渡さなくてよい）
_MASTER = os.environ.get("MOGAMI_MASTER", "")
if _MASTER and m:
    try:
        import hmac, hashlib
        _period = json.loads(m.group(1)).get("period")
        if _period:
            _ab = "abcdefghjkmnpqrstuvwxyz23456789"; _h = hmac.new(_MASTER.encode(), ("mogami-pass:" + _period).encode(), hashlib.sha256).digest()
            _p = "".join(_ab[_h[i] % len(_ab)] + ("-" if i % 4 == 3 and i < 11 else "") for i in range(12))
            PASS_CANDIDATES = [_p] + ([PASS] if PASS else [])
    except Exception: pass
# 社員コード（見積書・営業記録の登録に必要）も親鍵から作る
STAFF_CODE = ""
if _MASTER:
    try:
        import hmac, hashlib
        _sv = re.search(r"const STAFF_KEY = \{\"v\":\s*(\d+)", src)
        _h = hmac.new(_MASTER.encode(), ("mogami-staff:v" + (_sv.group(1) if _sv else "1")).encode(), hashlib.sha256).digest()
        STAFF_CODE = "".join("abcdefghjkmnpqrstuvwxyz23456789"[_h[i] % 31] for i in range(8))
    except Exception: pass
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

        def toasts_since(fn, wait=1500):
            """fn() を実行して、その間に出たトースト（画面下の案内）を全部返す"""
            pg.evaluate("""()=>{ window.__toasts = []; const host = document.getElementById("toastHost");
              if (host && !host.__watch){ host.__watch = new MutationObserver(()=>{ const t = host.textContent.trim(); if (t) window.__toasts.push(t); }); host.__watch.observe(host,{childList:true,subtree:true,characterData:true}); } }""")
            fn(); pg.wait_for_timeout(wait)
            return pg.evaluate("()=>window.__toasts||[]")

        def button_check(where):
            """ボタン周り：入力した直後の1回目のタップで反応するか・PDFボタンが固まらないか"""
            inputs = pg.locator("main input.i:visible, main textarea.i:visible")
            pdfs = pg.locator("main button:visible", has_text="PDFで保存")
            if not pdfs.count(): bad("%s：「PDFで保存」ボタンがない" % where); return
            for i in range(pdfs.count()):
                btn = pg.locator("main button:visible", has_text="PDFで保存").nth(i)
                def tap():
                    if inputs.count():
                        inp = inputs.first; inp.click(); inp.fill((inp.input_value() or "") + "1")  # 入力した直後（確定前）に
                    btn.click()                                                                      # ボタンを1回だけ押す
                t1 = toasts_since(tap)
                if not t1: bad("%s：入力直後に「PDFで保存」（%d番目）を押しても反応しない（1回目が空振り）" % (where, i + 1)); continue
                if "PDFを作っています" not in " ".join(t1) and "数字を入れて" not in " ".join(t1):
                    bad("%s：「PDFで保存」（%d番目）の反応がおかしい（%s）" % (where, i + 1, t1[0][:40])); continue
                pg.wait_for_timeout(1500)
                t2 = toasts_since(lambda: pg.locator("main button:visible", has_text="PDFで保存").nth(i).click())
                if not t2: bad("%s：「PDFで保存」（%d番目）が2回目から反応しない（固まっている）" % (where, i + 1)); continue
                ok("%s：「PDFで保存」%d番目（入力直後の1回目・2回目とも反応）" % (where, i + 1))
            # 入力直後の「LINEで送る」も1回目で開くか
            top_line = pg.locator("main a.btn.line:visible").first
            if inputs.count() and pg.locator("main a.btn.line:visible").count():
                inp = inputs.first; inp.click(); inp.fill((inp.input_value() or "") + "1")
                line_popup(top_line, where + "（入力直後）")

        opened = False
        for _pw in (globals().get("PASS_CANDIDATES") or [PASS]):
            pg.goto("about:blank"); pg.goto(base + ("#k=" + urllib.parse.quote(_pw) if _pw else ""))
            try: pg.wait_for_selector("nav.tabs a", timeout=12000); opened = True; break
            except Exception: pass
        try:
            if not opened: raise Exception("gate")
            ok("合言葉で開けた")
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
                    button_check("診断結果")
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
                button_check("原価計算")
            # 営業記録（社員登録 → 訪問を1件記録 → フォームへの送信内容を確認。本物には送らない）
            share = [h for h, l in tabs if h == "#share"]
            if share:
                pg.click('nav.tabs a[href="#share"]'); pg.wait_for_timeout(300)
                entry = pg.locator("main button", has_text=re.compile("社員として登録|営業記録を開く"))
                if not entry.count(): bad("共有画面に「営業記録」の入口がない")
                else:
                    entry.first.click(); pg.wait_for_timeout(300)
                    # 社員だけ：社員コードが違うと登録できない
                    pg.fill("#rec-name", "チェック 太郎"); pg.fill("#rec-pin", "0000"); pg.fill("#rec-code", "zzzz-zzzz")
                    pg.locator("main button[type=submit]").first.click(); pg.wait_for_timeout(1500)
                    if pg.locator("#rec-shop").count(): bad("営業記録：社員コードが違うのに登録できてしまう（社員以外も使える）")
                    else: ok("営業記録：違う社員コードでは登録できない")
                    pg.fill("#rec-name", "チェック 太郎"); pg.fill("#rec-pin", "0000"); pg.fill("#rec-code", STAFF_CODE)
                    pg.locator("main button[type=submit]").first.click(); pg.wait_for_timeout(1500)
                    if not STAFF_CODE: bad("営業記録：社員コードが分からない（MOGAMI_MASTER が未指定）")
                    elif not pg.locator("#rec-shop").count(): bad("営業記録：正しい社員コードで登録できない")
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
            # 新しい版の確認（独立版だけ）：同じ版なら「更新」を出さない／違う版なら出す
            if pg.evaluate("()=>typeof STANDALONE!=='undefined' && STANDALONE && typeof verCheck==='function'"):
                same = pg.evaluate("()=>verCheck()")
                html = open(PAGE, encoding="utf8").read()
                diff = pg.evaluate("(t)=>verCompare(t)", html.replace("/* ============ ページ自身の再発行用", "/* ============ ページ自身の再発行用 x", 1))
                if same: bad("新しい版の確認：同じ版なのに「新しい版があります」と出る")
                elif not diff: bad("新しい版の確認：版が変わっても気づけない")
                else: ok("新しい版の確認")
            # 見積書（社員登録済みの端末で：商品1行で出せる・値引きすると承認待ちで止まる）
            if pg.locator('nav.tabs a[href="#quote"]').count():
                pg.click('nav.tabs a[href="#quote"]'); pg.wait_for_timeout(400)
                r = pg.evaluate("""()=>{ const t = getPricing().tiers[0];
                  const p = S.products.find(x=>(x.sizes||[]).some(z=>sellQuote(x,z,t))); if (!p) return {skip:true};
                  const z = p.sizes.find(z=>sellQuote(p,z,t)); const q = qtBlank(); q.shop = "チェック用の店";
                  q.items = [{id:"c1", product:p.name, size:z, kind:"shiro", qty:"20", price:""}]; q.delivery = "own"; S.qt = q; render();
                  const c = qtCalc(q), P = parseFloat(z), rule = sellQuote(p,z,c.tier).hi;
                  const per = Math.ceil((rule+1100)/P/50)*50;
                  const okCalc = c.lines[0] && c.lines[0].up===per && c.total===c.base8+c.base10+Math.floor(c.base8*0.08)+Math.floor(c.base10*0.1);
                  const btn = () => [...document.querySelectorAll("main button")].find(b=>b.textContent.includes("見積書をPDFにする"));
                  const en1 = btn() && !btn().disabled;
                  q.items[0].price = String(sellQuote(p,z,c.tier).lo - 100); render();
                  const en2 = btn() && !btn().disabled;
                  S.qt = qtBlank(); render();
                  return {okCalc, en1, en2}; }""")
                if r.get("skip"): ok("見積書：価格のある商品がないので計算の確認は省略")
                elif not r.get("okCalc"): bad("見積書：白焼1枚の単価または合計の計算が合わない")
                elif not r.get("en1"): bad("見積書：商品を入れても「PDFにする」が押せない")
                elif r.get("en2"): bad("見積書：値引きしたのに承認なしで出せてしまう")
                else: ok("見積書：計算・値引きの承認待ち")
            # 見積書：うなぎ以外（付属品）と運賃
            if pg.evaluate("()=>typeof getExtras==='function'"):
                r = pg.evaluate("""()=>{ const ex = getExtras(), sh = getShip(); if (!ex.length) return {none:true};
                  const e8 = ex.find(x=>Number(x.tax)===8), e10 = ex.find(x=>Number(x.tax)!==8);
                  const q = qtBlank(); q.shop = "チェック用の店"; q.items = []; q.extras = [e8,e10].filter(Boolean).map((x,i)=>({id:"x"+i, eid:x.id, qty:"2", price:""})); q.delivery = "takuhai";
                  q.delivery = "own"; const noShipOwn = !qtCalc(q).lines.some(l=>l.name.startsWith(sh.name)); q.delivery = "takuhai";
                  const c = qtCalc(q), ship = c.lines.find(l=>l.name.startsWith(sh.name));
                  const b8 = (e8 ? e8.price*2 : 0), b10 = (e10 ? e10.price*2 : 0) + Number(sh.price);
                  const okSum = c.base8===b8 && c.base10===b10 && c.total===b8+b10+Math.floor(b8*0.08)+Math.floor(b10*0.1);
                  q.noShip = true; const shipAppr = qtCalc(q).disc.some(d=>d.kind==="ship"); q.noShip = false;
                  q.extras[0].price = String(Number(ex.find(x=>x.id===q.extras[0].eid).price)-10); const lowAppr = qtCalc(q).disc.some(d=>d.kind==="extra");
                  return {okSum, ship:!!ship, shipAppr, lowAppr, noShipOwn}; }""")
                if r.get("none"): bad("見積書：うなぎ以外の価格表が空")
                elif not r.get("ship"): bad("見積書：宅配便・活鰻5kg未満なのに運賃がつかない")
                elif not r.get("noShipOwn"): bad("見積書：宅配便でないのに運賃がつく")
                elif not r.get("okSum"): bad("見積書：うなぎ以外・運賃の税率別の計算が合わない")
                elif not (r.get("shipAppr") and r.get("lowAppr")): bad("見積書：運賃なし・付属品の値引きが承認なしで通ってしまう")
                else: ok("見積書：うなぎ以外・運賃")
            if errors and not any("エラー" in x for x in problems):
                bad("画面でエラーが出ている: " + errors[0][:160])
        b.close()
    srv.shutdown()

if problems:
    print("CHECK_FAIL %d件" % len(problems)); sys.exit(1)
print("CHECK_OK")
