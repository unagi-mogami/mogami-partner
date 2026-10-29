#!/usr/bin/env node
/*
 * 独立版（index.html）に埋め込んだ商品データ（pub-data）を、claude.ai版のデータベースの内容で作り直す。
 * 使い方: node tools/sync.js <productsのJSONフォルダ> [settingsのJSONフォルダ]
 *   各フォルダは ArtifactData の list に out_dir を付けて保存したもの（<doc_id>.json に中身が入っている）。
 * 出力: 変更があれば index.html を書き換えて "UPDATED"、なければ "NO_CHANGE"。
 * 安全策: 商品が0件なら中止。仕入原価・上乗せ額・特記事項が含まれていたら中止。
 * 暗号化: 商品データは「合言葉」で暗号化して埋め込む。合言葉は毎月（日本時間の月が変わったとき）自動で変わる。
 *   環境変数 MOGAMI_MASTER（親鍵・16文字以上）から、その月の合言葉を計算する。未設定なら中止。
 *   MOGAMI_PASS は月替わりより前に手で決めた合言葉（移行用・任意）。
 *   月が変わって合言葉を変えたときは "ROTATED ... PASS=<新しい合言葉> LINK=<そのまま開けるリンク>" と出力する。
 *   --rekey: 今の合言葉で読めなくても、今月の合言葉で作り直す（親鍵を変えたとき用）。
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const REKEY = process.argv.includes("--rekey");
process.argv = process.argv.filter(a => a !== "--rekey");
const PUBLIC_URL = "https://unagi-mogami.github.io/mogami-partner/";
const MASTER = process.env.MOGAMI_MASTER || "", LEGACY = process.env.MOGAMI_PASS || "";
const normPass = s => String(s||"").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g,"");
if (MASTER.length < 16) { console.error("ABORT: MOGAMI_MASTER (16+ chars) is not set"); process.exit(1); }
const NOW_PERIOD = process.env.MOGAMI_NOW_PERIOD || new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7); // 日本時間の YYYY-MM
function monthPass(period){
  const ab = "abcdefghjkmnpqrstuvwxyz23456789", h = crypto.createHmac("sha256", MASTER).update("mogami-pass:" + period).digest();
  let s = ""; for (let i = 0; i < 12; i++){ s += ab[h[i] % ab.length]; if (i % 4 === 3 && i < 11) s += "-"; } return s;
}
const ITER = 250000;
function encryptPub(obj, pass, period){
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(normPass(pass), salt, ITER, 32, "sha256");
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final(), c.getAuthTag()]);
  return { enc: 1, period, iter: ITER, salt: salt.toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64") };
}
function decryptPub(env, pass){
  const key = crypto.pbkdf2Sync(normPass(pass), Buffer.from(env.salt, "base64"), env.iter, 32, "sha256");
  const buf = Buffer.from(env.ct, "base64"), d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString("utf8"));
}
const [prodDir, setDir] = process.argv.slice(2);
if (!prodDir) { console.error("usage: node tools/sync.js <productsDir> [settingsDir]"); process.exit(2); }
const indexPath = path.join(__dirname, "..", "index.html");
const html = fs.readFileSync(indexPath, "utf8");
const m = html.match(/<script>\n([\s\S]*?)<\/script>/);
if (!m) { console.error("app script not found"); process.exit(1); }
const appJs = m[1].replace(/\(async function boot[\s\S]*$/, "");
const readDir = d => (d && fs.existsSync(d)) ? fs.readdirSync(d).filter(f => f.endsWith(".json")).map(f => ({ id: f.replace(/\.json$/, ""), data: JSON.parse(fs.readFileSync(path.join(d, f), "utf8")) })) : [];
const prods = readDir(prodDir);
if (!prods.length) { console.error("ABORT: products are empty"); process.exit(1); }
const sets = Object.fromEntries(readDir(setDir).map(x => [x.id, x.data]));
// ブラウザの代わりの最小限の環境
global.window = {}; global.location = { hash: "", origin: "", pathname: "" }; global.Node = class {};
global.document = { addEventListener() {}, getElementById() { return { textContent: "null" }; }, currentScript: null, head: { querySelector() { return null; } } };
global.navigator = { userAgent: "" };
const run = new Function("PRODS", "SETS", appJs + `
  S.products = PRODS.map(x => ({ id: x.id, ...normScale(x.data) })).sort((a,b)=>(a.demo?1:0)-(b.demo?1:0) || String(a.name).localeCompare(String(b.name),"ja"));
  S.pricing = SETS.pricing || null; S.weights = SETS.weights || null; S.extras = SETS.extras || null; S.staffKey = SETS.staff_key || null;
  return buildSnapshot();`);
const snap = run(prods, sets);
const txt = JSON.stringify(snap);
// 利率がデータベースから読めなかった等で販売単価が全部空になったら中止（価格表示が消えるのを防ぐ）
const anyPrice = snap.products.some(p => Object.values(p._sell || {}).some(a => (a || []).some(q => q && q.lo != null)));
if (!anyPrice) { console.error("ABORT: no selling prices (settings/pricing missing?)"); process.exit(1); }
if (/"cost"|"low"|"high"|"notes"|"pct"/.test(txt)) { console.error("ABORT: snapshot contains internal fields"); process.exit(1); }
const cur = html.match(/<script id="pub-data" type="application\/json">([\s\S]*?)<\/script>/);
let curSnap = null; try { curSnap = JSON.parse(cur[1].replace(/\\u003c/g, "<")); } catch (e) {}
let usePass = null, envPeriod = null;
if (curSnap && curSnap.enc) {
  envPeriod = curSnap.period || null;
  const env = curSnap; curSnap = null;
  for (const p of [monthPass(envPeriod || NOW_PERIOD), LEGACY].filter(Boolean)) { try { curSnap = decryptPub(env, p); usePass = p; break; } catch (e) {} }
  if (!curSnap && !REKEY) { console.error("ABORT: the current data cannot be opened with this month's passcode (check MOGAMI_MASTER, or use --rekey)"); process.exit(1); }
} else curSnap = null; // 暗号化前の古い形式 → 作り直す
const rotate = !usePass || (envPeriod && envPeriod !== NOW_PERIOD);
if (rotate) usePass = monthPass(NOW_PERIOD);
const key = o => o ? JSON.stringify({ ...o, builtAt: undefined }) : "";
if (!rotate && envPeriod && key(curSnap) === key(snap)) { console.log("NO_CHANGE"); process.exit(0); }
const out = JSON.stringify(encryptPub({ ...snap, builtAt: new Date().toISOString() }, usePass, NOW_PERIOD));
fs.writeFileSync(indexPath, html.replace(cur[0], () => '<script id="pub-data" type="application/json">' + out + "</script>"));
if (rotate) console.log("ROTATED " + snap.products.length + " products PASS=" + usePass + " LINK=" + PUBLIC_URL + "#k=" + usePass);
else console.log("UPDATED " + snap.products.length + " products");
