// Self-serve end to end: signup → pending login → KSS approves → trial on demo
// data → own FMH key switches to real data → trial ends → locked (plan page
// only) → pay (fake Omise) → unlocked; paid grace; retention + purge; reject.
//   PORT=4500 FAKE_CTL_PORT=4599 OMISE_SECRET_KEY=skey_test_x node -r ./scripts/fake-omise.js server.js
//   node scripts/test-self-serve.js
const assert = require('assert');
const mysql = require('mysql2/promise');
const B = 'http://127.0.0.1:4500', CTL = 'http://127.0.0.1:4599';
const jar = { kss: '', cust: '', anon: '' };
const req = async (who, method, path, body) => {
  const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', cookie: jar[who] }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
};
let pass = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('PASS  ' + name); }, (e) => { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; });
const bkk = (d = 0) => new Date(Date.now() + 7 * 3600e3 + d * 86400e3).toISOString().slice(0, 10);

(async () => {
  const db = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  const q = async (sql, p) => (await db.query(sql, p))[0];
  const stamp = Date.now().toString(36);
  const email = `trial-${stamp}@example.test`, pw = 'trialpass1';
  const form = { company_name: `ร้านทดลอง ${stamp}`, contact_name: 'คุณทดลอง', email, phone: '081-234-5678', password: pw, branches: '2-5', uses_fmh: 'yes', consent: true };
  await q(`DELETE FROM signup_requests WHERE ip IN ('127.0.0.1', '::1', '::ffff:127.0.0.1')`);
  await q(`DELETE FROM billing_prices`);
  let companyId;

  await ok('signup is open (not Railway production) and says 30 days', async () => {
    const r = await req('anon', 'GET', '/api/signup/config');
    assert.strictEqual(r.body.enabled, true); assert.strictEqual(r.body.trial_days, 30);
  });
  await ok('signup validates: email, password, consent, honeypot', async () => {
    for (const bad of [{ email: 'nope' }, { password: 'short' }, { consent: false }, { website: 'http://spam' }, { phone: '12' }]) {
      const r = await req('anon', 'POST', '/api/signup', { ...form, ...bad });
      assert.strictEqual(r.status, 400, JSON.stringify(bad) + ' ' + JSON.stringify(r.body));
    }
  });
  await ok('signup accepted; the same email twice is refused', async () => {
    assert.strictEqual((await req('anon', 'POST', '/api/signup', form)).status, 201);
    assert.strictEqual((await req('anon', 'POST', '/api/signup', form)).status, 409);
  });
  await ok('password is stored hashed, never in clear', async () => {
    const [s] = await q(`SELECT password_hash FROM signup_requests WHERE email = ?`, [email]);
    assert.ok(s.password_hash.startsWith('$2') && !s.password_hash.includes(pw));
  });
  await ok('login before approval: "waiting for KSS", not "wrong password"', async () => {
    const r = await req('cust', 'POST', '/api/auth/login', { email, password: pw });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'SIGNUP_PENDING');
    assert.strictEqual((await req('cust', 'POST', '/api/auth/login', { email, password: 'wrongwrong' })).status, 401);
  });
  await ok('KSS sees the request in the pending list', async () => {
    assert.strictEqual((await req('kss', 'POST', '/api/auth/login', { email: 'admin@kinsupplyandservice.com', password: process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!' })).status, 200);
    const r = await req('kss', 'GET', '/api/admin/self-serve');
    assert.ok(r.body.pending_count >= 1 && r.body.signups.some((s) => s.email === email), JSON.stringify(r.body).slice(0, 300));
  });
  await ok('approve → trial company on demo data, 30 days, starter dashboard, admin user', async () => {
    const id = (await q(`SELECT id FROM signup_requests WHERE email = ?`, [email]))[0].id;
    const r = await req('kss', 'POST', `/api/admin/self-serve/signups/${id}/approve`, { note: 'test' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    companyId = r.body.company_id;
    const [c] = await q(`SELECT status, data_source, self_serve, DATE_FORMAT(subscription_ends_at, '%Y-%m-%d') e, company_code FROM companies WHERE id = ?`, [companyId]);
    assert.deepStrictEqual([c.status, c.data_source, c.self_serve, c.e], ['trial', 'demo', 1, bkk(30)]);
    assert.ok(/^KSS-\d{4}$/.test(c.company_code));
    const [w] = await q(`SELECT COUNT(*) n FROM dashboard_widgets w JOIN dashboards d ON d.id = w.dashboard_id WHERE d.company_id = ?`, [companyId]);
    assert.strictEqual(w.n, 7);
    assert.strictEqual((await req('kss', 'POST', `/api/admin/self-serve/signups/${id}/approve`)).status, 409);
  });
  await ok('customer signs in with the signup password; /me shows trial, 30 days left', async () => {
    const r = await req('cust', 'POST', '/api/auth/login', { email, password: pw });
    assert.strictEqual(r.status, 200);
    const me = (await req('cust', 'GET', '/api/auth/me')).body.user;
    assert.strictEqual(me.role, 'company_admin'); assert.strictEqual(me.subscription.state, 'trial'); assert.strictEqual(me.subscription.days_left, 30);
    assert.strictEqual((await req('cust', 'GET', '/api/dashboards')).status, 200);
  });
  await ok('customer cannot reach the KSS review screen', async () => {
    assert.strictEqual((await req('cust', 'GET', '/api/admin/self-serve')).status, 403);
  });
  await ok('no price set → checkout refused with a clear message', async () => {
    const r = await req('cust', 'POST', '/api/subscription/checkout', { period_months: 12 });
    assert.strictEqual(r.status, 409); assert.ok(/ราคา/.test(r.body.error));
  });
  await ok('KSS sets prices; the customer sees them', async () => {
    assert.strictEqual((await req('kss', 'PUT', '/api/admin/self-serve/prices', { monthly: 'abc', yearly: 15000 })).status, 400);
    assert.strictEqual((await req('kss', 'PUT', '/api/admin/self-serve/prices', { monthly: 1500, yearly: 15000 })).status, 200);
    const s = (await req('cust', 'GET', '/api/subscription')).body;
    assert.deepStrictEqual(s.prices.map((p) => p.amount_baht), [1500, 15000]); assert.strictEqual(s.payments_enabled, true);
  });
  await ok('own FMH key switches the company from demo to real data', async () => {
    const r = await req('cust', 'POST', '/api/settings/fmh-key', { api_key: 'fmh_rpt_test_key_123456' });
    assert.strictEqual(r.status, 200);
    const [c] = await q(`SELECT data_source FROM companies WHERE id = ?`, [companyId]);
    assert.strictEqual(c.data_source, 'fmh');
  });
  await ok('trial ends → locked: data APIs 402, sign-in and plan page still work', async () => {
    await q(`UPDATE companies SET subscription_ends_at = ? WHERE id = ?`, [bkk(-1), companyId]);
    const d = await req('cust', 'GET', '/api/dashboards');
    assert.strictEqual(d.status, 402); assert.strictEqual(d.body.code, 'SUBSCRIPTION_LOCKED');
    assert.strictEqual((await req('cust', 'GET', '/api/auth/me')).body.user.subscription.state, 'locked');
    assert.strictEqual((await req('cust', 'GET', '/api/subscription')).status, 200);
    assert.strictEqual((await req('cust', 'POST', '/api/auth/login', { email, password: pw })).status, 200);
  });
  await ok('the last day of the trial is still usable', async () => {
    await q(`UPDATE companies SET subscription_ends_at = ? WHERE id = ?`, [bkk(0), companyId]);
    assert.strictEqual((await req('cust', 'GET', '/api/dashboards')).status, 200);
    await q(`UPDATE companies SET subscription_ends_at = ? WHERE id = ?`, [bkk(-1), companyId]);
  });
  let token;
  await ok('checkout makes a yearly link at the set price; asking again reuses it', async () => {
    const a = await req('cust', 'POST', '/api/subscription/checkout', { period_months: 12 });
    assert.strictEqual(a.status, 200, JSON.stringify(a.body)); token = a.body.pay_path.split('/pay/')[1];
    const b = await req('cust', 'POST', '/api/subscription/checkout', { period_months: 12 });
    assert.strictEqual(b.body.pay_path, a.body.pay_path); assert.strictEqual(b.body.reused, true);
    const [p] = await q(`SELECT amount_satang, period_months FROM payments WHERE token = ?`, [token]);
    assert.deepStrictEqual([p.amount_satang, p.period_months], [1500000, 12]);
    assert.strictEqual((await req('cust', 'POST', '/api/subscription/checkout', { period_months: 6 })).status, 400);
  });
  await ok('paying unlocks: active, a year from today, dashboards back', async () => {
    const qr = await req('anon', 'POST', `/api/pay/${token}/qr`);
    assert.ok(qr.body.qr_url, JSON.stringify(qr.body));
    const [p] = await q(`SELECT charge_id FROM payments WHERE token = ?`, [token]);
    await fetch(`${CTL}/pay?id=${p.charge_id}`, { method: 'POST' });
    const r = await req('anon', 'GET', `/api/pay/${token}`);
    assert.strictEqual(r.body.status, 'paid');
    const [c] = await q(`SELECT status, DATE_FORMAT(subscription_ends_at, '%Y-%m-%d') e FROM companies WHERE id = ?`, [companyId]);
    const y = new Date(Date.parse(bkk(0) + 'T00:00:00Z')); y.setUTCFullYear(y.getUTCFullYear() + 1);
    assert.deepStrictEqual([c.status, c.e], ['active', y.toISOString().slice(0, 10)]);
    assert.strictEqual((await req('cust', 'GET', '/api/dashboards')).status, 200);
    const s = (await req('cust', 'GET', '/api/subscription')).body;
    assert.ok(s.payments.some((x) => x.status === 'paid'));
  });
  await ok('a paid plan gets 3 days of grace, then locks', async () => {
    await q(`UPDATE companies SET subscription_ends_at = ? WHERE id = ?`, [bkk(-3), companyId]);
    let me = (await req('cust', 'GET', '/api/auth/me')).body.user.subscription;
    assert.strictEqual(me.state, 'active'); assert.strictEqual(me.in_grace, true);
    await q(`UPDATE companies SET subscription_ends_at = ? WHERE id = ?`, [bkk(-4), companyId]);
    me = (await req('cust', 'GET', '/api/auth/me')).body.user.subscription;
    assert.strictEqual(me.state, 'locked');
  });
  await ok('retention: no purge before 60 days locked; after, KSS can purge (data only)', async () => {
    let r = await req('kss', 'GET', '/api/admin/self-serve');
    const row = r.body.locked.find((x) => x.id === companyId);
    assert.ok(row && !row.purgeable, JSON.stringify(row));
    assert.strictEqual((await req('kss', 'POST', `/api/admin/self-serve/companies/${companyId}/purge`)).status, 409);
    await q(`UPDATE companies SET subscription_ends_at = ? WHERE id = ?`, [bkk(-70), companyId]);
    await q(`INSERT INTO alert_events (company_id, watcher, finding_key, first_seen, last_seen, payload_json) VALUES (?, 'price', 'x', ?, ?, '{}')`, [companyId, bkk(-80), bkk(-80)]);
    r = await req('kss', 'POST', `/api/admin/self-serve/companies/${companyId}/purge`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const [c] = await q(`SELECT data_purged_at, fmh_api_key_enc FROM companies WHERE id = ?`, [companyId]);
    assert.ok(c.data_purged_at && !c.fmh_api_key_enc);
    assert.strictEqual((await q(`SELECT COUNT(*) n FROM alert_events WHERE company_id = ?`, [companyId]))[0].n, 0);
    assert.strictEqual((await q(`SELECT COUNT(*) n FROM users WHERE company_id = ?`, [companyId]))[0].n, 1);
    assert.strictEqual((await req('cust', 'GET', '/api/auth/me')).body.user.subscription.data_purged, true);
  });
  await ok('rejected signup: login is just "wrong email or password"', async () => {
    const e2 = `reject-${stamp}@example.test`;
    assert.strictEqual((await req('anon', 'POST', '/api/signup', { ...form, email: e2 })).status, 201);
    const id = (await q(`SELECT id FROM signup_requests WHERE email = ?`, [e2]))[0].id;
    assert.strictEqual((await req('kss', 'POST', `/api/admin/self-serve/signups/${id}/reject`, { note: 'ไม่ใช่ลูกค้า F&B' })).status, 200);
    assert.strictEqual((await req('anon', 'POST', '/api/auth/login', { email: e2, password: pw })).status, 401);
    const [s] = await q(`SELECT password_hash FROM signup_requests WHERE id = ?`, [id]);
    assert.strictEqual(s.password_hash, '');
  });
  await ok('KSS can switch an existing company to self-serve: trial starts today', async () => {
    const id = (await req('kss', 'POST', '/api/admin/companies', { name: `เปลี่ยนเป็นชำระเอง ${stamp}`, status: 'active' })).body.id;
    assert.strictEqual((await req('kss', 'PATCH', `/api/admin/companies/${id}`, { self_serve: '1' })).status, 200);
    const [c] = await q(`SELECT self_serve, status, DATE_FORMAT(subscription_ends_at, '%Y-%m-%d') e FROM companies WHERE id = ?`, [id]);
    assert.deepStrictEqual([c.self_serve, c.status, c.e], [1, 'trial', bkk(30)]);
    assert.strictEqual((await req('kss', 'GET', `/api/admin/companies/${id}`)).body.company.self_serve, 1);
    await req('kss', 'PATCH', `/api/admin/companies/${id}`, { self_serve: '0' });
    assert.strictEqual((await q(`SELECT self_serve FROM companies WHERE id = ?`, [id]))[0].self_serve, 0);
  });
  await ok('a KSS-managed company with a past end date is never locked', async () => {
    const [c] = await q(`SELECT id FROM companies WHERE self_serve = FALSE AND status <> 'suspended' LIMIT 1`);
    const ss = require('../lib/selfServe');
    assert.strictEqual(ss.subscriptionOf({ status: 'active', subscription_ends_at: bkk(-100), self_serve: 0 }).state, 'managed');
    assert.ok(c);
  });
  await q(`DELETE FROM billing_prices`);
  console.log(`\n${pass} passed${process.exitCode ? ', some failed' : ', 0 failed'}`);
  await db.end();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
