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
    summaries: await require('./lineSummary').view(companyId),
    quota: quotaView(r),
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
async function chargeQuota(companyId, r, cost) {
  const month = monthOf();
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
  if (!r || !r.channel_secret_enc || !r.access_token_enc) throw bad('ยังไม่ได้ใส่ Channel secret / Access token');
  if (!r.group_id) throw bad('ยังไม่ได้ผูกกลุ่ม LINE — เชิญบอทเข้ากลุ่มแล้วพิมพ์ข้อความ 1 ข้อความ');
  const { items, today } = await current(companyId, { lineOnly: true });
  const send = force ? items : items.filter((i) => i.sent_sig !== i.sig);
  const token = decrypt(r.access_token_enc);
  // Cost of one push = members of the group. Stop the routine digest when the month's quota is spent.
  // The daily numbers go out once a day, even when no alert is new.
  const numbers = await dailyNumbers(companyId, today);
  const numbersDue = numbers.length > 0 && r.summary_day !== today;
  const numsOut = numbersDue || force ? numbers : []; // once a day, unless Admin asks to send now
  if (!send.length && !force && !numbersDue) return { sent: false, reason: items.length ? 'ไม่มีเรื่องใหม่ (เรื่องที่เปิดอยู่แจ้งไปแล้ว)' : 'ไม่มีเรื่องผิดปกติ' };
  const members = (await groupMembers(token, r.group_id)) || r.members || 1;
  const q = quotaView(r);
  const critical = send.some((i) => i.severity === 'วิกฤต');
  if (!force && q.used + members > q.limit && !critical) {
    return { sent: false, reason: `โควตา LINE เดือนนี้เต็มแล้ว (ใช้ ${q.used}/${q.limit}) — ข้ามการส่งประจำวัน`, quota: q };
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
  return { sent: true, count: send.length, flagged: send.length, quota: quotaView(await get(companyId)) };
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
  // A company still exploring on sample data gets no routine digest: sample
  // numbers in a real LINE group read as real. KSS's own demo companies
  // (status 'demo') keep theirs.
  const [rows] = await pool.query(
    `SELECT l.company_id FROM company_line l JOIN companies c ON c.id = l.company_id
     WHERE l.enabled = 1 AND l.group_id IS NOT NULL AND l.access_token_enc IS NOT NULL
       AND (c.data_source <> 'demo' OR c.status = 'demo')`
  );
  for (const { company_id } of rows) {
    try { await sendAlert(company_id, { base }); } catch (err) { console.error(`LINE alert failed (company ${company_id}):`, err.message); }
  }
}

module.exports = { quotaView, dailyNumbers, ensure, publicView, save, unbindGroup, verifySignature, handleWebhook, sendAlert, sendTest, statusFor, current, digestMessages, runDaily };
