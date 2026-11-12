// Marketing budget vs actual, from two standard files a company uploads
// (templates: GET /api/marketing/template/budget|actual).
//
//   budget  month | channel | amount (baht)       one row per month × channel
//   actual  date  | channel | amount (baht) | note   one row per spend; several
//                                                    rows of the same day × channel add up
//
// Rules (so a re-upload never double counts):
//   - a file is checked whole: ONE bad row rejects the file with the row
//     numbers, nothing is half-saved — half a budget would make the % wrong.
//   - budget: a later file replaces the same month × channel.
//   - actual: a later file replaces the same day × channel (the latest total wins).
//   - deleting an upload removes the rows it last wrote.
//
// Output: the 'marketing' report source (lib/fmhCache.js, local). One row per
// day × channel with
//   budget_to_date  the month's budget spread evenly over its days (the last day
//                   takes the rounding), so any date range gets a fair share
//   month_budget    the whole month's budget, on the 1st only — summed over a
//                   range it is the budget of every month the range starts in
//   actual          spend that day
const pool = require('../db/pool');

const fmhCache = () => require('./fmhCache'); // lazy: fmhCache requires this file

const MAX_ROWS = 20000;
const MAX_ERRORS = 20;

const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// ---------- reading cells ----------

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[\s()（）[\]:.,_\-/฿*]/g, '');

const HEADERS = {
  budget: {
    month: ['เดือน', 'month', 'งบเดือน', 'period', 'เดือนที่'],
    channel: ['ช่องทาง', 'channel', 'ช่องทางการตลาด', 'platform', 'ประเภท'],
    amount: ['จำนวนเงินบาท', 'จำนวนเงิน', 'งบ', 'งบประมาณ', 'budget', 'amount', 'บาท'],
  },
  actual: {
    date: ['วันที่', 'date', 'spenddate', 'วันที่ใช้จ่าย'],
    channel: ['ช่องทาง', 'channel', 'ช่องทางการตลาด', 'platform', 'ประเภท'],
    amount: ['จำนวนเงินบาท', 'จำนวนเงิน', 'ใช้จริง', 'actual', 'amount', 'spend', 'cost', 'บาท'],
    note: ['หมายเหตุ', 'note', 'notes', 'remark', 'รายละเอียด'],
  },
};
const REQUIRED = { budget: ['month', 'channel', 'amount'], actual: ['date', 'channel', 'amount'] };
const ROLE_LABEL = { month: 'เดือน', date: 'วันที่', channel: 'ช่องทาง', amount: 'จำนวนเงิน (บาท)', note: 'หมายเหตุ' };

const THAI_MONTHS = [
  ['มกราคม', 'ม.ค.', 'มค', 'jan', 'january'], ['กุมภาพันธ์', 'ก.พ.', 'กพ', 'feb', 'february'], ['มีนาคม', 'มี.ค.', 'มีค', 'mar', 'march'],
  ['เมษายน', 'เม.ย.', 'เมย', 'apr', 'april'], ['พฤษภาคม', 'พ.ค.', 'พค', 'may'], ['มิถุนายน', 'มิ.ย.', 'มิย', 'jun', 'june'],
  ['กรกฎาคม', 'ก.ค.', 'กค', 'jul', 'july'], ['สิงหาคม', 'ส.ค.', 'สค', 'aug', 'august'], ['กันยายน', 'ก.ย.', 'กย', 'sep', 'sept', 'september'],
  ['ตุลาคม', 'ต.ค.', 'ตค', 'oct', 'october'], ['พฤศจิกายน', 'พ.ย.', 'พย', 'nov', 'november'], ['ธันวาคม', 'ธ.ค.', 'ธค', 'dec', 'december'],
];
const MONTH_WORD = new Map();
THAI_MONTHS.forEach((names, i) => names.forEach((n) => MONTH_WORD.set(norm(n), i + 1)));

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

function realDate(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 2000 || y > 2100) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return iso(y, m, d);
}
function fixYear(y) {
  if (y >= 2400) return y - 543; // Buddhist era
  if (y < 100) return 2000 + y;
  return y;
}
const fromSerial = (n) => {
  if (!(n > 20000 && n < 80000)) return null;
  const t = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};

