#!/usr/bin/env node
// Checks the row layer and every Line Checks template against six hand-built
// purchase lines whose correct answers were worked out by hand.
//
// It runs with no database and no FMH key: it lifts the pure helpers out of
// public/app.js and feeds them the real template configs, so a config edit that
// changes what a widget selects fails here rather than in front of a client.
//
// Usage:  node scripts/test-row-layer.js   (exit 0 = all pass)
//
// It already earned its keep once: the three-way-match template was selecting
// lines that were merely not received yet, which would have buried the real
// mismatches under rows where nothing was wrong.
// Run in Thailand's clock: the date bugs this catches only show east of UTC.
process.env.TZ = 'Asia/Bangkok';
const fs = require('fs');
const os = require('os');
const path = require('path');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
const want = ['pick', 'evalMetric', 'evalRow', 'dateOnly', 'rowMatches', 'applyRowLayer', 'groupRows', 'rowFields', 'bucketOf', 'keyOf', 'pivotRows', 'localIso', 'bucketKey'];
let code = 'const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };\n';
code += 'const isBlank = (v) => v === null || v === undefined || String(v).trim() === "";\n';
for (const name of want) {
  const re = new RegExp(`^function ${name}\\([\\s\\S]*?\\n\\}`, 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + name);
  code += m[0] + '\n';
}
code += 'module.exports = {' + want.join(',') + '};';
const HELPERS = path.join(os.tmpdir(), '_kss_helpers.js');
fs.writeFileSync(HELPERS, code);
const H = require(HELPERS);
const { BUILTIN_TEMPLATES } = require('../lib/widgetCatalog');
const T = (k) => BUILTIN_TEMPLATES.find((t) => t.template_key === k).config;

// Six purchase lines. Everything asserted below was worked out from these by hand.
const rows = [
  // clean line: PO = GRN = invoice, on time
  { po_number: 'PO-1', order_date: '2026-09-01', requested_delivery_date: '2026-09-03', grn_date: '2026-09-03', do_date: '2026-09-03',
    do_number: 'DO-1', grn_number: 'GRN-1', invoice_number: 'INV-1', supplier: 'A', product_name: 'หมู', product_code: 'PRK-001',
    uom: 'kg', po_qty: 10, do_quantity: 10, grn_quantity: 10, po_total: 1000, grn_total: 1000, invoice_total: 1000, qty: 10, price: 100, total: 1000 },
  // over-billed by 150, delivered 2 days late, short 2 units
  { po_number: 'PO-2', order_date: '2026-09-02', requested_delivery_date: '2026-09-04', grn_date: '2026-09-06', do_date: '2026-09-06',
    do_number: 'DO-2', grn_number: 'GRN-2', invoice_number: 'INV-2', supplier: 'B', product_name: 'หมู', product_code: 'PRK-001',
    uom: 'kg', po_qty: 10, do_quantity: 8, grn_quantity: 8, po_total: 1000, grn_total: 800, invoice_total: 950, qty: 8, price: 100, total: 800 },
  // ordered, never received
  { po_number: 'PO-3', order_date: '2026-09-05', requested_delivery_date: '2026-09-08', grn_date: '', do_date: '',
    do_number: '', grn_number: '', invoice_number: '', supplier: 'B', product_name: 'ไก่', product_code: 'CHK-002',
    uom: 'kg', po_qty: 5, do_quantity: 0, grn_quantity: 0, po_total: 400, grn_total: 0, invoice_total: 0, qty: 5, price: 80, total: 400 },
  // received, not yet invoiced
  { po_number: 'PO-4', order_date: '2026-09-07', requested_delivery_date: '2026-09-09', grn_date: '2026-09-09', do_date: '2026-09-09',
    do_number: 'DO-4', grn_number: 'GRN-4', invoice_number: '', supplier: 'A', product_name: 'ไก่', product_code: 'CHK-002',
    uom: 'kg', po_qty: 4, do_quantity: 4, grn_quantity: 4, po_total: 360, grn_total: 360, invoice_total: 0, qty: 4, price: 90, total: 360 },
  // same product, different unit price and a different UOM, odd code
  { po_number: 'PO-5', order_date: '2026-09-10', requested_delivery_date: '2026-09-12', grn_date: '2026-09-12', do_date: '2026-09-12',
    do_number: 'DO-5', grn_number: 'GRN-5', invoice_number: 'INV-5', supplier: 'C', product_name: 'หมู', product_code: 'PRK-001',
    uom: 'g', po_qty: 2, do_quantity: 2, grn_quantity: 2, po_total: 260, grn_total: 260, invoice_total: 260, qty: 2, price: 130, total: 260 },
  // no product code at all; DO says 3, GRN says 2
  { po_number: 'PO-6', order_date: '2026-09-11', requested_delivery_date: '2026-09-13', grn_date: '2026-09-14', do_date: '2026-09-13',
    do_number: 'DO-6', grn_number: 'GRN-6', invoice_number: 'INV-6', supplier: 'C', product_name: 'ผักสด', product_code: '',
    uom: 'kg', po_qty: 3, do_quantity: 3, grn_quantity: 2, po_total: 150, grn_total: 100, invoice_total: 100, qty: 2, price: 50, total: 100 },
];

