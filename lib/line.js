// LINE bot for executive groups. Two modes per company:
//   own    — the company brings its own LINE Official Account (channel secret + access
//            token, stored encrypted); the bot binds to the first group that talks to it.
//   shared — KSS pays for and owns ONE Official Account for all companies (secret and token in
//            env LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN, never in the database). One
//            webhook; a group is tied to a company by typing "ผูก <รหัส>" with the code shown
//            in that company's Admin page. The OA-wide quota and each company's use are counted.
// The bot sends the
// "branches to check" alert from the branch purchase audit (lib/ckAudit.js)
// when that list changes, and answers "สถานะ" in the bound group.
//
// Reply messages (answering someone) are free on LINE; push messages count
// toward the OA's monthly quota — so a finding is sent again only when it is new
// or worse (lib/alerts.js keeps what was sent).
const crypto = require('crypto');
const pool = require('../db/pool');
const { encrypt, decrypt, mask } = require('./crypto');

// ---------- KSS's shared Official Account (mode 'shared') ----------
const sharedKeys = () => ({ secret: process.env.LINE_CHANNEL_SECRET || '', token: process.env.LINE_CHANNEL_ACCESS_TOKEN || '' });
const sharedReady = () => { const k = sharedKeys(); return !!(k.secret && k.token); };
// Messages per month in KSS's OA plan (Free 300, Basic 15,000, Pro 35,000 …): set LINE_MONTHLY_QUOTA to the plan.
const sharedLimit = () => Math.max(1, Number(process.env.LINE_MONTHLY_QUOTA) || 300);
const isShared = (r) => !!r && r.mode === 'shared';
// The token a company's messages go out with, or null when it has none.
const tokenOf = (r) => (isShared(r) ? sharedKeys().token || null : r.access_token_enc ? decrypt(r.access_token_enc) : null);
const hasKeys = (r) => (isShared(r) ? sharedReady() : !!(r.channel_secret_enc && r.access_token_enc));
const BIND_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const BIND_TTL_DAYS = 3;

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

// A company still exploring on sample data (KSS's own demo companies excepted):
// nothing goes to its LINE group until it is on real data.
async function onSampleData(companyId) {
  const [[c]] = await pool.query(`SELECT data_source, status FROM companies WHERE id = ?`, [companyId]);
  return !!c && c.data_source === 'demo' && c.status !== 'demo';
}

// What the Admin screen sees: never the secrets, only whether they are set.
async function publicView(companyId, baseUrl) {
  const r = await ensure(companyId);
  const sec = r.channel_secret_enc ? decrypt(r.channel_secret_enc) : '';
  const tok = r.access_token_enc ? decrypt(r.access_token_enc) : '';
  const shared = isShared(r);
  return {
    mode: shared ? 'shared' : 'own',
    shared_available: sharedReady(),
    ...(shared ? await bindView(r) : {}),
    webhook_url: shared ? `${baseUrl}/api/webhooks/line` : `${baseUrl}/api/webhooks/line/${r.webhook_key}`,
    has_secret: !!sec, secret_hint: sec ? mask(sec) : '',
    has_token: !!tok, token_hint: tok ? mask(tok) : '',
    group_bound: !!r.group_id, enabled: !!r.enabled,
    last_sent_at: r.last_sent_at, ready: hasKeys(r),
    last_event_at: r.last_event_at, last_event_note: r.last_event_note || '',
    watchers: await watcherView(companyId),
    summaries: await require('./lineSummary').view(companyId),
    quota: shared ? await sharedQuotaView(r) : quotaView(r),
    sample: await onSampleData(companyId),
  };
}

async function watcherView(companyId) {
  const alerts = require('./alerts');
  const set = await alerts.settings(companyId);
  return alerts.ORDER.map((k) => ({ key: k, name: alerts.WATCHERS[k].name, cadence: alerts.WATCHERS[k].cadence, defaults: alerts.WATCHERS[k].defaults, ...set[k] }));
}