// A date cell: Excel date (number), 2026-11-05, 5/11/2026 (day first), 5/11/69 or a Buddhist year.
function parseDate(v) {
  if (typeof v === 'number') return fromSerial(v);
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (/^\d{5}(\.\d+)?$/.test(s)) return fromSerial(Number(s));
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(s);
  if (m) return realDate(fixYear(Number(m[1])), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ T].*)?$/.exec(s);
  if (m) return realDate(fixYear(Number(m[3])), Number(m[2]), Number(m[1]));
  return null;
}

// A month cell: 2026-11, 11/2026, พ.ย. 2569, November 2026, or any full date (its month).
function parseMonth(v) {
  if (typeof v === 'number') {
    const d = fromSerial(v);
    return d ? d.slice(0, 7) + '-01' : null;
  }
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  const full = parseDate(s);
  if (full) return full.slice(0, 7) + '-01';
  let m = /^(\d{4})[-/.](\d{1,2})$/.exec(s);
  if (m) return realDate(fixYear(Number(m[1])), Number(m[2]), 1);
  m = /^(\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return realDate(fixYear(Number(m[2])), Number(m[1]), 1);
  m = /^(.*?)[\s\-/.]*(\d{2,4})$/.exec(s);
  if (m && MONTH_WORD.has(norm(m[1]))) return realDate(fixYear(Number(m[2])), MONTH_WORD.get(norm(m[1])), 1);
  return null;
}

// An amount cell in baht: 12345, "12,345.50", "฿ 1,200", "1200 บาท". Never negative.
function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v == null ? '' : v).replace(/[฿,\s]|บาท/g, '');
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}
const cents = (baht) => Math.round(baht * 100);

// Same channel written differently is one channel.
const CHANNEL_ALIASES = [
  ['Meta', ['meta', 'facebook', 'fb', 'instagram', 'ig', 'metaads', 'facebookads', 'fbads', 'เฟซบุ๊ก', 'เฟซบุ๊ค', 'เฟสบุ๊ก', 'เมต้า']],
  ['TikTok', ['tiktok', 'tiktokads', 'ติ๊กต็อก', 'ติ๊กตอก', 'ติ๊กต๊อก', 'ติ๊กต็อค']],
  ['Google Ads', ['google', 'googleads', 'adwords', 'googleadwords', 'gads', 'กูเกิล', 'กูเกิลแอดส์']],
  ['Influencer', ['influencer', 'kol', 'อินฟลูเอนเซอร์', 'อินฟลู', 'รีวิวเวอร์']],
  ['ออฟไลน์/อีเวนต์', ['offline', 'event', 'events', 'อีเวนต์', 'อีเว้นท์', 'ออฟไลน์', 'ออฟไลน์อีเวนต์', 'ป้าย', 'สิ่งพิมพ์']],
  ['LINE', ['line', 'lineoa', 'lineads', 'ไลน์']],
];
const CHANNEL_MAP = new Map();
CHANNEL_ALIASES.forEach(([name, list]) => list.forEach((a) => CHANNEL_MAP.set(norm(a), name)));
function parseChannel(v) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return CHANNEL_MAP.get(norm(s)) || s.slice(0, 100);
}

// ---------- reading a file ----------

// The header row is the first of the top 15 rows that names every required column.
function findHeader(kind, table) {
  const need = REQUIRED[kind];
  let best = null;
  for (let i = 0; i < Math.min(table.length, 15); i++) {
    const cells = (table[i] || []).map(norm);
    const cols = {};
    Object.entries(HEADERS[kind]).forEach(([role, names]) => {
      const at = cells.findIndex((c, idx) => c && names.map(norm).includes(c) && !Object.values(cols).includes(idx));
      if (at >= 0) cols[role] = at;
    });
    const missing = need.filter((r) => cols[r] == null);
    if (!missing.length) return { at: i, cols, missing };
    if (!best || Object.keys(cols).length > Object.keys(best.cols).length) best = { at: i, cols, missing };
  }
  return best && Object.keys(best.cols).length >= 1 ? best : null;
}

