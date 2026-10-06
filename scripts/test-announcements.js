// "What's new" bell: audience, unread counts, scheduling, KSS-only authoring.
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
  const hash = await bcrypt.hash('News#2026', 10);
  const [[co]] = await pool.query(`SELECT id FROM companies ORDER BY id LIMIT 1`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'newstest-%@test.co'`);
  await pool.query(`DELETE FROM announcements WHERE title LIKE 'NEWSTEST%'`);
  for (const [e, role, cid] of [['newstest-kss@test.co', 'kss_superadmin', null], ['newstest-ca@test.co', 'company_admin', co.id], ['newstest-cl@test.co', 'client', co.id]]) {
    await pool.query(`INSERT INTO users (email, password_hash, display_name, role, company_id, must_change_password, announcements_seen_at) VALUES (?, ?, ?, ?, ?, 0, NOW() - INTERVAL 1 MINUTE)`, [e, hash, e, role, cid]);
  }
  const login = async (email) => { const s = session(); const r = await s('POST', '/api/auth/login', { email, password: 'News#2026' }); if (r.status !== 200) throw new Error('login ' + email); return s; };
  const kss = await login('newstest-kss@test.co');
  const ca = await login('newstest-ca@test.co');
  const cl = await login('newstest-cl@test.co');
  const base = { ca: (await ca('GET', '/api/announcements')).json.unread, cl: (await cl('GET', '/api/announcements')).json.unread };
  

  check('client cannot post', (await cl('POST', '/api/announcements/admin', { title: 'x', body: 'y' })).status === 403);
  check('company admin cannot post', (await ca('POST', '/api/announcements/admin', { title: 'x', body: 'y' })).status === 403);
  check('empty post refused', (await kss('POST', '/api/announcements/admin', { title: '', body: '' })).status === 400);
  let r = await kss('POST', '/api/announcements/admin', { title: 'NEWSTEST all', body: 'สำหรับทุกคน', title_en: 'NEWSTEST all EN', template_keys: ['pos_cogs_kpi', 'pos_menu_gp', 'no_such_widget'] });
  check('KSS posts to everyone', r.status === 201, JSON.stringify(r.json));
  const allId = r.json.id;
  r = await kss('POST', '/api/announcements/admin', { title: 'NEWSTEST admins', body: 'เฉพาะ admin', audience: 'admins' });
  const adminId = r.json.id;
  await kss('POST', '/api/announcements/admin', { title: 'NEWSTEST future', body: 'ยังไม่ถึงเวลา', published_at: new Date(Date.now() + 86400000).toISOString() });

  let c = (await cl('GET', '/api/announcements')).json;
  let a = (await ca('GET', '/api/announcements')).json;
  check('client: 1 new unread (admins-only and scheduled hidden)', c.unread === base.cl + 1 && !c.items.some((i) => /admins|future/.test(i.title)), JSON.stringify(c.items.map((i) => i.title)));
  check('company admin: 2 new unread', a.unread === base.ca + 2, `${base.ca} -> ${a.unread}`);
  const post = c.items.find((i) => i.id === allId);
  check('post lists its widgets by name (unknown key dropped)', post.widgets.length === 2 && post.widgets.every((w) => w.name), JSON.stringify(post.widgets));
  check('English title carried', post.title_en === 'NEWSTEST all EN');

  await cl('POST', '/api/announcements/seen');
  c = (await cl('GET', '/api/announcements')).json;
  check('opening the bell clears the count', c.unread === 0 && c.items.every((i) => !i.unread));
  check('…for that user only', (await ca('GET', '/api/announcements')).json.unread === base.ca + 2);

  r = await kss('PUT', `/api/announcements/admin/${adminId}`, { title: 'NEWSTEST admins edited', body: 'แก้แล้ว', audience: 'all' });
  check('KSS edits a post (now for everyone)', r.status === 200 && (await cl('GET', '/api/announcements')).json.items.some((i) => i.title === 'NEWSTEST admins edited'));
  const list = (await kss('GET', '/api/announcements/admin')).json.items;
  check('KSS list includes the scheduled post', list.some((i) => i.title === 'NEWSTEST future'));
  check('KSS deletes a post', (await kss('DELETE', `/api/announcements/admin/${allId}`)).status === 200 && !(await cl('GET', '/api/announcements')).json.items.some((i) => i.id === allId));

  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM announcements WHERE title NOT LIKE 'NEWSTEST%'`);
  check('first posts seeded by migration', n >= 2, n);
  await pool.query(`DELETE FROM announcements WHERE title LIKE 'NEWSTEST%'`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'newstest-%@test.co'`);
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
