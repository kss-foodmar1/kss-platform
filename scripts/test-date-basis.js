// Date basis (public/date-basis.js): which date column the page's range counts by.
// Hand-worked numbers; the Oct 2026 case also runs on the real exports when they are on disk.
const fs = require('fs');
const DB = require('../public/date-basis');
const TEMPLATES = require('../lib/widgetCatalog').BUILTIN_TEMPLATES;
let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };

// default = FMH's
check('default is Order Date', DB.DEFAULT === 'order_date' && DB.normalize(undefined) === 'order_date' && DB.normalize('bogus') === 'order_date');
check('labels: Thai name with the field name in brackets', DB.label('order_date') === 'วันที่สั่ง (Order Date)' && DB.label('do_date') === 'วันที่ส่งของ (DO Date)' && DB.label('grn_date') === 'วันที่รับของ (GRN Date)' && DB.label('invoice_date') === 'วันที่ใบแจ้งหนี้ (Invoice Date)' && DB.label('do_date', 'en') === 'DO Date', DB.label('do_date'));
check('the four asked-for dates are all choices', ['order_date', 'grn_date', 'do_date', 'invoice_date'].every((k) => DB.KEYS.includes(k)));
check('only itemized Sales / Purchase Analysis follow it', DB.isBasisSource('sales-analysis') && DB.isBasisSource('purchase-analysis') && !DB.isBasisSource('sales-analysis', 'product') && !DB.isBasisSource('cogs-stat'));

// 3 SO: A ordered 30/9 delivered 1/10 (DO 1/10); B ordered 31/10 delivered 1/11 (DO 31/10); C ordered 5/10, no DO yet
const rows = [
  { so_number: 'A', order_date: '2026-09-30', requested_delivery_date: '2026-10-01', do_date: '2026-10-01', total: 100 },
  { so_number: 'B', order_date: '2026-10-31', requested_delivery_date: '2026-11-01', do_date: '2026-10-31', total: 50 },
  { so_number: 'C', order_date: '2026-10-05', requested_delivery_date: '2026-10-06', do_date: '', total: 70 },
];
const inOct = (field) => rows.filter((r) => r[field] && r[field] >= '2026-10-01' && r[field] <= '2026-10-31');
const sum = (rs) => rs.reduce((a, r) => a + r.total, 0);
check('Order Date October = B + C = 120 (FMH way)', sum(inOct('order_date')) === 120 && inOct('order_date').length === 2);
check('Requested delivery October = A + C = 170', sum(inOct('requested_delivery_date')) === 170);
check('DO Date October = A + B = 150, C has no DO yet and is left out', sum(inOct('do_date')) === 150 && DB.missing(rows, 'do_date') === 1);

// which choices a report offers
check('available: order_date always; others only when a row has them', JSON.stringify(DB.available([rows])) === JSON.stringify(['order_date', 'requested_delivery_date', 'do_date']), JSON.stringify(DB.available([rows])));
check('available with no rows is just Order Date', JSON.stringify(DB.available([[]])) === '["order_date"]');
check('a report without the chosen column falls back to Order Date, and says so', (() => { const f = DB.fieldFor('invoice_date', rows); return f.field === 'order_date' && f.fellBack; })());
check('a report with it uses it', DB.fieldFor('do_date', rows).field === 'do_date' && !DB.fieldFor('do_date', rows).fellBack);

