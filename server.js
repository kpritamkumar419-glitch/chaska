// Chaska Restaurant backend — zero npm dependencies. Needs Node >= 22.13 (built-in SQLite).
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const env = process.env;
const PORT = +env.PORT || 3000;
const OWNER = env.OWNER_PHONE || '9939834950';
const SECRET = env.JWT_SECRET || crypto.randomBytes(32).toString('hex'); // set JWT_SECRET in production!
const DEMO = env.DEMO_OTP === '1'; // demo mode: OTP is always 1234 and returned in the response
const ORIGIN = env.ALLOWED_ORIGIN || '*';
const REST = { lat: +env.REST_LAT || 26.4667, lng: +env.REST_LNG || 84.4333 }; // set exact restaurant coordinates
const now = () => Date.now();
const OFFER_S = +env.OFFER_SECONDS || 30; // rider ke paas accept karne ke second

const DB_FILE = env.DB_FILE || 'chaska.db'; // Render free plan: this file is WIPED whenever the service sleeps & wakes.
// Fix: add a paid Starter plan + a persistent Disk in Render, mount it (e.g. /var/data), then set DB_FILE=/var/data/chaska.db
{ const dir = path.dirname(DB_FILE); if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
const db = new DatabaseSync(DB_FILE);
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY AUTOINCREMENT,cat TEXT,name TEXT,price INT,img TEXT DEFAULT '',custom INT DEFAULT 0,off INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS banners(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT,sub TEXT DEFAULT '',img TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS partners(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,phone TEXT UNIQUE,online INT DEFAULT 0,lat REAL,lng REAL,seen INT);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,seq INT,items TEXT,total INT,name TEXT,phone TEXT,addr TEXT,lat REAL,lng REAL,pay TEXT,status INT DEFAULT 0,cancelled INT DEFAULT 0,rider INT,earn INT DEFAULT 0,created INT,out_at INT,done_at INT);
CREATE TABLE IF NOT EXISTS otps(phone TEXT,role TEXT,code TEXT,exp INT,tries INT DEFAULT 0,sent INT,PRIMARY KEY(phone,role));
CREATE TABLE IF NOT EXISTS offers(oid TEXT,rider INT,t INT,state TEXT DEFAULT 'sent',PRIMARY KEY(oid,rider));
CREATE TABLE IF NOT EXISTS pushes(endpoint TEXT PRIMARY KEY,rider INT);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY,v TEXT);
CREATE TABLE IF NOT EXISTS msgs(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,phone TEXT,msg TEXT,created INT);
CREATE TABLE IF NOT EXISTS coupons(code TEXT PRIMARY KEY,type TEXT,value INT,active INT DEFAULT 1,max_uses INT,uses INT DEFAULT 0,created INT);
CREATE TABLE IF NOT EXISTS customers(email TEXT PRIMARY KEY,name TEXT,created INT);`);
for (const [col, def] of [['email', 'TEXT'], ['coupon', 'TEXT'], ['discount', 'INT DEFAULT 0'], ['subtotal', 'INT']]) { try { db.exec(`ALTER TABLE orders ADD COLUMN ${col} ${def}`); } catch {} } // migration for orders created before this update
const CATS = JSON.parse(fs.readFileSync(new URL('./menu.json', import.meta.url), 'utf8'));
if (!db.prepare('SELECT COUNT(*) c FROM products').get().c) {
  const ins = db.prepare('INSERT INTO products(cat,name,price) VALUES(?,?,?)');
  for (const c of CATS) for (const i of c.items) ins.run(c.cat, i[0], i[1]);
}
if (!db.prepare('SELECT COUNT(*) c FROM partners').get().c) db.prepare('INSERT INTO partners(name,phone) VALUES(?,?)').run('Rahul', '9000000001');

// ---------- helpers ----------
const err = (code, msg) => Object.assign(new Error(msg), { code });
const b64 = (x) => Buffer.from(x).toString('base64url');
const mac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const sign = (p) => { const h = b64('{"alg":"HS256","typ":"JWT"}'), d = b64(JSON.stringify({ ...p, exp: now() + 30 * 864e5 })); return `${h}.${d}.${mac(h + '.' + d)}`; };
const verify = (t) => {
  try {
    const [h, d, s] = String(t).split('.'), x = mac(h + '.' + d);
    if (s.length !== x.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(x))) return null;
    const p = JSON.parse(Buffer.from(d, 'base64url')); return p.exp > now() ? p : null;
  } catch { return null; }
};
const hashOtp = (c) => crypto.createHash('sha256').update(c + SECRET).digest('hex');
const hits = new Map();
const limit = (key, max, ms) => { const t = now(), a = (hits.get(key) || []).filter((x) => t - x < ms); if (a.length >= max) throw err(429, 'Bahut zyada requests, thoda ruk kar try karein'); a.push(t); hits.set(key, a); };
setInterval(() => { const t = now(); for (const [k, a] of hits) if (!a.some((x) => t - x < 6e4)) hits.delete(k); }, 6e4).unref();
const km = (a, b, c, d) => { if ([a, b, c, d].some((v) => typeof v !== 'number')) return null; const r = (x) => x * Math.PI / 180, h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return +(12742 * Math.asin(Math.sqrt(h)) * 1.3).toFixed(1); }; // x1.3 ≈ road factor
const phoneOk = (p) => /^[6-9]\d{9}$/.test(String(p));
const emailOk = (e) => typeof e === 'string' && e.length < 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const couponCalc = (row, subtotal) => { if (!row || !row.active) return 0; if (row.max_uses && row.uses >= row.max_uses) return 0; const d = row.type === 'percent' ? Math.round(subtotal * row.value / 100) : row.value; return Math.max(0, Math.min(d, subtotal)); };
const imgOk = (s) => !s || (typeof s === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(s) && s.length < 450000);
const str = (v, min, max, what) => { if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw err(400, `${what} galat hai`); return v.trim(); };

// ---------- Web Push (VAPID, koi npm package nahi) + rider offers ----------
let VK = db.prepare("SELECT v FROM kv WHERE k='vapid'").get()?.v;
if (!VK) { VK = JSON.stringify(crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })); db.prepare("INSERT INTO kv VALUES('vapid',?)").run(VK); }
const VJ = JSON.parse(VK), VPRIV = crypto.createPrivateKey({ key: VJ, format: 'jwk' });
const VPUB = Buffer.concat([Buffer.from([4]), Buffer.from(VJ.x, 'base64url'), Buffer.from(VJ.y, 'base64url')]).toString('base64url');
const PUSH_OK = ['googleapis.com', 'mozilla.com', 'push.apple.com', 'windows.com'];
const pushHostOk = (u) => { try { const x = new URL(u); if (env.ALLOW_LOCAL_PUSH === '1' && x.hostname === 'localhost') return true; return x.protocol === 'https:' && PUSH_OK.some((d) => x.hostname === d || x.hostname.endsWith('.' + d)); } catch { return false; } };
async function push(rider) {
  for (const r of db.prepare('SELECT endpoint FROM pushes WHERE rider=?').all(rider)) {
    try {
      const u = new URL(r.endpoint), h = b64('{"typ":"JWT","alg":"ES256"}'), p = b64(JSON.stringify({ aud: u.origin, exp: Math.floor(now() / 1000) + 43200, sub: env.VAPID_SUBJECT || 'mailto:owner@chaska.example' }));
      const sig = crypto.sign('sha256', Buffer.from(h + '.' + p), { key: VPRIV, dsaEncoding: 'ieee-p1363' }).toString('base64url');
      const res = await fetch(r.endpoint, { method: 'POST', headers: { Authorization: `vapid t=${h}.${p}.${sig}, k=${VPUB}`, TTL: String(OFFER_S), Urgency: 'high' } });
      if (res.status === 404 || res.status === 410) db.prepare('DELETE FROM pushes WHERE endpoint=?').run(r.endpoint);
    } catch (e) { console.error('push fail', e.message); }
  }
}
const offerTo = (oid, rider) => db.prepare("INSERT OR REPLACE INTO offers(oid,rider,t,state) VALUES(?,?,?,'sent')").run(oid, rider, now());
const offerAll = (oid) => { for (const p of db.prepare('SELECT id FROM partners WHERE online=1').all()) if (!activeOf(p.id)) { offerTo(oid, p.id); push(p.id); } };
const offerPending = (rider) => { // rider online hua / free hua: pending orders ka offer (jo pehle mil chuka ho use dobara nahi)
  if (activeOf(rider)) return; let n = 0;
  for (const o of db.prepare('SELECT id FROM orders WHERE rider IS NULL AND status BETWEEN 0 AND 2 AND cancelled=0').all()) if (!db.prepare('SELECT 1 FROM offers WHERE oid=? AND rider=?').get(o.id, rider)) { offerTo(o.id, rider); n++; }
  if (n) push(rider);
};

// ---------- realtime (Server-Sent Events) ----------
const clients = new Set();
const emit = (order, k = 'order') => { const m = `data: ${JSON.stringify({ k, id: order })}\n\n`; for (const c of clients) if (c.role === 'owner' || c.role === 'rider' || c.order === order) c.res.write(m); };
setInterval(() => { for (const c of clients) c.res.write(': hb\n\n'); }, 25000).unref();

// ---------- routes ----------
const routes = [];
const on = (m, p, role, fn) => routes.push([m, new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), role, fn]);
const orderOut = (o) => ({ id: o.id, status: o.status, cancelled: !!o.cancelled, total: o.total, subtotal: o.subtotal ?? o.total, discount: o.discount || 0, coupon: o.coupon || null, items: JSON.parse(o.items), name: o.name, phone: o.phone, addr: o.addr, pay: o.pay, rider: o.rider, earn: o.earn, created: o.created, out_at: o.out_at, done_at: o.done_at });

// auth
async function sendEmailOtp(to, code) {
  if (!env.RESEND_API_KEY) throw err(500, 'Email provider set nahi hai (RESEND_API_KEY)');
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: env.RESEND_FROM || 'Chaska <onboarding@resend.dev>', to, subject: `Aapka OTP: ${code}`, html: `<p>Aapka Chaska login OTP hai: <b>${code}</b> (5 minute tak valid)</p>` }) });
  if (!r.ok) throw err(502, 'OTP email bhejne me dikkat aayi');
}
on('POST', '/api/auth/otp', null, async ({ body, ip }) => {
  const { role } = body; limit('otp' + ip, 10, 6e5);
  if (!['owner', 'rider', 'customer'].includes(role)) throw err(400, 'Role galat hai');
  const idField = role === 'customer' ? String(body.email || '').trim().toLowerCase() : String(body.phone || '').trim();
  if (role === 'customer' ? !emailOk(idField) : !phoneOk(idField)) throw err(400, role === 'customer' ? 'Sahi email daalein' : '10 digit number daalein');
  if (role === 'owner' && idField !== OWNER) throw err(404, 'Ye number registered nahi hai');
  if (role === 'rider' && !db.prepare('SELECT 1 FROM partners WHERE phone=?').get(idField)) throw err(404, 'Ye number registered nahi hai');
  const old = db.prepare('SELECT sent FROM otps WHERE phone=? AND role=?').get(idField, role);
  if (old && now() - old.sent < 30000) throw err(429, '30 second baad dobara try karein');
  const code = DEMO ? '1234' : String(crypto.randomInt(1000, 10000));
  db.prepare('INSERT OR REPLACE INTO otps(phone,role,code,exp,tries,sent) VALUES(?,?,?,?,0,?)').run(idField, role, hashOtp(code), now() + 5 * 6e4, now());
  if (!DEMO) {
    if (role === 'customer') await sendEmailOtp(idField, code);
    else {
      if (!env.FAST2SMS_KEY) throw err(500, 'SMS provider set nahi hai (FAST2SMS_KEY)');
      const r = await fetch(`https://www.fast2sms.com/dev/bulkV2?authorization=${encodeURIComponent(env.FAST2SMS_KEY)}&route=otp&variables_values=${code}&numbers=${idField}`);
      if (!r.ok) throw err(502, 'OTP bhejne me dikkat aayi');
    }
  }
  return DEMO ? { sent: true, demo_otp: code } : { sent: true };
});
on('POST', '/api/auth/verify', null, ({ body, ip }) => {
  const { role, otp } = body; limit('ver' + ip, 20, 6e5);
  const idField = role === 'customer' ? String(body.email || '').trim().toLowerCase() : String(body.phone || '').trim();
  const row = db.prepare('SELECT * FROM otps WHERE phone=? AND role=?').get(idField, String(role));
  if (!row || row.exp < now() || row.tries >= 5) throw err(400, 'OTP expire ho gaya, naya mangwayein');
  if (row.code !== hashOtp(String(otp))) { db.prepare('UPDATE otps SET tries=tries+1 WHERE phone=? AND role=?').run(idField, role); throw err(400, 'Galat OTP'); }
  db.prepare('DELETE FROM otps WHERE phone=? AND role=?').run(idField, role);
  if (role === 'owner') return { token: sign({ role, id: 0 }) };
  if (role === 'customer') {
    db.prepare('INSERT OR IGNORE INTO customers(email,name,created) VALUES(?,?,?)').run(idField, str(body.name || 'Guest', 1, 60, 'Naam'), now());
    if (body.name) db.prepare('UPDATE customers SET name=? WHERE email=?').run(str(body.name, 1, 60, 'Naam'), idField);
    const c = db.prepare('SELECT name FROM customers WHERE email=?').get(idField);
    return { token: sign({ role, email: idField }), name: c.name };
  }
  const p = db.prepare('SELECT id,name FROM partners WHERE phone=?').get(idField);
  return { token: sign({ role, id: p.id }), name: p.name };
});
on('GET', '/api/customer/me', 'customer', ({ user }) => db.prepare('SELECT name,email FROM customers WHERE email=?').get(user.email));
on('PATCH', '/api/customer/me', 'customer', ({ user, body }) => { db.prepare('UPDATE customers SET name=? WHERE email=?').run(str(body.name, 1, 60, 'Naam'), user.email); return { ok: true }; });
on('GET', '/api/customer/orders', 'customer', ({ user }) => ({ orders: db.prepare('SELECT * FROM orders WHERE email=? ORDER BY created DESC LIMIT 50').all(user.email).map(orderOut) }));

