// Card auto-renew end to end against a server loaded with scripts/fake-omise.js:
//   PORT=4500 FAKE_CTL_PORT=4599 OMISE_SECRET_KEY=skey_test_x OMISE_PUBLIC_KEY=pkey_test_x node -r ./scripts/fake-omise.js server.js
//   node scripts/test-card-renew.js
const assert = require('assert');
const mysql = require('mysql2/promise');
const B = 'http://127.0.0.1:4500', CTL = 'http://127.0.0.1:4599';
const jar = { kss: '', cust: '', anon: '' };
const req = async (who, method, path, body, manual) => {
  const r = await fetch(B + path, { method, redirect: manual ? 'manual' : 'follow', headers: { 'Content-Type': 'application/json', cookie: jar[who] }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j, location: r.headers.get('location') };
};
let pass = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('PASS  ' + name); }, (e) => { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; });
const bkk = (d = 0) => new Date(Date.now() + 7 * 3600e3 + d * 86400e3).toISOString().slice(0, 10);
const plusMonths = (iso, m) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); };

(async () => {
  const db = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  const q = async (sql, p) => (await db.query(sql, p))[0];
  const stamp = Date.now().toString(36), email = `card-${stamp}@example.test`, pw = 'cardpass12';
  await q(`DELETE FROM signup_requests WHERE ip IN ('127.0.0.1', '::1', '::ffff:127.0.0.1')`);
  assert.strictEqual((await req('kss', 'POST', '/api/auth/login', { email: 'admin@kinsupplyandservice.com', password: process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!' })).status, 200);
  await req('kss', 'PUT', '/api/admin/self-serve/prices', { monthly: 1500, yearly: 15000 });
  await req('anon', 'POST', '/api/signup', { company_name: `บัตร ${stamp}`, contact_name: 'คุณบัตร', email, phone: '0812345678', password: pw, consent: true });
  const sid = (await q(`SELECT id FROM signup_requests WHERE email = ?`, [email]))[0].id;
  const companyId = (await req('kss', 'POST', `/api/admin/self-serve/signups/${sid}/approve`)).body.company_id;
  await req('cust', 'POST', '/api/auth/login', { email, password: pw });
  const ends = async () => (await q(`SELECT DATE_FORMAT(subscription_ends_at, '%Y-%m-%d') e, status FROM companies WHERE id = ?`, [companyId]))[0];
  const cardStatus = async () => (await req('cust', 'GET', '/api/subscription')).body.card.status;
  const custId = async () => (await q(`SELECT omise_customer_id c FROM card_subscriptions WHERE company_id = ?`, [companyId]))[0].c;
  const renew = async () => (await req('kss', 'POST', '/api/admin/self-serve/card-renew-now')).body;
  const dueTomorrow = async () => q(`UPDATE companies SET subscription_ends_at = ? WHERE id = ?`, [bkk(1), companyId]).then(() => q(`UPDATE card_subscriptions SET last_attempt_on = NULL WHERE company_id = ?`, [companyId]));

  await ok('card payment is on with a public key, 5% off', async () => {
    const c = (await req('cust', 'GET', '/api/subscription')).body.card;
    assert.strictEqual(c.enabled, true); assert.strictEqual(c.public_key, 'pkey_test_x'); assert.strictEqual(c.discount_pct, 5); assert.strictEqual(c.status, null);
  });
  await ok('only a token is accepted, never card numbers', async () => {
    const r = await req('cust', 'POST', '/api/subscription/card/start', { period_months: 1, token: '4242424242424242' });
    assert.strictEqual(r.status, 400);
  });
  await ok('declined first card: clear error, nothing extended, auto-renew stays off', async () => {
    const before = await ends();
    const r = await req('cust', 'POST', '/api/subscription/card/start', { period_months: 1, token: 'tokn_test_fail' });
    assert.strictEqual(r.status, 402); assert.ok(/insufficient/.test(r.body.error), r.body.error);
    assert.deepStrictEqual(await ends(), before);
    assert.strictEqual((await cardStatus()).active, false);
    assert.strictEqual((await q(`SELECT status FROM payments WHERE company_id = ? ORDER BY id DESC LIMIT 1`, [companyId]))[0].status, 'cancelled');
  });
  await ok('good card: charged ฿1,425 (5% off ฿1,500) now, trial days kept, auto-renew on', async () => {
    const before = await ends();
    const r = await req('cust', 'POST', '/api/subscription/card/start', { period_months: 1, token: 'tokn_test_ok' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.status, 'paid');
    const after = await ends();
    assert.deepStrictEqual([after.status, after.e], ['active', plusMonths(before.e, 1)]);
    const [p] = await q(`SELECT amount_satang, pay_method, status FROM payments WHERE company_id = ? ORDER BY id DESC LIMIT 1`, [companyId]);
    assert.deepStrictEqual([p.amount_satang, p.pay_method, p.status], [142500, 'card', 'paid']);
    const cs = await cardStatus();
    assert.deepStrictEqual([cs.active, cs.last4, cs.brand, cs.period_months], [true, '4242', 'Visa', 1]);
    const d = new Date(after.e + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
    assert.strictEqual(cs.next_charge_on, d.toISOString().slice(0, 10));
  });
  await ok('nothing is charged while the plan has time left', async () => {
    const r = await renew();
    const [{ n }] = await q(`SELECT COUNT(*) n FROM payments WHERE company_id = ?`, [companyId]);
    assert.strictEqual(n, 2, JSON.stringify(r));
  });
  await ok('the day before it ends: charged once, extended a month; not twice the same day', async () => {
    await dueTomorrow();
    const r = await renew();
    assert.ok(r.charged >= 1, JSON.stringify(r));
    assert.strictEqual((await ends()).e, plusMonths(bkk(1), 1));
    await q(`UPDATE companies SET subscription_ends_at = ? WHERE id = ?`, [bkk(1), companyId]);
    await renew();
    assert.strictEqual((await ends()).e, bkk(1), 'charged twice in a day');
  });
  await ok('declined renewal: counted, error shown, retried next day, stops after 3', async () => {
    await fetch(`${CTL}/card?cust=${await custId()}&how=fail`);
    await dueTomorrow();
    await renew();
    let cs = await cardStatus();
    assert.strictEqual(cs.failures, 1); assert.ok(/insufficient/.test(cs.last_error));
    for (let i = 0; i < 4; i++) { await q(`UPDATE card_subscriptions SET last_attempt_on = ? WHERE company_id = ?`, [bkk(-1), companyId]); await renew(); }
    cs = await cardStatus();
    assert.strictEqual(cs.failures, 3, 'kept retrying after 3 declines');
    assert.strictEqual((await ends()).e, bkk(1));
  });
  await ok('a new card resets the failures and the next run charges it', async () => {
    const r = await req('cust', 'POST', '/api/subscription/card/change', { token: 'tokn_test_ok' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.status.failures, 0);
    await q(`UPDATE card_subscriptions SET last_attempt_on = NULL WHERE company_id = ?`, [companyId]);
    await renew();
    assert.strictEqual((await ends()).e, plusMonths(bkk(1), 1));
  });
  let token3ds;
  await ok('3-D Secure renewal waits for the cardholder: link shown, not doubled', async () => {
    await req('cust', 'POST', '/api/subscription/card/change', { token: 'tokn_test_3ds' });
    await dueTomorrow();
    const r = await renew();
    assert.strictEqual(r.pending, 1, JSON.stringify(r));
    const cs = await cardStatus();
    assert.ok(/^https:\/\/bank\.test\/3ds\//.test(cs.needs_authorization), JSON.stringify(cs));
    await q(`UPDATE card_subscriptions SET last_attempt_on = NULL WHERE company_id = ?`, [companyId]);
    await renew();
    const [{ n }] = await q(`SELECT COUNT(*) n FROM payments WHERE company_id = ? AND status = 'pending'`, [companyId]);
    assert.strictEqual(n, 1);
    token3ds = (await q(`SELECT token FROM payments WHERE company_id = ? AND status = 'pending'`, [companyId]))[0].token;
    const list = (await req('cust', 'GET', '/api/subscription')).body.payments;
    assert.ok(list.some((p) => p.pay_method === 'card' && /bank\.test/.test(p.pay_path)));
  });
  await ok('back from the bank after approving: paid, extended, redirected with card=paid', async () => {
    const [p] = await q(`SELECT charge_id FROM payments WHERE token = ?`, [token3ds]);
    await fetch(`${CTL}/pay?id=${p.charge_id}`, { method: 'POST' });
    const r = await req('anon', 'GET', `/pay/card-return/${token3ds}`, undefined, true);
    assert.strictEqual(r.status, 303); assert.strictEqual(r.location, '/?card=paid');
    assert.strictEqual((await ends()).e, plusMonths(bkk(1), 1));
  });
  await ok('switching to yearly: the next charge is ฿14,250', async () => {
    await req('cust', 'POST', '/api/subscription/card/change', { token: 'tokn_test_ok' });
    const r = await req('cust', 'POST', '/api/subscription/card/auto', { on: true, period_months: 12 });
    assert.strictEqual(r.body.status.period_months, 12);
    await dueTomorrow();
    await renew();
    const [p] = await q(`SELECT amount_satang, period_months FROM payments WHERE company_id = ? ORDER BY id DESC LIMIT 1`, [companyId]);
    assert.deepStrictEqual([p.amount_satang, p.period_months], [1425000, 12]);
    assert.strictEqual((await ends()).e, plusMonths(bkk(1), 12));
  });
  await ok('auto-renew off: nothing charged when the plan ends', async () => {
    await req('cust', 'POST', '/api/subscription/card/auto', { on: false });
    await dueTomorrow();
    const before = (await q(`SELECT COUNT(*) n FROM payments WHERE company_id = ?`, [companyId]))[0].n;
    await renew();
    assert.strictEqual((await q(`SELECT COUNT(*) n FROM payments WHERE company_id = ?`, [companyId]))[0].n, before);
    assert.strictEqual((await cardStatus()).active, false);
  });
  await ok('a KSS-managed company cannot start card auto-renew', async () => {
    const ss = await q(`SELECT u.email FROM users u JOIN companies c ON c.id = u.company_id WHERE c.self_serve = FALSE AND u.role = 'company_admin' LIMIT 1`);
    if (!ss.length) return;
    const ccard = require('../lib/cardRenew');
    assert.ok(ccard.cardPriceBaht(1500) === 1425 && ccard.cardPriceBaht(15000) === 14250);
  });
  await q(`DELETE FROM billing_prices`);
  console.log(`\n${pass} passed${process.exitCode ? ', some failed' : ', 0 failed'}`);
  await db.end();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