let fails = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ได้ ${JSON.stringify(actual)}${ok ? '' : ` ควรเป็น ${JSON.stringify(expected)}`}`);
}
const apply = (k) => H.applyRowLayer(rows, T(k));
const byGroup = (k, rs) => {
  const cfg = T(k);
  return [...H.groupRows(rs, H.rowFields(cfg))].map(([n, g]) => [String(n), Math.round(H.evalMetric(cfg.value, g) * 100) / 100]);
};

// three-way match: PO-2 (GRN<PO and INV>GRN) and PO-6 (GRN<PO) -> 2 lines
const tw = apply('ita_three_way_match');
check('three_way_match เลือกบรรทัดที่ไม่ตรง', tw.map((r) => r.po_number), ['PO-2', 'PO-6']);
check('three_way_match คำนวณส่วนต่าง PO-2', [tw[0].grn_minus_po, tw[0].invoice_minus_grn], [-200, 150]);

// over-billed: only PO-2, 150, supplier B
check('overbilled รวมตามซัพพลายเออร์', byGroup('ita_overbilled', apply('ita_overbilled')), [['B', 150]]);

// short delivery: PO-2 short 2 (supplier B), PO-6 short 1 (supplier C). PO-3 has no GRN so is excluded.
check('short_delivery ไม่นับบรรทัดที่ยังไม่รับของ', byGroup('ita_short_delivery', apply('ita_short_delivery')), [['B', 2], ['C', 1]]);

// not received: PO-3 only
check('not_received', apply('ita_not_received').map((r) => r.po_number), ['PO-3']);

// received not invoiced: PO-4, 360, supplier A
check('grn_not_invoiced', byGroup('ita_grn_not_invoiced', apply('ita_grn_not_invoiced')), [['A', 360]]);

// lead time: A = (2 + 2)/2 = 2 ; B = 4 ; C = (2 + 3)/2 = 2.5. PO-3 excluded (no grn_date).
check('lead_time เฉลี่ยเป็นวัน', byGroup('ita_lead_time', apply('ita_lead_time')), [['A', 2], ['B', 4], ['C', 2.5]]);

// days late: A = (0 + 0)/2 = 0 ; B = 2 ; C = (0 + 1)/2 = 0.5
check('late_delivery เฉลี่ยวันที่ช้ากว่านัด', byGroup('ita_late_delivery', apply('ita_late_delivery')), [['A', 0], ['B', 2], ['C', 0.5]]);

// price dispersion on หมู: min 100, max 130, avg (100+100+130)/3 = 110
{
  const cfg = T('ita_price_dispersion');
  const g = H.groupRows(rows, H.rowFields(cfg));
  const pork = g.get('หมู');
  check('price_dispersion ของหมู (min, max, avg)',
    [H.evalMetric(cfg.min, pork), H.evalMetric(cfg.max, pork), Math.round(H.evalMetric(cfg.last, pork) * 100) / 100],
    [100, 130, 110]);
}
// price gap: หมู 130-100 = 30 ; ไก่ 90-80 = 10 ; ผักสด 0
check('price_gap_saving', byGroup('ita_price_gap_saving', rows), [['หมู', 30], ['ไก่', 10], ['ผักสด', 0]]);

// uom mix: หมู has kg and g -> 2
check('uom_mix', byGroup('ita_uom_mix', rows), [['หมู', 2], ['ไก่', 1], ['ผักสด', 1]]);

// missing code: PO-6
check('missing_code', apply('ita_missing_code').map((r) => r.po_number), ['PO-6']);

// code convention: PRK-001 and CHK-002 match ABC-123; blank is excluded by `present`
check('code_convention ไม่เตือนรหัสที่เข้ารูปแบบ', apply('ita_code_convention').map((r) => r.product_code), []);

// order frequency: หมู in 3 POs, ไก่ 2, ผักสด 1
check('order_frequency', byGroup('ita_order_frequency', rows), [['หมู', 3], ['ไก่', 2], ['ผักสด', 1]]);

// split orders: none of the rows carry split_order_status
check('split_orders ว่างเมื่อไม่มีใบแตกส่ง', apply('ita_split_orders').length, 0);

// DO vs GRN: PO-6 only (3 vs 2)
const dg = apply('ita_do_vs_grn');
check('do_vs_grn', dg.map((r) => [r.po_number, r.qty_gap]), [['PO-6', -1]]);


// ---------- the pivot ----------
// CK sales live in the COGS report, CK purchases in purchase analysis. Two
// months, with the September purchases deliberately higher than September's
// recipe cost — which is the whole point of showing both margins.
const salesRows = [
  { period: '2026-09-01', sales: 10000, cogs: 6000, gross_profit: 4000 },
  { period: '2026-10-01', sales: 8000, cogs: 4800, gross_profit: 3200 },
];
const purchaseRows = [
  { order_date: '2026-09-03', total: 4000, product_code: 'PRK-001', product_name: 'หมู', category_name: 'เนื้อสัตว์', supplier: 'A' },
  { order_date: '2026-09-20', total: 3000, product_code: 'CH01', product_name: 'ชีส', category_name: 'นม', supplier: 'B' },
  { order_date: '2026-10-05', total: 4200, product_code: 'PRK-001', product_name: 'หมู', category_name: 'เนื้อสัตว์', supplier: 'A' },
];
const recipeRows = [
  { ingredient_code: 'PRK-001', ingredient_name: 'หมู', total_cost: 50 },
];

{
  const cfg = T('ck_margin_table');
  const piv = H.pivotRows({ sales: salesRows, purchase: purchaseRows }, cfg);
  check('pivot ทำหนึ่งแถวต่อเดือน', piv.map((r) => r.period), ['2026-09-01', '2026-10-01']);
  check('pivot รวมยอดซื้อเดือน ก.ย. จากสองบรรทัด', [piv[0].purchase_value, piv[0].purchase_rows], [7000, 2]);
  const withDerived = H.applyRowLayer(piv, cfg);
  // ก.ย.: ขาย 10,000 ซื้อจริง 7,000 -> GM สด 30% ; ตามสูตร 6,000 -> 40% ; ช่องว่าง 10 จุด
  check('GM จ่ายจริงเดือน ก.ย.', Math.round(withDerived[0].gm_cash_pct * 100) / 100, 30);
  check('GM ตามสูตรเดือน ก.ย.', Math.round(withDerived[0].gm_recipe_pct * 100) / 100, 40);
  check('ช่องว่างเดือน ก.ย.', Math.round(withDerived[0].gap_pct * 100) / 100, 10);
  // ต.ค.: ขาย 8,000 ซื้อ 4,200 -> 47.5% ; ตามสูตร 4,800 -> 40%  (ซื้อน้อยกว่าที่ขาย = กินของเก่า)
  check('GM จ่ายจริงเดือน ต.ค. สูงกว่าตามสูตร', Math.round(withDerived[1].gm_cash_pct * 100) / 100, 47.5);
}
{
  const cfg = T('bought_not_in_recipe');
  const piv = H.pivotRows({ purchase: purchaseRows, recipe: recipeRows }, cfg);
  const rows = H.applyRowLayer(piv, cfg);
  check('ของที่ซื้อแต่ไม่มีในสูตร', rows.map((r) => [r.product_code, r.spend]), [['CH01', 3000]]);
  check('ชื่อสินค้าถูกดึงข้ามมาด้วย', rows[0].product_name, 'ชีส');
  check('หมูไม่ถูกเตือน เพราะอยู่ในสูตร', piv.find((r) => r.product_code === 'PRK-001').recipe_rows, 1);
}
check('bucketOf รายเดือนคืนวันที่จริง', H.bucketOf('2026-09-20T10:00:00Z', 'month'), '2026-09-01');
check('bucketOf รายสัปดาห์คืนวันจันทร์', H.bucketOf('2026-10-02', 'week'), '2026-09-28');


// The line renderer's own bucketing, in Bangkok time. It used toISOString(),
// which put every month on the line one month early for a Thai viewer.
check('bucketKey รายเดือนไม่เลื่อนในเวลาไทย', H.bucketKey('2026-04-01', 'month'), '2026-04-01');
check('bucketKey รายวันไม่เลื่อนในเวลาไทย', H.bucketKey('2026-04-01', 'day'), '2026-04-01');
check('localIso ใช้ปฏิทินเครื่อง', H.localIso(new Date(2026, 9, 3, 1, 30)), '2026-10-03');

// CK sales vs purchases: a month with purchases and no sales must survive the
// join as its own bar, not vanish.
{
  const cfg = T('ck_sales_vs_purchase');
  const out = H.pivotRows({
    sales: [{ period: '2026-07-03', sales: 600 }, { period: '2026-07-20', sales: 400 }],
    purchase: [{ order_date: '2026-07-05', total: 700 }, { order_date: '2026-08-02', total: 120 }],
  }, cfg);
  check('ขาย-ซื้อ CK: ได้ 2 เดือน', out.length, 2);
  check('ขาย-ซื้อ CK: ก.ค. ยอดขาย', out[0].sales_value, 1000);
  check('ขาย-ซื้อ CK: ก.ค. ยอดซื้อ', out[0].purchase_value, 700);
  check('ขาย-ซื้อ CK: ส.ค. มีแต่ยอดซื้อ', [out[1].period, out[1].sales_value, out[1].purchase_value].join('|'), '2026-08-01|0|120');
  check('ขาย-ซื้อ CK: เดือนเดียวกันลงช่องเดียวกันในกราฟ', H.bucketKey(out[0].period, cfg.bucket), '2026-07-01');
}

// CK category mix: the stacked bar's two segments must add back to the PO
// total, and only lines received with no invoice count as awaiting INV.
{
  const panel = T('ck_category_mix').panels.find((p) => p.chart === 'stack');
  const lines = [
    { category_name: 'เนื้อ', po_total: 180, grn_total: 178, grn_number: 'G1', invoice_number: 'I1' }, // invoiced
    { category_name: 'เนื้อ', po_total: 120, grn_total: 118, grn_number: 'G2', invoice_number: '' },   // awaiting
    { category_name: 'เนื้อ', po_total: 30, grn_total: 0, grn_number: '', invoice_number: '' },         // not received
  ];
  const [awaiting, rest] = panel.segments.map((sg) => H.evalMetric(sg.value, lines));
  check('แท่งซ้อน: รอ INV นับเฉพาะใบที่รับแล้วไม่มี INV', awaiting, 118);
  check('แท่งซ้อน: สองส่วนรวมกันเท่ายอด PO', awaiting + rest, 330);
  check('แท่งซ้อน: ส่วนที่เหลือไม่ติดลบ', H.evalMetric(panel.segments[1].value, [{ po_total: 100, grn_total: 120, grn_number: 'G', invoice_number: '' }]), 0);
}
console.log(fails ? `\n${fails} ข้อไม่ผ่าน` : '\nผ่านทั้งหมด');
process.exit(fails ? 1 : 0);