// public
on('GET', '/api/menu', null, () => ({
  cats: CATS.map((c) => ({ name: c.cat, emoji: c.emoji })),
  products: db.prepare('SELECT id,cat,name,price,img,off FROM products ORDER BY id').all(),
  banners: db.prepare('SELECT id,title,sub,img FROM banners ORDER BY id').all(),
}));
on('GET', '/api/coupons/active', null, () => ({ coupons: db.prepare('SELECT code,type,value FROM coupons WHERE active=1 AND (max_uses IS NULL OR uses<max_uses)').all() }));
on('POST', '/api/coupon/check', null, ({ body }) => {
  const code = String(body.code || '').trim().toUpperCase(), sub = +body.subtotal;
  if (!code || !(sub > 0)) throw err(400, 'Coupon ya amount galat hai');
  const c = db.prepare('SELECT * FROM coupons WHERE code=?').get(code);
  if (!c) throw err(404, 'Ye coupon nahi mila');
  if (!c.active) throw err(409, 'Ye coupon band hai');
  if (c.max_uses && c.uses >= c.max_uses) throw err(409, 'Ye coupon khatam ho gaya');
  return { code, discount: couponCalc(c, sub) };
});
on('POST', '/api/orders', null, ({ body, ip, req }) => {
  limit('ord' + ip, 8, 6e5);
  const name = str(body.name, 1, 60, 'Naam'), addr = str(body.addr, 8, 300, 'Address');
  if (!phoneOk(body.phone)) throw err(400, 'Phone number galat hai');
  const pay = ['Cash on Delivery', 'UPI'].includes(body.pay) ? body.pay : null; if (!pay) throw err(400, 'Payment method galat hai');
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 30) throw err(400, 'Cart khali hai');
  let subtotal = 0; const items = [];
  for (const it of body.items) {
    const q = +it.q, p = db.prepare('SELECT * FROM products WHERE id=?').get(+it.id);
    if (!p || !Number.isInteger(q) || q < 1 || q > 20) throw err(400, 'Item galat hai');
    if (p.off) throw err(409, `${p.name} abhi available nahi hai`);
    subtotal += p.price * q; items.push({ n: p.name, p: p.price, q });
  }
  let discount = 0, coupon = null;
  if (body.coupon) {
    coupon = String(body.coupon).trim().toUpperCase();
    const c = db.prepare('SELECT * FROM coupons WHERE code=?').get(coupon);
    discount = couponCalc(c, subtotal);
    if (!c || !c.active || discount <= 0) { coupon = null; discount = 0; } else db.prepare('UPDATE coupons SET uses=uses+1 WHERE code=?').run(coupon);
  }
  const total = subtotal - discount;
  const lat = typeof body.lat === 'number' ? body.lat : null, lng = typeof body.lng === 'number' ? body.lng : null;
  const seq = (db.prepare('SELECT MAX(seq) m FROM orders').get().m || 1000) + 1, id = 'CH' + seq;
  const tok = verify((req.headers.authorization || '').replace('Bearer ', '')), email = tok && tok.role === 'customer' ? tok.email : null;
  db.prepare('INSERT INTO orders(id,seq,items,total,subtotal,discount,coupon,email,name,phone,addr,lat,lng,pay,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, seq, JSON.stringify(items), total, subtotal, discount, coupon, email, name, body.phone, addr, lat, lng, pay, now());
  offerAll(id); emit(id); return { id, total, subtotal, discount };
});
on('GET', '/api/track/:id', null, ({ params, query }) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(params.id);
  if (!o || o.phone !== query.get('phone')) throw err(404, 'Order nahi mila');
  const r = o.rider && o.status < 4 ? db.prepare('SELECT name,phone,lat,lng FROM partners WHERE id=?').get(o.rider) : null;
  const { rider, earn, ...pub } = orderOut(o); return { ...pub, rider: r, dest: o.lat != null ? { lat: o.lat, lng: o.lng } : null, restaurant: REST };
});
on('POST', '/api/contact', null, ({ body, ip }) => { limit('msg' + ip, 5, 6e5); db.prepare('INSERT INTO msgs(name,phone,msg,created) VALUES(?,?,?,?)').run(str(body.name || 'Guest', 1, 60, 'Naam'), String(body.phone || '').slice(0, 15), str(body.msg, 1, 1000, 'Message'), now()); return { ok: true }; });

