// Dashboard AI chat against a fake Gemini.
//   GEMINI_API_KEY=test GEMINI_BASE=http://127.0.0.1:4777 AI_DAILY_LIMIT=3 PORT=3101 node server.js
//   node scripts/test-ai.js
const assert = require('assert');
const http = require('http');
const mysql = require('mysql2/promise');
const B = process.env.BASE || 'http://127.0.0.1:3101';

let lastBody = null;
let fail429 = false;
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    lastBody = { url: req.url, key: req.headers['x-goog-api-key'], json: JSON.parse(raw || '{}') };
    if (fail429) { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'quota' } })); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: '- **สรุป**: ยอดซื้อเพิ่มขึ้น' }] } }] }));
  });
});

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
  await new Promise((r) => fake.listen(4777, r));
  const db = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  const q = async (sql, p) => (await db.query(sql, p))[0];
  await req('kss', 'POST', '/api/auth/login', { email: 'admin@kinsupplyandservice.com', password: process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!' });
  const stamp = Date.now().toString(36);
  const mk = async (name, src) => { const id = (await req('kss', 'POST', '/api/admin/companies', { name, status: 'active' })).body.id; await q(`UPDATE companies SET data_source = ? WHERE id = ?`, [src, id]); return id; };
  const demo = await mk(`AI demo ${stamp}`, 'demo');
  const real = await mk(`AI real ${stamp}`, 'fmh');
  const dash = async (cid) => (await req('kss', 'POST', `/api/admin/companies/${cid}/dashboards`, { display_name: 'AI' })).body.id;
  const dDemo = await dash(demo), dReal = await dash(real);
  const email = `viewer-${stamp}@example.test`;
  await req('kss', 'POST', '/api/users', { email, display_name: 'v', temp_password: 'aipass1234', role: 'client', company_id: real });
  await q(`UPDATE users SET must_change_password = FALSE WHERE email = ?`, [email]);
  await req('viewer', 'POST', '/api/auth/login', { email, password: 'aipass1234' });

  await ok('free tier: on for a demo company, off for a real one', async () => {
    assert.strictEqual((await req('kss', 'GET', `/api/ai/status?dashboard_id=${dDemo}`)).body.available, true);
    const r = (await req('kss', 'GET', `/api/ai/status?dashboard_id=${dReal}`)).body;
    assert.strictEqual(r.available, false); assert.strictEqual(r.reason, 'free_tier_demo_only');
    assert.strictEqual((await req('kss', 'POST', '/api/ai/chat', { dashboard_id: dReal, question: 'x', context: 'x' })).status, 403);
  });
  await ok('a question goes to Gemini with the page summary, the key in a header, and comes back', async () => {
    const r = await req('kss', 'POST', '/api/ai/chat', { dashboard_id: dDemo, question: 'สรุปให้หน่อย', context: '[ยอดซื้อ]\n  - สูงสุดคือ A ที่ ฿100', history: [{ role: 'user', text: 'ก่อนหน้า' }, { role: 'model', text: 'ตอบ' }] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.answer.includes('ยอดซื้อเพิ่มขึ้น'));
    assert.strictEqual(lastBody.key, 'test');
    assert.ok(!/key=/.test(lastBody.url), 'key not in the URL');
    const last = lastBody.json.contents[lastBody.json.contents.length - 1].parts[0].text;
    assert.ok(last.includes('สูงสุดคือ A ที่ ฿100') && last.includes('สรุปให้หน่อย'));
    assert.strictEqual(lastBody.json.contents.length, 3);
    assert.ok(lastBody.json.systemInstruction.parts[0].text.includes('ห้ามเดา'));
  });
  await ok('a viewer can’t ask about another company’s dashboard', async () => {
    assert.strictEqual((await req('viewer', 'POST', '/api/ai/chat', { dashboard_id: dDemo, question: 'x' })).status, 404);
  });
  await ok('Google’s rate limit comes back as a plain 429', async () => {
    fail429 = true;
    const r = await req('kss', 'POST', '/api/ai/chat', { dashboard_id: dDemo, question: 'อีกข้อ', context: 'x' });
    fail429 = false;
    assert.strictEqual(r.status, 429); assert.ok(r.body.error.includes('ถี่เกินไป'));
  });
  await ok('the daily limit per company holds (AI_DAILY_LIMIT=3)', async () => {
    const r = await req('kss', 'POST', '/api/ai/chat', { dashboard_id: dDemo, question: 'ข้อที่สาม', context: 'x' });
    assert.strictEqual(r.status, 200);
    const over = await req('kss', 'POST', '/api/ai/chat', { dashboard_id: dDemo, question: 'เกิน', context: 'x' });
    assert.strictEqual(over.status, 429); assert.strictEqual(over.body.code, 'AI_DAILY_LIMIT');
    const [row] = await q(`SELECT questions FROM ai_usage WHERE company_id = ?`, [demo]);
    assert.ok(row.questions >= 3);
  });
  await ok('an empty question is refused before it costs anything', async () => {
    assert.strictEqual((await req('kss', 'POST', '/api/ai/chat', { dashboard_id: dDemo, question: '  ' })).status, 400);
  });
  await ok('feedback and misses are stored; anyone with access sends, only KSS staff read', async () => {
    assert.strictEqual((await req('kss', 'POST', '/api/ai/feedback', { dashboard_id: dReal, kind: 'miss', question: 'ราคาไข่วันนี้', source: 'none' })).status, 200);
    assert.strictEqual((await req('kss', 'POST', '/api/ai/feedback', { dashboard_id: dReal, kind: 'down', question: 'ราคาไข่วันนี้', answer: 'x', source: 'faq' })).status, 200);
    assert.strictEqual((await req('kss', 'POST', '/api/ai/feedback', { dashboard_id: dReal, kind: 'bogus', question: 'x' })).status, 400);
    assert.strictEqual((await req('viewer', 'POST', '/api/ai/feedback', { dashboard_id: dDemo, kind: 'up', question: 'x' })).status, 404);
    assert.strictEqual((await req('viewer', 'GET', '/api/ai/misses')).status, 403);
    const r = await req('kss', 'GET', '/api/ai/misses?days=1');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.list.some((x) => x.question === 'ราคาไข่วันนี้' && x.kind === 'miss'));
    assert.ok(r.body.totals.miss >= 1 && r.body.totals.down >= 1);
  });
  console.log(`\n${pass} passed${process.exitCode ? ', some failed' : ', 0 failed'}`);
  await db.end();
  fake.close();
})().catch((e) => { console.error(e); process.exit(1); });