// The code a group types to tie itself to this company (shared mode). Valid for a few days, one use.
async function newBindCode(companyId) {
  let code = '';
  for (let k = 0; k < 8; k++) code += BIND_ALPHABET[crypto.randomInt(BIND_ALPHABET.length)];
  await pool.query(`UPDATE company_line SET bind_code = ?, bind_code_expires = DATE_ADD(NOW(), INTERVAL ${BIND_TTL_DAYS} DAY) WHERE company_id = ?`, [code, companyId]);
  return code;
}
async function bindView(r) {
  if (r.group_id) return { bind_code: '', bind_expires: null };
  let code = r.bind_code, exp = r.bind_code_expires;
  if (!code || !exp || new Date(exp) <= new Date()) {
    code = await newBindCode(r.company_id);
    exp = (await get(r.company_id)).bind_code_expires;
  }
  return { bind_code: code, bind_expires: exp };
}
// Switch between the company's own OA and KSS's shared one. A group belongs to one bot, so the
// binding (and what was sent to it) starts over.
async function setMode(companyId, mode) {
  if (mode !== 'own' && mode !== 'shared') throw bad('โหมด LINE ไม่ถูกต้อง');
  const r = await ensure(companyId);
  if (mode === 'shared' && !sharedReady()) throw bad('ยังไม่ได้ตั้ง LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN ของ OA กลางของ KSS ใน Railway Variables', 409);
  if ((r.mode || 'own') === mode) return;
  await unbindGroup(companyId);
  await pool.query(`UPDATE company_line SET mode = ?, bind_code = NULL, bind_code_expires = NULL, enabled = 0 WHERE company_id = ?`, [mode, companyId]);
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

// KSS-wide: the shared OA's plan against what each company used this month (for Admin and for billing).
async function sharedUsage() {
  const month = monthOf();
  const [rows] = await pool.query(
    `SELECT c.id, c.name, COALESCE(u.messages, 0) AS messages, l.group_id IS NOT NULL AS bound, l.enabled
     FROM company_line l JOIN companies c ON c.id = l.company_id LEFT JOIN line_usage u ON u.company_id = c.id AND u.month = ?
     WHERE l.mode = 'shared' ORDER BY messages DESC, c.name`, [month]);
  const used = await sharedUsed(month);
  return { month, configured: sharedReady(), limit: sharedLimit(), used, companies: rows.map((x) => ({ id: x.id, name: x.name, messages: Number(x.messages), bound: !!x.bound, enabled: !!x.enabled })) };
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
// ---------- monthly quota ----------
// A push to a group is billed once per member. We count it ourselves (LINE's own counter is only
// readable per channel), warn at 80% and stop the routine digest at 100% — a critical one still goes.
const monthOf = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 7);
async function groupMembers(token, groupId) {
  try {
    const res = await fetch(`${API()}/v2/bot/group/${encodeURIComponent(groupId)}/members/count`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const n = Number((await res.json()).count);
    return n > 0 ? n : null;
  } catch (e) { return null; }
}
function quotaView(r) {
  const used = r.quota_month === monthOf() ? r.quota_used : 0;
  const limit = r.monthly_quota || 300;
  return { used, limit, members: r.members || null, pct: Math.min(999, Math.round((used / limit) * 100)), month: monthOf(), warn: used / limit >= 0.8, full: used >= limit };
}
// Shared OA: the plan's quota is one pool for every company, so the check is on the pool; each
// company's own counter (monthly_quota, set by KSS) keeps one company from eating all of it.
async function sharedUsed(month = monthOf()) {
  const [[t]] = await pool.query(`SELECT COALESCE(SUM(messages), 0) AS n FROM line_usage WHERE month = ?`, [month]);
  return Number(t.n) || 0;
}
async function sharedQuotaView(r) {
  const month = monthOf();
  const [[m]] = await pool.query(`SELECT COALESCE(SUM(messages), 0) AS n FROM line_usage WHERE month = ? AND company_id = ?`, [month, r.company_id]);
  const pool_used = await sharedUsed(month), pool_limit = sharedLimit();
  const used = Number(m.n) || 0, limit = r.monthly_quota || 300;
  return { shared: true, used, limit, members: r.members || null, pct: Math.min(999, Math.round((used / limit) * 100)), month,
    pool_used, pool_limit, warn: used / limit >= 0.8 || pool_used / pool_limit >= 0.8, full: used >= limit || pool_used >= pool_limit };
}
async function chargeQuota(companyId, r, cost) {
  const month = monthOf();
  if (isShared(r)) await pool.query(`INSERT INTO line_usage (month, company_id, messages) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE messages = messages + VALUES(messages)`, [month, companyId, cost]);
  await pool.query(
    `UPDATE company_line SET quota_used = IF(quota_month = ?, quota_used, 0) + ?, quota_month = ?, members = ? WHERE company_id = ?`,
    [month, cost, month, cost, companyId]
  );
}
const push = (token, to, messages) => call(token, '/v2/bot/message/push', { to, messages });
// A Flex message can be refused (size, a bad field). The digest must still arrive: fall back to plain text.
async function pushFlexOrText(token, to, messages, textFallback) {
  try { await push(token, to, messages); } catch (err) {
    if (!/ 400/.test(err.message)) throw err;
    console.error('LINE flex refused, sending plain text:', err.message);
    await push(token, to, [{ type: 'text', text: textFallback.slice(0, 4900) }]);
  }
}
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
// ---------- card design ----------
// A carousel: the first card is the morning at a glance (severity tiles, yesterday's numbers, what
// each next card holds); then one card per watcher, its items as rows with a severity bar. Each
// card is short enough to read without scrolling, and swiping moves topic to topic.
const C = {
  brand: '#1D4ED8', ink: '#101828', sub: '#475467', muted: '#98A2B3', line: '#EAECF0', tile: '#F2F4F7',
  sev: { 'วิกฤต': ['#B42318', '#FEE4E2'], 'สูง': ['#C4320A', '#FFEAD5'], 'กลาง': ['#B54708', '#FEF0C7'], 'ต่ำ': ['#475467', '#F2F4F7'] },
};
const sevOf = (r) => C.sev[r.severity] || C.sev['ต่ำ'];
const clip = (t, n) => { const x = String(t || ''); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
// "SO-30092026-3979 · ร้านเดโม สาขา สยาม - สาขา สยาม" → document number on one line, who on the next.
function splitSubject(r) {
  const s = String(r.subject || r.branch || '-');
  const k = s.indexOf(' · ');
  if (k < 0) return [s, ''];
  let who = s.slice(k + 3);
  const parts = who.split(' - ');
  if (parts.length === 2 && parts[0].includes(parts[1].replace(/^สาขา\s*/, ''))) who = parts[1]; // "ร้านเดโม สาขา สยาม - สาขา สยาม"
  return [s.slice(0, k), who];
}
function itemRow(r, first) {
  const [color] = sevOf(r);
  const [head, who] = splitSubject(r);
  const aged = r.age_days !== null && r.age_days !== undefined;
  const meta = aged
    ? [who, `ค้าง ${r.age_days} วัน`].filter(Boolean).join(' · ')
    : r.watcher === 'price' ? [who, `แพงขึ้น ${r.change_pct}%`, clip(r.detail, 60)].filter(Boolean).join(' · ') : clip(r.detail, 90);
  return {
    type: 'box', layout: 'horizontal', spacing: 'md', margin: first ? 'none' : 'lg', contents: [
      { type: 'box', layout: 'vertical', width: '4px', backgroundColor: color, cornerRadius: '2px', contents: [{ type: 'filler' }] },
      { type: 'box', layout: 'vertical', flex: 1, spacing: 'xs', contents: [
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: clip(head, 40), size: 'sm', weight: 'bold', color: C.ink, flex: 1, wrap: true, maxLines: 2 },
          { type: 'text', text: baht(r.impact), size: 'sm', weight: 'bold', color, align: 'end', flex: 0 },
        ] },
        { type: 'text', text: meta || ' ', size: 'xs', color: C.sub, wrap: true, maxLines: 2 },
      ] },
    ],
  };
}
function chip(text, color, bg) {
  return { type: 'box', layout: 'vertical', backgroundColor: bg, cornerRadius: '12px', paddingStart: '8px', paddingEnd: '8px', paddingTop: '2px', paddingBottom: '2px', flex: 0, contents: [{ type: 'text', text, size: 'xxs', color, weight: 'bold' }] };
}
const button = (label, uri) => (/^https:\/\//.test(uri || '') ? { type: 'box', layout: 'vertical', paddingAll: '12px', paddingTop: '0px', contents: [{ type: 'button', style: 'primary', color: C.brand, height: 'sm', action: { type: 'uri', label, uri } }] } : undefined);
const linkFor = (dashUrl, key) => (dashUrl ? `${dashUrl}${dashUrl.includes('?') ? '&' : '?'}w=${key}` : '');

// What each watcher card holds; the summary card lists the same rows as its table of contents.
function sectionData(send, open) {
  const alerts = require('./alerts');
  return alerts.ORDER.map((key) => {
    const w = alerts.WATCHERS[key];
    const changed = send.filter((r) => r.watcher === key);
    if (!changed.length) return null;
    const all = open.filter((r) => r.watcher === key);
    const list = w.digest === 'summary' ? all : changed;
    const value = list.reduce((t, r) => t + (Number(r.impact) || 0), 0);
    const unit = w.digest === 'summary' ? 'ใบ' : 'เรื่อง';
    const line = w.digest === 'summary'
      ? `${w.name}: ${all.length} ใบ · ${baht(value)} · เก่าสุด ${Math.max(...all.map((r) => r.age_days || 0))} วัน`
      : `${w.name} (${changed.length})`;
    const oldest = w.digest === 'summary' ? Math.max(...all.map((r) => r.age_days || 0)) : 0;
    return { key, name: w.name, list, value, unit, line, oldest, worst: list.reduce((m, r) => (['วิกฤต', 'สูง', 'กลาง'].indexOf(r.severity) >= 0 && (m === null || ['วิกฤต', 'สูง', 'กลาง'].indexOf(r.severity) < ['วิกฤต', 'สูง', 'กลาง'].indexOf(m)) ? r.severity : m), null) };
  }).filter(Boolean);
}
// Kept for the old single-card shape (statusFor and tests read the section line text).
function sectionsFor(send, open) {
  return sectionData(send, open).map((d) => ({ type: 'text', text: d.line }));
}

// "เมื่อวาน" in numbers: the families the company ticked in Admin (lib/lineSummary.js).
const dailyNumbers = (companyId, today) => require('./lineSummary').numbers(companyId, today);
function numberTiles(nums) {
  if (!nums || !nums.length) return [];
  const tile = (n) => ({ type: 'box', layout: 'vertical', flex: 1, backgroundColor: C.tile, cornerRadius: '10px', paddingAll: '10px', spacing: 'xs', contents: [
    { type: 'text', text: n.label.replace(/เมื่อวาน$/, ''), size: 'xxs', color: C.sub, wrap: true, maxLines: 2 },
    { type: 'text', text: n.value, size: 'lg', weight: 'bold', color: C.ink },
    ...(n.sub ? [{ type: 'text', text: n.sub, size: 'xxs', color: n.tone === 'good' ? '#067647' : n.tone === 'bad' ? '#B42318' : C.sub, weight: n.tone ? 'bold' : 'regular', wrap: true, maxLines: 2 }] : []),
    ...(n.note ? [{ type: 'text', text: n.note, size: 'xxs', color: C.sub, wrap: true, maxLines: 2 }] : []),
  ] });
  const rows = [];
  for (let k = 0; k < nums.length; k += 2) {
    const pair = nums.slice(k, k + 2).map(tile);
    if (pair.length === 1) pair.push({ type: 'filler' });
    rows.push({ type: 'box', layout: 'horizontal', spacing: 'sm', margin: k ? 'sm' : 'none', contents: pair });
  }
  return [{ type: 'text', text: 'เมื่อวาน', size: 'xs', weight: 'bold', color: C.sub, margin: 'xl' }, { type: 'box', layout: 'vertical', margin: 'sm', contents: rows }];
}
function severityTiles(list) {
  const t = ['วิกฤต', 'สูง', 'กลาง'].map((k) => [k, list.filter((r) => r.severity === k).length]);
  if (!t.some(([, n]) => n)) return [];
  return [{ type: 'box', layout: 'horizontal', spacing: 'sm', contents: t.map(([k, n]) => ({
    type: 'box', layout: 'vertical', flex: 1, cornerRadius: '10px', paddingAll: '8px', backgroundColor: n ? C.sev[k][1] : C.tile, contents: [
      { type: 'text', text: String(n), size: 'xl', weight: 'bold', align: 'center', color: n ? C.sev[k][0] : C.muted },
      { type: 'text', text: k, size: 'xxs', align: 'center', color: n ? C.sev[k][0] : C.muted },
    ] })) }];
}
function digestMessages(send, { today, open = send, dashUrl, company, numbers }) {
  const sections = sectionData(send, open);
  const impactTotal = open.reduce((t, r) => t + (Number(r.impact) || 0), 0);
  const toc = sections.map((d, k) => ({ type: 'box', layout: 'horizontal', margin: k ? 'md' : 'none', spacing: 'sm', contents: [
    { type: 'box', layout: 'vertical', width: '8px', height: '8px', cornerRadius: '4px', offsetTop: '5px', backgroundColor: d.worst ? C.sev[d.worst][0] : C.muted, contents: [{ type: 'filler' }] },
    { type: 'text', text: d.name, size: 'sm', color: C.ink, flex: 1, wrap: true },
    { type: 'text', text: `${d.list.length} ${d.unit}`, size: 'sm', color: C.sub, flex: 0 },
  ] }));
  const notes = [send.length && open.length > send.length ? `ยังเปิดอยู่อีก ${open.length - send.length} เรื่องที่แจ้งไปแล้ว` : '', 'เป็นสัญญาณให้ตรวจสอบ ไม่ใช่ข้อสรุป'].filter(Boolean).join(' · ');
  const cover = {
    type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', backgroundColor: C.brand, paddingAll: '16px', spacing: 'xs', contents: [
      { type: 'text', text: send.length ? 'สิ่งที่ควรดูวันนี้' : 'สรุปเมื่อวาน', weight: 'bold', size: 'xl', color: '#FFFFFF' },
      { type: 'text', text: [company, dateLabel(today)].filter(Boolean).join(' · '), size: 'xs', color: '#DBEAFE', wrap: true },
    ] },
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', contents: [
      ...severityTiles(open),
      ...(send.length ? [{ type: 'text', text: `${send.length} เรื่องใหม่หรือแย่ลง${impactTotal > 0 ? ` · มูลค่าที่เกี่ยวข้อง ${baht(impactTotal)}` : ''}`, size: 'xs', color: C.sub, margin: 'md', wrap: true }]
        : [{ type: 'text', text: open.length ? `ไม่มีเรื่องใหม่ · ยังเปิดอยู่ ${open.length} เรื่องที่แจ้งไปแล้ว` : 'ไม่มีเรื่องผิดปกติ', size: 'xs', color: C.sub, wrap: true, margin: 'md' }]),
      ...(sections.length ? [] : numberTiles(numbers)),
      ...(toc.length ? [{ type: 'separator', margin: 'xl', color: C.line }, { type: 'text', text: 'ปัดดูทีละหัวข้อ →', size: 'xs', weight: 'bold', color: C.sub, margin: 'lg' }, { type: 'box', layout: 'vertical', margin: 'md', contents: toc }] : []),
      { type: 'text', text: notes, size: 'xxs', color: C.muted, wrap: true, margin: 'xl' },
    ] },
  };
  const fb = button('เปิด Dashboard', dashUrl);
  if (fb) cover.footer = fb;
  const cards = sections.map((d) => {
    const shown = d.list.slice(0, 4);
    const [color, bg] = d.worst ? C.sev[d.worst] : [C.sub, C.tile];
    const card = {
      type: 'bubble', size: 'mega',
      header: { type: 'box', layout: 'vertical', backgroundColor: bg, paddingAll: '14px', spacing: 'sm', contents: [
        { type: 'text', text: d.name, weight: 'bold', size: 'md', color: C.ink, wrap: true },
        { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [chip(`${d.list.length} ${d.unit}`, color, '#FFFFFF'), chip(baht(d.value), color, '#FFFFFF'), { type: 'filler' }] },
        ...(d.oldest ? [{ type: 'text', text: `เก่าสุด ${d.oldest} วัน`, size: 'xxs', color: C.sub }] : []),
      ] },
      body: { type: 'box', layout: 'vertical', paddingAll: '14px', contents: [
        ...shown.flatMap((r, k) => [...(k ? [{ type: 'separator', margin: 'lg', color: C.line }] : []), itemRow(r, !k)]),
        ...(d.list.length > shown.length ? [{ type: 'text', text: `และอีก ${d.list.length - shown.length} ${d.unit}ใน Dashboard`, size: 'xs', color: C.sub, margin: 'xl', align: 'center' }] : []),
      ] },
    };
    const b = button('ดูทั้งหมด', linkFor(dashUrl, d.key));
    if (b) card.footer = b;
    return card;
  });
  // Yesterday's numbers get their own card next to the cover, so the cover stays as short as the
  // topic cards (a carousel stretches every card to the tallest one).
  if (sections.length && numbers && numbers.length) {
    const tiles = numberTiles(numbers).slice(1); // drop the "เมื่อวาน" caption; the header says it
    cards.unshift({ type: 'bubble', size: 'mega',
      header: { type: 'box', layout: 'vertical', backgroundColor: C.tile, paddingAll: '14px', spacing: 'xs', contents: [
        { type: 'text', text: 'ตัวเลขเมื่อวาน', weight: 'bold', size: 'md', color: C.ink },
        { type: 'text', text: 'เทียบเฉลี่ย 7 วันก่อนหน้า', size: 'xxs', color: C.sub },
      ] },
      body: { type: 'box', layout: 'vertical', paddingAll: '14px', contents: tiles } });
  }
  const contents = cards.length ? { type: 'carousel', contents: [cover, ...cards].slice(0, 12) } : cover;
  // The notification preview shows altText: say what each card holds.
  const altLines = sections.map((d) => d.line).join(' | ');
  const alt = !send.length ? `สรุปเมื่อวาน ${(numbers || []).map((n) => `${n.label} ${n.value}`).join(' · ')}` : `สิ่งที่ควรดูวันนี้ ${send.length} เรื่อง — ${altLines}`;
  return [{ type: 'flex', altText: alt.slice(0, 400), contents }];
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
  if (!r || !hasKeys(r)) throw bad(isShared(r) ? 'OA กลางของ KSS ยังไม่ได้ตั้งค่า (LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN)' : 'ยังไม่ได้ใส่ Channel secret / Access token');
  if (!r.group_id) throw bad(isShared(r) ? 'ยังไม่ได้ผูกกลุ่ม LINE — เชิญบอท KSS เข้ากลุ่ม แล้วพิมพ์ "ผูก <รหัส>" ในกลุ่ม' : 'ยังไม่ได้ผูกกลุ่ม LINE — เชิญบอทเข้ากลุ่มแล้วพิมพ์ข้อความ 1 ข้อความ');
  if (await onSampleData(companyId)) throw bad('บริษัทนี้ยังใช้ข้อมูลตัวอย่าง จึงยังไม่ส่งสรุปเข้ากลุ่ม LINE — จะส่งได้เมื่อสลับเป็นข้อมูลจริง');
  const { items, today } = await current(companyId, { lineOnly: true });
  const send = force ? items : items.filter((i) => i.sent_sig !== i.sig);
  const token = tokenOf(r);
  // Cost of one push = members of the group. Stop the routine digest when the month's quota is spent.
  // The daily numbers go out once a day, even when no alert is new.
  const numbers = await dailyNumbers(companyId, today);
  const numbersDue = numbers.length > 0 && r.summary_day !== today;
  const numsOut = numbersDue || force ? numbers : []; // once a day, unless Admin asks to send now
  if (!send.length && !force && !numbersDue) return { sent: false, reason: items.length ? 'ไม่มีเรื่องใหม่ (เรื่องที่เปิดอยู่แจ้งไปแล้ว)' : 'ไม่มีเรื่องผิดปกติ' };
  const members = (await groupMembers(token, r.group_id)) || r.members || 1;
  const q = isShared(r) ? await sharedQuotaView(r) : quotaView(r);
  const critical = send.some((i) => i.severity === 'วิกฤต');
  if (!force && q.used + members > q.limit && !critical) {
    return { sent: false, reason: `โควตา LINE เดือนนี้เต็มแล้ว (ใช้ ${q.used}/${q.limit}) — ข้ามการส่งประจำวัน`, quota: q };
  }
  // The shared OA has one plan for everybody: nothing is sent past it (LINE refuses it anyway), a critical one included.
  if (isShared(r) && q.pool_used + members > q.pool_limit) {
    return { sent: false, reason: `โควตา OA กลางของ KSS เดือนนี้เต็มแล้ว (${q.pool_used}/${q.pool_limit}) — ต้องอัปเกรดแพ็กเกจ LINE OA`, quota: q };
  }
  const [[co]] = await pool.query(`SELECT name FROM companies WHERE id = ?`, [companyId]);
  const dashUrl = base ? `${base}/?alerts=1` : '';
  if (send.length) {
    const plain = [`สิ่งที่ควรดูวันนี้ (${dateLabel(today)}) · ${send.length} เรื่อง`, ...send.slice(0, 12).map((r) => `• ${r.subject || r.branch} — ${tailOf(r)}`), send.length > 12 ? `และอีก ${send.length - 12} เรื่องใน Dashboard` : '', ...numsOut.map((n) => `${n.label}: ${n.value}${[n.sub, n.note].filter(Boolean).length ? ' (' + [n.sub, n.note].filter(Boolean).join(' · ') + ')' : ''}`), base ? `${base}/` : ''].filter(Boolean).join('\n');
    await pushFlexOrText(token, r.group_id, digestMessages(send, { today, open: items, dashUrl, company: co && co.name, numbers: numsOut }), plain);
    await require('./alerts').markSent(companyId, send);
  } else if (numbers.length) {
    const plain = [`สรุปเมื่อวาน (${dateLabel(today)})`, ...numbers.map((n) => `${n.label}: ${n.value}${[n.sub, n.note].filter(Boolean).length ? ' (' + [n.sub, n.note].filter(Boolean).join(' · ') + ')' : ''}`)].join('\n');
    await pushFlexOrText(token, r.group_id, digestMessages([], { today, open: items, dashUrl, company: co && co.name, numbers }), plain);
  } else {
    await push(token, r.group_id, [{ type: 'text', text: `${dateLabel(today)}: ไม่มีเรื่องผิดปกติจากตัวเตือนที่เปิดไว้` }]);
  }
  if (numsOut.length || (!send.length && numbers.length)) await pool.query(`UPDATE company_line SET summary_day = ? WHERE company_id = ?`, [today, companyId]);
  await pool.query(`UPDATE company_line SET last_sent_at = NOW() WHERE company_id = ?`, [companyId]);
  await chargeQuota(companyId, r, members);
  const after = await get(companyId);
  return { sent: true, count: send.length, flagged: send.length, quota: isShared(after) ? await sharedQuotaView(after) : quotaView(after) };
}
async function sendTest(companyId) {
  const r = await get(companyId);
  const token = r && tokenOf(r);
  if (!token) throw bad(isShared(r) ? 'OA กลางของ KSS ยังไม่ได้ตั้งค่า' : 'ยังไม่ได้ใส่ Access token');
  if (!r.group_id) throw bad('ยังไม่ได้ผูกกลุ่ม LINE — เชิญบอทเข้ากลุ่มแล้วพิมพ์ข้อความ 1 ข้อความ');
  await push(token, r.group_id, [{ type: 'text', text: 'ทดสอบจาก KSS Dashboard: บอทเชื่อมกับกลุ่มนี้แล้ว' }]);
  if (isShared(r)) await chargeQuota(companyId, r, (await groupMembers(token, r.group_id)) || r.members || 1);
}