// widget configs follow the basis
const get = (k) => (TEMPLATES || []).find((t) => t.template_key === k);
if (get('cks_overview')) {
  const t = JSON.parse(JSON.stringify(get('cks_overview').config));
  const same = JSON.stringify(DB.applyToConfig(t, 'sales-analysis', 'order_date'));
  check('cks_overview: no old delivery date left, label names the basis', !same.includes('requested_delivery_date') && same.includes('เฉลี่ยต่อวันที่มียอด (ตามวันที่สั่ง)') && !same.includes('วันที่ส่งจริง'), same.slice(0, 300));
  const doCfg = JSON.stringify(DB.applyToConfig(t, 'sales-analysis', 'do_date'));
  check('cks_overview on DO Date counts distinct do_date', doCfg.includes('"field":"do_date"') && doCfg.includes('(ตามวันที่ส่งของ)'));
  check('English label when the language is English', JSON.stringify(DB.applyToConfig(t, 'sales-analysis', 'do_date', 'en')).includes('Avg per active day (by DO Date)'));
  check('the original config is not changed', JSON.stringify(t).includes('requested_delivery_date'));
}
if (get('cks_by_customer_trend')) {
  const c = DB.applyToConfig(get('cks_by_customer_trend').config, 'sales-analysis', 'grn_date');
  check('customer trend buckets by GRN Date', JSON.stringify(c.date_fields) === '["grn_date"]', JSON.stringify(c.date_fields));
}
if (get('pa_trend')) {
  const c = DB.applyToConfig(get('pa_trend').config, 'purchase-analysis', 'do_date');
  check('PO vs GRN vs Invoice keeps its four date fields', JSON.stringify(c.date_fields) === '["order_date","issued_date","grn_date","invoice_date"]');
}
if (get('cks_weekday')) {
  const w = get('cks_weekday').config;
  const c = DB.applyToConfig(w, 'sales-analysis', 'grn_date');
  check('weekday plan keeps the requested delivery date and its own range', c.row_date_field === 'requested_delivery_date' && JSON.stringify(c.derived) === JSON.stringify(w.derived) && !!w.foot, JSON.stringify(c.row_date_field));
}
check('Purchase: a requested_delivery_date mention is not swapped', DB.applyToConfig({ date_fields: ['requested_delivery_date'] }, 'purchase-analysis', 'grn_date').date_fields[0] === 'requested_delivery_date');
check('money left out of a date', DB.money([{ total: 10, do_date: '' }, { total: 5, do_date: '2026-10-01' }, { total: 7 }], 'do_date') === 17);
check('every choice has a hint in both languages', DB.KEYS.every((k) => DB.hint(k, 'th') && DB.hint(k, 'en')));
const single = DB.applyToConfig({ date_fields: ['order_date'], col_date: 'order_date', derived: [{ field: 'weekday', expr: { op: 'weekday', from: 'order_date' } }], sort: { by: 'order_date' } }, 'purchase-analysis', 'grn_date');
check('purchase: single date_fields, col_date and weekday follow; other mentions do not', single.date_fields[0] === 'grn_date' && single.col_date === 'grn_date' && single.derived[0].expr.from === 'grn_date' && single.sort.by === 'order_date');
check('other reports are left alone', DB.applyToConfig({ date_fields: ['order_date'] }, 'pos-sales', 'do_date').date_fields[0] === 'order_date');

// range presets (Mon 2 Nov 2026 and Sun 8 Nov 2026; weeks run Monday to Sunday)
const RP = require('../public/range-presets');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check('presets in order', eq(RP.PRESETS.map((p) => p.key), ['d7', 'd30', 'this_week', 'last_week', 'this_month', 'last_month', 'this_year', 'd365']));
check('last month = 1-31 Oct', eq(RP.compute('last_month', '2026-11-02'), { start: '2026-10-01', end: '2026-10-31' }));
check('last month across a year end', eq(RP.compute('last_month', '2026-01-15'), { start: '2025-12-01', end: '2025-12-31' }));
check('this week starts Monday (Sunday 8 Nov -> 2 Nov)', eq(RP.compute('this_week', '2026-11-08'), { start: '2026-11-02', end: '2026-11-08' }));
check('last week = Monday to Sunday before', eq(RP.compute('last_week', '2026-11-02'), { start: '2026-10-26', end: '2026-11-01' }));
check('this month / this year start on the 1st', RP.compute('this_month', '2026-11-02').start === '2026-11-01' && RP.compute('this_year', '2026-11-02').start === '2026-01-01');
check('year-long presets only with file history', !RP.available(false).some((p) => p.needsHistory) && RP.available(true).length === 8);
check('a custom pick equal to a preset is recognised', RP.match('2026-10-01', '2026-10-31', '2026-11-02') === 'last_month' && RP.match('2026-10-02', '2026-10-31', '2026-11-02') === null);

// the real exports (Oct + Sep 2026): FMH shows 111 SO / 596,571 for 1-31 Oct by Order Date
const dir = '/mnt/user-data/attachments/ca120d37-6e88-5288-a803-02d28934e1a6/';
const files = [dir + '6ca4b015-1-31_Oct.xlsx', dir + 'c21ab5dd-1-30_Sep.xlsx'];
(async () => {
  if (files.every((f) => fs.existsSync(f))) {
    const { read } = require('../public/fmh-file');
    let all = [];
    for (const f of files) {
      const res = await read(fs.readFileSync(f), { source: 'sales-analysis' });
      if (res.error) { check('read ' + f, false, res.error); continue; }
      all = all.concat(res.rows);
    }
    const oct = (field) => all.filter((r) => r[field] && r[field] >= '2026-10-01' && r[field] <= '2026-10-31');
    const stat = (rs) => ({ so: new Set(rs.map((r) => r.so_number)).size, total: Math.round(rs.reduce((a, r) => a + (Number(r.total) || 0), 0) * 100) / 100 });
    const o = stat(oct('order_date')), d = stat(oct('requested_delivery_date'));
    check('real exports, Order Date 1-31 Oct = FMH: 111 SO / 596,571', o.so === 111 && o.total === 596571, JSON.stringify(o));
    check('real exports, requested delivery 1-31 Oct = old dashboard: 113 SO / 615,874.5', d.so === 113 && d.total === 615874.5, JSON.stringify(d));
  } else console.log('SKIP  real exports not on disk');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
