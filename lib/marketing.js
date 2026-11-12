// Marketing budget vs actual, from two standard files a company uploads
// (templates: GET /api/marketing/template/budget|actual).
//
//   budget  month | channel | amount (baht)       one row per month × channel
//           (or horizontal: a row per channel, a column per month)
//   actual  date  | channel | amount (baht) | note   one row per spend; several
//                                                    rows of the same day × channel add up
//           (or horizontal: a row per channel, a column per day)
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
const nowYear = () => new Date(Date.now() + 7 * 3600 * 1000).getUTCFullYear();
// 4 digits: Buddhist era (>= 2400) is converted. 2 digits ("69"): CE 2069 or Buddhist 2569 (= 2026)?
// Only the reading within five years of today is accepted; neither or both -> null (the cell is rejected).
function fixYear(y) {
  if (y >= 2400) return y - 543;
  if (y < 100) {
    const near = (c) => Math.abs(c - nowYear()) <= 5;
    const ce = 2000 + y;
    const be = 1957 + y; // 2500 + y - 543
    if (near(ce) && !near(be)) return ce;
    if (near(be) && !near(ce)) return be;
    return null;
  }
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
  ['Meta', ['meta', 'facebookigads', 'facebookig', 'fbigads', 'facebook', 'fb', 'instagram', 'ig', 'metaads', 'facebookads', 'fbads', 'เฟซบุ๊ก', 'fb', 'instagram', 'ig', 'metaads', 'facebookads', 'fbads', 'เฟซบุ๊ก', 'เฟซบุ๊ค', 'เฟสบุ๊ก', 'เมต้า']],
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

// Horizontal layout (like a cash-flow sheet): one row per channel, one column per
// month (budget) or per day (actual). Blank cell = nothing entered (not 0).
// "รวม"/Total rows and columns are ignored: totals are recomputed, never read.
const TOTAL_WORDS = new Set(['รวม', 'รวมทั้งหมด', 'ยอดรวม', 'total', 'grandtotal', 'sum', 'subtotal']);
const isTotalText = (v) => {
  const t = String(v == null ? '' : v).trim();
  return !!t && (TOTAL_WORDS.has(norm(t)) || /รวม|\b(sub)?total\b|\bgrand ?total\b|^sum\b/i.test(t));
};
// Words the first header cell may use (the channel column).
const FIRST_HEAD = new Set([...HEADERS.budget.channel, 'รายการ', 'หมวด', 'หมวดหมู่', 'หมวดค่าใช้จ่าย', 'item', 'items', 'category', 'name', 'ชื่อ', 'ประเภท'].map(norm));
const BLANK_MARKS = new Set(['-', '–', '—', '−', 'n/a', 'na', '#n/a', 'null']);
const isBlankCell = (v) => {
  if (v == null) return true;
  const t = String(v).trim();
  return t === '' || BLANK_MARKS.has(t.toLowerCase());
};

// A header cell as a month/day. `year` (optional) lets a budget header with no year ("ม.ค.", "พ.ย.") be read.
function headerWhen(kind, c, year) {
  const v = kind === 'budget' ? parseMonth(c) : parseDate(c);
  if (v || kind !== 'budget' || !year) return v;
  const m = MONTH_WORD.get(norm(String(c == null ? '' : c)));
  return m ? realDate(year, m, 1) : null;
}

function findWide(kind, table, opts = {}) {
  for (let i = 0; i < Math.min(table.length, 15); i++) {
    const r = table[i] || [];
    const first = r[0] == null ? '' : String(r[0]).trim();
    const collect = (parse) => {
      const cols = [];
      const skipped = [];
      const totalCols = [];
      r.forEach((c, idx) => {
        if (idx === 0 || isBlankCell(c)) return;
        if (isTotalText(c)) { totalCols.push(idx); return; }
        const w = parse(c);
        const label = String(c).trim().slice(0, 20);
        if (w) cols.push({ idx, when: w, label });
        else skipped.push({ idx, label });
      });
      return { cols, skipped, totalCols };
    };
    let got = collect((c) => headerWhen(kind, c, opts.year));
    let monthly = false;
    if (kind === 'actual' && !got.cols.length) { // month columns in an actual file: monthly spend
      const m = collect((c) => headerWhen('budget', c, opts.year));
      if (m.cols.length) { got = m; monthly = true; }
    }
    // first cell: a channel/item word, or empty when the header has at least two real dates
    if (!(FIRST_HEAD.has(norm(first)) || (!first && got.cols.length >= 2))) continue;
    if (got.cols.length) return { at: i, ...got, monthly };
  }
  return null;
}

function parseWide(kind, table, w) {
  const errors = [];
  const err = (rowNo, msg) => { if (errors.length < MAX_ERRORS) errors.push({ row: rowNo, message: msg }); else errors.overflow = (errors.overflow || 0) + 1; };
  const seen = new Map();
  const unit = kind === 'budget' || w.monthly ? 'เดือน' : 'วันที่';
  w.cols.forEach((c) => {
    if (seen.has(c.when)) err(w.at + 1, `คอลัมน์ "${c.label}" เป็น${unit}เดียวกับคอลัมน์ก่อนหน้า — ลบหรือเปลี่ยนหัวคอลัมน์หนึ่งอัน`);
    seen.set(c.when, true);
  });
  const merged = new Map();
  const rawNames = new Map(); // channel key -> [{raw,row}]
  const skippedWithData = new Set();
  const warnings = [];
  const fileTotalRow = new Map(); // when -> amount the file's own total row shows
  const rowSums = []; // {row, name, sum, fileTotal}
  let count = 0;
  let afterData = false;
  for (let i = w.at + 1; i < table.length; i++) {
    const r = table[i] || [];
    if (r.every(isBlankCell)) { if (afterData) break; continue; } // blank row after the data ends the table
    const name = String(r[0] == null ? '' : r[0]).replace(/^[\s\-–•·*]+/, '').trim();
    if (!name) {
      if (w.cols.some((c) => !isBlankCell(r[c.idx]))) err(i + 1, 'มีตัวเลขแต่ไม่ได้ระบุชื่อช่องทางในคอลัมน์แรก');
      continue;
    }
    if (isTotalText(name)) {
      if (afterData) w.cols.forEach((c) => { const x = parseAmount(r[c.idx]); if (x != null) fileTotalRow.set(c.when, x); });
      continue;
    }
    const rowNo = i + 1;
    const channel = parseChannel(name);
    afterData = true;
    (w.skipped || []).forEach((sc) => { if (!isBlankCell(r[sc.idx]) && !skippedWithData.has(sc.idx)) skippedWithData.add(sc.idx); });
    const key0 = channel.toLowerCase();
    if (w.cols.some((c) => !isBlankCell(r[c.idx]))) {
      if (!rawNames.has(key0)) rawNames.set(key0, []);
      rawNames.get(key0).push({ raw: name, row: rowNo });
    }
    let rowSum = 0;
    for (const c of w.cols) {
      const raw = r[c.idx];
      if (isBlankCell(raw)) continue; // blank, "-", "n/a" = not entered
      const amt = parseAmount(raw);
      if (amt == null) { err(rowNo, `คอลัมน์ ${c.label}: อ่านจำนวนเงินไม่ได้ ("${String(raw).slice(0, 30)}")`); continue; }
      if (amt < 0) { err(rowNo, `คอลัมน์ ${c.label}: จำนวนเงินติดลบไม่รองรับ`); continue; }
      if (amt > 1e9) { err(rowNo, `คอลัมน์ ${c.label}: จำนวนเงินผิดปกติ (เกินพันล้านบาท)`); continue; }
      count++;
      rowSum += amt;
      const key = `${c.when}|${key0}`;
      const prev = merged.get(key);
      if (prev) {
        if (kind === 'budget') {
          const a = prev.raw === name ? `"${name}"` : `"${prev.raw}" (แถว ${prev.row}) กับ "${name}"`;
          err(rowNo, `${a} เป็นช่องทางเดียวกัน (${channel}) และมีงบ${unit} ${c.when.slice(0, 7)} ทั้งคู่ — เหลือแถวเดียวต่อช่องทาง`);
          continue;
        }
        prev.cents += cents(amt); // actual: two rows of one channel add up
      } else merged.set(key, { when: c.when, channel, cents: cents(amt), note: '', row: rowNo, raw: name, monthly: !!w.monthly });
    }
    const tc = (w.totalCols || []).map((ix) => parseAmount(r[ix])).find((x) => x != null);
    rowSums.push({ row: rowNo, name, sum: rowSum, fileTotal: tc == null ? null : tc });
  }
  // the file's own totals vs ours (a warning only: totals are never read as data)
  rowSums.forEach((x) => {
    if (x.fileTotal != null && Math.abs(x.fileTotal - x.sum) > 1) warnings.push(`แถว ${x.row} "${x.name}": คอลัมน์รวมในไฟล์ ${x.fileTotal.toLocaleString('en-US')} แต่ผลรวมที่อ่านได้ ${x.sum.toLocaleString('en-US')}`);
  });
  fileTotalRow.forEach((tot, when) => {
    let mine = 0;
    merged.forEach((v) => { if (v.when === when) mine += v.cents / 100; });
    if (Math.abs(tot - mine) > 1) warnings.push(`แถวรวมในไฟล์ของ ${w.monthly || kind === 'budget' ? when.slice(0, 7) : when} คือ ${tot.toLocaleString('en-US')} แต่ผลรวมที่อ่านได้ ${mine.toLocaleString('en-US')}`);
  });
  // header columns we could not read as month/day but that hold numbers
  (w.skipped || []).forEach((sc) => {
    if (skippedWithData.has(sc.idx)) {
      err(w.at + 1, `คอลัมน์ "${sc.label}" อ่านเป็น${unit}ไม่ได้ แต่มีตัวเลขอยู่ข้างใต้ — แก้หัวคอลัมน์เป็น ${kind === 'budget' ? 'เช่น 2026-11 หรือ พ.ย. 2569' : 'เช่น 2026-11-05'} (ถ้าเป็นคอลัมน์รวมให้ลบหรือเปลี่ยนชื่อเป็น "รวม")`);
    }
  });
  if (!merged.size && !errors.length) errors.push({ row: null, message: 'ไม่พบตัวเลขในตาราง — กรอกจำนวนเงินในช่องใต้เดือน/วันที่' });
  const meta = {
    layout: 'wide',
    channels: [...rawNames.entries()].map(([k, list]) => ({ channel: parseChannel(list[0].raw), raw: [...new Set(list.map((x) => x.raw))] })),
    skipped: (w.skipped || []).filter((sc) => !skippedWithData.has(sc.idx)).map((sc) => sc.label),
    columns: w.cols.length,
    monthly: !!w.monthly,
  };
  return { rows: [...merged.values()], errors, overflow: errors.overflow || 0, count, meta, warnings };
}

// table: [[cell, ...], ...] straight from the file. -> { rows, errors, count }
function parseFile(kind, table, opts = {}) {
  if (!HEADERS[kind]) throw bad('ชนิดไฟล์ต้องเป็น budget หรือ actual');
  if (!Array.isArray(table) || !table.length) throw bad('ไฟล์ว่าง');
  if (table.length > MAX_ROWS + 20) throw bad(`ไฟล์ใหญ่เกิน ${MAX_ROWS.toLocaleString('en-US')} แถว — แบ่งเป็นหลายไฟล์`, 413);
  const h = findHeader(kind, table);
  if (!h || h.missing.length) {
    const wide = findWide(kind, table, opts);
    if (wide) return parseWide(kind, table, wide);
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
      merged.set(key, { when, channel, cents: cents(amountRaw), row: rowNo, raw: String(cell('channel') || '').trim() });
    } else if (prev) {
      prev.cents += cents(amountRaw);
      if (note && !prev.note.includes(note)) prev.note = (prev.note ? prev.note + '; ' : '') + note;
      prev.note = prev.note.slice(0, 500);
    } else merged.set(key, { when, channel, cents: cents(amountRaw), note, row: rowNo, raw: String(cell('channel') || '').trim() });
  }
  if (!merged.size && !errors.length) errors.push({ row: null, message: 'ไม่พบแถวข้อมูลใต้หัวคอลัมน์' });
  const raws = new Map();
  merged.forEach((v) => { if (!raws.has(v.channel)) raws.set(v.channel, new Set()); raws.get(v.channel).add(v.raw || v.channel); });
  const meta = { layout: 'list', channels: [...raws.entries()].map(([channel, set]) => ({ channel, raw: [...set] })), skipped: [], monthly: false };
  return { rows: [...merged.values()], errors, overflow: errors.overflow || 0, count, meta, warnings: [] };
}

