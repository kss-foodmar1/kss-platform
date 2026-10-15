// LINE bot for executive groups. Each company brings its own LINE Official
// Account (channel secret + access token, stored encrypted); KSS never holds a
// shared bot. The bot binds to the first group that talks to it, sends the
// "branches to check" alert from the branch purchase audit (lib/ckAudit.js)
// when that list changes, and answers "สถานะ" in the bound group.
//
// Reply messages (answering someone) are free on LINE; push messages count
// toward the OA's monthly quota — so a finding is sent again only when it is new
// or worse (lib/alerts.js keeps what was sent).
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
    watchers: await watcherView(companyId),
  };
}

async function watcherView(companyId) {
  const alerts = require('./alerts');
  const set = await alerts.settings(companyId);
  return alerts.ORDER.map((k) => ({ key: k, name: alerts.WATCHERS[k].name, cadence: alerts.WATCHERS[k].cadence, defaults: alerts.WATCHERS[k].defaults, ...set[k] }));
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
  // A new group has seen nothing yet.
  await pool.query(`UPDATE alert_events SET sent_sig = NULL WHERE company_id = ?`, [companyId]);
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

// ---------- the daily digest (all alert widgets) ----------
const THAI_MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const dateLabel = (iso) => {
  const [y, m, d] = String(iso).split('-');
  if (!m) return iso;
  return d ? `${Number(d)} ${THAI_MONTH[Number(m) - 1]} ${Number(y) + 543}` : `${THAI_MONTH[Number(m) - 1]} ${Number(y) + 543}`;
};
const baht = (n) => '฿' + Math.round(Number(n) || 0).toLocaleString('en-US');

// Runs the watchers and returns what is open today. lineOnly: only the ones
// switched on for LINE in Admin.
async function current(companyId, { lineOnly = false } = {}) {
  const alerts = require('./alerts');
  const set = await alerts.settings(companyId);
  const items = [], notes = [], checked = [];
  for (const key of alerts.ORDER) {
    if (lineOnly && !set[key].line) continue;
    const w = alerts.WATCHERS[key];
    checked.push(w.name);
    let note = '';
    try { note = (await alerts.evaluate(companyId, key)).note; } catch (err) { console.error(`watcher ${key} failed (company ${companyId}):`, err.message); note = 'ตรวจไม่สำเร็จ'; }
    if (note) notes.push(`${w.name}: ${note}`);
    (await alerts.history(companyId, key)).filter((r) => r.is_active).forEach((r) => items.push({ ...r, watcher_name: w.name }));
  }
  items.sort((x, y) => y.rank - x.rank);
  return { items, notes, checked, today: alerts.bkkToday() };
}

const PER_WATCHER = 3;
function tailOf(r) {
  if (r.watcher === 'price') return `สูงกว่าปกติ ${r.change_pct}% · จ่ายเกิน ${baht(r.impact)}`;
  if (r.age_days !== null && r.age_days !== undefined) return `ค้าง ${r.age_days} วัน · มูลค่า ${baht(r.impact)}`;
  return `ผลกระทบโดยประมาณ ${baht(r.impact)}`;
}
function itemBox(r) {
  return {
    type: 'box', layout: 'vertical', spacing: 'xs', margin: 'md', contents: [
      { type: 'text', text: r.subject || r.branch || '-', weight: 'bold', size: 'sm', wrap: true },
      { type: 'text', text: r.detail || '', size: 'xs', color: '#555555', wrap: true },
      { type: 'text', text: tailOf(r), size: 'xs', color: r.severity === 'สูง' || r.severity === 'วิกฤต' ? '#B42318' : '#B54708', wrap: true },
    ],
  };
}
// One section per watcher that has something new or worse. A "summary"
// watcher (stale PO/SO — there can be dozens) shows the whole open count and
// value, then its oldest few; the others list what changed.
function sectionsFor(send, open) {
  const alerts = require('./alerts');
  const out = [];
  alerts.ORDER.forEach((key) => {
    const w = alerts.WATCHERS[key];
    const changed = send.filter((r) => r.watcher === key);
    if (!changed.length) return;
    if (w.digest === 'summary') {
      const all = open.filter((r) => r.watcher === key);
      const value = all.reduce((t, r) => t + (Number(r.impact) || 0), 0);
      const oldest = Math.max(...all.map((r) => r.age_days || 0));
      out.push({ type: 'text', text: `${w.name}: ${all.length} ใบ · ${baht(value)} · เก่าสุด ${oldest} วัน`, weight: 'bold', size: 'xs', color: '#777777', margin: 'lg', wrap: true });
      all.slice(0, PER_WATCHER).forEach((r) => out.push(itemBox(r)));
      if (all.length > PER_WATCHER) out.push({ type: 'text', text: `และอีก ${all.length - PER_WATCHER} ใบใน Dashboard`, size: 'xxs', color: '#777777', margin: 'sm' });
    } else {
      out.push({ type: 'text', text: `${w.name} (${changed.length})`, weight: 'bold', size: 'xs', color: '#777777', margin: 'lg', wrap: true });
      changed.slice(0, PER_WATCHER).forEach((r) => out.push(itemBox(r)));
      if (changed.length > PER_WATCHER) out.push({ type: 'text', text: `และอีก ${changed.length - PER_WATCHER} เรื่องใน Dashboard`, size: 'xxs', color: '#777777', margin: 'sm' });
    }
  });
  return out;
}
function digestMessages(send, { today, open = send, dashUrl, company }) {
  const bubble = {
    type: 'bubble',
    header: { type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: 'สิ่งที่ควรดูวันนี้', weight: 'bold', size: 'lg' },
      { type: 'text', text: `${company ? company + ' · ' : ''}${dateLabel(today)} · ${send.length} เรื่องใหม่หรือแย่ลง`, size: 'xs', color: '#777777', wrap: true },
    ] },
    body: { type: 'box', layout: 'vertical', contents: [
      ...sectionsFor(send, open),
      { type: 'text', text: [open.length > send.length ? `ยังเปิดอยู่อีก ${open.length - send.length} เรื่องที่แจ้งไปแล้ว` : '', 'เป็นสัญญาณให้ตรวจสอบ ไม่ใช่ข้อสรุป'].filter(Boolean).join(' · '), size: 'xxs', color: '#777777', wrap: true, margin: 'lg' },
    ] },
  };
  if (/^https:\/\//.test(dashUrl || '')) {
    bubble.footer = { type: 'box', layout: 'vertical', contents: [{ type: 'button', style: 'primary', color: '#C2410C', action: { type: 'uri', label: 'ดูใน Dashboard', uri: dashUrl } }] };
  }
  const alt = `สิ่งที่ควรดูวันนี้ ${send.length} เรื่อง: ${send.slice(0, 4).map((r) => r.subject || r.branch).join(', ')}`;
  return [{ type: 'flex', altText: alt.slice(0, 400), contents: bubble }];
}

