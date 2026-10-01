// ブラインド入札型オークション MVP  (依存パッケージなし / Node 22+)
// 起動: node server.js  → http://localhost:3000
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const db = new DatabaseSync(process.env.DB_FILE || 'auction.db');
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, phone TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY, seller_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, description TEXT NOT NULL, image_url TEXT NOT NULL,
  category TEXT NOT NULL, brand TEXT, item_condition TEXT NOT NULL,
  shipping_method TEXT NOT NULL, ship_from TEXT NOT NULL, shipping_payer TEXT NOT NULL,
  start_price INTEGER NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bids(
  id INTEGER PRIMARY KEY, auction_id INTEGER NOT NULL REFERENCES products(id),
  user_id INTEGER NOT NULL REFERENCES users(id), amount INTEGER NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(auction_id, user_id));
CREATE TABLE IF NOT EXISTS transactions(
  id INTEGER PRIMARY KEY, auction_id INTEGER UNIQUE NOT NULL REFERENCES products(id),
  buyer_id INTEGER NOT NULL, seller_id INTEGER NOT NULL, amount INTEGER NOT NULL,
  fee INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'payment_pending', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, message TEXT NOT NULL, link TEXT,
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO settings VALUES('seller_fee_percent','5');
`);

const CATEGORIES = ['本・雑誌', '家電', 'ファッション', 'ホビー', 'コレクション', 'スポーツ', 'その他'];
const CONDITIONS = ['新品', '未使用に近い', '目立った傷なし', 'やや傷あり', '傷あり'];
const TX_STEPS = {
  payment_pending: '支払い待ち', paid: '発送待ち', shipped: '配送中', received: '取引完了',
};

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = (n) => '¥' + Number(n).toLocaleString('ja-JP');
const fmtDate = (ms) => new Date(ms).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });
const now = () => Date.now();
const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const notify = (uid, message, link) => run('INSERT INTO notifications(user_id,message,link,created_at) VALUES(?,?,?,?)', uid, message, link || null, now());
const getFee = () => Number(one("SELECT value FROM settings WHERE key='seller_fee_percent'").value);

function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPw(pw, stored) {
  const [salt, h] = stored.split(':');
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- 終了処理 (§11-13, §32) ----------
function settleEnded() {
  const t = now();
  const due = all("SELECT * FROM products WHERE status='active' AND end_at<=?", t);
  for (const p of due) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const cur = one('SELECT status FROM products WHERE id=?', p.id);
      if (cur.status !== 'active') { db.exec('COMMIT'); continue; }
      // 最高額、同額なら先に入札した人 (ミリ秒精度の created_at、最後は id)
      const win = one('SELECT * FROM bids WHERE auction_id=? ORDER BY amount DESC, created_at ASC, id ASC LIMIT 1', p.id);
      const url = '/auction/' + p.id;
      if (!win) {
        run("UPDATE products SET status='ended_nobid' WHERE id=?", p.id);
        notify(p.seller_id, `「${p.title}」は入札なしで終了しました。`, url);
      } else {
        run("UPDATE products SET status='ended' WHERE id=?", p.id);
        const fee = Math.floor(win.amount * getFee() / 100);
        run('INSERT INTO transactions(auction_id,buyer_id,seller_id,amount,fee,created_at) VALUES(?,?,?,?,?,?)',
          p.id, win.user_id, p.seller_id, win.amount, fee, t);
        const tx = one('SELECT id FROM transactions WHERE auction_id=?', p.id);
        notify(win.user_id, `🏆「${p.title}」を落札しました！(${yen(win.amount)})`, '/transaction/' + tx.id);
        notify(p.seller_id, `「${p.title}」が落札されました。(${yen(win.amount)})`, '/transaction/' + tx.id);
        for (const l of all('SELECT user_id FROM bids WHERE auction_id=? AND user_id<>?', p.id, win.user_id)) {
          notify(l.user_id, `「${p.title}」のオークションが終了しました。今回は落札できませんでした。`, url);
        }
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); console.error('settle failed', e); }
  }
}
setInterval(settleEnded, 1000);

// ---------- layout ----------
const CSS = `
:root{--paper:#f4ecdc;--paper2:#ebe0c8;--ink:#17130f;--mut:#6b6254;--card:#fffaf0;--seal:#d4301a;--indigo:#23386b;--gold:#c8962e;--bd:#17130f;
--serif:"Shippori Mincho","Yu Mincho","Hiragino Mincho ProN",serif;--sans:"Zen Kaku Gothic New","Hiragino Sans","Yu Gothic",sans-serif}
*{box-sizing:border-box}
body{margin:0;font:15px/1.7 var(--sans);background:var(--paper);color:var(--ink);
background-image:radial-gradient(rgba(23,19,15,.06) 1px,transparent 1px);background-size:14px 14px}
a{color:var(--indigo)}a:hover{color:var(--seal)}
h1,h2,h3{font-family:var(--serif);font-weight:800;letter-spacing:.02em}
.top{position:sticky;top:0;z-index:5;background:var(--paper);border-bottom:3px solid var(--ink);padding:.6rem 1.2rem;display:flex;gap:1.2rem;align-items:center;flex-wrap:wrap}
.top a{color:var(--ink);text-decoration:none}
.logo{font-family:var(--serif);font-weight:800;font-size:1.7rem;letter-spacing:.08em;display:flex;align-items:center;gap:.5rem}
.logo i{font-style:normal;background:var(--seal);color:#fff;width:2rem;height:2rem;display:grid;place-items:center;font-size:1.15rem;border-radius:3px;transform:rotate(-6deg);box-shadow:2px 2px 0 var(--ink)}
.sbar{display:flex;flex:1;min-width:220px;max-width:520px;border:2px solid var(--ink);background:var(--card);box-shadow:3px 3px 0 var(--ink)}
.sbar select{width:auto;border:0;border-right:2px solid var(--ink);background:var(--paper2);padding:.4rem;font-size:.85rem}
.sbar input{border:0;flex:1;min-width:0;background:transparent}.sbar button{border:0;border-radius:0;background:var(--ink);color:var(--paper);box-shadow:none;padding:.4rem 1rem}
.acts{margin-left:auto;display:flex;gap:1.1rem;align-items:center;font-weight:700;font-size:.9rem;white-space:nowrap}
.acts a:hover{color:var(--seal)}.acts .cta{background:var(--seal);color:#fff;padding:.35rem 1rem;border:2px solid var(--ink);box-shadow:3px 3px 0 var(--ink)}
.sub{display:flex;gap:.5rem;overflow-x:auto;white-space:nowrap;padding:.6rem 1.2rem;max-width:1280px;margin:0 auto}
.sub a{text-decoration:none;color:var(--ink);font-size:.85rem;padding:.1rem .8rem;border:1.5px solid var(--ink);border-radius:99px;background:var(--card)}
.sub a:hover{background:var(--ink);color:var(--paper)}
main{max-width:1280px;margin:0 auto;padding:.5rem 1.2rem 1.5rem}
.hero{position:relative;overflow:hidden;background:var(--ink);color:var(--paper);padding:3rem 2rem;margin-bottom:1.5rem;border:3px solid var(--ink);box-shadow:6px 6px 0 var(--seal)}
.hero h1{font-size:clamp(2rem,5vw,3.4rem);margin:0 0 .5rem;line-height:1.25}.hero h1 em{font-style:normal;color:var(--seal);background:var(--paper);padding:0 .3em}
.hero p{margin:0 0 1.2rem;opacity:.85;max-width:32em}
.hero:after{content:"一発";position:absolute;right:-1rem;bottom:-2.5rem;font:800 11rem/1 var(--serif);color:rgba(244,236,220,.07);pointer-events:none}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:1.5rem;counter-reset:s}
.steps div{border:2px dashed var(--ink);padding:.8rem 1rem;background:var(--card)}.steps b{font-family:var(--serif);font-size:1.05rem;display:block}
.steps div:before{counter-increment:s;content:counter(s);display:inline-grid;place-items:center;width:1.6rem;height:1.6rem;border-radius:50%;background:var(--seal);color:#fff;font-weight:800;margin-right:.4rem}
.sec{margin-bottom:2rem}.sec h2{margin:0 0 .8rem;font-size:1.5rem;display:flex;justify-content:space-between;align-items:baseline;border-bottom:3px double var(--ink);padding-bottom:.3rem}
.sec h2 a{font-family:var(--sans);font-size:.85rem;font-weight:400}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:1.1rem}
.card{background:var(--card);border:2px solid var(--ink);text-decoration:none;color:var(--ink);display:block;position:relative;box-shadow:4px 4px 0 var(--ink);transition:transform .12s,box-shadow .12s}
.card:hover{transform:translate(-2px,-2px);box-shadow:7px 7px 0 var(--seal);color:var(--ink)}
.card img{width:100%;aspect-ratio:1;object-fit:cover;background:var(--paper2);display:block;border-bottom:2px solid var(--ink)}.card .b{padding:.7rem .8rem}
.card h3{font-family:var(--sans);font-size:.95rem;font-weight:700;margin:0 0 .4rem;height:2.7em;overflow:hidden;line-height:1.4}
.price{font-family:var(--serif);font-size:1.3rem;font-weight:800}.price small{font-family:var(--sans);font-size:.72rem;font-weight:400;color:var(--mut);margin-right:.2rem}
.meta{font-size:.8rem;color:var(--mut)}
.tag{display:inline-block;font-size:.7rem;font-weight:700;padding:0 .5rem;border:1.5px solid var(--seal);color:var(--seal);border-radius:2px;letter-spacing:.05em}
.tag.blind{background:var(--seal);color:#fff}.tag.end{border-color:var(--mut);color:var(--mut)}
.timer{font-family:var(--serif);font-weight:800;color:var(--seal);font-variant-numeric:tabular-nums}.timer.big{font-size:2.4rem;line-height:1.1}
.btn,button{background:var(--card);color:var(--ink);border:2px solid var(--ink);border-radius:2px;padding:.45rem 1.2rem;font:inherit;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block;box-shadow:3px 3px 0 var(--ink)}
.btn:hover,button:hover{transform:translate(1px,1px);box-shadow:2px 2px 0 var(--ink);color:var(--ink)}
.hero .btn{background:var(--seal);color:#fff;border-color:var(--paper);box-shadow:3px 3px 0 var(--paper)}.hero .btn:hover{color:#fff}
button.buy{background:var(--seal);color:#fff;width:100%;padding:.8rem;font-size:1.1rem;font-family:var(--serif);letter-spacing:.1em}
button.sec,.btn.sec{background:var(--card)}button:disabled{background:var(--paper2);color:var(--mut);box-shadow:none;cursor:default;border-color:var(--mut)}
form.f label{display:block;margin:.8rem 0 .2rem;font-weight:700}
input,select,textarea{width:100%;padding:.5rem;border:2px solid var(--ink);border-radius:2px;font:inherit;background:var(--card)}
input:focus,select:focus,textarea:focus{outline:3px solid var(--gold);outline-offset:0}
.panel{background:var(--card);border:2px solid var(--ink);box-shadow:4px 4px 0 var(--ink);padding:1.2rem;margin-bottom:1.2rem}
.crumb{font-size:.8rem;color:var(--mut);margin:.3rem 0 .8rem}.crumb a{color:var(--mut)}
.detail{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:1.8rem;margin-bottom:1.5rem;align-items:start}
@media(max-width:820px){.detail{grid-template-columns:1fr}}
.detail img{width:100%;border:3px solid var(--ink);box-shadow:6px 6px 0 var(--ink);background:var(--paper2);object-fit:cover;max-height:560px}
.detail h1{font-size:1.8rem;margin:0 0 .4rem;line-height:1.35}
.buybox{border:3px solid var(--ink);background:var(--card);padding:1.2rem;margin:1rem 0;position:relative;box-shadow:6px 6px 0 var(--seal)}
.buybox:before{content:"入札札";position:absolute;top:-.85rem;left:1rem;background:var(--ink);color:var(--paper);font-family:var(--serif);padding:0 .8rem;letter-spacing:.2em}
.info td,.info th{padding:.4rem .5rem;border-bottom:1px dashed var(--mut);text-align:left;vertical-align:top}.info th{width:8em;font-weight:700;color:var(--mut)}
.err{background:#fde9e5;border:2px solid var(--seal);color:#8e1d0e;padding:.7rem 1rem;margin:.5rem 0 1rem;font-weight:700}
.ok{background:#e8f1e1;border:2px solid #3b6b27;color:#2b5019;padding:.7rem 1rem;margin:.5rem 0 1rem;font-weight:700}
.win{font-family:var(--serif);font-size:1.7rem;font-weight:800;color:var(--seal)}
table{width:100%;border-collapse:collapse}td,th{padding:.45rem;border-bottom:1px solid var(--paper2);text-align:left}
.layout{display:grid;grid-template-columns:230px 1fr;gap:1.4rem}@media(max-width:800px){.layout{grid-template-columns:1fr}}
.side{background:var(--card);border:2px solid var(--ink);padding:1rem;align-self:start}.side h4{margin:1rem 0 .3rem;font-family:var(--serif);border-bottom:2px solid var(--ink)}.side h4:first-child{margin-top:0}
.side a{display:block;text-decoration:none;padding:.1rem 0;color:var(--ink)}.side a.on{font-weight:800;color:var(--seal)}.side a.on:before{content:"▶ "}
.sorts{display:flex;justify-content:space-between;align-items:center;margin-bottom:.8rem;gap:1rem;flex-wrap:wrap}.sorts select{width:auto}
.warn{background:#fff3d6;border:2px dashed var(--gold);padding:.8rem 1.4rem}
footer{border-top:3px solid var(--ink);background:var(--ink);color:var(--paper);text-align:center;padding:1.6rem;font-family:var(--serif);letter-spacing:.1em;margin-top:2rem}
`;
const JS = `
function tick(){document.querySelectorAll('[data-end]').forEach(function(e){
 var ms=+e.dataset.end-Date.now();if(ms<=0){e.textContent='終了';if(!e.dataset.done){e.dataset.done=1;if(e.dataset.reload)setTimeout(function(){location.reload()},1500)}return}
 var s=Math.floor(ms/1000),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60),x=s%60,p=function(n){return String(n).padStart(2,'0')};
 e.textContent=(d?d+'日 ':'')+p(h)+':'+p(m)+':'+p(x)})}
tick();setInterval(tick,1000);`;

function page(user, title, body, opts = {}) {
  const unread = user ? one('SELECT COUNT(*) c FROM notifications WHERE user_id=?', user.id).c : 0;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} | 一発入札</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@500;800&family=Zen+Kaku+Gothic+New:wght@400;700&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<div class="top"><a class="logo" href="/"><i>札</i>一発入札</a>
<form class="sbar" action="/search"><select name="category"><option value="">すべて</option>${CATEGORIES.map((c) => `<option>${c}</option>`).join('')}</select><input name="q" placeholder="さがす…"><button>検索</button></form>
<div class="acts">${user ? `<a href="/mypage">${esc(user.username)}${unread ? ` 🔔${unread}` : ''}</a><a href="/logout">ログアウト</a><a class="cta" href="/sell">出品する</a>`
      : '<a href="/login">ログイン</a><a class="cta" href="/register">会員登録</a>'}</div></div>
<nav class="sub"><a href="/search?sort=ending">⏰ 終了間近</a><a href="/search?sort=new">新着</a><a href="/search?sort=bidders">人気</a>${CATEGORIES.map((c) => `<a href="/search?category=${encodeURIComponent(c)}">${c}</a>`).join('')}<a href="/search?ended=1">落札結果</a></nav>
<main>${opts.flash ? `<div class="${opts.flashType || 'err'}">${esc(opts.flash)}</div>` : ''}${body}</main>
<footer>見えない価格、ただ一度の入札。</footer><script>${JS}</script></body></html>`;
}

const timer = (end, reload) => `<span class="timer" data-end="${end}"${reload ? ' data-reload="1"' : ''}></span>`;
function statusOf(p) {
  if (p.status !== 'active') return 'ended';
  const t = now();
  return t < p.start_at ? 'scheduled' : t >= p.end_at ? 'ended' : 'live';
}
const bidderCount = (id) => one('SELECT COUNT(*) c FROM bids WHERE auction_id=?', id).c;

function card(p) {
  // ※ 現在価格は意図的に表示しない (§19)
  const st = statusOf(p);
  return `<a class="card" href="/auction/${p.id}"><img src="${esc(p.image_url)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
<div class="b"><h3>${esc(p.title)}</h3><div class="price"><small>開始価格</small> ${yen(p.start_price)}</div>
<div class="meta"><span class="tag blind">🔒 封印中</span> ${bidderCount(p.id)}人が入札</div>
<div class="meta">${st === 'live' ? '残り ' + timer(p.end_at) : st === 'scheduled' ? '開始前' : '<span class="tag end">終了</span>'}</div></div></a>`;
}

// ---------- request plumbing ----------
function parseCookies(h) {
  const o = {};
  (h || '').split(';').forEach((c) => { const i = c.indexOf('='); if (i > 0) o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return o;
}
function readBody(req) {
  return new Promise((res, rej) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) { rej(new Error('too large')); req.destroy(); } });
    req.on('end', () => res(Object.fromEntries(new URLSearchParams(d))));
    req.on('error', rej);
  });
}
function currentUser(req) {
  const tok = parseCookies(req.headers.cookie).sid;
  if (!tok) return null;
  const u = one("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.status='active'", tok);
  return u || null;
}

const routes = [];
const route = (method, re, fn) => routes.push({ method, re, fn });

// ---------- ページ ----------
route('GET', /^\/$/, ({ user }) => {
  const live = "status='active' AND start_at<=? AND end_at>?";
  const t = now();
  const sec = (title, rows, href) => `<div class="sec"><h2>${title}<a href="${href}">もっと見る ›</a></h2>` + (rows.length ? `<div class="grid">${rows.map(card).join('')}</div>` : '<p class="meta">該当する商品はありません。</p>') + '</div>';
  const body = `<div class="hero"><h1>あなたは、<br><em>いくら</em>だと思う？</h1><p>他人の価格は見えない。競り上げもない。最後まで誰が勝つか分からない、ただ一度きりの入札。</p><a class="btn" href="/search">商品を探す</a></div>
<div class="steps"><div><b>商品を見る</b>現在価格は非公開</div><div><b>自分の価値で決める</b>払ってもいい金額を考える</div><div><b>一度だけ入札</b>変更も再入札もなし</div><div><b>最高額が落札</b>終了時刻に自動で決定</div></div>
${sec('⏰ 終了間近のオークション', all(`SELECT * FROM products WHERE ${live} ORDER BY end_at ASC LIMIT 6`, t, t), '/search?sort=ending')}
${sec('🆕 新着商品', all(`SELECT * FROM products WHERE ${live} ORDER BY created_at DESC LIMIT 6`, t, t), '/search?sort=new')}
${sec('🔥 人気商品(入札者数順)', all(`SELECT p.* FROM products p WHERE p.status='active' AND p.start_at<=? AND p.end_at>? ORDER BY (SELECT COUNT(*) FROM bids b WHERE b.auction_id=p.id) DESC LIMIT 6`, t, t), '/search?sort=bidders')}
<div class="sec"><h2>カテゴリから探す</h2><div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr))">${CATEGORIES.map((c) => `<a class="btn sec" style="border-radius:4px;text-align:center" href="/search?category=${encodeURIComponent(c)}">${c}</a>`).join('')}</div></div>`;
  return page(user, 'トップ', body);
});

route('GET', /^\/search$/, ({ user, query }) => {
  const w = [], p = [];
  const t = now();
  if (query.q) { w.push('(title LIKE ? OR brand LIKE ? OR description LIKE ?)'); const l = '%' + query.q + '%'; p.push(l, l, l); }
  if (query.category) { w.push('category=?'); p.push(query.category); }
  if (query.condition) { w.push('item_condition=?'); p.push(query.condition); }
  if (+query.min) { w.push('start_price>=?'); p.push(+query.min); }
  if (+query.max) { w.push('start_price<=?'); p.push(+query.max); }
  if (query.ended === '1') w.push("status<>'active'"); else { w.push("status='active' AND end_at>?"); p.push(t); }
  // 「現在価格順」は存在しない (§23)
  const sorts = {
    new: ['新着順', 'created_at DESC'], ending: ['終了間近', 'end_at ASC'],
    bidders: ['入札者数順', '(SELECT COUNT(*) FROM bids b WHERE b.auction_id=products.id) DESC'],
    low: ['開始価格が安い順', 'start_price ASC'], high: ['開始価格が高い順', 'start_price DESC'],
  };
  const sk = sorts[query.sort] ? query.sort : 'new';
  const rows = all(`SELECT * FROM products WHERE ${w.join(' AND ')} ORDER BY ${sorts[sk][1]} LIMIT 100`, ...p);
  const link = (o) => '/search?' + new URLSearchParams(Object.fromEntries(Object.entries({ ...query, ...o }).filter(([, v]) => v))).toString();
  const body = `<div class="layout"><aside class="side"><form action="/search">
<h4>カテゴリ</h4><a class="${query.category ? '' : 'on'}" href="${esc(link({ category: '' }))}">すべて</a>${CATEGORIES.map((c) => `<a class="${query.category === c ? 'on' : ''}" href="${esc(link({ category: c }))}">${c}</a>`).join('')}
<h4>商品の状態</h4><select name="condition"><option value="">すべて</option>${CONDITIONS.map((c) => `<option ${query.condition === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
<h4>開始価格</h4><input name="min" type="number" placeholder="下限(円)" value="${esc(query.min)}"><p></p><input name="max" type="number" placeholder="上限(円)" value="${esc(query.max)}">
<h4>状態</h4><label><input type="checkbox" name="ended" value="1" style="width:auto" ${query.ended === '1' ? 'checked' : ''}> 終了したオークション</label>
<input type="hidden" name="q" value="${esc(query.q)}"><input type="hidden" name="category" value="${esc(query.category)}"><input type="hidden" name="sort" value="${sk}"><p></p><button>絞り込む</button></form></aside>
<section><div class="sec"><div class="sorts"><span><b>${rows.length}件</b>${query.q ? ` 「${esc(query.q)}」の検索結果` : ''}</span>
<span>並び替え: <select onchange="location=this.value">${Object.entries(sorts).map(([k, v]) => `<option value="${esc(link({ sort: k }))}" ${k === sk ? 'selected' : ''}>${v[0]}</option>`).join('')}</select></span></div>
${rows.length ? `<div class="grid">${rows.map(card).join('')}</div>` : '<p>該当する商品がありません。</p>'}</div></section></div>`;
  return page(user, '商品検索', body);
});

function auctionBody(user, p, flash) {
  const st = statusOf(p);
  const seller = one('SELECT username FROM users WHERE id=?', p.seller_id);
  const n = bidderCount(p.id);
  const mine = user ? one('SELECT amount FROM bids WHERE auction_id=? AND user_id=?', p.id, user.id) : null;
  let box = '';
  if (st === 'ended') {
    // 終了後に公開するのは落札価格のみ (§14)。他人の入札額は一切送らない。
    const tx = one('SELECT * FROM transactions WHERE auction_id=?', p.id);
    if (!tx) box = '<p><b>オークション終了</b><br>入札はありませんでした。</p>';
    else {
      const w = one('SELECT username FROM users WHERE id=?', tx.buyer_id);
      const isWin = user && user.id === tx.buyer_id;
      box = `<p><b>オークション終了</b></p><p class="win">落札価格 ${yen(tx.amount)}</p><p>落札者: ${esc(w.username)}</p>
${isWin ? '<p class="win">🏆 落札しました</p>' : ''}
${mine && !isWin ? `<p>あなたの入札額: ${yen(mine.amount)}<br>今回は落札できませんでした。</p>` : ''}
${user && (isWin || user.id === p.seller_id) ? `<a class="btn" href="/transaction/${tx.id}">取引画面へ</a>` : ''}`;
    }
  } else if (st === 'scheduled') {
    box = `<p>開始前です。<br>開始: ${fmtDate(p.start_at)}</p>`;
  } else if (!user) {
    box = '<p><a class="btn" href="/login?next=/auction/' + p.id + '">ログインして入札</a></p>';
  } else if (user.id === p.seller_id) {
    box = '<p class="meta">あなたの出品商品です(入札できません)。</p>';
  } else if (mine) {
    box = `<div><p><b>あなたはこの商品に入札済みです。</b></p><p>あなたの入札額<br><span class="win">${yen(mine.amount)}</span></p>
<p class="meta">※入札額の変更はできません。終了までお待ちください。<br>現在の順位: 非公開 / 他の入札額: 非公開</p><button disabled>入札済み</button></div>`;
  } else {
    box = `<p>あなたの入札: 未入札</p><form action="/auction/${p.id}/confirm" method="post" class="f">
<label>あなたがこの商品に払ってもいい金額(円)</label><input name="amount" type="number" min="${p.start_price}" step="1" required placeholder="${p.start_price}以上">
<p></p><button class="buy">一発入札する</button></form>`;
  }
  return `<div class="crumb"><a href="/">トップ</a> › <a href="/search?category=${encodeURIComponent(p.category)}">${esc(p.category)}</a> › ${esc(p.title)}</div>
<div class="detail"><div><img src="${esc(p.image_url)}" alt="" onerror="this.style.display='none'"></div><div>
<h1>${esc(p.title)}</h1><p class="meta">出品者: <a href="#">${esc(seller.username)}</a></p><hr>
<div class="price"><small>開始価格</small> ${yen(p.start_price)}</div>
${st === 'ended' ? '' : '<p><span class="tag blind">🔒 封印中</span> <span class="meta">他の人の入札額は終了まで誰にも見えません</span></p>'}
<div class="buybox">${st === 'live' ? `<div class="meta">残り時間</div>${timer(p.end_at, true).replace('class="timer"', 'class="timer big"')}<hr>` : ''}${box}</div>
<table class="info"><tr><th>入札者数</th><td>${n}人</td></tr><tr><th>終了日時</th><td>${fmtDate(p.end_at)}</td></tr>
<tr><th>商品の状態</th><td>${esc(p.item_condition)}</td></tr>${p.brand ? `<tr><th>ブランド</th><td>${esc(p.brand)}</td></tr>` : ''}
<tr><th>カテゴリ</th><td>${esc(p.category)}</td></tr><tr><th>発送方法</th><td>${esc(p.shipping_method)}</td></tr>
<tr><th>発送元</th><td>${esc(p.ship_from)}</td></tr><tr><th>送料</th><td>${esc(p.shipping_payer)}</td></tr></table>
<h3>商品説明</h3><p>${esc(p.description).replace(/\n/g, '<br>')}</p></div></div>`;
}

route('GET', /^\/auction\/(\d+)$/, ({ user, m, query }) => {
  const p = one('SELECT * FROM products WHERE id=?', +m[1]);
  if (!p) return [404, page(user, '404', '<p>商品が見つかりません。</p>')];
  return page(user, p.title, auctionBody(user, p), { flash: query.msg, flashType: 'ok' });
});

// 入札確認画面 (§8)
route('POST', /^\/auction\/(\d+)\/confirm$/, ({ user, m, form }) => {
  if (!user) return redirect('/login');
  const p = one('SELECT * FROM products WHERE id=?', +m[1]);
  const amount = Number(form.amount);
  const err = bidError(user, p, amount);
  if (err) return page(user, '入札エラー', auctionBody(user, p), { flash: err });
  return page(user, '入札確認', `<div class="panel"><h2>入札確認</h2><p>商品:<br><b>${esc(p.title)}</b></p>
<p>あなたの入札額:<br><span class="win">${yen(amount)}</span></p>
<div class="warn"><ul><li>入札は1回のみです</li><li>入札後の変更はできません</li><li>他のユーザーの入札額は公開されません</li><li>終了時に最高額だった場合、落札となります</li></ul></div>
<form method="post" action="/auction/${p.id}/bid" class="f"><input type="hidden" name="amount" value="${amount}"><p></p>
<button>入札を確定する</button> <a class="btn sec" href="/auction/${p.id}">キャンセル</a></form></div>`);
});

function bidError(user, p, amount) {
  if (!p) return '商品が存在しません。';
  if (statusOf(p) !== 'live') return 'このオークションは入札を受け付けていません。';
  if (user.id === p.seller_id) return '自分の商品には入札できません。';
  if (!Number.isInteger(amount) || amount < p.start_price) return `入札額は開始価格(${yen(p.start_price)})以上の整数で指定してください。`;
  if (amount > 1e9) return '入札額が大きすぎます。';
  if (one('SELECT 1 x FROM bids WHERE auction_id=? AND user_id=?', p.id, user.id)) return 'すでに入札済みです。変更はできません。';
  return null;
}

route('POST', /^\/auction\/(\d+)\/bid$/, ({ user, m, form }) => {
  if (!user) return redirect('/login');
  db.exec('BEGIN IMMEDIATE');
  try {
    const p = one('SELECT * FROM products WHERE id=?', +m[1]);
    const amount = Number(form.amount);
    const err = bidError(user, p, amount); // 終了時刻の再検証もトランザクション内で行う
    if (err) { db.exec('ROLLBACK'); return page(user, '入札エラー', auctionBody(user, p), { flash: err }); }
    run('INSERT INTO bids(auction_id,user_id,amount,created_at) VALUES(?,?,?,?)', p.id, user.id, amount, now());
    notify(user.id, `「${p.title}」への入札が完了しました。`, '/auction/' + p.id);
    db.exec('COMMIT');
    return redirect('/auction/' + p.id + '?msg=' + encodeURIComponent('入札が完了しました'));
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});

// 会員登録 / ログイン
const regForm = (v = {}) => `<h1>会員登録</h1><form method="post" class="panel f">
<label>ユーザー名</label><input name="username" required value="${esc(v.username)}">
<label>メールアドレス</label><input name="email" type="email" required value="${esc(v.email)}">
<label>パスワード(8文字以上)</label><input name="password" type="password" required minlength="8">
<label>電話番号</label><input name="phone" required value="${esc(v.phone)}">
<label><input type="checkbox" name="terms" value="1" style="width:auto" required> 利用規約に同意する</label><p></p><button>登録する</button></form>`;
route('GET', /^\/register$/, ({ user }) => page(user, '会員登録', regForm()));
route('POST', /^\/register$/, ({ user, form, res }) => {
  const { username = '', email = '', password = '', phone = '', terms } = form;
  let err = null;
  if (!username.trim() || username.length > 30) err = 'ユーザー名は1〜30文字で入力してください。';
  else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) err = 'メールアドレスが不正です。';
  else if (password.length < 8) err = 'パスワードは8文字以上にしてください。';
  else if (!/^[0-9+\-]{8,15}$/.test(phone)) err = '電話番号が不正です。';
  else if (!terms) err = '利用規約への同意が必要です。';
  else if (one('SELECT 1 x FROM users WHERE username=? OR email=?', username.trim(), email.trim())) err = 'ユーザー名またはメールアドレスは既に使われています。';
  if (err) return page(user, '会員登録', regForm(form), { flash: err });
  const r = run('INSERT INTO users(username,email,password_hash,phone,created_at) VALUES(?,?,?,?,?)', username.trim(), email.trim(), hashPw(password), phone, now());
  return login(Number(r.lastInsertRowid), '/mypage');
});
route('GET', /^\/login$/, ({ user, query }) => page(user, 'ログイン', `<h1>ログイン</h1><form method="post" class="panel f">
<input type="hidden" name="next" value="${esc(query.next)}"><label>メールアドレス</label><input name="email" type="email" required>
<label>パスワード</label><input name="password" type="password" required><p></p><button>ログイン</button> <a href="/register">会員登録</a></form>`));
route('POST', /^\/login$/, ({ user, form }) => {
  const u = one('SELECT * FROM users WHERE email=?', form.email || '');
  if (!u || u.status !== 'active' || !checkPw(form.password || '', u.password_hash)) {
    return page(user, 'ログイン', '<h1>ログイン</h1><p><a href="/login">もう一度</a></p>', { flash: 'メールアドレスまたはパスワードが違います。' });
  }
  return login(u.id, form.next && form.next.startsWith('/') && !form.next.startsWith('//') ? form.next : '/mypage');
});
function login(uid, to) {
  const tok = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions VALUES(?,?,?)', tok, uid, now());
  return redirect(to, { 'Set-Cookie': `sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` });
}
route('GET', /^\/logout$/, ({ req }) => {
  const tok = parseCookies(req.headers.cookie).sid;
  if (tok) run('DELETE FROM sessions WHERE token=?', tok);
  return redirect('/', { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
});

// 出品
const toInput = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 16);
const sellForm = (v = {}) => {
  const sel = (arr, k) => arr.map((c) => `<option ${v[k] === c ? 'selected' : ''}>${c}</option>`).join('');
  const t = now();
  return `<h1>商品を出品する</h1><form method="post" class="panel f">
<label>商品名</label><input name="title" required value="${esc(v.title)}">
<label>商品画像URL</label><input name="image_url" type="url" required placeholder="https://..." value="${esc(v.image_url)}">
<label>商品説明</label><textarea name="description" rows="5" required>${esc(v.description)}</textarea>
<label>カテゴリ</label><select name="category">${sel(CATEGORIES, 'category')}</select>
<label>ブランド(任意)</label><input name="brand" value="${esc(v.brand)}">
<label>商品の状態</label><select name="item_condition">${sel(CONDITIONS, 'item_condition')}</select>
<label>開始価格(円)</label><input name="start_price" type="number" min="1" required value="${esc(v.start_price)}">
<label>開始日時(日本時間)</label><input name="start_at" type="datetime-local" required value="${esc(v.start_at || toInput(t))}">
<label>終了日時(日本時間)</label><input name="end_at" type="datetime-local" required value="${esc(v.end_at || toInput(t + 7 * 864e5))}">
<label>発送方法</label><input name="shipping_method" required value="${esc(v.shipping_method || '宅配便')}">
<label>発送元地域</label><input name="ship_from" required value="${esc(v.ship_from || '東京都')}">
<label>送料負担者</label><select name="shipping_payer">${sel(['出品者負担', '落札者負担'], 'shipping_payer')}</select>
<p class="meta">※出品後、終了日時の延長はできません。</p><button>出品する</button></form>`;
};
route('GET', /^\/sell$/, ({ user }) => user ? page(user, '出品', sellForm()) : redirect('/login?next=/sell'));
route('POST', /^\/sell$/, ({ user, form }) => {
  if (!user) return redirect('/login');
  const need = ['title', 'image_url', 'description', 'category', 'item_condition', 'start_price', 'start_at', 'end_at', 'shipping_method', 'ship_from', 'shipping_payer'];
  const startAt = Date.parse(form.start_at + ':00+09:00'), endAt = Date.parse(form.end_at + ':00+09:00');
  const price = Number(form.start_price);
  let err = null;
  if (need.some((k) => !String(form[k] || '').trim())) err = '必須項目が未入力です。';
  else if (!/^https?:\/\//i.test(form.image_url)) err = '画像URLは http(s):// で始めてください。';
  else if (!CATEGORIES.includes(form.category) || !CONDITIONS.includes(form.item_condition)) err = 'カテゴリまたは状態が不正です。';
  else if (!Number.isInteger(price) || price < 1) err = '開始価格は1円以上の整数にしてください。';
  else if (isNaN(startAt) || isNaN(endAt)) err = '日時が不正です。';
  else if (endAt <= now()) err = '終了日時は未来にしてください。';
  else if (endAt <= startAt) err = '終了日時は開始日時より後にしてください。';
  if (err) return page(user, '出品', sellForm(form), { flash: err });
  const r = run(`INSERT INTO products(seller_id,title,description,image_url,category,brand,item_condition,shipping_method,ship_from,shipping_payer,start_price,start_at,end_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, user.id, form.title.trim(), form.description, form.image_url, form.category, form.brand || null,
    form.item_condition, form.shipping_method, form.ship_from, form.shipping_payer, price, startAt, endAt, now());
  return redirect('/auction/' + r.lastInsertRowid);
});

// マイページ (§26, §27) — 自分の入札額のみ取得する
route('GET', /^\/mypage$/, ({ user }) => {
  if (!user) return redirect('/login?next=/mypage');
  const bidding = all(`SELECT p.*, b.amount my FROM bids b JOIN products p ON p.id=b.auction_id WHERE b.user_id=? ORDER BY p.end_at DESC`, user.id);
  const sell = all('SELECT * FROM products WHERE seller_id=? ORDER BY created_at DESC', user.id);
  const txs = all(`SELECT t.*, p.title FROM transactions t JOIN products p ON p.id=t.auction_id WHERE buyer_id=? OR seller_id=? ORDER BY t.created_at DESC`, user.id, user.id);
  const notes = all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 20', user.id);
  const lbl = (p) => ({ live: '入札受付中', scheduled: '開始前', ended: '終了' }[statusOf(p)]);
  const outcome = (p) => {
    if (statusOf(p) !== 'ended') return '入札中';
    const t = one('SELECT buyer_id FROM transactions WHERE auction_id=?', p.id);
    return t && t.buyer_id === user.id ? '🏆 落札' : '落札できず';
  };
  const body = `<h1>マイページ</h1>
<div class="panel"><h3>🔔 通知</h3>${notes.length ? '<ul>' + notes.map((n) => `<li>${n.link ? `<a href="${esc(n.link)}">${esc(n.message)}</a>` : esc(n.message)} <span class="meta">${fmtDate(n.created_at)}</span></li>`).join('') + '</ul>' : '<p class="meta">通知はありません。</p>'}</div>
<div class="panel"><h3>入札した商品</h3><table><tr><th>商品</th><th>あなたの入札額</th><th>状況</th></tr>${bidding.map((p) => `<tr><td><a href="/auction/${p.id}">${esc(p.title)}</a></td><td>${yen(p.my)}</td><td>${outcome(p)}</td></tr>`).join('') || '<tr><td colspan=3 class="meta">なし</td></tr>'}</table></div>
<div class="panel"><h3>出品した商品</h3><table><tr><th>商品</th><th>開始価格</th><th>入札者</th><th>状況</th></tr>${sell.map((p) => `<tr><td><a href="/auction/${p.id}">${esc(p.title)}</a></td><td>${yen(p.start_price)}</td><td>${bidderCount(p.id)}人</td><td>${lbl(p)}</td></tr>`).join('') || '<tr><td colspan=4 class="meta">なし</td></tr>'}</table></div>
<div class="panel"><h3>取引</h3><table><tr><th>商品</th><th>区分</th><th>金額</th><th>状況</th></tr>${txs.map((t) => `<tr><td><a href="/transaction/${t.id}">${esc(t.title)}</a></td><td>${t.buyer_id === user.id ? '購入' : '販売'}</td><td>${yen(t.amount)}</td><td>${TX_STEPS[t.status]}</td></tr>`).join('') || '<tr><td colspan=4 class="meta">なし</td></tr>'}</table></div>`;
  return page(user, 'マイページ', body);
});

// 取引 (§16) — 決済は分離。MVPでは「支払い完了」ボタンのモック
route('GET', /^\/transaction\/(\d+)$/, ({ user, m, query }) => {
  if (!user) return redirect('/login');
  const t = one('SELECT t.*, p.title FROM transactions t JOIN products p ON p.id=t.auction_id WHERE t.id=?', +m[1]);
  if (!t || (t.buyer_id !== user.id && t.seller_id !== user.id)) return [404, page(user, '404', '<p>取引が見つかりません。</p>')];
  const isBuyer = user.id === t.buyer_id;
  const buyer = one('SELECT username FROM users WHERE id=?', t.buyer_id), seller = one('SELECT username FROM users WHERE id=?', t.seller_id);
  const next = { payment_pending: isBuyer && ['pay', '支払いを完了する(モック)'], paid: !isBuyer && ['ship', '発送しました'], shipped: isBuyer && ['receive', '受取を確認する'] }[t.status];
  const steps = Object.entries(TX_STEPS).map(([k, v]) => k === t.status ? `<b>【${v}】</b>` : v).join(' → ');
  return page(user, '取引', `<h1>取引: ${esc(t.title)}</h1><div class="panel">
<p>落札価格: <b>${yen(t.amount)}</b></p><p>購入者: ${esc(buyer.username)} / 出品者: ${esc(seller.username)}</p>
${isBuyer ? '' : `<p>販売手数料: ${yen(t.fee)} → 出品者受取: <b>${yen(t.amount - t.fee)}</b></p>`}
<p>${steps}</p>${next ? `<form method="post" action="/transaction/${t.id}/${next[0]}"><button>${next[1]}</button></form>` : t.status === 'received' ? '<p>取引は完了しました。</p>' : '<p class="meta">相手の対応を待っています。</p>'}</div>`,
  { flash: query.msg, flashType: 'ok' });
});
route('POST', /^\/transaction\/(\d+)\/(pay|ship|receive)$/, ({ user, m }) => {
  if (!user) return redirect('/login');
  const t = one('SELECT * FROM transactions WHERE id=?', +m[1]);
  const flow = { pay: ['payment_pending', 'paid', t && t.buyer_id, t && t.seller_id, '支払いが完了しました。発送をお願いします。'],
    ship: ['paid', 'shipped', t && t.seller_id, t && t.buyer_id, '商品が発送されました。'],
    receive: ['shipped', 'received', t && t.buyer_id, t && t.seller_id, '購入者が受取を確認しました。取引完了です。'] }[m[2]];
  if (!t || t.status !== flow[0] || user.id !== flow[2]) return [403, page(user, '403', '<p>この操作はできません。</p>')];
  run('UPDATE transactions SET status=? WHERE id=?', flow[1], t.id);
  notify(flow[3], flow[4], '/transaction/' + t.id);
  return redirect('/transaction/' + t.id);
});

function redirect(to, headers = {}) { return { redirect: to, headers }; }

// ---------- server ----------
http.createServer(async (req, res) => {
  try {
    settleEnded();
    const url = new URL(req.url, 'http://x');
    const query = Object.fromEntries(url.searchParams);
    const user = currentUser(req);
    const form = req.method === 'POST' ? await readBody(req) : {};
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (!m) continue;
      let out = await r.fn({ req, res, user, query, form, m });
      let status = 200, headers = { 'Content-Type': 'text/html; charset=utf-8' };
      if (Array.isArray(out)) [status, out] = out;
      if (out && out.redirect) { res.writeHead(303, { Location: out.redirect, ...out.headers }); return res.end(); }
      res.writeHead(status, headers);
      return res.end(out);
    }
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(user, '404', '<p>ページが見つかりません。</p>'));
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('サーバーエラー');
  }
}).listen(PORT, () => console.log('http://localhost:' + PORT));
