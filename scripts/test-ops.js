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
  await pool.query(`INSERT INTO users (email, password_hash, display_name, role, company_id, must_change_password) VALUES ('opstest-cc@test.co', ?, 'cc', 'company_admin', ?, 0)`, [hash, C]);
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

  // item 6 + raw error hidden from customers
  const cc = await login('opstest-cc@test.co');
  const fc = (await cc('GET', '/api/health')).json.checks.find((c) => c.key === 'fmh');
  check('customer sees fix pointing to แจ้งทีมงาน, no raw error text', fc.go === 'support' && fc.kind === 'connect' && !('raw' in fc), JSON.stringify(fc));
  const fk = (await kss('GET', `/api/health?company_id=${C}`)).json.checks.find((c) => c.key === 'fmh');
  check('KSS still sees the raw error', /401/.test(fk.raw || ''));
  const { explainFmhError } = require('../lib/health');
  check('PO number 5012 is not an HTTP 5xx', explainFmhError('PO 5012 rejected').go === 'support' && !/ชั่วคราว/.test(explainFmhError('PO 5012 rejected').fix));
  check('"generate" is not a rate limit', !/โควตา/.test(explainFmhError('cannot generate report').fix));
  check('real 503 is transient', /ชั่วคราว/.test(explainFmhError('HTTP 503 Service Unavailable').fix));
  // latest error wins, not the alphabetically first
  await pool.query(`INSERT INTO fmh_sync_errors (company_id, cache_key, error_text, failed_at) VALUES (?, 'k0', 'AAA timeout earliest', NOW() - INTERVAL 3 DAY), (?, 'k2', 'HTTP 503 newest', NOW())`, [C, C]);
  const latest = (await kss('GET', `/api/health?company_id=${C}`)).json.checks.find((c) => c.key === 'fmh');
  check('shows the most recent error', /503/.test(latest.raw), latest.raw);
  await pool.query(`DELETE FROM fmh_sync_errors WHERE company_id = ?`, [C]);

  // stale sync: oldest report decides
  await pool.query(`INSERT INTO fmh_report_cache (company_id, cache_key, data_json, row_count, synced_at) VALUES (?, 'purchase_orders', '[]', 0, NOW()), (?, 'receiving', '[]', 0, NOW() - INTERVAL 4 DAY)`, [C, C]);
  const st = (await kss('GET', `/api/health?company_id=${C}`)).json.checks.find((c) => c.key === 'fmh');
  check('one fresh report does not hide a stuck one', st.state === 'warn' && /อัปเดตล่าสุดเมื่อ/.test(st.detail), JSON.stringify(st));

  // POS cadence: monthly uploader is fine at 12 days, weekly uploader is late
  const up = (cid, d) => pool.query(`INSERT INTO pos_uploads (company_id, filename, date_to, created_at) VALUES (?, 'f.csv', CURDATE() - INTERVAL ? DAY, NOW() - INTERVAL ? DAY)`, [cid, d, d]);
  for (const d of [12, 42, 72, 102]) await up(B, d);
  for (const d of [12, 19, 26, 33]) await up(A, d);
  const posB = (await kss('GET', `/api/health?company_id=${B}`)).json.checks.find((c) => c.key === 'pos');
  const posA = (await kss('GET', `/api/health?company_id=${A}`)).json.checks.find((c) => c.key === 'pos');
  check('monthly uploader not flagged at 12 days', posB.state === 'ok', JSON.stringify(posB));
  check('weekly uploader flagged at 12 days', posA.state === 'warn', JSON.stringify(posA));
  await pool.query(`INSERT INTO pos_uploads (company_id, filename, date_to) VALUES (?, 'future.csv', CURDATE() + INTERVAL 5 DAY)`, [C]);
  check('future end date never gives a negative age', !/-\d+ วัน/.test((await kss('GET', `/api/health?company_id=${C}`)).json.checks.find((c) => c.key === 'pos').detail));

  // LINE: limit and month agree with lib/line.js (null monthly_quota falls back to 300)
  await pool.query(`INSERT INTO company_line (company_id, webhook_key, access_token_enc, enabled, group_id, quota_used, quota_month, monthly_quota) VALUES (?, 'opstest-wk', 'x', 1, 'g', 290, DATE_FORMAT(NOW() + INTERVAL 7 HOUR, '%Y-%m'), 0)`, [A]);
  const ln = (await kss('GET', `/api/health?company_id=${A}`)).json.checks.find((c) => c.key === 'line');
  check('LINE quota 0 falls back to 300 and warns at 290', ln.state === 'warn' && /290\/300/.test(ln.detail), JSON.stringify(ln));
  check('LINE warning says which alerts stop', /ตัวเตือน/.test(ln.fix));
  await pool.query(`UPDATE company_line SET quota_used = 300 WHERE company_id = ?`, [A]);
  check('LINE full says what stops', /ตัวเตือน/.test((await kss('GET', `/api/health?company_id=${A}`)).json.checks.find((c) => c.key === 'line').fix));

  // reset the fixtures the queue checks rely on
  await pool.query(`DELETE FROM company_line WHERE company_id = ?`, [A]);
  await pool.query(`DELETE FROM pos_uploads WHERE company_id IN (?, ?, ?)`, [A, B, C]);
  await pool.query(`DELETE FROM fmh_report_cache WHERE company_id = ?`, [C]);
  await pool.query(`INSERT INTO fmh_sync_errors (company_id, cache_key, error_text) VALUES (?, 'k1', 'HTTP 401 Unauthorized')`, [C]);

  // attention (KSS only)
  check('customer cannot read attention queue', (await ca('GET', '/api/admin/ops/attention')).status === 403);
  let q = (await kss('GET', '/api/admin/ops/attention')).json;
  const row = (id) => q.queue.find((x) => x.company_id === id);
  check('C (sync error) is in the queue as bad with a plain-language fix', row(C) && row(C).level === 'bad' && /ไม่รับ API key/.test(row(C).issues[0].fix), JSON.stringify(row(C)));
  check('B in queue as warn', row(B) && row(B).level === 'warn');
  check('A (only "off" checks) is not in the queue', !row(A));
  check('FMH failure ranks above a renewal in the same list', q.queue.findIndex((x) => x.company_id === C) < q.queue.findIndex((x) => x.company_id === B));
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
  // secrets are masked before storage
  r = await cl('POST', '/api/support', { message: 'key คือ skey_live_5abcdefghijklmnopqrstuvwxyz123 และบัตร 4242 4242 4242 4242 ครับ', context: { error: 'token abcdefghijklmnopqrstuvwxyz0123456789' } });
  const [[mkd]] = await pool.query(`SELECT message, context_json FROM support_requests WHERE id = ?`, [r.json.id]);
  check('keys and card numbers are masked', !/skey_live|4242|abcdefghijklmnop/.test(mkd.message + mkd.context_json) && /ซ่อน/.test(mkd.message), mkd.message);
  // retention: finished reports older than 12 months go, open ones stay
  const [o1] = await pool.query(`INSERT INTO support_requests (company_id, user_id, kind, message, status, handled_at, created_at) VALUES (?, NULL, 'other', 'old done', 'done', NOW() - INTERVAL 13 MONTH, NOW() - INTERVAL 14 MONTH)`, [A]);
  const [o2] = await pool.query(`INSERT INTO support_requests (company_id, user_id, kind, message, status, created_at) VALUES (?, NULL, 'other', 'old open', 'open', NOW() - INTERVAL 14 MONTH)`, [A]);
  await require('../routes/ops').purgeOld();
  const [[g1]] = await pool.query(`SELECT COUNT(*) AS n FROM support_requests WHERE id = ?`, [o1.insertId]);
  const [[g2]] = await pool.query(`SELECT COUNT(*) AS n FROM support_requests WHERE id = ?`, [o2.insertId]);
  check('old finished reports purged, open kept', g1.n === 0 && g2.n === 1);
  for (let i = 0; i < 8; i++) await cl('POST', '/api/support', { message: 'ซ้ำ ' + i + ' ทดสอบ' });
  check('daily limit stops floods', (await cl('POST', '/api/support', { message: 'อีกอันหนึ่ง' })).status === 429);

  await pool.query(`DELETE FROM companies WHERE name LIKE 'OPSTEST%'`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'opstest-%@test.co'`);
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
