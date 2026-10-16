// Support loop + health: customer reports → KSS queue → handled; health states.
// Needs a running server (BASE, default :3100) on the DB in the env.
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
  const hash = await bcrypt.hash('Ops#2026x', 10);
  await pool.query(`DELETE FROM companies WHERE name LIKE 'OPSTEST%'`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'opstest-%@test.co'`);
  const mk = async (name, extra = '') => (await pool.query(`INSERT INTO companies (name, status, plan_tier, data_source ${extra ? ', subscription_ends_at' : ''}) VALUES (?, 'active', 'starter', 'fmh' ${extra ? ', ' + extra : ''})`, [name]))[0].insertId;
  const A = await mk('OPSTEST A (no key)');
  const B = await mk('OPSTEST B (expires soon)', 'CURDATE() + INTERVAL 5 DAY');
  const C = await mk('OPSTEST C (sync error)');
  await pool.query(`UPDATE companies SET fmh_api_key_enc = 'x' WHERE id = ?`, [C]);
  await pool.query(`INSERT INTO fmh_sync_errors (company_id, cache_key, error_text) VALUES (?, 'k1', 'HTTP 401 Unauthorized')`, [C]);
  for (const [e, role, cid] of [['opstest-kss@test.co', 'kss_superadmin', null], ['opstest-ca@test.co', 'company_admin', A], ['opstest-cl@test.co', 'client', A], ['opstest-cb@test.co', 'company_admin', B]]) {
    await pool.query(`INSERT INTO users (email, password_hash, display_name, role, company_id, must_change_password) VALUES (?, ?, ?, ?, ?, 0)`, [e, hash, e, role, cid]);
  }
  const login = async (email) => { const s = session(); const r = await s('POST', '/api/auth/login', { email, password: 'Ops#2026x' }); if (r.status !== 200) throw new Error('login ' + email + ' ' + r.status); return s; };
  const kss = await login('opstest-kss@test.co');
  const ca = await login('opstest-ca@test.co');
  const cl = await login('opstest-cl@test.co');
  const cb = await login('opstest-cb@test.co');

  // health
  let h = (await ca('GET', '/api/health')).json;
  check('company A: fmh off with a fix + link', h.checks.find((c) => c.key === 'fmh').state === 'off' && h.checks.find((c) => c.key === 'fmh').go === 'data', JSON.stringify(h.checks[0]));
  check('client (not admin) cannot read health', (await cl('GET', '/api/health')).status === 403);
  h = (await cb('GET', '/api/health')).json;
  const plan = h.checks.find((c) => c.key === 'plan');
  check('company B: plan warns with days left', plan.state === 'warn' && /5 วัน/.test(plan.detail), JSON.stringify(plan));
  check('company admin cannot read another company', (await ca('GET', `/api/health?company_id=${B}`)).json.checks.find((c) => c.key === 'plan').state === 'ok');

  // attention (KSS only)
  check('customer cannot read attention queue', (await ca('GET', '/api/admin/ops/attention')).status === 403);
  let q = (await kss('GET', '/api/admin/ops/attention')).json;
  const row = (id) => q.queue.find((x) => x.company_id === id);
  check('C (sync error) is in the queue as bad with a plain-language fix', row(C) && row(C).level === 'bad' && /ไม่รับ API key/.test(row(C).issues[0].fix), JSON.stringify(row(C)));
  check('B in queue as warn', row(B) && row(B).level === 'warn');
  check('A (only "off" checks) is not in the queue', !row(A));
  check('bad sorts before warn', q.queue.findIndex((x) => x.company_id === C) < q.queue.findIndex((x) => x.company_id === B));

  // support
  check('empty report refused', (await ca('POST', '/api/support', { message: 'x' })).status === 400);
  check('KSS staff cannot use the customer form', (await kss('POST', '/api/support', { message: 'ทดสอบข้อความ' })).status === 400);
  let r = await cl('POST', '/api/support', { kind: 'data', message: 'ยอดซื้อไม่ตรงกับ FMH', context: { page: 'Dashboard', widget_title: 'ต้นทุนวัตถุดิบ', evil: '<script>', filters: 'สาขา=สีลม' } });
  check('client can report', r.status === 201, JSON.stringify(r.json));
  const sid = r.json.id;
  const [[row0]] = await pool.query(`SELECT context_json FROM support_requests WHERE id = ?`, [sid]);
  check('context is whitelisted', !/evil|script/.test(row0.context_json) && /ต้นทุนวัตถุดิบ/.test(row0.context_json), row0.context_json);
  q = (await kss('GET', '/api/admin/ops/attention')).json;
  check('A now in queue because of the open request', row(A) && row(A).open_support === 1, JSON.stringify(row(A)));
  check('inbox counts support', q.inbox.support >= 1 && q.inbox.support_new >= 1);
  let list = (await kss('GET', '/api/admin/ops/support')).json.list;
  const item = list.find((x) => x.id === sid);
  check('KSS sees company, who and context', item && /OPSTEST A/.test(item.company) && item.context.widget_title === 'ต้นทุนวัตถุดิบ');
  check('customer cannot list the KSS queue', (await ca('GET', '/api/admin/ops/support')).status === 403);
  check('customer cannot change status', (await ca('PATCH', `/api/admin/ops/support/${sid}`, { status: 'done' })).status === 403);
  check('bad status refused', (await kss('PATCH', `/api/admin/ops/support/${sid}`, { status: 'weird' })).status === 400);
  check('KSS marks doing with a note', (await kss('PATCH', `/api/admin/ops/support/${sid}`, { status: 'doing', note: 'กำลังตรวจกับ FMH' })).status === 200);
  let mine = (await ca('GET', '/api/support/mine')).json.list;
  check('company admin sees status + note', mine.some((x) => x.id === sid && x.status === 'doing' && /FMH/.test(x.note)));
  mine = (await cl('GET', '/api/support/mine')).json.list;
  check('client sees own request', mine.some((x) => x.id === sid));
  check('other company sees nothing', !(await cb('GET', '/api/support/mine')).json.list.some((x) => x.id === sid));
  await kss('PATCH', `/api/admin/ops/support/${sid}`, { status: 'done' });
  q = (await kss('GET', '/api/admin/ops/attention')).json;
  check('done request leaves the queue', !row(A));
  for (let i = 0; i < 8; i++) await cl('POST', '/api/support', { message: 'ซ้ำ ' + i + ' ทดสอบ' });
  check('daily limit stops floods', (await cl('POST', '/api/support', { message: 'อีกอันหนึ่ง' })).status === 429);

  await pool.query(`DELETE FROM companies WHERE name LIKE 'OPSTEST%'`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'opstest-%@test.co'`);
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
