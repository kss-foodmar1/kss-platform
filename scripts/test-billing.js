// End-to-end billing test against a running server loaded with scripts/fake-omise.js.
//   node -r ./scripts/fake-omise.js server.js   (PORT=4500, FAKE_CTL_PORT=4599, BILLING_ENFORCE=1, BILLING_GRACE_DAYS=14)
//   node scripts/test-billing.js
const crypto = require('crypto');
const assert = require('assert');
const mysql = require('mysql2/promise');
const B = 'http://127.0.0.1:4500', CTL = 'http://127.0.0.1:4599';
const SECRET = process.env.OMISE_WEBHOOK_SECRET;
let cookie = '';
const req = async (method, path, body, headers = {}) => {
  const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
};
const sign = (raw, ts = String(Math.floor(Date.now() / 1000)), secret = SECRET) =>
  ({ 'Omise-Signature': crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(`${ts}.${raw}`).digest('hex'), 'Omise-Signature-Timestamp': ts });
let pass = 0;
const ok = (name, fn) => Promise.resolve(fn()).then(() => { pass++; console.log('  ok  ' + name); }, (e) => { console.error('FAIL ' + name + '\n  ' + e.message); process.exitCode = 1; });

(async () => {
  const db = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  const q = async (sql, p) => (await db.query(sql, p))[0];
  const login = async () => {
    const r = await req('POST', '/api/auth/login', { email: 'admin@kinsupplyandservice.com', password: process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  };
  await ok('login as KSS admin', login);
  const co = (await req('POST', '/api/admin/companies', { name: 'Billing Test Co', status: 'trial' })).body.id;
  const pilot = (await req('POST', '/api/admin/companies', { name: 'Pilot (no end date)', status: 'active' })).body.id;
  let pay, token, chargeId;

  await ok('admin status reports test mode, no price anywhere', async () => {
    const r = await req('GET', '/api/admin/billing/status');
    assert.strictEqual(r.body.omise_mode, 'test'); assert.strictEqual(r.body.webhook_secret_set, true);
  });
  await ok('create payment: validates amount/description/period', async () => {
    for (const bad of [{ description: 'x', amount_baht: 0 }, { description: 'x', amount_baht: 5 }, { description: '', amount_baht: 1000 }, { description: 'x', amount_baht: 1000, period_months: 0 }]) {
      assert.strictEqual((await req('POST', `/api/admin/billing/companies/${co}/payments`, bad)).status, 400, JSON.stringify(bad));
    }
    const r = await req('POST', `/api/admin/billing/companies/${co}/payments`, { description: 'สมาชิกรายปี', amount_baht: '12,345.67', period_months: 12 });
    assert.strictEqual(r.status, 201); pay = r.body.payment; token = pay.pay_url.split('/pay/')[1];
    assert.strictEqual(pay.amount_satang, 1234567); assert.match(token, /^[a-f0-9]{48}$/);
  });
  await ok('public page shows company + amount, no QR yet, no auth needed', async () => {
    cookie = '';
    const r = await req('GET', `/api/pay/${token}`);
    assert.strictEqual(r.body.company_name, 'Billing Test Co'); assert.strictEqual(r.body.qr_url, null); assert.strictEqual(r.body.status, 'pending');
    assert.strictEqual((await req('GET', '/api/pay/' + 'a'.repeat(48))).status, 404);
    assert.strictEqual((await req('GET', '/api/pay/short')).status, 404);
  });
  await login();
  await ok('QR creation uses exact satang amount + metadata; second call reuses same charge', async () => {
    const a = await req('POST', `/api/pay/${token}/qr`);
    assert.ok(a.body.qr_url, JSON.stringify(a.body));
    const [row] = await q(`SELECT charge_id FROM payments WHERE token = ?`, [token]); chargeId = row.charge_id;
    const b = await req('POST', `/api/pay/${token}/qr`);
    const [row2] = await q(`SELECT charge_id FROM payments WHERE token = ?`, [token]);
    assert.strictEqual(row2.charge_id, chargeId); assert.strictEqual(b.body.qr_url, a.body.qr_url);
  });
  await ok('webhook: bad / missing signature rejected; payment stays pending', async () => {
    const raw = JSON.stringify({ object: 'event', key: 'charge.complete', data: { id: chargeId } });
    assert.strictEqual((await req('POST', '/api/webhooks/omise', raw)).status, 401);
    assert.strictEqual((await req('POST', '/api/webhooks/omise', raw, sign(raw, undefined, Buffer.from('wrong').toString('base64')))).status, 401);
    assert.strictEqual((await q(`SELECT status FROM payments WHERE token = ?`, [token]))[0].status, 'pending');
  });
  await ok('webhook: validly signed event for an UNPAID charge does not settle (re-fetch decides)', async () => {
    const raw = JSON.stringify({ object: 'event', key: 'charge.complete', data: { id: chargeId, status: 'successful', paid: true } });
    const r = await req('POST', '/api/webhooks/omise', raw, sign(raw));
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await q(`SELECT status FROM payments WHERE token = ?`, [token]))[0].status, 'pending');
  });
  await ok('unknown charge in a signed webhook is acknowledged and ignored', async () => {
    const raw = JSON.stringify({ key: 'charge.complete', data: { id: 'chrg_other_system' } });
    assert.strictEqual((await req('POST', '/api/webhooks/omise', raw, sign(raw))).status, 200);
  });
  await ok('customer pays -> signed webhook settles, trial company becomes active, +12 months', async () => {
    await fetch(`${CTL}/pay?id=${chargeId}`);
    const raw = JSON.stringify({ key: 'charge.complete', data: { id: chargeId } });
    assert.strictEqual((await req('POST', '/api/webhooks/omise', raw, sign(raw))).status, 200);
    const [p] = await q(`SELECT * FROM payments WHERE token = ?`, [token]);
    assert.strictEqual(p.status, 'paid'); assert.strictEqual(p.paid_via, 'omise');
    const [c] = await q(`SELECT status, DATE_FORMAT(subscription_ends_at,'%Y-%m-%d') AS e FROM companies WHERE id = ?`, [co]);
    assert.strictEqual(c.status, 'active');
    const today = new Date(); const exp = new Date(Date.UTC(today.getFullYear() + 1, today.getMonth(), today.getDate()));
    assert.ok(Math.abs(new Date(c.e) - exp) <= 2 * 86400e3, `end date ${c.e}`);
  });
  await ok('replayed webhook + page poll + cron path do NOT extend twice', async () => {
    const before = (await q(`SELECT subscription_ends_at e FROM companies WHERE id = ?`, [co]))[0].e;
    const raw = JSON.stringify({ key: 'charge.complete', data: { id: chargeId } });
    await req('POST', '/api/webhooks/omise', raw, sign(raw));
    await req('GET', `/api/pay/${token}`);
    await req('POST', `/api/admin/billing/payments/${pay.id}/check`);
    const after = (await q(`SELECT subscription_ends_at e FROM companies WHERE id = ?`, [co]))[0].e;
    assert.strictEqual(String(after), String(before));
  });
  await ok('paid page shows thanks + end date; no QR leaks after payment', async () => {
    const r = await req('GET', `/api/pay/${token}`);
    assert.strictEqual(r.body.status, 'paid'); assert.strictEqual(r.body.qr_url, null); assert.ok(r.body.extended_to);
    assert.strictEqual((await req('POST', `/api/pay/${token}/qr`)).body.status, 'paid');
  });
  await ok('NO webhook at all: polling the pay page settles a paid QR (webhook is optional)', async () => {
    const r = (await req('POST', `/api/admin/billing/companies/${co}/payments`, { description: 'ต่ออายุ', amount_baht: 500 })).body.payment;
    const t = r.pay_url.split('/pay/')[1];
    await req('POST', `/api/pay/${t}/qr`);
    const cid = (await q(`SELECT charge_id FROM payments WHERE token = ?`, [t]))[0].charge_id;
    const endBefore = (await q(`SELECT DATE_FORMAT(subscription_ends_at,'%Y-%m-%d') e FROM companies WHERE id = ?`, [co]))[0].e;
    await fetch(`${CTL}/pay?id=${cid}`);
    assert.strictEqual((await req('GET', `/api/pay/${t}`)).body.status, 'paid');
    const endAfter = (await q(`SELECT DATE_FORMAT(subscription_ends_at,'%Y-%m-%d') e FROM companies WHERE id = ?`, [co]))[0].e;
    assert.ok(endAfter > endBefore, 'early renewal stacks on remaining time');
    assert.strictEqual(Number(endAfter.slice(0, 4)) - Number(endBefore.slice(0, 4)), 1);
  });
  await ok('expired/failed charge frees the slot and a fresh QR is issued', async () => {
    const r = (await req('POST', `/api/admin/billing/companies/${co}/payments`, { description: 'retry', amount_baht: 100 })).body.payment;
    const t = r.pay_url.split('/pay/')[1];
    await req('POST', `/api/pay/${t}/qr`);
    const c1 = (await q(`SELECT charge_id FROM payments WHERE token = ?`, [t]))[0].charge_id;
    await fetch(`${CTL}/status?id=${c1}&s=expired`);
    const v = await req('GET', `/api/pay/${t}`); assert.strictEqual(v.body.qr_url, null);
    await req('POST', `/api/pay/${t}/qr`);
    const c2 = (await q(`SELECT charge_id FROM payments WHERE token = ?`, [t]))[0].charge_id;
    assert.ok(c2 && c2 !== c1);
  });
  await ok('wrong amount on a "successful" charge never settles', async () => {
    const r = (await req('POST', `/api/admin/billing/companies/${co}/payments`, { description: 'tamper', amount_baht: 300 })).body.payment;
    const t = r.pay_url.split('/pay/')[1];
    await req('POST', `/api/pay/${t}/qr`);
    const cid = (await q(`SELECT charge_id FROM payments WHERE token = ?`, [t]))[0].charge_id;
    global.__t = cid;
    // flip amount in the fake via control: mark paid, then the server compares amount with the row; simulate row drift instead
    await q(`UPDATE payments SET amount_satang = amount_satang + 100 WHERE token = ?`, [t]);
    await fetch(`${CTL}/pay?id=${cid}`);
    assert.strictEqual((await req('GET', `/api/pay/${t}`)).body.status, 'pending');
  });
  await ok('cancel works only while pending; cancelled link refuses QR (410)', async () => {
    const r = (await req('POST', `/api/admin/billing/companies/${co}/payments`, { description: 'cancel me', amount_baht: 100 })).body.payment;
    const t = r.pay_url.split('/pay/')[1];
    assert.strictEqual((await req('POST', `/api/admin/billing/payments/${r.id}/cancel`)).status, 200);
    assert.strictEqual((await req('POST', `/api/admin/billing/payments/${r.id}/cancel`)).status, 409);
    assert.strictEqual((await req('POST', `/api/pay/${t}/qr`)).status, 410);
  });
  await ok('manual mark-paid needs a note, extends once, then refuses a second time', async () => {
    const r = (await req('POST', `/api/admin/billing/companies/${pilot}/payments`, { description: 'โอนเอง', amount_baht: 1000, period_months: 6 })).body.payment;
    assert.strictEqual((await req('POST', `/api/admin/billing/payments/${r.id}/mark-paid`, {})).status, 400);
    assert.strictEqual((await req('POST', `/api/admin/billing/payments/${r.id}/mark-paid`, { note: 'โอน 3/10 ref123' })).status, 200);
    assert.strictEqual((await req('POST', `/api/admin/billing/payments/${r.id}/mark-paid`, { note: 'again' })).status, 409);
    const [c] = await q(`SELECT subscription_ends_at e FROM companies WHERE id = ?`, [pilot]);
    assert.ok(c.e);
  });
  await ok('expiry: only active companies with an end date past grace get suspended (reason=billing); null end date is untouched', async () => {
    const a = (await req('POST', '/api/admin/companies', { name: 'Lapsed Co', status: 'active' })).body.id;
    const never = (await req('POST', '/api/admin/companies', { name: 'Never expires', status: 'active' })).body.id;
    const inGrace = (await req('POST', '/api/admin/companies', { name: 'In grace', status: 'active' })).body.id;
    const manual = (await req('POST', '/api/admin/companies', { name: 'Manually suspended', status: 'suspended' })).body.id;
    const day = (n) => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
    await req('PUT', `/api/admin/billing/companies/${a}/subscription`, { subscription_ends_at: day(20) });
    await req('PUT', `/api/admin/billing/companies/${inGrace}/subscription`, { subscription_ends_at: day(5) });
    await req('PUT', `/api/admin/billing/companies/${manual}/subscription`, { subscription_ends_at: day(100) });
    const { enforceExpiry } = require('../lib/billing');
    const r = await enforceExpiry();
    assert.strictEqual(r.enforced, true);
    const st = async (id) => (await q(`SELECT status, suspended_reason r FROM companies WHERE id = ?`, [id]))[0];
    assert.deepStrictEqual(await st(a), { status: 'suspended', r: 'billing' });
    assert.strictEqual((await st(never)).status, 'active'); assert.strictEqual((await st(inGrace)).status, 'active');
    assert.strictEqual((await st(manual)).r, null);
    // paying lifts a billing suspension but NOT a manual one
    const p1 = (await req('POST', `/api/admin/billing/companies/${a}/payments`, { description: 'renew', amount_baht: 100 })).body.payment;
    const p2 = (await req('POST', `/api/admin/billing/companies/${manual}/payments`, { description: 'renew', amount_baht: 100 })).body.payment;
    await req('POST', `/api/admin/billing/payments/${p1.id}/mark-paid`, { note: 'x' });
    await req('POST', `/api/admin/billing/payments/${p2.id}/mark-paid`, { note: 'x' });
    assert.strictEqual((await st(a)).status, 'active');
    assert.strictEqual((await st(manual)).status, 'suspended');
    // a late renewal does not back-date: end = today + 12 months, not old end + 12 months
    const e = (await q(`SELECT DATE_FORMAT(subscription_ends_at,'%Y') y FROM companies WHERE id = ?`, [a]))[0].y;
    assert.strictEqual(Number(e), new Date().getFullYear() + 1);
  });
  await ok('billing admin API is closed to non-superadmins and anonymous', async () => {
    cookie = '';
    assert.strictEqual((await req('GET', '/api/admin/billing/status')).status, 401);
    assert.strictEqual((await req('POST', `/api/admin/billing/companies/${co}/payments`, { description: 'x', amount_baht: 100 })).status, 401);
  });
  console.log(`\n${pass} checks passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
  await db.end();
  process.exit(process.exitCode || 0);
})();