// ---------- saving ----------

const VAT_RATE = 1.07;
const monthOf = (when) => String(when).slice(0, 7);
const validMonth = (v) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || '')) ? String(v) : null);
const lastDay = (month) => iso(Number(month.slice(0, 4)), Number(month.slice(5, 7)), daysIn(Number(month.slice(0, 4)), Number(month.slice(5, 7))));

// What an upload would do, without writing: who is replaced, which channels are new, per-month totals.
async function previewOf(companyId, kind, rows, parsed, vat) {
  const dates = rows.map((r) => r.when).sort();
  const monthly = !!(parsed.meta && parsed.meta.monthly);
  const table = kind === 'budget' ? ['marketing_budget', 'budget_month'] : monthly ? ['marketing_actual_month', 'spend_month'] : ['marketing_actual', 'spend_date'];
  const [ex] = await pool.query(`SELECT ${table[1]} AS d, channel FROM ${table[0]} WHERE company_id = ? AND ${table[1]} BETWEEN ? AND ?`, [companyId, dates[0], dates[dates.length - 1]]);
  const have = new Set(ex.map((x) => `${dateText(x.d)}|${String(x.channel).toLowerCase()}`));
  const replaces = rows.filter((r) => have.has(`${r.when}|${r.channel.toLowerCase()}`)).length;
  const known = new Set((await overview(companyId)).channels.map((c) => c.toLowerCase()));
  const channels = (parsed.meta ? parsed.meta.channels : []).map((c) => ({ ...c, is_new: known.size > 0 && !known.has(c.channel.toLowerCase()), renamed: c.raw.some((x) => x !== c.channel) }));
  const byMonth = new Map();
  rows.forEach((r) => {
    const k = monthOf(r.when);
    if (!byMonth.has(k)) byMonth.set(k, { month: k, total: 0, rows: 0 });
    const m = byMonth.get(k);
    m.total += r.cents / 100;
    m.rows++;
  });
  const warnings = [...(parsed.warnings || [])];
  if (kind === 'actual' && monthly) {
    const [dl] = await pool.query(`SELECT DISTINCT DATE_FORMAT(spend_date, '%Y-%m') AS m, channel FROM marketing_actual WHERE company_id = ? AND spend_date BETWEEN ? AND ?`, [companyId, dates[0], lastDay(monthOf(dates[dates.length - 1]))]);
    const daily = new Set(dl.map((x) => `${x.m}|${String(x.channel).toLowerCase()}`));
    const clash = rows.filter((r) => daily.has(`${monthOf(r.when)}|${r.channel.toLowerCase()}`));
    if (clash.length) warnings.push(`${clash.length} เดือน×ช่องทางมียอดรายวันอยู่แล้ว — รายงานจะใช้ยอดรายวันและไม่นับยอดรายเดือนซ้ำ`);
  }
  if (replaces) warnings.push(`จะแทนที่ข้อมูลเดิม ${replaces} รายการ (เดือน×ช่องทาง${kind === 'actual' && !monthly ? '/วัน' : ''}เดียวกัน)`);
  channels.filter((c) => c.is_new).forEach((c) => warnings.push(`ช่องทางใหม่ "${c.raw.join('/')}" ที่ยังไม่เคยมีในระบบ — ตรวจว่าไม่ได้พิมพ์ชื่อผิดจากช่องทางเดิม`));
  return {
    kind,
    monthly,
    vat_included: !!vat,
    rows: rows.length,
    date_from: dates[0],
    date_to: dates[dates.length - 1],
    total: rows.reduce((s, r) => s + r.cents, 0) / 100,
    months: [...byMonth.values()].sort((x, y) => (x.month < y.month ? -1 : 1)).map((m) => ({ ...m, total: Math.round(m.total * 100) / 100 })),
    channels,
    skipped: (parsed.meta && parsed.meta.skipped) || [],
    replaces,
    warnings,
  };
}

