#!/usr/bin/env python3
"""
セキュリティチェック（毎日の定期作業で実行する）。読むだけで、何も書き換えない。

使い方:
  MOGAMI_MASTER=… MOGAMI_PASS=… python3 tools/security.py [--claude <claude.ai版のindex.html>] [--decl <宣言のJSON>]
    --claude : Artifact の read（path=index.html）で保存した claude.ai版。あれば一緒に調べる。
    --decl   : Artifact の read の結果にある <artifact-stored-declaration> の中身（JSON）を保存したファイル。
               あれば、データベースの読み書きのルールと、外部サービスの許可が想定どおりか調べる。

出力:
  最後の行が "SEC_OK" なら問題なし。"SEC_FAIL" なら問題あり（その前の NG 行が内容）。
  親鍵・合言葉そのものは表示しない。

チェック内容:
  1. 秘密が漏れていないか
     - 親鍵・合言葉（環境変数で渡したもの）が、リポジトリのファイルにも、git の履歴にも、claude.ai版のページにも入っていない
     - 秘密鍵・トークンの形（-----BEGIN … PRIVATE KEY、"d": を持つ鍵、ghp_、github_pat_、AKIA、sk-ant、AIza）がない
     - 値引き承認の公開鍵（APR_PUB）に秘密の部分（d）が入っていない
  2. GitHub版の埋め込みデータが合言葉で暗号化されている（商品・価格が平文で見えない）
  3. 外部とのやりとり
     - 通信先・リンク先が、いまの決まった相手だけ（新しい相手が増えていたら NG）
     - Googleフォームの項目・スプレッドシートが決まったもののまま
     - 外から読むプログラム（PDF用）は cdnjs の版を固定したものだけ
  4. 画面の作り
     - HTMLを文字列で差し込む危ない書き方（innerHTML= / outerHTML / document.write / eval / new Function / srcdoc）がない
       （insertAdjacentHTML は最初の固定の枠を出す1か所だけ）
     - 新しいタブで開くリンクに rel="noopener" が付いている
  5. claude.ai版のデータベースのルール・外部サービスの許可が想定どおり（--decl があれば）
"""
import json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = sys.argv[1:]
def opt(name):
    if name in args:
        i = args.index(name); return args[i+1] if i+1 < len(args) else None
    return None
CLAUDE = opt("--claude"); DECL = opt("--decl")
problems = []
def bad(msg): problems.append(msg); print("NG:", msg)
def ok(msg): print("OK:", msg)

# いまの決まった通信先・リンク先（増やす時は、ここも直して理由をコミットに書く）
ALLOWED_HOSTS = {
    "cdnjs.cloudflare.com",      # PDFを作るプログラム
    "claude.ai",                 # 社長版へのリンク
    "docs.google.com",           # 営業記録のGoogleフォーム
    "fonts.googleapis.com", "fonts.gstatic.com",  # 文字の形
    "line.me",                   # LINEで送る
    "script.google.com",         # 写真の受付係（Apps Script）
    "unagi-mogami.github.io",    # 独立版の公開URL
    "www.icloud.com",            # iPhoneのショートカット
    "www.w3.org",                # SVGの名前空間（通信しない）
}
REC_ENTRY = "entry.1301070373"
REC_SHEET_ID = "1A3n07qLpLLU7UnfarlTAvbk1zRg7p1EAc-qrPDXE1HI"
EXPECTED_DB_RULES = [
    {"path": "", "read": "interact", "write": "interact"},
    {"path": "staff", "read": "interact", "write": "owner"},
    {"path": "access_requests", "read": "admin", "write": "owner"},
    {"path": "access_requests/{self}", "read": "interact", "write": "interact"},
    {"path": "settings/staff_key", "read": "interact", "write": "owner"},
]
EXPECTED_MCP = {"Claude Code Remote": {"fire_trigger", "list_triggers"},
                "Google Drive": {"download_file_content", "read_file_content", "create_file"}}
