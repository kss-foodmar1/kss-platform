// Daily numbers for the LINE digest, one per widget family. The company picks which ones to send
// (Admin › ตัวเตือน & LINE); a family none of the company's dashboards use is greyed out there
// and never sent. Every number comes from the same cached rows the widget reads, so LINE and the
// screen agree. Nothing here pulls from FMH.
const pool = require('../db/pool');

const baht = (n) => '฿' + Math.round(Number(n) || 0).toLocaleString('en-US');
// Short money for the small line under a tile: ฿4.33M, ฿812K.
const short = (n) => { const a = Math.abs(Number(n) || 0); const v = a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? Math.round(a / 1e3) + 'K' : Math.round(a).toLocaleString('en-US'); return (n < 0 ? '−฿' : '฿') + v; };
const num = (v) => Number(v) || 0;
const day = (v) => String(v || '').slice(0, 10);
const SKIP = /CANCEL|REJECT|DRAFT|VOID/i;
// good / bad news for the colour of the small line: sales up is good, wastage up is bad.
const toneOf = (v, avg, upIsGood) => (!avg || Math.abs(v - avg) / avg < 0.05 ? null : (v > avg) === upIsGood ? 'good' : 'bad');
const pctVs = (v, avg) => (avg ? `${v >= avg ? '+' : ''}${Math.round(((v - avg) / avg) * 100)}%` : '');

// Sum rows into { date → value } and return yesterday's value, the average of the 7 days before it.
function dayTotals(rows, dateOf, valueOf) {
  const m = new Map();
  rows.forEach((r) => { const d = day(dateOf(r)); if (d) m.set(d, (m.get(d) || 0) + valueOf(r)); });
  return m;
}
function vsWeek(m, y, addDays) {
  if (!m.has(y)) return null;
  const prev = []; for (let i = 2; i <= 8; i++) { const v = m.get(addDays(y, -i + 1)); if (v != null) prev.push(v); }
  return { v: m.get(y), avg: prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : null };
}

const ITEMS = [
  {
    key: 'cks_sales', name: 'ยอดขายครัวกลาง', desc: 'ยอดขายเมื่อวาน จำนวนใบสั่ง เทียบเฉลี่ย 7 วัน', sources: ['sales-analysis'], default: true,
    async compute({ rows, y, addDays }) {
      const r = rows('sales-analysis').filter((x) => !SKIP.test(x.status || x.so_status || ''));
      const so = new Set(); r.forEach((x) => { if (day(x.requested_delivery_date) === y && x.so_number) so.add(x.so_number); });
      const t = vsWeek(dayTotals(r, (x) => x.requested_delivery_date, (x) => num(x.total)), y, addDays);
      return t && { label: 'ยอดขายครัวกลางเมื่อวาน', tone: toneOf(t.v, t.avg, true), value: baht(t.v), sub: `${so.size} ใบสั่ง${t.avg ? ` · ${pctVs(t.v, t.avg)} จากเฉลี่ย` : ''}` };
    },
  },
  {
    key: 'purchases', name: 'ยอดสั่งซื้อ', desc: 'มูลค่า PO ที่สั่งเมื่อวาน จำนวนใบ', sources: ['purchase-analysis'], default: true,
    async compute({ rows, y }) {
      const r = rows('purchase-analysis').filter((x) => day(x.order_date) === y && !SKIP.test(x.order_status || ''));
      if (!r.length) return null;
      const n = new Set(r.map((x) => x.po_number).filter(Boolean)).size || r.length;
      // po_total (with tax) is what the PO widgets sum; fall back to qty × price for rows without it.
      return { label: 'สั่งซื้อเมื่อวาน', value: baht(r.reduce((t, x) => t + (x.po_total != null && x.po_total !== '' ? num(x.po_total) : num(x.qty) * num(x.price)), 0)), sub: `${n} ใบสั่งซื้อ` };
    },
  },
  {
    key: 'pos_sales', name: 'ยอดขายหน้าร้าน (POS)', desc: 'ยอดขายสุทธิเมื่อวานทุกสาขา เทียบเฉลี่ย 7 วัน', sources: ['pos-sales'], default: false,
    async compute({ rows, y, addDays }) {
      const r = rows('pos-sales');
      const t = vsWeek(dayTotals(r, (x) => x.sale_date, (x) => num(x.net_sales)), y, addDays);
      if (!t) return null;
      const by = new Map(); r.filter((x) => day(x.sale_date) === y).forEach((x) => by.set(x.branch, (by.get(x.branch) || 0) + num(x.net_sales)));
      const top = [...by.entries()].sort((a, b) => b[1] - a[1])[0];
      return { label: 'ยอดขายหน้าร้านเมื่อวาน', tone: toneOf(t.v, t.avg, true), value: baht(t.v), sub: `${t.avg ? `${pctVs(t.v, t.avg)} จากเฉลี่ย` : ''}${top ? `${t.avg ? ' · ' : ''}สูงสุด ${top[0]}` : ''}` };
    },
  },
  {
    key: 'gross_margin', name: 'ต้นทุนและกำไรขั้นต้น', desc: 'อัตรากำไรขั้นต้นของช่วงที่ซิงก์ล่าสุด', sources: ['cogs'], default: false,
    async compute({ rows }) {
      const r = rows('cogs'); if (!r.length) return null;
      const sales = r.reduce((t, x) => t + num(x.total_sales), 0), gp = r.reduce((t, x) => t + num(x.gross_profit), 0);
      return sales > 0 ? { label: 'กำไรขั้นต้น (ทั้งช่วงที่ซิงก์)', value: `${((gp / sales) * 100).toFixed(1)}%`, sub: `ขาย ${short(sales)} · กำไร ${short(gp)}` } : null;
    },
  },
  {
    key: 'wastage', name: 'ของเสีย', desc: 'มูลค่าของเสียเมื่อวาน เทียบเฉลี่ย 7 วัน', sources: ['wastage-trend'], default: false,
    async compute({ rows, y, addDays }) {
      const t = vsWeek(dayTotals(rows('wastage-trend'), (x) => x.period, (x) => num(x.total_wastage_value)), y, addDays);
      return t && { label: 'ของเสียเมื่อวาน', tone: toneOf(t.v, t.avg, false), value: baht(t.v), sub: t.avg ? `${pctVs(t.v, t.avg)} จากเฉลี่ย` : '' };
    },
  },
  {
    key: 'picking', name: 'จัดของได้ครบตามที่สาขาขอ', desc: 'อัตราจัดของครบเมื่อวาน และสาขาที่ได้น้อยสุด', sources: ['picking'], default: false,
    async compute({ rows, y }) {
      const r = rows('picking').filter((x) => day(x.issued_date) === y && num(x.requested_qty) > 0 && !SKIP.test(x.order_status || ''));
      if (!r.length) return null;
      const req = r.reduce((t, x) => t + num(x.requested_qty), 0), got = r.reduce((t, x) => t + num(x.picked_qty), 0);
      const by = new Map(); r.forEach((x) => { const o = by.get(x.branch) || { q: 0, p: 0 }; o.q += num(x.requested_qty); o.p += num(x.picked_qty); by.set(x.branch, o); });
      const worst = [...by.entries()].filter(([, o]) => o.q > 0).map(([b, o]) => [b, o.p / o.q]).sort((a, b) => a[1] - b[1])[0];
      return { label: 'จัดของครบเมื่อวาน', value: `${Math.round((got / req) * 100)}%`, sub: worst && worst[1] < 0.98 ? `ต่ำสุด ${worst[0]} ${Math.round(worst[1] * 100)}%` : 'ทุกสาขาใกล้ครบ' };
    },
  },
  {
    key: 'stock_count', name: 'ผลการนับสต็อก', desc: 'ผลต่างมูลค่าของการนับล่าสุด', sources: ['stock-count'], default: false,
    async compute({ rows }) {
      const r = rows('stock-count'); if (!r.length) return null;
      const last = r.map((x) => day(x.count_date)).sort().pop();
      const l = r.filter((x) => day(x.count_date) === last);
      const v = l.reduce((t, x) => t + num(x.variance_value), 0);
      return { label: `นับสต็อก ${last.slice(5).replace('-', '/')}`, value: `${v >= 0 ? '+' : '−'}${baht(Math.abs(v))}`, sub: `${l.length} รายการ · ${new Set(l.map((x) => x.branch)).size} สาขา` };
    },
  },
];