// owner
on('GET', '/api/owner/orders', 'owner', () => ({ orders: db.prepare('SELECT o.*,p.name rider_name FROM orders o LEFT JOIN partners p ON p.id=o.rider ORDER BY o.created DESC LIMIT 300').all().map((o) => ({ ...orderOut(o), rider_name: o.rider_name })), partners: db.prepare('SELECT id,name,phone,online FROM partners').all(), msgs: db.prepare('SELECT * FROM msgs ORDER BY id DESC LIMIT 100').all() }));
on('POST', '/api/owner/orders/:id/status', 'owner', ({ params, body }) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(params.id); if (!o || o.cancelled) throw err(404, 'Order nahi mila');
  if (body.cancel) { if (o.status >= 3) throw err(409, 'Ab cancel nahi ho sakta'); db.prepare('UPDATE orders SET cancelled=1 WHERE id=?').run(o.id); }
  else if (o.status < 2) db.prepare('UPDATE orders SET status=status+1 WHERE id=?').run(o.id); else throw err(409, 'Ab rider status badlega');
  emit(o.id); return { ok: true };
});
on('POST', '/api/owner/products', 'owner', ({ body }) => {
  const cat = CATS.find((c) => c.cat === body.cat); if (!cat) throw err(400, 'Category galat hai');
  const price = +body.price; if (!(price > 0 && price < 100000)) throw err(400, 'Price galat hai'); if (!imgOk(body.img)) throw err(400, 'Photo galat ya badi hai');
  const r = db.prepare('INSERT INTO products(cat,name,price,img,custom) VALUES(?,?,?,?,1)').run(cat.cat, str(body.name, 1, 80, 'Naam'), Math.round(price), body.img || ''); return { id: Number(r.lastInsertRowid) };
});
on('PATCH', '/api/owner/products/:id', 'owner', ({ params, body }) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(+params.id); if (!p) throw err(404, 'Product nahi mila');
  if (!imgOk(body.img)) throw err(400, 'Photo galat ya badi hai');
  db.prepare('UPDATE products SET off=?,img=?,price=? WHERE id=?').run(body.off === undefined ? p.off : body.off ? 1 : 0, body.img === undefined ? p.img : body.img, body.price > 0 ? Math.round(body.price) : p.price, p.id); return { ok: true };
});
on('DELETE', '/api/owner/products/:id', 'owner', ({ params }) => ({ deleted: Number(db.prepare('DELETE FROM products WHERE id=? AND custom=1').run(+params.id).changes) }));
on('POST', '/api/owner/banners', 'owner', ({ body }) => { if (!imgOk(body.img)) throw err(400, 'Photo galat ya badi hai'); return { id: Number(db.prepare('INSERT INTO banners(title,sub,img) VALUES(?,?,?)').run(str(body.title, 1, 100, 'Title'), String(body.sub || '').slice(0, 150), body.img || '').lastInsertRowid) }; });
on('DELETE', '/api/owner/banners/:id', 'owner', ({ params }) => { db.prepare('DELETE FROM banners WHERE id=?').run(+params.id); return { ok: true }; });
on('POST', '/api/owner/partners', 'owner', ({ body }) => {
  if (!phoneOk(body.phone)) throw err(400, '10 digit number daalein');
  try { return { id: Number(db.prepare('INSERT INTO partners(name,phone) VALUES(?,?)').run(str(body.name, 1, 60, 'Naam'), body.phone).lastInsertRowid) }; } catch (e) { if (typeof e.code === 'number') throw e; throw err(409, 'Ye number pehle se hai'); }
});
on('GET', '/api/owner/coupons', 'owner', () => ({ coupons: db.prepare('SELECT * FROM coupons ORDER BY created DESC').all() }));
on('POST', '/api/owner/coupons', 'owner', ({ body }) => {
  const code = String(body.code || '').trim().toUpperCase(); if (!/^[A-Z0-9]{3,15}$/.test(code)) throw err(400, 'Coupon code sirf letters/numbers, 3-15 characters');
  if (!['percent', 'flat'].includes(body.type)) throw err(400, 'Type galat hai');
  const value = +body.value; if (!(value > 0) || (body.type === 'percent' && value > 90)) throw err(400, 'Value galat hai (percent 90 se zyada nahi)');
  const max_uses = body.max_uses ? +body.max_uses : null;
  try { db.prepare('INSERT INTO coupons(code,type,value,max_uses,created) VALUES(?,?,?,?,?)').run(code, body.type, Math.round(value), max_uses, now()); } catch { throw err(409, 'Ye code pehle se hai'); }
  return { ok: true, code };
});
on('PATCH', '/api/owner/coupons/:code', 'owner', ({ params, body }) => { const r = db.prepare('UPDATE coupons SET active=? WHERE code=?').run(body.active ? 1 : 0, params.code); if (!r.changes) throw err(404, 'Coupon nahi mila'); return { ok: true }; });
on('DELETE', '/api/owner/coupons/:code', 'owner', ({ params }) => { db.prepare('DELETE FROM coupons WHERE code=?').run(params.code); return { ok: true }; });
on('DELETE', '/api/owner/partners/:id', 'owner', ({ params }) => { if (db.prepare('SELECT 1 FROM orders WHERE rider=? AND status<4 AND cancelled=0').get(+params.id)) throw err(409, 'Rider ka order chal raha hai'); db.prepare('DELETE FROM partners WHERE id=?').run(+params.id); return { ok: true }; });

