#!/usr/bin/env python3
"""
claude.ai版（社長用アプリ）を、この index.html（GitHub版）から組み立てる。
アプリ本体（スクリプト）と見た目（<style id="app-style">）は index.html と同じものにし、
claude.ai版の外枠と、claude.ai版の埋め込みデータ（pub-data）はそのまま残す。

使い方: python3 tools/build_claude.py <いまのclaude.ai版.html> <出力先.html>
  いまのclaude.ai版は Artifact ツールの read（path=index.html）で保存したもの。
出力が "BUILT" なら、出力先を claude.ai版として公開してよい。
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from same import parts

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cur_path, out_path = sys.argv[1], sys.argv[2]
src = parts(os.path.join(ROOT, "index.html"))
cur = parts(cur_path)
if cur["style"] is None or cur["app"] is None:
    print("ABORT: claude.ai版の形が想定と違う（app-style か アプリ本体が見つからない）"); sys.exit(1)
s = cur["src"]
a0, a1 = cur["app_span"]
s = s[:a0] + src["app"] + s[a1:]
st = s.index('<style id="app-style">') + len('<style id="app-style">'); en = s.index("</style>", st)
s = s[:st] + src["style"] + s[en:]
open(out_path, "w", encoding="utf8").write(s)
chk = parts(out_path)
if chk["app"] != src["app"] or chk["style"] != src["style"] or chk["pub"] != cur["pub"]:
    print("ABORT: 組み立て結果が一致しない"); sys.exit(1)
print("BUILT")