// Text answer to "สถานะ" in the group: every watcher, a count and the top few.
async function statusFor(companyId) {
  const alerts = require('./alerts');
  const { items, notes, checked, today } = await current(companyId);
  if (!items.length) {
    return [`${dateLabel(today)}: ไม่มีเรื่องผิดปกติ`, `ตรวจแล้ว: ${checked.join(', ')}`, ...notes].join('\n');
  }
  const lines = [`${dateLabel(today)}: มี ${items.length} เรื่องที่ควรดู`];
  alerts.ORDER.forEach((key) => {
    const mine = items.filter((r) => r.watcher === key);
    if (!mine.length) return;
    lines.push('', `${alerts.WATCHERS[key].name} (${mine.length})`);
    mine.slice(0, PER_WATCHER).forEach((r) => lines.push(`• ${r.subject || r.branch} — ${r.detail}`));
    if (mine.length > PER_WATCHER) lines.push(`และอีก ${mine.length - PER_WATCHER} ใน Dashboard`);
  });
  return [...lines, ...(notes.length ? ['', ...notes] : [])].join('\n');
}

// Sends the digest to the bound group: only findings that are new or got
// worse since they were last sent. force: everything open now (Admin button).
async function sendAlert(companyId, { force = false, base = '' } = {}) {
  const r = await get(companyId);
  if (!r || !r.channel_secret_enc || !r.access_token_enc) throw bad('ยังไม่ได้ใส่ Channel secret / Access token');
  if (!r.group_id) throw bad('ยังไม่ได้ผูกกลุ่ม LINE — เชิญบอทเข้ากลุ่มแล้วพิมพ์ข้อความ 1 ข้อความ');
  const { items, today } = await current(companyId, { lineOnly: true });
  const send = force ? items : items.filter((i) => i.sent_sig !== i.sig);
  const token = decrypt(r.access_token_enc);
  if (!send.length) {
    if (!force) return { sent: false, reason: items.length ? 'ไม่มีเรื่องใหม่ (เรื่องที่เปิดอยู่แจ้งไปแล้ว)' : 'ไม่มีเรื่องผิดปกติ' };
    await push(token, r.group_id, [{ type: 'text', text: `${dateLabel(today)}: ไม่มีเรื่องผิดปกติจากตัวเตือนที่เปิดไว้` }]);
  } else {
    const [[co]] = await pool.query(`SELECT name FROM companies WHERE id = ?`, [companyId]);
    await push(token, r.group_id, digestMessages(send, { today, open: items, dashUrl: base ? `${base}/` : '', company: co && co.name }));
    await require('./alerts').markSent(companyId, send);
  }
  await pool.query(`UPDATE company_line SET last_sent_at = NOW() WHERE company_id = ?`, [companyId]);
  return { sent: true, count: send.length, flagged: send.length };
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
        try { text = await statusFor(r.company_id); } catch (err) { console.error('LINE status failed:', err.message); text = 'ดึงข้อมูลไม่สำเร็จ ลองใหม่อีกครั้งภายหลัง'; }
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

module.exports = { ensure, publicView, save, unbindGroup, verifySignature, handleWebhook, sendAlert, sendTest, statusFor, current, digestMessages, runDaily };