// ---------- incoming webhook ----------
// What the webhook last did, shown in Admin: a silent bot is otherwise a mystery.
async function note(companyId, text) {
  try { await pool.query(`UPDATE company_line SET last_event_at = NOW(), last_event_note = ? WHERE company_id = ?`, [String(text).slice(0, 250), companyId]); } catch (e) { /* diagnostics only */ }
}

// One group event for the company it belongs to. Own mode: the first group that talks binds. Shared
// mode: the group is already bound (see handleSharedWebhook). Returns nothing; notes what happened.
async function handleEvent(r, token, ev, { bindFirst }) {
  const src = ev.source || {};
  if (src.type !== 'group' || !src.groupId) { await note(r.company_id, `ได้รับ event ${ev.type} จากแชท${src.type === 'user' ? 'ส่วนตัว' : src.type || ''} — บอทรับเฉพาะกลุ่ม`); return; }
  const bound = r.group_id;
  if (!bound && bindFirst && (ev.type === 'join' || ev.type === 'message')) {
    await pool.query(`UPDATE company_line SET group_id = ? WHERE company_id = ? AND group_id IS NULL`, [src.groupId, r.company_id]);
    r.group_id = src.groupId;
    if (!token) { await note(r.company_id, 'ผูกกลุ่มแล้ว แต่ยังไม่มี Access token จึงตอบไม่ได้ — ใส่ token แล้วพิมพ์ "สถานะ" ในกลุ่ม'); return; }
    if (ev.replyToken) await reply(token, ev.replyToken, [{ type: 'text', text: 'เชื่อมกับกลุ่มนี้แล้ว จากนี้จะแจ้งสาขาที่ควรตรวจสอบที่นี่ พิมพ์ "สถานะ" เพื่อดูสรุปได้ทุกเมื่อ' }]);
    await note(r.company_id, 'ผูกกลุ่มสำเร็จและตอบข้อความต้อนรับแล้ว');
    return;
  }
  if (bound !== src.groupId) { await note(r.company_id, 'ได้รับ event จากกลุ่มอื่นที่ไม่ใช่กลุ่มที่ผูกไว้ — เมิน'); return; }
  if (ev.type === 'message' && ev.message && ev.message.type === 'text') {
    const t = String(ev.message.text || '').trim();
    if (!/^(สถานะ|ตรวจสาขา|status)$/i.test(t)) { await note(r.company_id, 'ได้รับข้อความในกลุ่มที่ผูกไว้ (ไม่ใช่คำสั่ง "สถานะ")'); return; }
    if (!token) { await note(r.company_id, 'ได้รับ "สถานะ" แต่ยังไม่มี Access token'); return; }
    let text;
    try { text = await statusFor(r.company_id); } catch (err) { console.error('LINE status failed:', err.message); text = 'ดึงข้อมูลไม่สำเร็จ ลองใหม่อีกครั้งภายหลัง'; }
    await reply(token, ev.replyToken, [{ type: 'text', text }]);
    await note(r.company_id, 'ตอบ "สถานะ" ในกลุ่มแล้ว');
  }
}

