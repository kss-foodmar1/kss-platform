// Date basis over HTTP: the choice is saved per user, comes back on the dashboard,
// the Sales / Purchase Analysis pulls say they follow it, and Sales Analysis counts
// by Order Date by default (as FMH does).
//   PORT=3100 node server.js   then   node scripts/test-date-basis-api.js
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { addTemplatesToDashboard } = require('../lib/widgetCatalog');
const B = process.env.BASE || 'http://127.0.0.1:3100';
let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };
const session = () => {
  let cookie = '';
  return async (method, path, body) => {
    const r = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let json = null; try { json = await r.json(); } catch (e) { /* none */ }
    return { status: r.status, json };
  };
};
(async () => {
  const hash = await bcrypt.hash('BasisTest#2026', 10);
  await pool.query(`DELETE FROM companies WHERE name LIKE 'BasisTest%'`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'basistest-%@test.co'`);
  const [c] = await pool.query(`INSERT INTO companies (name) VALUES ('BasisTest Co')`);
  const [d] = await pool.query(`INSERT INTO dashboards (company_id, display_name, sort_order) VALUES (?, 'ยอดขาย', 1)`, [c.insertId]);
  await addTemplatesToDashboard(pool, d.insertId, ['cks_overview', 'pa_trend']);
  for (const e of ['basistest-a@test.co', 'basistest-b@test.co']) {
    await pool.query(`INSERT INTO users (email, password_hash, display_name, role, company_id, must_change_password) VALUES (?, ?, ?, 'company_admin', ?, 0)`, [e, hash, e, c.insertId]);
  }
  const login = async (email) => { const s = session(); const r = await s('POST', '/api/auth/login', { email, password: 'BasisTest#2026' }); if (r.status !== 200) throw new Error('login ' + email); return s; };
  const a = await login('basistest-a@test.co');
  const b = await login('basistest-b@test.co');

  let g = await a('GET', `/api/dashboards/${d.insertId}`);
  check('default is Order Date', g.json.dashboard.my_date_basis === 'order_date', JSON.stringify(g.json.dashboard));
  const src = Object.values(g.json.sources);
  const sales = src.find((s) => s.source === 'sales-analysis'), purch = src.find((s) => s.source === 'purchase-analysis');
  check('Sales Analysis counts by order_date and follows the choice', sales && sales.date_field === 'order_date' && sales.date_basis === true, JSON.stringify(sales));
  check('Purchase Analysis follows the choice', purch && purch.date_basis === true, JSON.stringify(purch));

  check('an unknown date is refused', (await a('PUT', '/api/dashboards/me/date-basis', { basis: 'created_at' })).status === 400);
  check('DO Date saved', (await a('PUT', '/api/dashboards/me/date-basis', { basis: 'do_date' })).status === 200);
  g = await a('GET', `/api/dashboards/${d.insertId}`);
  check('the choice comes back for the same user', g.json.dashboard.my_date_basis === 'do_date');
  const gb = await b('GET', `/api/dashboards/${d.insertId}`);
  check('another user keeps Order Date', gb.json.dashboard.my_date_basis === 'order_date');
  await a('PUT', '/api/dashboards/me/date-basis', { basis: 'invoice_date' });
  const [rows] = await pool.query(`SELECT pref_value FROM user_prefs WHERE user_id = (SELECT id FROM users WHERE email = 'basistest-a@test.co') AND pref_key = 'date_basis'`);
  check('changing it again replaces, one row', rows.length === 1 && rows[0].pref_value === 'invoice_date', JSON.stringify(rows));
  check('needs a login', (await session()('PUT', '/api/dashboards/me/date-basis', { basis: 'do_date' })).status === 401);

  await pool.query(`DELETE FROM companies WHERE name LIKE 'BasisTest%'`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'basistest-%@test.co'`);
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
