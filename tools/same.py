#!/usr/bin/env python3
"""
2つの版（GitHub版 index.html と claude.ai版）のアプリ本体と見た目が同じかを確かめる。
使い方: python3 tools/same.py <claude.ai版.html> [index.html]
出力: "SAME" または "DIFF ..."（違う所の要約）。DIFF の時は終了コード 1。
"""
import re, sys, os, difflib

MARK = "<script>\n/* ============ ページ自身の再発行用"

def parts(p):
    s = open(p, encoding="utf8").read()
    st = re.search(r'<style id="app-style">(.*?)</style>', s, re.S)
    pd = re.search(r'<script id="pub-data" type="application/json">(.*?)</script>', s, re.S)
    app = app_span = None
    if MARK in s:
        i = s.index(MARK) + len("<script>"); j = s.index("</script>", i)
        app, app_span = s[i:j], (i, j)
    return {"src": s, "style": st.group(1) if st else None, "pub": pd.group(1) if pd else None, "app": app, "app_span": app_span}

if __name__ == "__main__":
    ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    a = parts(sys.argv[1]); b = parts(sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "index.html"))
    bad = []
    for k, label in (("app", "アプリ本体"), ("style", "見た目")):
        if a[k] is None or b[k] is None: bad.append(label + "が見つからない"); continue
        if a[k] != b[k]:
            d = [l for l in difflib.unified_diff(b[k].splitlines(), a[k].splitlines(), lineterm="", n=0) if l[:1] in "+-" and not l.startswith(("+++", "---"))]
            bad.append("%s が %d 行違う（例：%s）" % (label, len(d), (d[0][:80] if d else "")))
    if bad: print("DIFF " + " ／ ".join(bad)); sys.exit(1)
    print("SAME")
