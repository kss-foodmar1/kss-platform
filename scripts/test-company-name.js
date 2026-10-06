// Company admins rename their own company; the company code never changes and
// KSS sees every former name. Needs a running server (BASE, default :3100) on
// the DB in the env.
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const BASE = process.env.BASE || 'http://127.0.0.1:3100';
let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };
function session() {
  let cookie = '';
  return async (method, p, body) => {
    const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
}
(async () => {
  const hash = await bcrypt.hash('NameTest#2026', 10);
  await pool.query(`DELETE FROM companies WHERE name LIKE 'NameTest%' OR name LIKE 'ร้านใหม่ NameTest%'`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'nametest-%@test.co'`);
  await pool.query(`INSERT INTO users (email, password_hash, display_name, role, company_id, must_change_password) VALUES ('nametest-kss@test.co', ?, 'k', 'kss_superadmin', NULL, 0)`, [hash]);
  const login = async (email) => { const s = session(); const r = await s('POST', '/api/auth/login', { email, password: 'NameTest#2026' }); if (r.status !== 200) throw new Error('login ' + email); return s; };
  const kss = await login('nametest-kss@test.co');
  let r = await kss('POST', '/api/admin/companies', { name: 'NameTest A' });
  const a = r.json.id;
  check('new company gets a code', /^KSS-\d{4,}$/.test(r.json.company_code), JSON.stringify(r.json));
  const code = r.json.company_code;
  const b = (await kss('POST', '/api/admin/companies', { name: 'NameTest B' })).json.id;
  for (const [e, role, cid] of [['nametest-ca@test.co', 'company_admin', a], ['nametest-cl@test.co', 'client', a]]) {
    await pool.query(`INSERT INTO users (email, password_hash, display_name, role, company_id, must_change_password) VALUES (?, ?, ?, ?, ?, 0)`, [e, hash, e, role, cid]);
  }
  const ca = await login('nametest-ca@test.co');
  const cl = await login('nametest-cl@test.co');
  check('company admin sees own code on login', (await ca('GET', '/api/auth/me')).json.user ? (await ca('GET', '/api/auth/me')).json.user.company_code === code : true);
  r = await ca('PATCH', `/api/admin/companies/${a}/name`, { name: '  ร้านใหม่   NameTest  ' });
  check('company admin renames own company', r.status === 200 && r.json.company.name === 'ร้านใหม่ NameTest' && r.json.company.company_code === code, JSON.stringify(r.json));
  check('company admin cannot rename another company', (await ca('PATCH', `/api/admin/companies/${b}/name`, { name: 'hijack' })).status === 403);
  check('client (view only) cannot rename', (await cl('PATCH', `/api/admin/companies/${a}/name`, { name: 'x y' })).status === 403);
  check('too short name refused', (await ca('PATCH', `/api/admin/companies/${a}/name`, { name: 'x' })).status === 400);
  check('company admin still cannot change status/tier', (await ca('PATCH', `/api/admin/companies/${a}`, { status: 'active' })).status === 403);
  r = await kss('GET', `/api/admin/companies/${a}`);
  const h = r.json.company.name_history || [];
  check('KSS sees the rename with who did it', h.length === 1 && h[0].old_name === 'NameTest A' && h[0].changed_by_role === 'company_admin', JSON.stringify(h));
  check('code unchanged after rename', r.json.company.company_code === code);
  r = await kss('GET', '/api/admin/companies');
  const row = r.json.companies.find((c) => c.id === a);
  check('company list carries code and former name', row && row.company_code === code && /NameTest A/.test(row.former_names || ''), JSON.stringify(row));
  await kss('PATCH', `/api/admin/companies/${a}`, { name: 'ร้านใหม่ NameTest' });
  check('saving the same name adds no history', (await kss('GET', `/api/admin/companies/${a}`)).json.company.name_history.length === 1);
  await kss('PATCH', `/api/admin/companies/${a}`, { name: 'NameTest C' });
  check('KSS rename recorded too', (await kss('GET', `/api/admin/companies/${a}`)).json.company.name_history.length === 2);
  const [[nulls]] = await pool.query(`SELECT COUNT(*) AS n FROM companies WHERE company_code IS NULL`);
  check('every company has a code', nulls.n === 0);
  await pool.query(`DELETE FROM companies WHERE id IN (?, ?)`, [a, b]);
  await pool.query(`DELETE FROM users WHERE email LIKE 'nametest-%@test.co'`);
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
