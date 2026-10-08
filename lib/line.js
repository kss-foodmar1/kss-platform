// LINE bot for executive groups. Each company brings its own LINE Official
// Account (channel secret + access token, stored encrypted); KSS never holds a
// shared bot. The bot binds to the first group that talks to it, sends the
// "branches to check" alert from the branch purchase audit (lib/ckAudit.js)
// when that list changes, and answers "สถานะ" in the bound group.
//
// Reply messages (answering someone) are free on LINE; push messages count
// toward the OA's monthly quota — so alerts are de-duplicated by fingerprint.
const crypto = require('crypto');
const pool = require('../db/pool');
const { encrypt, decrypt, mask } = require('./crypto');

const API = () => (process.env.LINE_API_BASE || 'https://api.line.me').replace(/\/$/, '');
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

async function get(companyId) {
  const [[r]] = await pool.query(`SELECT * FROM company_line WHERE company_id = ?`, [companyId]);
  return r || null;
}
async function ensure(companyId) {
  let r = await get(companyId);
  if (!r) {
    await pool.query(`INSERT INTO company_line (company_id, webhook_key) VALUES (?, ?)`, [companyId, crypto.randomBytes(18).toString('hex')]);
    r = await get(companyId);
  }
  return r;
}

// What the Admin screen sees: never the secrets, only whether they are set.
async function publicView(companyId, baseUrl) {
  const r = await ensure(companyId);
  const sec = r.channel_secret_enc ? decrypt(r.channel_secret_enc) : '';
  const tok = r.access_token_enc ? decrypt(r.access_token_enc) : '';
  return {
    webhook_url: `${baseUrl}/api/webhooks/line/${r.webhook_key}`,
    has_secret: !!sec, secret_hint: sec ? mask(sec) : '',
    has_token: !!tok, token_hint: tok ? mask(tok) : '',
    group_bound: !!r.group_id, enabled: !!r.enabled,
    last_sent_at: r.last_sent_at, ready: !!(sec && tok),
    last_event_at: r.last_event_at, last_event_note: r.last_event_note || '',
  };
}

async function save(companyId, { channel_secret, access_token, enabled }) {
  await ensure(companyId);
  const sets = [], vals = [];
  if (typeof channel_secret === 'string' && channel_secret.trim()) { sets.push('channel_secret_enc = ?'); vals.push(encrypt(channel_secret.trim())); }
  if (typeof access_token === 'string' && access_token.trim()) { sets.push('access_token_enc = ?'); vals.push(encrypt(access_token.trim())); }
  if (typeof enabled === 'boolean') { sets.push('enabled = ?'); vals.push(enabled ? 1 : 0); }
  if (sets.length) await pool.query(`UPDATE company_line SET ${sets.join(', ')} WHERE company_id = ?`, [...vals, companyId]);
}
async function unbindGroup(companyId) {
  await pool.query(`UPDATE company_line SET group_id = NULL, last_alert_key = NULL WHERE company_id = ?`, [companyId]);
}

// ---------- LINE API ----------
function verifySignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  const want = crypto.createHmac('sha256', secret).update(rawBody).digest();
  let got;
  try { got = Buffer.from(String(signature), 'base64'); } catch (e) { return false; }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