TOKEN_PATTERNS = [
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "秘密鍵（PEM）"),
    (r'"kty"\s*:\s*"[A-Z]+"[^{}]{0,400}"d"\s*:\s*"', "秘密の部分（d）を持つ鍵"),
    (r"\bghp_[A-Za-z0-9]{30,}", "GitHubのトークン"),
    (r"\bgithub_pat_[A-Za-z0-9_]{30,}", "GitHubのトークン"),
    (r"\bAKIA[0-9A-Z]{16}\b", "AWSの鍵"),
    (r"\bsk-ant-[A-Za-z0-9_\-]{20,}", "Anthropicの鍵"),
    (r"\bAIza[0-9A-Za-z_\-]{35}\b", "Googleの鍵"),
]

def git(*a):
    return subprocess.run(["git", "-C", ROOT, *a], capture_output=True, text=True, errors="replace").stdout

def strip_pub(src):
    i = src.find('<script id="pub-data"')
    if i < 0: return src, ""
    j = src.find("</script>", i)
    return src[:i] + src[j:], src[i:j]

# ---------- 1. 秘密 ----------
secrets = [v for v in (os.environ.get("MOGAMI_MASTER"), os.environ.get("MOGAMI_PASS")) if v and len(v) >= 6]
if not secrets:
    bad("親鍵・合言葉が渡されていないので、漏れていないかを確かめられない（MOGAMI_MASTER / MOGAMI_PASS）")
files = [f for f in git("ls-files").splitlines() if f]
texts = {}
for f in files:
    try: texts[f] = open(os.path.join(ROOT, f), encoding="utf-8").read()
    except Exception: pass   # 画像など
claude_src = None
if CLAUDE:
    try: claude_src = open(CLAUDE, encoding="utf-8").read(); texts["(claude.ai版)"] = claude_src
    except Exception: bad("claude.ai版のファイルを読めない")
leak = [name for name, t in texts.items() for s in secrets if s in t]
history = git("log", "--all", "-p", "--no-color") if secrets else ""
hist_leak = any(s in history for s in secrets)
for name in sorted(set(leak)): bad("親鍵か合言葉が %s に書かれている" % name)
if hist_leak: bad("親鍵か合言葉が git の履歴（過去のコミット）に残っている")
if secrets and not leak and not hist_leak: ok("親鍵・合言葉はファイルにも履歴にも書かれていない")
tok = [(name, label) for name, t in texts.items() for pat, label in TOKEN_PATTERNS if re.search(pat, t)]
hist_tok = [label for pat, label in TOKEN_PATTERNS if re.search(pat, history)] if history else []
for name, label in tok: bad("%s に %s らしきものがある" % (name, label))
for label in sorted(set(hist_tok)): bad("git の履歴に %s らしきものがある" % label)
if not tok and not hist_tok: ok("秘密鍵・トークンの形のものはない")

src = texts.get("index.html", "")
code, pub = strip_pub(src)
m = re.search(r"APR_PUB\s*=\s*(\{[^;]*\})", code)
if not m: bad("値引き承認の公開鍵（APR_PUB）が見つからない")
else:
    try:
        k = json.loads(m.group(1))
        if "d" in k: bad("APR_PUB に秘密の部分（d）が入っている")
        else: ok("値引き承認の公開鍵に秘密の部分はない")
    except Exception: bad("APR_PUB の形がおかしい")

# ---------- 2. GitHub版の埋め込みデータ ----------
pm = re.search(r'<script id="pub-data" type="application/json">(.*?)</script>', src, re.S)
try:
    pd = json.loads(pm.group(1)) if pm else None
except Exception:
    pd = None
if not pd: bad("GitHub版の埋め込みデータが読めない")
elif not pd.get("enc"): bad("GitHub版の埋め込みデータが暗号化されていない（商品・価格が誰でも見える）")
elif any(k in pd for k in ("products", "pricing", "weights", "extras")): bad("GitHub版の埋め込みデータに平文の商品・価格が混ざっている")
else: ok("GitHub版の埋め込みデータは暗号化されている")