async function importUpload(companyId, userId, { kind, filename, table, year, vat_included, dry_run }) {
  const y = Number(year);
  const parsed = parseFile(kind, table, { year: Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : (Number.isInteger(y) && y >= 2400 && y <= 2700 ? y - 543 : null) });
  if (parsed.errors.length) {
    const more = parsed.overflow ? ` และอีก ${parsed.overflow} รายการ` : '';
    throw bad(`ไฟล์มีจุดที่อ่านไม่ได้ ${parsed.errors.length + parsed.overflow} จุด — ยังไม่ได้บันทึกอะไร แก้ไฟล์แล้วอัปโหลดใหม่${more ? ` (แสดง ${parsed.errors.length}${more})` : ''}`, 422, { details: parsed.errors, overflow: parsed.overflow || 0 });
  }
  const vat = vat_included === true || vat_included === 'true' || vat_included === 1;
  const rows = parsed.rows.map((r) => (vat ? { ...r, cents: Math.round(r.cents / VAT_RATE) } : r));
  const preview = await previewOf(companyId, kind, rows, parsed, vat);
  if (dry_run) return { dry_run: true, ...preview };
  const monthly = preview.monthly;
  const dates = rows.map((r) => r.when).sort();
  const total = rows.reduce((s, r) => s + r.cents, 0) / 100;
  const conn = await pool.getConnection();
  let uploadId;
  try {
    await conn.beginTransaction();
    const [ins] = await conn.query(
      `INSERT INTO marketing_uploads (company_id, kind, filename, row_count, date_from, date_to, total_amount, uploaded_by, vat_included, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [companyId, kind, String(filename || 'file').slice(0, 255), rows.length, dates[0], dates[dates.length - 1], total, userId || null, vat ? 1 : 0, monthly ? 'รายเดือน' : '']
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
      } else if (monthly) {
        await conn.query(
          `INSERT INTO marketing_actual_month (company_id, upload_id, spend_month, channel, amount) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?)').join(',')}
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
  return { upload_id: uploadId, kind, rows: rows.length, date_from: dates[0], date_to: dates[dates.length - 1], total, monthly, vat_included: vat, month_count: preview.months.length, channel_count: preview.channels.length, replaced: preview.replaces, skipped: preview.skipped };
}

const ALL_TABLES = ['marketing_budget', 'marketing_actual', 'marketing_actual_month'];

async function deleteUpload(companyId, uploadId) {
  const [[u]] = await pool.query(`SELECT id, kind FROM marketing_uploads WHERE id = ? AND company_id = ?`, [uploadId, companyId]);
  if (!u) return false;
  for (const t of ALL_TABLES) await pool.query(`DELETE FROM ${t} WHERE company_id = ? AND upload_id = ?`, [companyId, uploadId]);
  await pool.query(`DELETE FROM marketing_uploads WHERE id = ? AND company_id = ?`, [uploadId, companyId]);
  await rebuild(companyId);
  return true;
}

// Upload records whose rows were all deleted or overwritten by this operation disappear with them.
async function dropEmptyUploads(companyId, ids) {
  const list = [...new Set(ids)].filter(Boolean);
  if (!list.length) return;
  const ph = list.map(() => '?').join(',');
  await pool.query(
    `DELETE FROM marketing_uploads WHERE company_id = ? AND id IN (${ph})
       AND NOT EXISTS (SELECT 1 FROM marketing_budget x WHERE x.upload_id = marketing_uploads.id)
       AND NOT EXISTS (SELECT 1 FROM marketing_actual x WHERE x.upload_id = marketing_uploads.id)
       AND NOT EXISTS (SELECT 1 FROM marketing_actual_month x WHERE x.upload_id = marketing_uploads.id)`,
    [companyId, ...list]
  );
}

// Clear one month (optionally one channel) of budget or actual.
async function clearData(companyId, { kind, month, channel, dry_run }) {
  if (kind !== 'budget' && kind !== 'actual') throw bad('ชนิดต้องเป็น budget หรือ actual');
  const mo = validMonth(month);
  if (!mo) throw bad('เดือนไม่ถูกต้อง ใช้รูปแบบ 2026-11');
  const ch = channel ? parseChannel(channel) : null;
  const chSql = ch ? ' AND channel = ?' : '';
  const chArg = ch ? [ch] : [];
  const parts = kind === 'budget'
    ? [[`marketing_budget`, `budget_month = ?`, [`${mo}-01`]]]
    : [[`marketing_actual`, `spend_date BETWEEN ? AND ?`, [`${mo}-01`, lastDay(mo)]], [`marketing_actual_month`, `spend_month = ?`, [`${mo}-01`]]];
  let count = 0;
  const upIds = [];
  for (const [t, cond, args] of parts) {
    const [r] = await pool.query(`SELECT upload_id FROM ${t} WHERE company_id = ? AND ${cond}${chSql}`, [companyId, ...args, ...chArg]);
    count += r.length;
    r.forEach((x) => upIds.push(x.upload_id));
  }
  if (dry_run) return { dry_run: true, kind, month: mo, channel: ch, count };
  for (const [t, cond, args] of parts) await pool.query(`DELETE FROM ${t} WHERE company_id = ? AND ${cond}${chSql}`, [companyId, ...args, ...chArg]);
  await dropEmptyUploads(companyId, upIds);
  await rebuild(companyId);
  return { kind, month: mo, channel: ch, count };
}

// Copy the budget of one month into another: only channels that have no budget there yet.
async function copyBudget(companyId, userId, { from, to, dry_run }) {
  const f = validMonth(from);
  const t = validMonth(to);
  if (!f || !t) throw bad('เดือนไม่ถูกต้อง ใช้รูปแบบ 2026-11');
  if (f === t) throw bad('เดือนต้นทางกับปลายทางต้องไม่ใช่เดือนเดียวกัน');
  const [src] = await pool.query(`SELECT channel, amount FROM marketing_budget WHERE company_id = ? AND budget_month = ?`, [companyId, `${f}-01`]);
  if (!src.length) throw bad(`ไม่มีงบของเดือน ${f} ให้คัดลอก`, 422);
  const [dst] = await pool.query(`SELECT channel FROM marketing_budget WHERE company_id = ? AND budget_month = ?`, [companyId, `${t}-01`]);
  const have = new Set(dst.map((r) => String(r.channel).toLowerCase()));
  const todo = src.filter((r) => !have.has(String(r.channel).toLowerCase()));
  const skipped = src.length - todo.length;
  const total = todo.reduce((s, r) => s + Number(r.amount), 0);
  if (dry_run || !todo.length) return { dry_run: !!dry_run, from: f, to: t, copied: dry_run ? todo.length : 0, skipped, total, channels: todo.map((r) => r.channel) };
  const [ins] = await pool.query(
    `INSERT INTO marketing_uploads (company_id, kind, filename, row_count, date_from, date_to, total_amount, uploaded_by) VALUES (?, 'budget', ?, ?, ?, ?, ?, ?)`,
    [companyId, `คัดลอกจาก ${f}`, todo.length, `${t}-01`, `${t}-01`, total, userId || null]
  );
  await pool.query(
    `INSERT INTO marketing_budget (company_id, upload_id, budget_month, channel, amount) VALUES ${todo.map(() => '(?, ?, ?, ?, ?)').join(',')}`,
    todo.flatMap((r) => [companyId, ins.insertId, `${t}-01`, r.channel, r.amount])
  );
  await rebuild(companyId);
  return { from: f, to: t, copied: todo.length, skipped, total, channels: todo.map((r) => r.channel) };
}

async function overview(companyId) {
  const [uploads] = await pool.query(
    `SELECT m.id, m.kind, m.filename, m.row_count, m.date_from, m.date_to, m.total_amount, m.vat_included, m.note, m.created_at, u.email AS uploaded_by_email
       FROM marketing_uploads m LEFT JOIN users u ON u.id = m.uploaded_by
      WHERE m.company_id = ? ORDER BY m.id DESC LIMIT 50`,
    [companyId]
  );
  const [[b]] = await pool.query(`SELECT COUNT(*) AS n, MIN(budget_month) AS d1, MAX(budget_month) AS d2, COALESCE(SUM(amount),0) AS total FROM marketing_budget WHERE company_id = ?`, [companyId]);
  const [[a]] = await pool.query(`SELECT COUNT(*) AS n, MIN(spend_date) AS d1, MAX(spend_date) AS d2, COALESCE(SUM(amount),0) AS total FROM marketing_actual WHERE company_id = ?`, [companyId]);
  const [[am]] = await pool.query(`SELECT COUNT(*) AS n, MIN(spend_month) AS d1, MAX(spend_month) AS d2, COALESCE(SUM(amount),0) AS total FROM marketing_actual_month WHERE company_id = ?`, [companyId]);
  const [ch] = await pool.query(
    `SELECT channel FROM (SELECT channel FROM marketing_budget WHERE company_id = ? UNION SELECT channel FROM marketing_actual WHERE company_id = ? UNION SELECT channel FROM marketing_actual_month WHERE company_id = ?) t ORDER BY channel`,
    [companyId, companyId, companyId]
  );
  const [bm] = await pool.query(`SELECT DISTINCT DATE_FORMAT(budget_month, '%Y-%m') AS m FROM marketing_budget WHERE company_id = ? ORDER BY m DESC LIMIT 36`, [companyId]);
  const d = (x) => (x ? (x instanceof Date ? iso(x.getFullYear(), x.getMonth() + 1, x.getDate()) : String(x).slice(0, 10)) : null);
  return {
    budget: { rows: b.n, month_from: d(b.d1), month_to: d(b.d2), total: Number(b.total), months: bm.map((r) => r.m) },
    actual: { rows: a.n + am.n, daily_rows: a.n, monthly_rows: am.n, date_from: d(a.d1), date_to: d(a.d2), total: Number(a.total) + Number(am.total) },
    channels: ch.map((r) => r.channel),
    uploads: uploads.map((u) => ({ ...u, vat_included: !!u.vat_included, date_from: d(u.date_from), date_to: d(u.date_to), total_amount: Number(u.total_amount) })),
  };
}

// ---------- the report ----------

const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function dateText(x) {
  if (x instanceof Date) return iso(x.getFullYear(), x.getMonth() + 1, x.getDate());
  return String(x).slice(0, 10);
}

// Pure: budgets [{month:'2026-11-01', channel, amount}], actuals [{date, channel, amount, note}] -> rows.
function computeRows(budgets, actuals, monthlyActuals = []) {
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
  // monthly spend counts only where the month x channel has no daily rows; it sits on the month's last day
  const dailyKeys = new Set(actuals.map((a) => `${a.date.slice(0, 7)}|${a.channel.toLowerCase()}`));
  monthlyActuals.forEach((a) => {
    const mo = a.month.slice(0, 7);
    if (dailyKeys.has(`${mo}|${a.channel.toLowerCase()}`)) return;
    const r = row(lastDay(mo), a.channel);
    r.actual = Math.round((r.actual + a.amount) * 100) / 100;
  });
  return [...rows.values()].sort((x, y) => (x.spend_date < y.spend_date ? -1 : x.spend_date > y.spend_date ? 1 : x.channel.localeCompare(y.channel)));
}

async function buildFor(companyId) {
  const [b] = await pool.query(`SELECT budget_month, channel, amount FROM marketing_budget WHERE company_id = ?`, [companyId]);
  const [a] = await pool.query(`SELECT spend_date, channel, amount, note FROM marketing_actual WHERE company_id = ?`, [companyId]);
  const [am] = await pool.query(`SELECT spend_month, channel, amount FROM marketing_actual_month WHERE company_id = ?`, [companyId]);
  const rows = computeRows(
    b.map((r) => ({ month: dateText(r.budget_month).slice(0, 7) + '-01', channel: r.channel, amount: Number(r.amount) })),
    a.map((r) => ({ date: dateText(r.spend_date), channel: r.channel, amount: Number(r.amount), note: r.note || '' })),
    am.map((r) => ({ month: dateText(r.spend_month).slice(0, 7), channel: r.channel, amount: Number(r.amount) }))
  );
  const dates = rows.map((r) => r.spend_date);
  return {
    rows,
    meta: { marketing: { budget_rows: b.length, actual_rows: a.length + am.length, date_from: dates[0] || null, date_to: dates[dates.length - 1] || null } },
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

const TEMPLATE_CHANNELS = ['Meta', 'TikTok', 'Google Ads', 'Influencer', 'ออฟไลน์/อีเวนต์', 'LINE', 'อื่นๆ'];

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
const toCsv = (rows) => '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; // BOM: Excel shows Thai

const bangkokMonth = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);

// Horizontal templates (default): channels down, months (budget) or days (actual) across.
// opts.from = 'YYYY-MM' first month of the budget sheet; opts.month = 'YYYY-MM' the actual sheet.
function wideTemplate(kind, opts = {}) {
  const ok = (v) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || '')) ? String(v) : null);
  if (kind === 'budget' || (kind === 'actual' && opts.granularity === 'month')) {
    const from = ok(opts.from) || bangkokMonth();
    let y = Number(from.slice(0, 4));
    let m = Number(from.slice(5, 7));
    const head = ['ช่องทาง'];
    for (let k = 0; k < 12; k++) { head.push(`${y}-${pad(m)}`); if (++m > 12) { m = 1; y++; } }
    return { filename: kind === 'budget' ? `kss-marketing-budget-${from}-12months.csv` : `kss-marketing-actual-monthly-${from}-12months.csv`, rows: [head, ...TEMPLATE_CHANNELS.map((c) => [c])] };
  }
  const month = ok(opts.month) || bangkokMonth();
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const head = ['ช่องทาง'];
  for (let d = 1; d <= daysIn(y, m); d++) head.push(iso(y, m, d));
  return { filename: `kss-marketing-actual-${month}.csv`, rows: [head, ...TEMPLATE_CHANNELS.map((c) => [c])] };
}

function templateCsv(kind, opts = {}) {
  if (!TEMPLATES[kind]) return null;
  if (opts.layout === 'list') return { filename: TEMPLATES[kind].filename, body: toCsv(TEMPLATES[kind].rows) };
  const t = wideTemplate(kind, opts);
  return { filename: t.filename, body: toCsv(t.rows) };
}

module.exports = { parseFile, parseDate, parseMonth, parseAmount, parseChannel, importUpload, deleteUpload, clearData, copyBudget, overview, computeRows, buildFor, rebuild, templateCsv, MAX_ROWS };