// Which source reports does any dashboard of this company use?
async function usedSources(companyId) {
  const [rows] = await pool.query(
    `SELECT DISTINCT t.report_source FROM dashboard_widgets dw
       JOIN dashboards d ON d.id = dw.dashboard_id
       JOIN widget_templates t ON t.id = dw.widget_template_id
      WHERE d.company_id = ?`, [companyId]);
  return new Set(rows.map((r) => r.report_source));
}
async function savedKeys(companyId) {
  try {
    const [[r]] = await pool.query(`SELECT watch_json FROM company_line WHERE company_id = ?`, [companyId]);
    const j = r && r.watch_json ? JSON.parse(r.watch_json) : {};
    return Array.isArray(j.summary) ? j.summary.map(String) : null;
  } catch (e) { return null; }
}
// What Admin shows: every family, greyed out (available: false) when no dashboard uses its report.
async function view(companyId) {
  const used = await usedSources(companyId);
  const saved = await savedKeys(companyId);
  return ITEMS.map((i) => {
    const available = i.sources.some((s) => used.has(s));
    return { key: i.key, name: i.name, desc: i.desc, available, selected: available && (saved ? saved.includes(i.key) : i.default) };
  });
}
async function save(companyId, keys) {
  const known = new Set(ITEMS.map((i) => i.key));
  const ok = new Set((await view(companyId)).filter((v) => v.available).map((v) => v.key));
  const list = [...new Set((keys || []).map(String).filter((k) => known.has(k) && ok.has(k)))];
  const [[r]] = await pool.query(`SELECT watch_json FROM company_line WHERE company_id = ?`, [companyId]);
  let j = {}; try { j = r && r.watch_json ? JSON.parse(r.watch_json) : {}; } catch (e) { j = {}; }
  j.summary = list;
  await pool.query(`UPDATE company_line SET watch_json = ? WHERE company_id = ?`, [JSON.stringify(j), companyId]);
  return list;
}
// The chosen, available numbers for yesterday; a family with no data yet is simply left out.
async function numbers(companyId, today) {
  const alerts = require('./alerts');
  const chosen = (await view(companyId)).filter((v) => v.selected).map((v) => v.key);
  const bySource = new Map();
  for (const key of chosen) {
    for (const s of ITEMS.find((i) => i.key === key).sources) {
      if (!bySource.has(s)) { try { bySource.set(s, await alerts.rowsOf(companyId, s)); } catch (e) { bySource.set(s, []); } }
    }
  }
  const rows = (s) => bySource.get(s) || [];
  const out = [];
  for (const key of chosen) {
    try { const n = await ITEMS.find((i) => i.key === key).compute({ rows, y: alerts.addDays(today, -1), addDays: alerts.addDays }); if (n) out.push(n); }
    catch (err) { console.error(`LINE summary ${key} failed (company ${companyId}):`, err.message); }
  }
  return out;
}
module.exports = { ITEMS, view, save, numbers };