// Returns the HTTP status to answer with. Group events only; a different group
// than the bound one is ignored (no data leaves to a group nobody chose).
async function handleWebhook(webhookKey, rawBody, signature, body) {
  const [[r]] = await pool.query(`SELECT * FROM company_line WHERE webhook_key = ? AND mode = 'own'`, [String(webhookKey).slice(0, 40)]);
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
    try { await handleEvent(r, token, ev, { bindFirst: true }); } catch (err) {
      console.error(`LINE webhook event failed (company ${r.company_id}):`, err.message);
      await note(r.company_id, `ตอบ LINE ไม่สำเร็จ: ${err.message}`);
    }
  }
  return 200;
}

// KSS's shared OA: ONE webhook for every company, signed with the one channel secret. The group in
// each event says which company it is (company_line.group_id). A group nobody has bound yet gets
// no data and no chatter: it can only type "ผูก <รหัส>" with the code from a company's Admin page.
const BIND_RE = /^(?:ผูก|bind)\s+([A-Za-z0-9]{6,12})$/i;
async function handleSharedWebhook(rawBody, signature, body) {
  const { secret, token } = sharedKeys();
  if (!secret || !token) { console.warn('LINE shared webhook: OA กลางยังไม่ได้ตั้งค่า'); return 404; }
  if (!verifySignature(rawBody, signature, secret)) return 401;
  const events = (body && body.events) || [];
  for (const ev of events) {
    try {
      const src = ev.source || {};
      if (src.type !== 'group' || !src.groupId) continue;
      const [[r]] = await pool.query(`SELECT * FROM company_line WHERE group_id = ? AND mode = 'shared'`, [src.groupId]);
      if (r) { await handleEvent(r, token, ev, { bindFirst: false }); continue; }
      const text = ev.type === 'message' && ev.message && ev.message.type === 'text' ? String(ev.message.text || '').trim() : '';
      const m = BIND_RE.exec(text);
      if (ev.type === 'join' && ev.replyToken) {
        await reply(token, ev.replyToken, [{ type: 'text', text: 'สวัสดีครับ นี่คือบอท KSS Dashboard พิมพ์ "ผูก <รหัส>" (รหัสอยู่ในหน้า Admin → LINE ของบริษัท) เพื่อเชื่อมกลุ่มนี้' }]);
      } else if (m && ev.replyToken) {
        const [[c]] = await pool.query(`SELECT * FROM company_line WHERE bind_code = ? AND mode = 'shared' AND group_id IS NULL AND bind_code_expires > NOW()`, [m[1].toUpperCase()]);
        if (!c) { await reply(token, ev.replyToken, [{ type: 'text', text: 'รหัสไม่ถูกต้องหรือหมดอายุแล้ว ขอรหัสใหม่ได้ในหน้า Admin → LINE' }]); continue; }
        const [res] = await pool.query(`UPDATE company_line SET group_id = ?, bind_code = NULL, bind_code_expires = NULL, last_alert_key = NULL WHERE company_id = ? AND group_id IS NULL`, [src.groupId, c.company_id]);
        if (!res.affectedRows) continue;
        await pool.query(`UPDATE alert_events SET sent_sig = NULL WHERE company_id = ?`, [c.company_id]);
        await reply(token, ev.replyToken, [{ type: 'text', text: 'เชื่อมกับกลุ่มนี้แล้ว จากนี้จะแจ้งสาขาที่ควรตรวจสอบที่นี่ พิมพ์ "สถานะ" เพื่อดูสรุปได้ทุกเมื่อ' }]);
        await note(c.company_id, 'ผูกกลุ่มสำเร็จด้วยรหัส (OA กลางของ KSS)');
      }
    } catch (err) { console.error('LINE shared webhook event failed:', err.message); }
  }
  return 200;
}

// Daily: every enabled company with a bound group gets the alert if it changed.
async function runDaily(base = '') {
  // A company still exploring on sample data gets no routine digest: sample
  // numbers in a real LINE group read as real. KSS's own demo companies
  // (status 'demo') keep theirs.
  const [rows] = await pool.query(
    `SELECT l.company_id FROM company_line l JOIN companies c ON c.id = l.company_id
     WHERE l.enabled = 1 AND l.group_id IS NOT NULL AND (l.access_token_enc IS NOT NULL OR l.mode = 'shared')
       AND (c.data_source <> 'demo' OR c.status = 'demo')`
  );
  for (const { company_id } of rows) {
    try { await sendAlert(company_id, { base }); } catch (err) { console.error(`LINE alert failed (company ${company_id}):`, err.message); }
  }
}

module.exports = { quotaView, sharedQuotaView, sharedReady, setMode, sharedUsage, handleSharedWebhook, dailyNumbers, ensure, publicView, save, unbindGroup, verifySignature, handleWebhook, sendAlert, sendTest, statusFor, current, digestMessages, runDaily };
