// End-to-end test: run `DEMO_OTP=1 DB_FILE=:memory: node server.js` first (or `npm test` starts its own)
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
const P = 3111, B = `http://localhost:${P}`;
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: P, DEMO_OTP: '1', DB_FILE: ':memory:', OFFER_SECONDS: '3', ALLOW_LOCAL_PUSH: '1' }, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 800));
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log('FAIL:', m)); };
const call = async (m, p, body, tok) => { const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
const login = async (phone, role) => { const a = await call('POST', '/api/auth/otp', { phone, role }); if (a.s !== 200) return a; return call('POST', '/api/auth/verify', { phone, role, otp: a.j.demo_otp }); };
try {
  ok((await login('9123456789', 'owner')).s === 404, 'wrong owner number must fail');
  ok((await call('GET', '/api/owner/orders')).s === 401, 'owner api needs login');
  const ow = (await login('9939834950', 'owner')).j.token; ok(!!ow, 'owner login');
  const rd = (await login('9000000001', 'rider')).j.token; ok(!!rd, 'rider login');
  ok((await call('GET', '/api/owner/orders', null, rd)).s === 401, 'rider cannot use owner api');
  const menu = (await call('GET', '/api/menu')).j; ok(menu.products.length === 75, 'menu seeded 75');
  const np = await call('POST', '/api/owner/products', { cat: 'Roll', name: 'Test Roll', price: 55 }, ow); ok(np.s === 200, 'add product');
  ok((await call('POST', '/api/owner/products', { cat: 'Nope', name: 'x', price: 5 }, ow)).s === 400, 'bad category');
  const veg = menu.products.find((p) => p.name === 'Veg Burger');
  const o = await call('POST', '/api/orders', { name: 'Ram', phone: '9876543210', addr: 'Gopalganj main road', pay: 'Cash on Delivery', items: [{ id: veg.id, q: 2 }], lat: 26.47, lng: 84.45, total: 1 }); ok(o.s === 200 && o.j.total === 120, 'order total computed by server (ignores client total)');
  ok((await call('POST', '/api/orders', { name: 'Ram', phone: '123', addr: 'Gopalganj main road', pay: 'Cash on Delivery', items: [{ id: veg.id, q: 1 }] })).s === 400, 'bad phone rejected');
  await call('PATCH', `/api/owner/products/${veg.id}`, { off: true }, ow);
  ok((await call('POST', '/api/orders', { name: 'Ram', phone: '9876543210', addr: 'Gopalganj main road', pay: 'Cash on Delivery', items: [{ id: veg.id, q: 1 }] })).s === 409, 'stock-off item blocked');
  const id = o.j.id;
  ok((await call('GET', `/api/track/${id}?phone=9000000000`)).s === 404, 'track needs matching phone');
  await call('POST', '/api/rider/online', { online: true }, rd);
    await call('POST', '/api/rider/location', { lat: 26.46, lng: 84.43 }, rd);
  const st = (await call('GET', '/api/rider/state', null, rd)).j; ok(st.offers.length === 1 && st.offers[0].d_cust > 0, 'offer appears with real distance: ' + JSON.stringify([st.offers[0]?.d_rest, st.offers[0]?.d_cust, st.offers[0]?.earn]));
  const rd2 = (await call('POST', '/api/owner/partners', { name: 'Amit', phone: '9111111111' }, ow)).s; ok(rd2 === 200, 'add partner');
  ok((await call('POST', '/api/owner/partners', { name: 'Amit', phone: '9111111111' }, ow)).s === 409, 'duplicate partner blocked');
  const rd2t = (await login('9111111111', 'rider')).j.token; await call('POST', '/api/rider/online', { online: true }, rd2t);
  const [a, b] = await Promise.all([call('POST', `/api/rider/accept/${id}`, null, rd), call('POST', `/api/rider/accept/${id}`, null, rd2t)]);
  ok([a.s, b.s].sort().join() === '200,409', 'only one rider wins the swipe race: ' + a.s + ',' + b.s);
  const win = a.s === 200 ? rd : rd2t;
  ok((await call('POST', `/api/rider/deliver/${id}`, null, win)).s === 409, 'cannot deliver before pickup');
  ok((await call('POST', `/api/rider/pickup/${id}`, null, win)).s === 409, 'cannot pickup before preparing');
  await call('POST', `/api/owner/orders/${id}/status`, {}, ow);
  await call('POST', `/api/owner/orders/${id}/status`, {}, ow);
  ok((await call('POST', `/api/rider/pickup/${id}`, null, win)).s === 200, 'pickup');
  const t = (await call('GET', `/api/track/${id}?phone=9876543210`)).j; ok(t.status === 3 && t.rider?.name, 'customer sees rider + status 3');
  ok((await call('POST', `/api/rider/deliver/${id}`, null, win)).s === 200, 'deliver');
  const fin = (await call('GET', '/api/rider/state', null, win)).j; ok(fin.history.length === 1 && fin.earnings > 0, 'history + earnings recorded: ₹' + fin.earnings);

  // ---- push + countdown ----
  const pushes = []; const fake = http.createServer((q, r) => { pushes.push(q.headers); r.writeHead(201).end(); }).listen(3333);
  ok((await call('POST', '/api/rider/push', { endpoint: 'https://evil.internal/x' }, rd)).s === 400, 'push endpoint whitelist blocks other hosts');
  ok((await call('POST', '/api/rider/push', { endpoint: 'http://localhost:3333/p/1' }, rd)).s === 200, 'push subscribe');
  const o3 = (await call('POST', '/api/orders', { name: 'Sita', phone: '9876543211', addr: 'Second road Gopalganj', pay: 'UPI', items: [{ id: menu.products[5].id, q: 1 }] })).j.id;
  await new Promise((r) => setTimeout(r, 400));
  ok(pushes.length === 1, 'push sent to subscribed online rider: ' + pushes.length);
  const key = (await call('GET', '/api/push/key')).j.key, m = /^vapid t=([^,]+)\.([^,]+)\.([^,]+), k=(.+)$/.exec(pushes[0]?.authorization || '');
  ok(m && m[4] === key, 'push carries our VAPID public key');
  if (m) { const raw = Buffer.from(key, 'base64url'), pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' }); ok(crypto.verify('sha256', Buffer.from(m[1] + '.' + m[2]), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')), 'VAPID signature valid'); ok(pushes[0].urgency === 'high' && pushes[0].ttl === '3', 'urgency high + ttl = offer seconds'); }
  const s1 = (await call('GET', '/api/rider/state', null, rd)).j; ok(s1.offers.length === 1 && s1.offers[0].left >= 1 && s1.offers[0].left <= 3, 'offer has countdown left=' + s1.offers[0]?.left);
  await new Promise((r) => setTimeout(r, 3300));
  ok((await call('GET', '/api/rider/state', null, rd)).j.offers.length === 0, 'offer disappears after time limit');
  ok((await call('POST', `/api/rider/accept/${o3}`, null, rd)).s === 409, 'accept after expiry blocked');
  ok((await call('POST', `/api/owner/orders/${o3}/resend`, {}, ow)).s === 200, 'owner can resend');
  await new Promise((r) => setTimeout(r, 300)); ok(pushes.length >= 2, 'resend pushes again');
  ok((await call('GET', '/api/rider/state', null, rd)).j.offers.length === 1, 'offer back after resend');
  await call('POST', `/api/rider/decline/${o3}`, null, rd); ok((await call('GET', '/api/rider/state', null, rd)).j.offers.length === 0, 'decline hides offer');
  fake.close();
  const ctl = new AbortController(), sr = await fetch(`${B}/api/stream?token=${ow}`, { signal: ctl.signal }); ok(sr.headers.get('content-type').startsWith('text/event-stream'), 'SSE stream opens'); ctl.abort();
  ok((await call('GET', '/api/stream')).s === 401, 'SSE needs auth');
} catch (e) { fail++; console.log('ERROR', e); }
console.log(`\n${pass} passed, ${fail} failed`); srv.kill(); process.exit(fail ? 1 : 0);