// table: [[cell, ...], ...] straight from the file. -> { rows, errors, count }
function parseFile(kind, table) {
  if (!HEADERS[kind]) throw bad('ชนิดไฟล์ต้องเป็น budget หรือ actual');
  if (!Array.isArray(table) || !table.length) throw bad('ไฟล์ว่าง');
  if (table.length > MAX_ROWS + 20) throw bad(`ไฟล์ใหญ่เกิน ${MAX_ROWS.toLocaleString('en-US')} แถว — แบ่งเป็นหลายไฟล์`, 413);
  const h = findHeader(kind, table);
  if (!h || h.missing.length) {
    const miss = (h ? h.missing : REQUIRED[kind]).map((r) => ROLE_LABEL[r]).join(', ');
    throw bad(`ไม่พบหัวคอลัมน์ที่ต้องมี: ${miss} — ใช้ไฟล์แม่แบบที่ดาวน์โหลดจากหน้านี้ (อย่าแก้ชื่อหัวคอลัมน์)`, 422);
  }
  const { cols } = h;
  const errors = [];
  const err = (rowNo, msg) => { if (errors.length < MAX_ERRORS) errors.push({ row: rowNo, message: msg }); else errors.overflow = (errors.overflow || 0) + 1; };
  const merged = new Map();
  let count = 0;
  for (let i = h.at + 1; i < table.length; i++) {
    const r = table[i] || [];
    const cell = (role) => (cols[role] == null ? null : r[cols[role]]);
    const blank = Object.keys(cols).every((role) => String(cell(role) == null ? '' : cell(role)).trim() === '');
    if (blank) continue;
    const rowNo = i + 1;
    const channel = parseChannel(cell('channel'));
    const amountRaw = parseAmount(cell('amount'));
    let ok = true;
    if (!channel) { err(rowNo, 'ไม่ได้ระบุช่องทาง'); ok = false; }
    if (amountRaw == null) { err(rowNo, `จำนวนเงินอ่านไม่ได้ ("${String(cell('amount') ?? '').slice(0, 30)}")`); ok = false; }
    else if (amountRaw < 0) { err(rowNo, 'จำนวนเงินติดลบไม่รองรับ'); ok = false; }
    else if (amountRaw > 1e9) { err(rowNo, 'จำนวนเงินผิดปกติ (เกินพันล้านบาท)'); ok = false; }
    const when = kind === 'budget' ? parseMonth(cell('month')) : parseDate(cell('date'));
    if (!when) { err(rowNo, `${kind === 'budget' ? 'เดือน' : 'วันที่'}อ่านไม่ได้ ("${String(cell(kind === 'budget' ? 'month' : 'date') ?? '').slice(0, 30)}") — ใช้ เช่น ${kind === 'budget' ? '2026-11' : '2026-11-05'}`); ok = false; }
    if (!ok) continue;
    count++;
    const key = `${when}|${channel.toLowerCase()}`;
    const note = cols.note == null ? '' : String(cell('note') ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const prev = merged.get(key);
    if (kind === 'budget') {
      if (prev) { err(rowNo, `งบของ ${when.slice(0, 7)} ช่องทาง ${channel} ซ้ำกับแถว ${prev.row}`); continue; }
      merged.set(key, { when, channel, cents: cents(amountRaw), row: rowNo });
    } else if (prev) {
      prev.cents += cents(amountRaw);
      if (note && !prev.note.includes(note)) prev.note = (prev.note ? prev.note + '; ' : '') + note;
      prev.note = prev.note.slice(0, 500);
    } else merged.set(key, { when, channel, cents: cents(amountRaw), note, row: rowNo });
  }
  if (!merged.size && !errors.length) errors.push({ row: null, message: 'ไม่พบแถวข้อมูลใต้หัวคอลัมน์' });
  return { rows: [...merged.values()], errors, overflow: errors.overflow || 0, count };
}

// ---------- saving ----------

async function importUpload(companyId, userId, { kind, filename, table }) {
  const parsed = parseFile(kind, table);
  if (parsed.errors.length) {
    const more = parsed.overflow ? ` และอีก ${parsed.overflow} แถว` : '';
    throw bad(`ไฟล์มีแถวที่อ่านไม่ได้ ${parsed.errors.length + parsed.overflow} แถว — ยังไม่ได้บันทึกอะไร แก้ไฟล์แล้วอัปโหลดใหม่ (แถวที่ ${parsed.errors.map((e) => e.row).filter(Boolean).join(', ')}${more})`, 422, { details: parsed.errors });
  }
  const rows = parsed.rows;
  const dates = rows.map((r) => r.when).sort();
  const total = rows.reduce((s, r) => s + r.cents, 0) / 100;
  const conn = await pool.getConnection();
  let uploadId;
  try {
    await conn.beginTransaction();
    const [ins] = await conn.query(
      `INSERT INTO marketing_uploads (company_id, kind, filename, row_count, date_from, date_to, total_amount, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [companyId, kind, String(filename || 'file').slice(0, 255), rows.length, dates[0], dates[dates.length - 1], total, userId || null]
    );
    uploadId = ins.insertId;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      if (kind === 'budget') {
        await conn.query(
          `INSERT INTO marketing_budget (company_id, upload_id, budget_month, channel, amount) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?)').join(',')}
           ON DUPLICATE KEY UPDATE upload_id = VALUES(upload_id), amount = VALUES(amount), channel = VALUES(channel)`,
          chunk.flatMap((r) => [companyId, uploadId, r.when, r.channel, r.cents / 100])
        );
      } else {
        await conn.query(
          `INSERT INTO marketing_actual (company_id, upload_id, spend_date, channel, amount, note) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(',')}
           ON DUPLICATE KEY UPDATE upload_id = VALUES(upload_id), amount = VALUES(amount), note = VALUES(note), channel = VALUES(channel)`,
          chunk.flatMap((r) => [companyId, uploadId, r.when, r.channel, r.cents / 100, r.note])
        );
      }
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  await rebuild(companyId);
  return { upload_id: uploadId, kind, rows: rows.length, date_from: dates[0], date_to: dates[dates.length - 1], total };
}

async function deleteUpload(companyId, uploadId) {
  const [[u]] = await pool.query(`SELECT id, kind FROM marketing_uploads WHERE id = ? AND company_id = ?`, [uploadId, companyId]);
  if (!u) return false;
  const table = u.kind === 'budget' ? 'marketing_budget' : 'marketing_actual';
  await pool.query(`DELETE FROM ${table} WHERE company_id = ? AND upload_id = ?`, [companyId, uploadId]);
  await pool.query(`DELETE FROM marketing_uploads WHERE id = ? AND company_id = ?`, [uploadId, companyId]);
  await rebuild(companyId);
  return true;
}

async function overview(companyId) {
  const [uploads] = await pool.query(
    `SELECT m.id, m.kind, m.filename, m.row_count, m.date_from, m.date_to, m.total_amount, m.created_at, u.email AS uploaded_by_email
       FROM marketing_uploads m LEFT JOIN users u ON u.id = m.uploaded_by
      WHERE m.company_id = ? ORDER BY m.id DESC LIMIT 50`,
    [companyId]
  );
  const [[b]] = await pool.query(`SELECT COUNT(*) AS n, MIN(budget_month) AS d1, MAX(budget_month) AS d2, COALESCE(SUM(amount),0) AS total FROM marketing_budget WHERE company_id = ?`, [companyId]);
  const [[a]] = await pool.query(`SELECT COUNT(*) AS n, MIN(spend_date) AS d1, MAX(spend_date) AS d2, COALESCE(SUM(amount),0) AS total FROM marketing_actual WHERE company_id = ?`, [companyId]);
  const [ch] = await pool.query(
    `SELECT channel FROM (SELECT channel FROM marketing_budget WHERE company_id = ? UNION SELECT channel FROM marketing_actual WHERE company_id = ?) t ORDER BY channel`,
    [companyId, companyId]
  );
  const d = (x) => (x ? (x instanceof Date ? iso(x.getFullYear(), x.getMonth() + 1, x.getDate()) : String(x).slice(0, 10)) : null);
  return {
    budget: { rows: b.n, month_from: d(b.d1), month_to: d(b.d2), total: Number(b.total) },
    actual: { rows: a.n, date_from: d(a.d1), date_to: d(a.d2), total: Number(a.total) },
    channels: ch.map((r) => r.channel),
    uploads: uploads.map((u) => ({ ...u, date_from: d(u.date_from), date_to: d(u.date_to), total_amount: Number(u.total_amount) })),
  };
}

// ---------- the report ----------

const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function dateText(x) {
  if (x instanceof Date) return iso(x.getFullYear(), x.getMonth() + 1, x.getDate());
  return String(x).slice(0, 10);
}

// Pure: budgets [{month:'2026-11-01', channel, amount}], actuals [{date, channel, amount, note}] -> rows.
function computeRows(budgets, actuals) {
  const rows = new Map();
  const row = (date, channel) => {
    const k = `${date}|${channel.toLowerCase()}`;
    if (!rows.has(k)) rows.set(k, { spend_date: date, month: date.slice(0, 7), channel, budget_to_date: 0, month_budget: 0, actual: 0, note: '' });
    return rows.get(k);
  };
  budgets.forEach((b) => {
    const y = Number(b.month.slice(0, 4));
    const m = Number(b.month.slice(5, 7));
    const n = daysIn(y, m);
    const total = cents(b.amount);
    const per = Math.floor(total / n);
    for (let d = 1; d <= n; d++) {
      const r = row(iso(y, m, d), b.channel);
      r.budget_to_date = (d === n ? total - per * (n - 1) : per) / 100;
      if (d === 1) r.month_budget = total / 100;
    }
  });
  actuals.forEach((a) => {
    const r = row(a.date, a.channel);
    r.actual = Math.round((r.actual + a.amount) * 100) / 100;
    if (a.note) r.note = a.note;
  });
  return [...rows.values()].sort((x, y) => (x.spend_date < y.spend_date ? -1 : x.spend_date > y.spend_date ? 1 : x.channel.localeCompare(y.channel)));
}

async function buildFor(companyId) {
  const [b] = await pool.query(`SELECT budget_month, channel, amount FROM marketing_budget WHERE company_id = ?`, [companyId]);
  const [a] = await pool.query(`SELECT spend_date, channel, amount, note FROM marketing_actual WHERE company_id = ?`, [companyId]);
  const rows = computeRows(
    b.map((r) => ({ month: dateText(r.budget_month).slice(0, 7) + '-01', channel: r.channel, amount: Number(r.amount) })),
    a.map((r) => ({ date: dateText(r.spend_date), channel: r.channel, amount: Number(r.amount), note: r.note || '' }))
  );
  const dates = rows.map((r) => r.spend_date);
  return {
    rows,
    meta: { marketing: { budget_rows: b.length, actual_rows: a.length, date_from: dates[0] || null, date_to: dates[dates.length - 1] || null } },
  };
}

async function rebuild(companyId) {
  try {
    return await fmhCache().syncOne(companyId, 'marketing', null);
  } catch (err) {
    console.error(`Marketing rebuild failed for company ${companyId}:`, err.message);
    return null;
  }
}

// ---------- templates ----------

const TEMPLATES = {
  budget: {
    filename: 'kss-marketing-budget-template.csv',
    rows: [
      ['เดือน', 'ช่องทาง', 'จำนวนเงิน (บาท)'],
      ['2026-11', 'Meta', 50000],
      ['2026-11', 'TikTok', 30000],
      ['2026-11', 'Google Ads', 20000],
      ['2026-11', 'Influencer', 40000],
      ['2026-11', 'ออฟไลน์/อีเวนต์', 15000],
    ],
  },
  actual: {
    filename: 'kss-marketing-actual-template.csv',
    rows: [
      ['วันที่', 'ช่องทาง', 'จำนวนเงิน (บาท)', 'หมายเหตุ'],
      ['2026-11-01', 'Meta', 1650, 'แคมเปญโปรโมชันต้นเดือน'],
      ['2026-11-01', 'TikTok', 980, ''],
      ['2026-11-02', 'Meta', 1720, ''],
      ['2026-11-03', 'Influencer', 12000, 'รีวิวเมนูใหม่'],
    ],
  },
};
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
// UTF-8 with BOM, so Excel shows Thai correctly.
function templateCsv(kind) {
  const t = TEMPLATES[kind];
  if (!t) return null;
  return { filename: t.filename, body: '﻿' + t.rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n' };
}

module.exports = { parseFile, parseDate, parseMonth, parseAmount, parseChannel, importUpload, deleteUpload, overview, computeRows, buildFor, rebuild, templateCsv, MAX_ROWS };
