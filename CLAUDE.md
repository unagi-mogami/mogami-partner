# MOGAMI PARTNER の直し方（必ず守る）

株式会社もがみの社内アプリ。同じアプリが2つの場所で動いている。

- **GitHub版（独立版）**：このリポジトリの `index.html`。社員・お取引先がログインなしで使う。https://unagi-mogami.github.io/mogami-partner/
- **claude.ai版（社長用）**：Artifact https://claude.ai/artifact/6we5NTeRwJZrM9TfPELKhp 。社長がログインして使う（商品マスタ・顧客カルテ・実績・値引きの承認）。

## ルール：元は1つ（このリポジトリの index.html）

アプリ本体（`/* ============ ページ自身の再発行用` から始まる `<script>`）と見た目（`<style id="app-style">`）は、**2つの版で完全に同じ**にする。違いは実行時の切り替えで吸収する（`STANDALONE`＝独立版、`S.isOwner`＝社長、`S.guest`＝ログインなし）。

直す手順：
1. このリポジトリの `index.html` を直す（claude.ai版のファイルを直接直さない）。
2. 不具合チェック：`MOGAMI_MASTER=… MOGAMI_PASS=… python3 tools/check.py`（最後が `CHECK_OK`）。
3. claude.ai版を組み立てる：Artifact の read（path=index.html）でいまの claude.ai版を保存し、
   `python3 tools/build_claude.py <保存したファイル> <出力先>` → `BUILT`。
4. 出力先にも `python3 tools/check.py <出力先>` → `CHECK_OK`。
5. GitHub に push し、出力先を claude.ai版として publish（capabilities は省略して引き継ぐ）。
6. `python3 tools/same.py <claude.ai版>` が `SAME` になることを確認。

## 版ごとに違ってよいもの（build_claude.py が残す）

- 外枠（`<head>`、ホーム画面用アイコン、`window.MOGAMI_STANDALONE=true`）
- 埋め込みデータ `pub-data`：GitHub版は合言葉で暗号化（tools/sync.js が1日4回作り直す）、claude.ai版は暗号化しない。

## 秘密の扱い

- 親鍵・合言葉は、コード・コミット・報告・定期作業の指示文に書かない。
  社長だけが読めるデータ（claude.ai版の `data/users/me/sync_secret`）に入っている。
- 値引き承認の署名鍵（秘密）は `data/users/me/apr_key` にだけある。公開鍵はアプリ本体の `APR_PUB`。
- 外部（Googleフォーム `entry.1301070373`、スプレッドシート `1A3n07qLpLLU7UnfarlTAvbk1zRg7p1EAc-qrPDXE1HI`）の形を変えない。