// rider
const activeOf = (id) => db.prepare('SELECT * FROM orders WHERE rider=? AND status BETWEEN 0 AND 3 AND cancelled=0 LIMIT 1').get(id);
const geo = (o, me) => { const dRest = km(me.lat, me.lng, REST.lat, REST.lng), dCust = km(REST.lat, REST.lng, o.lat, o.lng); return { d_rest: dRest, d_cust: dCust, earn: dCust != null ? 20 + Math.round(dCust * 6) : 30 }; };
on('GET', '/api/rider/state', 'rider', ({ user }) => {
  const me = db.prepare('SELECT * FROM partners WHERE id=?').get(user.id); if (!me) throw err(401, 'Rider nahi mila');
  const a = activeOf(me.id), hist = db.prepare('SELECT * FROM orders WHERE rider=? AND status=4 ORDER BY done_at DESC LIMIT 100').all(me.id);
  const offers = me.online && !a ? db.prepare("SELECT o.*,f.t ot FROM orders o JOIN offers f ON f.oid=o.id AND f.rider=? WHERE o.rider IS NULL AND o.status BETWEEN 0 AND 2 AND o.cancelled=0 AND f.state='sent' AND f.t>? ORDER BY f.t LIMIT 5").all(me.id, now() - OFFER_S * 1000).map((o) => ({ ...orderOut(o), ...geo(o, me), dest: o.lat != null ? { lat: o.lat, lng: o.lng } : null, left: Math.max(1, Math.ceil((o.ot + OFFER_S * 1000 - now()) / 1000)) })) : [];
  return { me: { id: me.id, name: me.name, online: !!me.online }, restaurant: REST, active: a ? { ...orderOut(a), ...geo(a, me), dest: a.lat != null ? { lat: a.lat, lng: a.lng } : null } : null, offers, history: hist.map(orderOut), earnings: hist.reduce((s, o) => s + o.earn, 0) };
});
on('POST', '/api/rider/online', 'rider', ({ user, body }) => { db.prepare('UPDATE partners SET online=? WHERE id=?').run(body.online ? 1 : 0, user.id); if (body.online) offerPending(user.id); emit('', 'rider'); return { ok: true }; });
on('POST', '/api/rider/location', 'rider', ({ user, body }) => {
  const { lat, lng } = body; if (typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw err(400, 'Location galat hai');
  db.prepare('UPDATE partners SET lat=?,lng=?,seen=? WHERE id=?').run(lat, lng, now(), user.id);
  const a = activeOf(user.id); if (a) emit(a.id, 'loc'); return { ok: true };
});
on('POST', '/api/rider/accept/:id', 'rider', ({ user, params }) => {
  const me = db.prepare('SELECT * FROM partners WHERE id=?').get(user.id);
  if (!me.online) throw err(409, 'Pehle Online ho jaiye'); if (activeOf(me.id)) throw err(409, 'Aapka ek order pehle se chal raha hai');
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(params.id); if (!o) throw err(404, 'Order nahi mila');
  const f = db.prepare("SELECT t FROM offers WHERE oid=? AND rider=? AND state='sent'").get(o.id, me.id); if (!f || f.t + OFFER_S * 1000 < now()) throw err(409, 'Offer ka time khatam ho gaya');
  const r = db.prepare('UPDATE orders SET rider=?,earn=? WHERE id=? AND rider IS NULL AND cancelled=0 AND status BETWEEN 0 AND 2').run(me.id, geo(o, me).earn, o.id);
  if (!r.changes) throw err(409, 'Ye order kisi aur rider ne le liya'); emit(o.id); return { ok: true };
});
const step = (from, to, col) => ({ user, params }) => { const r = db.prepare(`UPDATE orders SET status=?,${col}=? WHERE id=? AND rider=? AND status=? AND cancelled=0`).run(to, now(), params.id, user.id, from); if (!r.changes) throw err(409, 'Ye abhi possible nahi'); emit(params.id); return { ok: true }; };
on('POST', '/api/rider/pickup/:id', 'rider', step(2, 3, 'out_at'));
on('POST', '/api/rider/deliver/:id', 'rider', (c) => { const x = step(3, 4, 'done_at')(c); offerPending(c.user.id); return x; });
on('POST', '/api/rider/decline/:id', 'rider', ({ user, params }) => { db.prepare("UPDATE offers SET state='declined' WHERE oid=? AND rider=?").run(params.id, user.id); return { ok: true }; });
on('GET', '/api/push/key', null, () => ({ key: VPUB, offer_seconds: OFFER_S }));
on('POST', '/api/rider/push', 'rider', ({ user, body }) => { const ep = body.endpoint; if (!pushHostOk(ep)) throw err(400, 'Push endpoint allowed nahi'); db.prepare('INSERT OR REPLACE INTO pushes(endpoint,rider) VALUES(?,?)').run(ep, user.id); return { ok: true }; });
on('POST', '/api/owner/orders/:id/resend', 'owner', ({ params }) => { const o = db.prepare('SELECT * FROM orders WHERE id=?').get(params.id); if (!o || o.cancelled || o.rider || o.status > 2) throw err(409, 'Resend possible nahi'); offerAll(o.id); emit(o.id); return { ok: true }; });

// realtime stream: owner/rider via ?token=, customer via ?track=ID&phone=
on('GET', '/api/stream', null, ({ req, res, query }) => {
  let c = null; const u = query.get('token') ? verify(query.get('token')) : null;
  if (u) c = { role: u.role, res };
  else { const o = db.prepare('SELECT phone FROM orders WHERE id=?').get(query.get('track') || ''); if (o && o.phone === query.get('phone')) c = { role: 'customer', order: query.get('track'), res }; }
  if (!c) throw err(401, 'Unauthorized');
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': ORIGIN });
  res.write('retry: 3000\n\n'); clients.add(c); req.on('close', () => clients.delete(c)); return undefined;
});

// ---------- server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const PUB = path.resolve('public');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  res.setHeader('Access-Control-Allow-Origin', ORIGIN); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE'); res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  const send = (code, obj) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
  if (!url.pathname.startsWith('/api/')) { // static front-end
    const pg = { '/': 'index.html', '/owner': 'owner.html', '/rider': 'rider.html' }[url.pathname.replace(/(.)\/$/, '$1')];
    if (pg && pg !== 'index.html') res.setHeader('X-Robots-Tag', 'noindex');
    if (url.pathname === '/sw.js') res.setHeader('Cache-Control', 'no-cache');
    let f = path.join(PUB, pg || url.pathname);
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(404, { error: 'Not found' });
    return res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }).end(fs.readFileSync(f));
  }
  try {
    for (const [m, re, role, fn] of routes) {
      if (m !== req.method) continue; const mt = re.exec(url.pathname); if (!mt) continue;
      const tok = (req.headers.authorization || '').replace('Bearer ', ''), user = role ? verify(tok) : null;
      if (role && (!user || user.role !== role)) throw err(401, 'Login karein');
      let body = {};
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        const chunks = []; let n = 0;
        for await (const c of req) { n += c.length; if (n > 3e6) throw err(413, 'Request bahut badi hai'); chunks.push(c); }
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw err(400, 'Invalid JSON'); }
      }
      const out = await fn({ req, res, ip, body, user, params: { ...mt.groups }, query: url.searchParams });
      return out === undefined ? undefined : send(200, out);
    }
    send(404, { error: 'Not found' });
  } catch (e) {
    if (!e.code || typeof e.code !== 'number') { console.error(e); return send(500, { error: 'Server error' }); }
    send(e.code, { error: e.message });
  }
});
server.listen(PORT, () => console.log(`Chaska backend on :${PORT} ${DEMO ? '(DEMO OTP MODE)' : ''}`));
