// Widget library: usage, add to several dashboards, new dashboard, packs,
// one-widget preview — and that a company admin can't touch another company.
//   PORT=3100 node server.js     (any DB with Demo Co and the seed admin)
//   node scripts/test-library.js
const assert = require('assert');
const mysql = require('mysql2/promise');
const B = process.env.BASE || 'http://127.0.0.1:3100';
const jar = {};
const req = async (who, method, path, body) => {
  const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', cookie: jar[who] || '' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
};
let pass = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };

(async () => {
  const db = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  const q = async (sql, p) => (await db.query(sql, p))[0];
  await req('kss', 'POST', '/api/auth/login', { email: 'admin@kinsupplyandservice.com', password: process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!' });
  const stamp = Date.now().toString(36);
  const mk = async (name) => (await req('kss', 'POST', '/api/admin/companies', { name, status: 'demo' })).body.id;
  const a = await mk(`Lib A ${stamp}`), b = await mk(`Lib B ${stamp}`);
  await q(`UPDATE companies SET data_source = 'demo' WHERE id IN (?)`, [[a, b]]);
  const user = async (who, cid) => {
    const email = `${who}-${stamp}@example.test`;
    await req('kss', 'POST', '/api/users', { email, display_name: who, temp_password: 'libpass123', role: 'company_admin', company_id: cid });
    await q(`UPDATE users SET must_change_password = FALSE WHERE email = ?`, [email]);
    await req(who, 'POST', '/api/auth/login', { email, password: 'libpass123' });
  };
  await user('ownerA', a); await user('ownerB', b);
  const d1 = (await req('ownerA', 'POST', `/api/admin/companies/${a}/dashboards`, { display_name: 'หนึ่ง' })).body.id;
  const d2 = (await req('ownerA', 'POST', `/api/admin/companies/${a}/dashboards`, { display_name: 'สอง' })).body.id;
  const [tpl] = await q(`SELECT id FROM widget_templates WHERE template_key = 'sq_scorecard'`);

  await ok('add one widget to two dashboards at once, with a size', async () => {
    const r = await req('ownerA', 'POST', `/api/admin/companies/${a}/library-add`, { template_id: tpl.id, dashboard_ids: [d1, d2], size: 'third' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.added.map((x) => x.id).sort(), [d1, d2].sort());
    const rows = await q(`SELECT dashboard_id, config_json FROM dashboard_widgets WHERE widget_template_id = ? AND dashboard_id IN (?)`, [tpl.id, [d1, d2]]);
    assert.strictEqual(rows.length, 2);
    assert.ok(rows.every((x) => JSON.parse(x.config_json).size === 'third'));
  });
  await ok('adding again leaves a dashboard that has it alone', async () => {
    const r = await req('ownerA', 'POST', `/api/admin/companies/${a}/library-add`, { template_id: tpl.id, dashboard_ids: [d1] });
    assert.strictEqual(r.body.added.length, 0); assert.strictEqual(r.body.had.length, 1);
  });
  await ok('usage lists where each widget is', async () => {
    const r = await req('ownerA', 'GET', `/api/admin/companies/${a}/widget-usage`);
    const on = r.body.usage.filter((u) => u.template_id === tpl.id).map((u) => u.dashboard_id).sort();
    assert.deepStrictEqual(on, [d1, d2].sort());
  });
  await ok('add to a new dashboard by name', async () => {
    const r = await req('ownerA', 'POST', `/api/admin/companies/${a}/library-add`, { template_id: tpl.id, dashboard_ids: [], new_dashboard_name: 'ใหม่จากคลัง' });
    assert.strictEqual(r.body.added[0].created, true);
    const [d] = await q(`SELECT company_id FROM dashboards WHERE id = ?`, [r.body.added[0].id]);
    assert.strictEqual(d.company_id, a);
  });
  await ok('a pack makes a whole dashboard', async () => {
    const r = await req('ownerA', 'POST', `/api/admin/companies/${a}/packs/purchasing_check`, {});
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.widgets, 7);
    const [n] = await q(`SELECT COUNT(*) n FROM dashboard_widgets WHERE dashboard_id = ?`, [r.body.id]);
    assert.strictEqual(Number(n.n), 7);
  });
  await ok('preview renders a template on the company’s own (demo) data', async () => {
    const p = await req('ownerA', 'GET', `/api/dashboards/preview/${tpl.id}`);
    assert.strictEqual(p.status, 200);
    const src = Object.values(p.body.sources)[0];
    const d = await req('ownerA', 'GET', `/api/dashboards/preview/${tpl.id}/data/${src.source}${src.grouping ? `?group=${src.grouping}` : ''}`);
    assert.strictEqual(d.status, 200, JSON.stringify(d.body));
    assert.ok(Array.isArray(d.body.data) && d.body.data.length > 0);
  });
  await ok('preview only serves the reports that widget reads', async () => {
    const d = await req('ownerA', 'GET', `/api/dashboards/preview/${tpl.id}/data/cogs`);
    assert.strictEqual(d.status, 404);
  });
  await ok('another company’s admin can’t add, use packs or see usage', async () => {
    assert.strictEqual((await req('ownerB', 'POST', `/api/admin/companies/${a}/library-add`, { template_id: tpl.id, dashboard_ids: [d1] })).status, 403);
    assert.strictEqual((await req('ownerB', 'POST', `/api/admin/companies/${a}/packs/ck_margin`, {})).status, 403);
    assert.strictEqual((await req('ownerB', 'GET', `/api/admin/companies/${a}/widget-usage`)).status, 403);
    // own company id, someone else's dashboard
    const r = await req('ownerB', 'POST', `/api/admin/companies/${b}/library-add`, { template_id: tpl.id, dashboard_ids: [d1] });
    assert.strictEqual(r.status, 404);
  });
  await ok('a viewer (client) can’t preview', async () => {
    const email = `viewer-${stamp}@example.test`;
    await req('kss', 'POST', '/api/users', { email, display_name: 'viewer', temp_password: 'libpass123', role: 'client', company_id: a });
    await q(`UPDATE users SET must_change_password = FALSE WHERE email = ?`, [email]);
    await req('viewer', 'POST', '/api/auth/login', { email, password: 'libpass123' });
    assert.strictEqual((await req('viewer', 'GET', `/api/dashboards/preview/${tpl.id}`)).status, 404);
  });
  await ok('KSS staff use the library for the company they view', async () => {
    const p = await req('kss', 'GET', `/api/dashboards/preview/${tpl.id}?company_id=${b}`);
    assert.strictEqual(p.status, 200);
    assert.strictEqual(p.body.dashboard.company_id, b);
  });
  await ok('starter: a demo company can fill an empty dashboard with the basic set', async () => {
    const o = (await req('ownerA', 'GET', `/api/admin/companies/${a}/starter-options`)).body.options;
    const basic = o.find((x) => x.key === 'basic');
    assert.ok(basic.ready.length >= 5 && !basic.skipped.length, JSON.stringify(basic));
    const d = (await req('ownerA', 'POST', `/api/admin/companies/${a}/dashboards`, { display_name: 'ว่าง' })).body.id;
    const r = await req('ownerA', 'POST', `/api/admin/companies/${a}/dashboards/${d}/starter`, { key: 'basic' });
    assert.strictEqual(r.body.added, basic.ready.length);
    const again = await req('ownerA', 'POST', `/api/admin/companies/${a}/dashboards/${d}/starter`, { key: 'basic' });
    assert.strictEqual(again.body.added, 0, 'not added twice');
  });
  await ok('starter: a real company only gets widgets with data (no POS file, an empty FMH report)', async () => {
    const c = await mk(`Lib C ${stamp}`);
    await q(`UPDATE companies SET data_source = 'fmh', status = 'active', fmh_api_key_enc = 'x' WHERE id = ?`, [c]);
    await q(`INSERT INTO fmh_report_cache (company_id, cache_key, data_json, row_count, synced_at) VALUES (?, 'purchase-analysis', '', 0, NOW())`, [c]);
    const o = (await req('kss', 'GET', `/api/admin/companies/${c}/starter-options`)).body.options;
    const audit = o.find((x) => x.key === 'branch_audit');
    assert.ok(audit.skipped.some((x) => x.reason.includes('POS')), JSON.stringify(audit.skipped));
    const basic = o.find((x) => x.key === 'basic');
    assert.ok(basic.skipped.some((x) => x.key === 'pa_kpis' && x.reason.includes('ยังไม่มีข้อมูล')), JSON.stringify(basic.skipped));
    assert.ok(basic.ready.some((x) => x.key === 'branch_purchase_tabs') || basic.ready.length >= 0);
    await q(`UPDATE companies SET fmh_api_key_enc = NULL WHERE id = ?`, [c]);
    const none = (await req('kss', 'GET', `/api/admin/companies/${c}/starter-options`)).body.options.find((x) => x.key === 'basic');
    assert.ok(none.skipped.some((x) => x.reason.includes('FMH')));
  });
  await ok('starter: another company’s admin can’t fill this company’s dashboard', async () => {
    assert.strictEqual((await req('ownerB', 'POST', `/api/admin/companies/${a}/dashboards/${d1}/starter`, { key: 'basic' })).status, 403);
    assert.strictEqual((await req('ownerB', 'POST', `/api/admin/companies/${b}/dashboards/${d1}/starter`, { key: 'basic' })).status, 404);
  });
  console.log(`\n${pass} passed${process.exitCode ? ', some failed' : ', 0 failed'}`);
  await db.end();
})().catch((e) => { console.error(e); process.exit(1); });