# ---------- 3. 外部とのやりとり ----------
def check_code(label, code):
    hosts = set(re.findall(r"https?://([a-zA-Z0-9.\-]+)", code))
    extra = sorted(hosts - ALLOWED_HOSTS)
    if extra: bad("%s：決まっていない通信先・リンク先がある（%s）" % (label, "、".join(extra)))
    else: ok("%s：通信先・リンク先は決まった相手だけ" % label)
    if 'REC_ENTRY = "%s"' % REC_ENTRY not in code: bad("%s：Googleフォームの項目（REC_ENTRY）が変わっている" % label)
    if 'REC_SHEET_ID = "%s"' % REC_SHEET_ID not in code: bad("%s：スプレッドシート（REC_SHEET_ID）が変わっている" % label)
    libs = re.findall(r'"(https://[^"]+\.js)"', code)
    badlib = [u for u in libs if not re.match(r"https://cdnjs\.cloudflare\.com/ajax/libs/[\w.\-]+/\d+\.\d+\.\d+/", u)]
    if badlib: bad("%s：版を固定していない・cdnjs 以外のプログラムを読んでいる（%s）" % (label, "、".join(badlib)))
    if re.search(r"<script[^>]*\bsrc=", code): bad("%s：外のプログラムを <script src> で読んでいる" % label)
    danger = [(r"\.innerHTML\s*=", "innerHTML="), (r"\.outerHTML\s*=", "outerHTML="), (r"document\.write\(", "document.write"),
              (r"\beval\(", "eval"), (r"new Function\(", "new Function"), (r"srcdoc", "srcdoc")]
    found = [n for p, n in danger if re.search(p, code)]
    if len(re.findall(r"insertAdjacentHTML", code)) > 1: found.append("insertAdjacentHTML（固定の枠以外）")
    if found: bad("%s：HTMLを文字列で差し込む危ない書き方がある（%s）" % (label, "、".join(found)))
    else: ok("%s：HTMLを文字列で差し込む書き方はない" % label)
    noop = [a for a in re.findall(r'h\("a",\{[^}]*target:"_blank"[^}]*\}', code) if "noopener" not in a]
    if noop: bad("%s：新しいタブで開くリンクに noopener がない（%d か所）" % (label, len(noop)))
check_code("GitHub版", code)
if claude_src:
    ccode, cpub = strip_pub(claude_src)
    check_code("claude.ai版", ccode)
    if re.search(r'"(sync_secret|apr_key|legacyPass)"', cpub): bad("claude.ai版の埋め込みデータに秘密の名前（sync_secret など）が入っている")

# ---------- 5. データベースのルール ----------
if DECL:
    try:
        d = json.load(open(DECL, encoding="utf-8"))
        rules = (d.get("db") or {}).get("rules")
        norm = lambda rs: sorted(json.dumps(r, sort_keys=True) for r in (rs or []))
        if norm(rules) != norm(EXPECTED_DB_RULES): bad("claude.ai版のデータベースの読み書きのルールが想定と違う（%s）" % json.dumps(rules, ensure_ascii=False)[:300])
        else: ok("claude.ai版のデータベースのルールは想定どおり")
        mcp = {s.get("server"): set(s.get("tools") or []) for s in ((d.get("mcp") or {}).get("servers") or [])}
        extra = {k: sorted(v - EXPECTED_MCP.get(k, set())) for k, v in mcp.items() if v - EXPECTED_MCP.get(k, set())}
        if extra: bad("claude.ai版に想定していない外部サービスの許可がある（%s）" % json.dumps(extra, ensure_ascii=False))
        else: ok("claude.ai版の外部サービスの許可は想定どおり")
    except Exception as e:
        bad("宣言のJSONを読めない（%s）" % e)

print("SEC_FAIL" if problems else "SEC_OK")
sys.exit(1 if problems else 0)
