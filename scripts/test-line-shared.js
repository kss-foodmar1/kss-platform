// KSS's shared LINE OA (lib/line.js, mode 'shared') against a local mock of the LINE API: one
// webhook, signature, binding by code (one use, expiry, wrong code), a group nobody bound gets
// nothing, a bound group is answered only with its own company's data, the pool quota stops
// sending, switching mode, and the keys never being stored. Needs the DB in the env.
const http = require('http');
const crypto = require('crypto');
const pool = require('../db/pool');
let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };
const sent = [];
const mock = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => { sent.push({ url: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : {} }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(req.url.includes('/members/count') ? '{"count":8}' : '{}'); });
});
(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.LINE_API_BASE = `http://127.0.0.1:${mock.address().port}`;
  const SECRET = 'shared-secret-123', TOKEN = 'shared-token-456';
  delete process.env.LINE_CHANNEL_SECRET; delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  process.env.LINE_MONTHLY_QUOTA = '20';
  const line = require('../lib/line');
  // Two throw-away companies (status 'demo': the digest is allowed to go out), removed at the end.
  const mk = async (n) => (await pool.query(`INSERT INTO companies (name, status) VALUES (?, 'demo')`, [n]))[0].insertId;
  const [A, B] = [await mk('LINE shared test A'), await mk('LINE shared test B')];
  for (const id of [A, B]) { await pool.query(`DELETE FROM company_line WHERE company_id = ?`, [id]); await pool.query(`DELETE FROM line_usage WHERE company_id = ?`, [id]); await line.ensure(id); }

  let err = null;
  try { await line.setMode(A, 'shared'); } catch (e) { err = e; }
  check('shared mode refused while KSS keys are not configured', err && err.status === 409);
  process.env.LINE_CHANNEL_SECRET = SECRET; process.env.LINE_CHANNEL_ACCESS_TOKEN = TOKEN;
  await line.setMode(A, 'shared'); await line.setMode(B, 'shared');
  const vA = await line.publicView(A, 'https://x.test');
  check('view: shared, ready with no keys stored, code shown', vA.mode === 'shared' && vA.ready && /^[A-Z2-9]{8}$/.test(vA.bind_code) && vA.webhook_url === 'https://x.test/api/webhooks/line', JSON.stringify(vA));
  const [[rowA]] = await pool.query(`SELECT * FROM company_line WHERE company_id = ?`, [A]);
  check('KSS keys never written to the database', !JSON.stringify(rowA).includes(SECRET) && !JSON.stringify(rowA).includes(TOKEN) && !rowA.access_token_enc);
  check('code is stable between views', (await line.publicView(A, 'x')).bind_code === vA.bind_code);
  const vB = await line.publicView(B, 'x');
  check('each company has its own code', vB.bind_code !== vA.bind_code);

  const post = async (events, secret = SECRET) => {
    const raw = Buffer.from(JSON.stringify({ events }));
    return line.handleSharedWebhook(raw, crypto.createHmac('sha256', secret).update(raw).digest('base64'), JSON.parse(raw.toString()));
  };
  const msg = (g, text, tok = 'rt') => ({ type: 'message', source: { type: 'group', groupId: g }, replyToken: tok, message: { type: 'text', text } });
  check('wrong signature → 401', (await post([], 'nope')) === 401);
  check('Verify (no events) → 200', (await post([])) === 200 && sent.length === 0);

  await post([msg('Gnew', 'สวัสดี')]);
  check('unbound group chatting gets nothing (no reply, no data)', sent.length === 0);
  await post([msg('Gnew', 'สถานะ')]);
  check('unbound group asking "สถานะ" gets nothing', sent.length === 0);
  await post([{ type: 'join', source: { type: 'group', groupId: 'Gnew' }, replyToken: 'rj' }]);
  check('join: one reply explaining how to bind', sent.length === 1 && /ผูก/.test(sent[0].body.messages[0].text) && sent[0].auth === `Bearer ${TOKEN}`);
  sent.length = 0;
  await post([msg('Gnew', 'ผูก ZZZZZZZZ')]);
  check('wrong code refused, not bound', sent.length === 1 && /ไม่ถูกต้อง/.test(sent[0].body.messages[0].text) && !(await pool.query(`SELECT 1 FROM company_line WHERE group_id = 'Gnew'`))[0].length);
  sent.length = 0;
  await post([msg('GA', `ผูก ${vA.bind_code.toLowerCase()}`)]);
  const [[a1]] = await pool.query(`SELECT group_id, bind_code FROM company_line WHERE company_id = ?`, [A]);
  check('right code binds the group to company A (case-insensitive) and the code is spent', a1.group_id === 'GA' && a1.bind_code === null && /เชื่อมกับกลุ่มนี้แล้ว/.test(sent[sent.length - 1].body.messages[0].text));
  sent.length = 0;
  await post([msg('GB', `ผูก ${vA.bind_code}`)]);
  const [[a2]] = await pool.query(`SELECT group_id FROM company_line WHERE company_id = ?`, [A]);
  check('a spent code cannot bind a second group', a2.group_id === 'GA' && /ไม่ถูกต้อง/.test(sent[0].body.messages[0].text));
  await pool.query(`UPDATE company_line SET bind_code_expires = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE company_id = ?`, [B]);
  sent.length = 0;
  await post([msg('GB', `ผูก ${vB.bind_code}`)]);
  check('an expired code is refused', /ไม่ถูกต้อง|หมดอายุ/.test(sent[0].body.messages[0].text) && !(await pool.query(`SELECT 1 FROM company_line WHERE company_id = ? AND group_id IS NOT NULL`, [B]))[0].length);
  const vB2 = await line.publicView(B, 'x');
  check('an expired code is replaced by a fresh one in Admin', vB2.bind_code && vB2.bind_code !== vB.bind_code);
  sent.length = 0;
  await post([msg('GB', `ผูก ${vB2.bind_code}`)]);
  check('company B binds its own group', (await pool.query(`SELECT 1 FROM company_line WHERE company_id = ? AND group_id = 'GB'`, [B]))[0].length === 1);

  sent.length = 0;
  await post([msg('GA', 'สถานะ', 'ra'), msg('GB', 'สถานะ', 'rb')]);
  check('one webhook call answers both groups with the shared token', sent.length === 2 && sent.every((x) => x.url === '/v2/bot/message/reply' && x.auth === `Bearer ${TOKEN}`));
  const [[nm]] = await pool.query(`SELECT 1`);
  check('each reply uses that company\'s own data (note recorded per company)', /ตอบ "สถานะ"/.test((await line.publicView(A, 'x')).last_event_note) && /ตอบ "สถานะ"/.test((await line.publicView(B, 'x')).last_event_note));

  // own-mode webhook keeps working and ignores shared companies
  const [[ownKey]] = await pool.query(`SELECT webhook_key FROM company_line WHERE company_id = ?`, [A]);
  check('a shared company\'s per-company webhook URL is closed (404)', (await line.handleWebhook(ownKey.webhook_key, Buffer.from('{}'), 'x', {})) === 404);

  // quota: members 8 → each digest costs 8; pool limit 20
  await pool.query(`UPDATE company_line SET enabled = 1 WHERE company_id IN (?, ?)`, [A, B]);
  sent.length = 0;
  const r1 = await line.sendAlert(A, { force: true, base: 'https://app.test' });
  check('force send works through the shared OA and counts 8 (group of 8)', r1.sent && r1.quota.shared && r1.quota.used === 8 && r1.quota.pool_used === 8, JSON.stringify(r1));
  const r2 = await line.sendAlert(B, { force: true, base: 'https://app.test' });
  check('second company adds to the pool (16/20)', r2.sent && r2.quota.pool_used === 16 && r2.quota.used === 8);
  const outgoing = () => sent.filter((x) => /\/message\/(push|reply)$/.test(x.url)).length;
  const before = outgoing();
  const r3 = await line.sendAlert(A, { force: true, base: 'https://app.test' });
  check('the pool is full: nothing is sent, even forced', r3.sent === false && /OA กลาง/.test(r3.reason) && outgoing() === before, JSON.stringify(r3));
  const usage = await line.sharedUsage();
  check('KSS overview: pool and per-company use', usage.used === 16 && usage.limit === 20 && usage.companies.find((c) => c.id === A).messages === 8);

  // switching mode starts over
  await line.setMode(A, 'own');
  const [[sw]] = await pool.query(`SELECT mode, group_id, enabled FROM company_line WHERE company_id = ?`, [A]);
  check('back to own OA: group unbound, auto-send off', sw.mode === 'own' && sw.group_id === null && !sw.enabled);
  await pool.query(`DELETE FROM companies WHERE id IN (?, ?)`, [A, B]);
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end(); mock.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