async function call(token, path, body) {
  const res = await fetch(`${API()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch (e) { /* no body */ }
    throw bad(`LINE ตอบกลับ ${res.status}${detail ? ': ' + detail : ''}`, 502);
  }
}
const push = (token, to, messages) => call(token, '/v2/bot/message/push', { to, messages });
const reply = (token, replyToken, messages) => call(token, '/v2/bot/message/reply', { replyToken, messages });

// ---------- the alert ----------
const baht0 = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const THAI_MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const monthLabel = (ym) => { const [y, m] = String(ym).split('-'); return m ? `${THAI_MONTH[Number(m) - 1]} ${Number(y) + 543}` : ym; };

// Branches flagged "ควรตรวจ" in the latest complete month, worst first.
async function flaggedBranches(companyId) {
  const fc = require('./fmhCache');
  const ck = require('./ckAudit');
  let rows = null;
  const cached = await fc.getCached(companyId, 'ck-audit', null);
  if (cached && cached.data && cached.data.length) rows = cached.data;
  else { const b = await ck.buildFor(companyId, 'ck-audit'); rows = (b && b.rows) || []; }
  const latest = rows.filter((r) => r.is_latest);
  const month = latest[0] ? latest[0].month : null;
  const flagged = latest.filter((r) => r.status === 'ควรตรวจ').sort((a, b) => (a.vs_median || 0) - (b.vs_median || 0));
  const watching = latest.filter((r) => r.status === 'เฝ้าดู').length;
  const out = { month, flagged, watching, total: latest.length };
  if (!month) {
    // Say which side is missing instead of a vague "no data".
    try { const o = await ck.overview(companyId); out.missing = { pos: !o.has_pos, ck: !o.has_ck }; } catch (e) { out.missing = null; }
  }
  return out;
}
const fingerprint = (f) => crypto.createHash('sha1').update(f.month + '|' + f.flagged.map((r) => `${r.branch}:${r.low_streak}`).sort().join(',')).digest('hex');

function alertMessages(f, dashUrl) {
  const lines = f.flagged.map((r) => ({
    type: 'box', layout: 'vertical', spacing: 'xs', margin: 'md', contents: [
      { type: 'text', text: r.branch, weight: 'bold', size: 'md', wrap: true },
      { type: 'text', text: `ซื้อจากครัวกลาง ${r.ck_pct}% ของยอดขาย (ค่ากลางสาขาอื่น ${r.median_pct}%)`, size: 'sm', color: '#555555', wrap: true },
      { type: 'text', text: `ต่ำกว่าเกณฑ์ ${r.low_streak} เดือนติดต่อกัน`, size: 'sm', color: '#B42318', wrap: true },
    ],
  }));
  const alt = `ควรตรวจสอบ ${f.flagged.length} สาขา (${monthLabel(f.month)}): ${f.flagged.map((r) => r.branch).join(', ')}`;
  const bubble = {
    type: 'bubble',
    header: { type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: 'สาขาที่ควรตรวจสอบ', weight: 'bold', size: 'lg' },
      { type: 'text', text: `ซื้อวัตถุดิบจากครัวกลางต่ำกว่าสาขาอื่น · ${monthLabel(f.month)}`, size: 'xs', color: '#777777', wrap: true },
    ] },
    body: { type: 'box', layout: 'vertical', contents: [
      ...lines,
      { type: 'text', text: 'เป็นสัญญาณให้ตรวจสอบ ไม่ใช่ข้อสรุป — ควรดูสูตรอาหารและใบสั่งซื้อของสาขาประกอบ', size: 'xs', color: '#777777', wrap: true, margin: 'lg' },
    ] },
  };
  if (/^https:\/\//.test(dashUrl || '')) {
    bubble.footer = { type: 'box', layout: 'vertical', contents: [{ type: 'button', style: 'primary', action: { type: 'uri', label: 'ดูรายละเอียดใน Dashboard', uri: dashUrl } }] };
  }
  return [{ type: 'flex', altText: alt.slice(0, 400), contents: bubble }];
}
function statusText(f) {
  if (!f.month) {
    const m = f.missing;
    const why = !m ? 'ต้องมียอดขาย POS และยอดขายจากครัวกลางใน FMH'
      : m.pos && m.ck ? 'ยังไม่มีทั้งยอดขาย POS และยอดขายจากครัวกลาง (FMH Sales Analysis)'
      : m.pos ? 'ยังไม่มียอดขาย POS (ต้องอัปโหลดไฟล์ POS ในหน้า Admin)'
      : m.ck ? 'ยังไม่มียอดขายจากครัวกลาง (FMH Sales Analysis ว่าง — ตรวจ FMH key / การซิงก์)'
      : 'มีข้อมูลสองฝั่งแล้ว แต่ช่วงเวลาที่ทับกันยังไม่พอจะเทียบ';
    return `ยังไม่มีข้อมูลตรวจสาขา: ${why}`;
  }
  if (!f.flagged.length) return `เดือน ${monthLabel(f.month)}: ไม่มีสาขาที่ควรตรวจสอบ` + (f.watching ? ` (เฝ้าดู ${f.watching} สาขา)` : '');
  return `เดือน ${monthLabel(f.month)} ควรตรวจสอบ ${f.flagged.length} สาขา:\n` + f.flagged.map((r) => `• ${r.branch} — ${r.ck_pct}% ของยอดขาย (ค่ากลาง ${r.median_pct}%), ต่ำ ${r.low_streak} เดือนติด`).join('\n');
}

// Sends the alert to the bound group. Unless force, nothing is sent when the
// flagged list is the same as last time or there is nothing to flag.
async function sendAlert(companyId, { force = false, base = '' } = {}) {
  const r = await get(companyId);
  if (!r || !r.channel_secret_enc || !r.access_token_enc) throw bad('ยังไม่ได้ใส่ Channel secret / Access token');
  if (!r.group_id) throw bad('ยังไม่ได้ผูกกลุ่ม LINE — เชิญบอทเข้ากลุ่มแล้วพิมพ์ข้อความ 1 ข้อความ');
  const f = await flaggedBranches(companyId);
  const key = fingerprint(f);
  if (!force) {
    if (!f.flagged.length) return { sent: false, reason: 'ไม่มีสาขาที่ควรตรวจ' };
    if (r.last_alert_key === key) return { sent: false, reason: 'รายการเดิมที่เคยแจ้งแล้ว' };
  }
  const token = decrypt(r.access_token_enc);
  const dash = base ? `${base}/` : '';
  const msgs = f.flagged.length ? alertMessages(f, dash) : [{ type: 'text', text: statusText(f) }];
  await push(token, r.group_id, msgs);
  await pool.query(`UPDATE company_line SET last_alert_key = ?, last_sent_at = NOW() WHERE company_id = ?`, [key, companyId]);
  return { sent: true, flagged: f.flagged.length };
}
async function sendTest(companyId) {
  const r = await get(companyId);
  if (!r || !r.access_token_enc) throw bad('ยังไม่ได้ใส่ Access token');
  if (!r.group_id) throw bad('ยังไม่ได้ผูกกลุ่ม LINE — เชิญบอทเข้ากลุ่มแล้วพิมพ์ข้อความ 1 ข้อความ');
  await push(decrypt(r.access_token_enc), r.group_id, [{ type: 'text', text: 'ทดสอบจาก KSS Dashboard: บอทเชื่อมกับกลุ่มนี้แล้ว' }]);
}

// ---------- incoming webhook ----------
// What the webhook last did, shown in Admin: a silent bot is otherwise a mystery.
async function note(companyId, text) {
  try { await pool.query(`UPDATE company_line SET last_event_at = NOW(), last_event_note = ? WHERE company_id = ?`, [String(text).slice(0, 250), companyId]); } catch (e) { /* diagnostics only */ }
}

// Returns the HTTP status to answer with. Group events only; a different group
// than the bound one is ignored (no data leaves to a group nobody chose).
async function handleWebhook(webhookKey, rawBody, signature, body) {
  const [[r]] = await pool.query(`SELECT * FROM company_line WHERE webhook_key = ?`, [String(webhookKey).slice(0, 40)]);
  if (!r) { console.warn('LINE webhook: unknown key'); return 404; }
  if (!r.channel_secret_enc) { await note(r.company_id, 'LINE เรียกมาแล้ว แต่ยังไม่ได้บันทึก Channel secret'); return 404; }
  if (!verifySignature(rawBody, signature, decrypt(r.channel_secret_enc))) {
    await note(r.company_id, rawBody ? 'ลายเซ็นไม่ตรง — Channel secret ที่บันทึกไม่ตรงกับของ LINE channel นี้' : 'ไม่ได้รับ body ของคำขอ');
    return 401;
  }
  const token = r.access_token_enc ? decrypt(r.access_token_enc) : null;
  const events = (body && body.events) || [];
  if (!events.length) { await note(r.company_id, 'Verify ผ่าน (LINE เรียก webhook ได้และลายเซ็นถูกต้อง)'); return 200; }
  for (const ev of events) {
    try {
      const src = ev.source || {};
      if (src.type !== 'group' || !src.groupId) { await note(r.company_id, `ได้รับ event ${ev.type} จากแชท${src.type === 'user' ? 'ส่วนตัว' : src.type || ''} — บอทรับเฉพาะกลุ่ม`); continue; }
      let bound = r.group_id;
      if (!bound && (ev.type === 'join' || ev.type === 'message')) {
        await pool.query(`UPDATE company_line SET group_id = ? WHERE company_id = ? AND group_id IS NULL`, [src.groupId, r.company_id]);
        r.group_id = src.groupId;
        if (!token) { await note(r.company_id, 'ผูกกลุ่มแล้ว แต่ยังไม่มี Access token จึงตอบไม่ได้ — ใส่ token แล้วพิมพ์ "สถานะ" ในกลุ่ม'); continue; }
        if (ev.replyToken) await reply(token, ev.replyToken, [{ type: 'text', text: 'เชื่อมกับกลุ่มนี้แล้ว จากนี้จะแจ้งสาขาที่ควรตรวจสอบที่นี่ พิมพ์ "สถานะ" เพื่อดูสรุปได้ทุกเมื่อ' }]);
        await note(r.company_id, 'ผูกกลุ่มสำเร็จและตอบข้อความต้อนรับแล้ว');
        continue;
      }
      if (bound !== src.groupId) { await note(r.company_id, 'ได้รับ event จากกลุ่มอื่นที่ไม่ใช่กลุ่มที่ผูกไว้ — เมิน'); continue; }
      if (ev.type === 'message' && ev.message && ev.message.type === 'text') {
        const t = String(ev.message.text || '').trim();
        if (!/^(สถานะ|ตรวจสาขา|status)$/i.test(t)) { await note(r.company_id, 'ได้รับข้อความในกลุ่มที่ผูกไว้ (ไม่ใช่คำสั่ง "สถานะ")'); continue; }
        if (!token) { await note(r.company_id, 'ได้รับ "สถานะ" แต่ยังไม่มี Access token'); continue; }
        let text;
        try { text = statusText(await flaggedBranches(r.company_id)); } catch (err) { console.error('LINE status failed:', err.message); text = 'ดึงข้อมูลตรวจสาขาไม่สำเร็จ ลองใหม่อีกครั้งภายหลัง'; }
        await reply(token, ev.replyToken, [{ type: 'text', text }]);
        await note(r.company_id, 'ตอบ "สถานะ" ในกลุ่มแล้ว');
      }
    } catch (err) {
      console.error(`LINE webhook event failed (company ${r.company_id}):`, err.message);
      await note(r.company_id, `ตอบ LINE ไม่สำเร็จ: ${err.message}`);
    }
  }
  return 200;
}

// Daily: every enabled company with a bound group gets the alert if it changed.
async function runDaily(base = '') {
  const [rows] = await pool.query(`SELECT company_id FROM company_line WHERE enabled = 1 AND group_id IS NOT NULL AND access_token_enc IS NOT NULL`);
  for (const { company_id } of rows) {
    try { await sendAlert(company_id, { base }); } catch (err) { console.error(`LINE alert failed (company ${company_id}):`, err.message); }
  }
}

module.exports = { publicView, save, unbindGroup, verifySignature, handleWebhook, sendAlert, sendTest, flaggedBranches, statusText, alertMessages, runDaily };
