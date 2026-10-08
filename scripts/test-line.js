// LINE bot (lib/line.js) against a local mock of the LINE API: signature check,
// group binding, ignoring other groups, the "สถานะ" reply, de-duplicated alert,
// and secrets never leaving the server in clear text. Needs the DB in the env.
const http = require('http');
const crypto = require('crypto');
const pool = require('../db/pool');
let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };
const sent = [];
const mock = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => { sent.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b || '{}') }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
});
(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.LINE_API_BASE = `http://127.0.0.1:${mock.address().port}`;
  const line = require('../lib/line');
  const [[demo]] = await pool.query(`SELECT id FROM companies WHERE data_source = 'demo' ORDER BY id LIMIT 1`);
  if (!demo) { console.log('no demo company — skipped'); process.exit(0); }
  const id = demo.id;
  await pool.query(`DELETE FROM company_line WHERE company_id = ?`, [id]);
  const SECRET = 'test-secret-abc123', TOKEN = 'test-token-xyz789';
  const v0 = await line.publicView(id, 'https://x.test');
  check('not ready before keys are set', v0.ready === false && /\/api\/webhooks\/line\/[0-9a-f]{36}$/.test(v0.webhook_url));
  await line.save(id, { channel_secret: SECRET, access_token: TOKEN, enabled: true });
  const [[row]] = await pool.query(`SELECT * FROM company_line WHERE company_id = ?`, [id]);
  check('secrets stored encrypted', !JSON.stringify(row).includes(SECRET) && !JSON.stringify(row).includes(TOKEN));
  const v1 = await line.publicView(id, 'https://x.test');
  check('view never returns secrets', v1.ready && !JSON.stringify(v1).includes(SECRET) && !JSON.stringify(v1).includes(TOKEN), JSON.stringify(v1));
  const key = row.webhook_key;
  const post = async (events, secret = SECRET, k = key) => {
    const raw = Buffer.from(JSON.stringify({ events }));
    const sig = crypto.createHmac('sha256', secret).update(raw).digest('base64');
    return line.handleWebhook(k, raw, sig, JSON.parse(raw.toString()));
  };
  check('wrong signature → 401', (await post([], 'nope')) === 401);
  let ev = (await line.publicView(id, 'x')).last_event_note;
  check('wrong signature is explained in Admin', /ลายเซ็นไม่ตรง/.test(ev), ev);
  check('Verify (no events) → 200 and noted', (await post([])) === 200 && /Verify ผ่าน/.test((await line.publicView(id, 'x')).last_event_note));
  check('unknown key → 404', (await post([], SECRET, 'zzz')) === 404);
  const G1 = { type: 'group', groupId: 'Gexec1' }, G2 = { type: 'group', groupId: 'Gother' };
  check('join accepted', (await post([{ type: 'join', source: G1, replyToken: 'r1' }])) === 200);
  const [[b1]] = await pool.query(`SELECT group_id FROM company_line WHERE company_id = ?`, [id]);
  check('bound to first group', b1.group_id === 'Gexec1');
  check('greeting replied (free reply API)', sent.length === 1 && sent[0].url === '/v2/bot/message/reply' && sent[0].auth === `Bearer ${TOKEN}`);
  await line.save(id, { access_token: ' ' });
  await post([{ type: 'message', source: G1, replyToken: 'rx', message: { type: 'text', text: 'hello' } }]);
  check('ordinary chat in the group is noted, not answered', sent.length === 1 && /ไม่ใช่คำสั่ง/.test((await line.publicView(id, 'x')).last_event_note));
  await post([{ type: 'message', source: G2, replyToken: 'r2', message: { type: 'text', text: 'สถานะ' } }]);
  check('other group ignored (no reply, no rebinding)', sent.length === 1);
  await post([{ type: 'message', source: { type: 'user', userId: 'U1' }, replyToken: 'r3', message: { type: 'text', text: 'สถานะ' } }]);
  check('1:1 chat ignored', sent.length === 1);
  await post([{ type: 'message', source: G1, replyToken: 'r4', message: { type: 'text', text: 'สถานะ' } }]);
  const st = sent[sent.length - 1];
  check('"สถานะ" in bound group answers with flagged branch', sent.length === 2 && st.body.messages[0].text.includes('บางนา'), JSON.stringify(st.body));
  const a1 = await line.sendAlert(id, { base: 'https://app.test' });
  const p = sent[sent.length - 1];
  check('alert pushed to the group as flex', a1.sent && p.url === '/v2/bot/message/push' && p.body.to === 'Gexec1' && p.body.messages[0].type === 'flex' && p.body.messages[0].altText.includes('บางนา'), JSON.stringify(a1));
  const flexStr = JSON.stringify(p.body.messages[0]);
  check('alert names only Bangna and has dashboard button', flexStr.includes('สาขา บางนา') && !flexStr.includes('สยาม') && flexStr.includes('https://app.test/'));
  const n = sent.length;
  const a2 = await line.sendAlert(id, { base: 'https://app.test' });
  check('same list is not sent again', a2.sent === false && sent.length === n, JSON.stringify(a2));
  const a3 = await line.sendAlert(id, { force: true, base: 'https://app.test' });
  check('force sends again', a3.sent === true && sent.length === n + 1);
  await line.unbindGroup(id);
  let err = null; try { await line.sendAlert(id); } catch (e) { err = e; }
  check('no group → clear error', err && /ผูกกลุ่ม/.test(err.message));
  await pool.query(`DELETE FROM company_line WHERE company_id = ?`, [id]);
  console.log(`\n${pass} passed, ${fail} failed`);
  mock.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
