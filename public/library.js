// Widget library ("คลัง Widget"): pick a widget by the question it answers,
// see it on the company's own data, then add it to any of the company's
// dashboards — or start a whole dashboard from a ready-made pack.
//   Company admins: their own company. KSS staff: the company being viewed.
//   Server: routes/admin.js (widget-usage, library-add, packs) and
//   routes/dashboards.js (/preview/:tid).

// The question each widget answers, shown as its title in the library.
// A widget not listed here shows its catalog name.
const LIB_QUESTIONS = {
  pa_kpis: 'สั่งซื้อ รับของ วางบิล รวมแล้วเท่าไร ต่างกันกี่ %?',
  pa_trend: 'มูลค่า PO, รับของ และใบแจ้งหนี้ วิ่งไปด้วยกันไหม?',
  pa_attention_products: 'สินค้าไหนรับของไม่ตรงกับที่สั่ง?',
  pa_top_suppliers: 'เราซื้อจากใครมากที่สุด?',
  pa_category_variance: 'หมวดไหนรับของต่างจาก PO มากที่สุด?',
  pa_supplier_spend: 'จ่ายให้ซัพพลายเออร์แต่ละเจ้าเท่าไร?',
  price_variance_top: 'สินค้าไหนราคาต่างกันมากระหว่างเจ้า?',
  price_avg_trend: 'ราคาที่จ่ายจริงขึ้นจริงไหม?',
  credit_note_by_supplier: 'เจ้าไหนต้องออกใบลดหนี้บ่อย?',
  price_compare_suppliers: 'ของชิ้นเดียวกัน เจ้าไหนถูกที่สุด?',
  po_status_mix: 'ใบสั่งซื้อค้างอยู่สถานะไหนบ้าง?',
  ops_snapshot: 'วันนี้งานจัดซื้อค้างอะไรอยู่?',
  pa_category_trend: 'หมวดไหนซื้อมากขึ้นผิดปกติ?',
  pa_category_week_heatmap: 'หมวดไหนซื้อมากผิดปกติในสัปดาห์ไหน?',
  pa_order_weekday_heatmap: 'สั่งอะไรวันไหนของสัปดาห์?',
  mc_kpis: 'ต้นทุนสูตรอาหารรวมเท่าไร?',
  mc_top_ingredients: 'วัตถุดิบไหนกระทบต้นทุนเมนูมากที่สุด?',
  mc_top_menus: 'เมนูไหนต้นทุนสูงที่สุด?',
  mc_sensitivity: 'ถ้าวัตถุดิบขึ้นราคา เมนูไหนโดนหนักสุด?',
  mc_menu_breakdown: 'เมนูนี้ต้นทุนมาจากวัตถุดิบไหน?',
  menu_ingredient_usage: 'วัตถุดิบไหนถูกใช้จริงมากที่สุดตามยอดขาย?',
  menu_matrix: 'เมนูไหนขายดีแต่กำไรต่ำ?',
  menu_mix_qty: 'ครัวทำเมนูไหนมากที่สุด?',
  menu_price_vs_cost: 'เมนูไหนแทบไม่เหลือกำไรต่อจาน?',
  cogs_kpis: 'ยอดขาย ต้นทุน กำไรขั้นต้นเท่าไร?',
  cogs_overview: 'ยอดขาย ต้นทุน กำไรขั้นต้นเท่าไร?',
  cogs_lowest_margin: 'เมนูไหนมาร์จิ้นต่ำที่สุด?',
  cogs_low_margin: 'เมนูไหนมาร์จิ้นต่ำกว่าเป้า?',
  cogs_margin_by_branch: 'สาขาไหนกำไรขั้นต้นต่ำ?',
  cogs_trend: 'กำไรที่หายไปมาจากยอดขายตก หรือต้นทุนขึ้น?',
  cogs_yield_loss: 'เสียต้นทุนกับการตัดแต่งไปเท่าไร?',
  cogs_menu_gp: 'กี่เมนูที่สร้างกำไร 80%?',
  cogs_menu_table: 'เมนูไหนควรปรับราคา?',
  avt_variance: 'ใช้วัตถุดิบจริงเกินสูตรเท่าไร?',
  production_yield: 'รอบผลิตได้ผลผลิตตามแผนไหม?',
  cogs_margin_menu_branch: 'เมนูเดียวกัน สาขาไหนทำกำไรต่ำกว่าเพื่อน?',
  branch_order_volume: 'แต่ละสาขาสั่งของจากครัวกลางเท่าไร?',
  cks_overview: 'ครัวกลางขายได้เท่าไร?',
  cks_by_customer_trend: 'ลูกค้าแต่ละรายสั่งเท่าไรในแต่ละวัน?',
  cks_customer_day_heatmap: 'ใครสั่งวันไหน เท่าไร?',
  cks_customer_ranking: 'ลูกค้ารายไหนสั่งมากที่สุด?',
  cks_top_products: 'ครัวกลางขายอะไรดีที่สุด?',
  cks_product_customer_matrix: 'สินค้าขายดีขายให้ใครบ้าง?',
  cks_by_category: 'ครัวกลางขายหมวดไหนมากที่สุด?',
  cks_weekday: 'วันไหนของสัปดาห์ส่งของมากที่สุด?',
  cks_fulfilment: 'ครัวกลางส่งได้ครบตามที่สั่งไหม?',
  cogs_branch_league: 'สาขาไหนคุมต้นทุนได้แย่ที่สุด?',
  wastage_top_branches: 'สาขาไหนของเสียเยอะที่สุด?',
  picking_fill_rate: 'ครัวกลางจัดของได้ครบตามที่สาขาขอไหม?',
  picking_trend: 'งานจัดของค้างเพิ่มขึ้นไหม?',
  branch_purchase_tabs: 'แต่ละสาขาซื้อเท่าไร วันนี้ 7 วัน 30 วัน?',
  stock_flow: 'สต็อกกำลังพอกขึ้นไหม?',
  wastage_trend: 'ของเสียเพิ่มขึ้นหรือลดลง?',
  wastage_top_products: 'สินค้าไหนเสียมากที่สุด?',
  stock_count_variance: 'นับสต็อกจริงตรงกับในระบบไหม?',
  batch_remaining: 'ของในล็อตไหนค้างนานผิดปกติ?',
  stock_value_by_category: 'เงินจมอยู่ในสต็อกหมวดไหน?',
  ita_three_way_match: 'บรรทัดไหน PO / รับของ / บิล ไม่ตรงกัน?',
  ita_overbilled: 'ถูกวางบิลเกินของที่รับจริงไปเท่าไร?',
  ita_short_delivery: 'เจ้าไหนส่งของขาดบ่อย?',
  ita_not_received: 'สั่งแล้วยังไม่ได้รับของ มีอะไรบ้าง?',
  ita_grn_not_invoiced: 'รับของแล้วแต่ยังไม่มีใบแจ้งหนี้เท่าไร?',
  ita_lead_time: 'แต่ละเจ้าส่งของใช้เวลากี่วัน?',
  ita_late_delivery: 'เจ้าไหนส่งช้ากว่านัด?',
  ita_price_dispersion: 'สินค้าเดียวกันจ่ายราคาไม่เท่ากันแค่ไหน?',
  ita_price_gap_saving: 'ถ้าซื้อได้ราคาต่ำสุดทุกครั้ง จะประหยัดเท่าไร?',
  ita_uom_mix: 'สินค้าไหนถูกบันทึกหลายหน่วยนับ?',
  ita_missing_code: 'บรรทัดไหนไม่มีรหัสสินค้า?',
  ita_code_convention: 'รหัสสินค้าไหนไม่เข้ารูปแบบ?',
  ita_order_frequency: 'สินค้าไหนสั่งถี่เกินไป?',
  ita_top_lines: 'รายการซื้อไหนมูลค่าสูงสุด?',
  ita_split_orders: 'ใบสั่งไหนถูกแตกส่งหลายรอบ?',
  ita_do_vs_grn: 'ของที่ส่งมากับของที่รับไม่ตรงกันตรงไหน?',
  sq_short_week_heatmap: 'เจ้าไหนส่งขาดมากขึ้นเรื่อย ๆ?',
  sq_scorecard: 'ซัพพลายเออร์รายไหนส่งของไม่ครบเป็นประจำ?',
  sq_short_value: 'ส่งขาดคิดเป็นเงินเท่าไร แยกตามเจ้า?',
  sq_mismatch_lines: 'บรรทัดไหนจำนวนในบิลไม่ตรงกับ PO?',
  sq_overbill_credit: 'บิลเกินที่ยังไม่ได้ใบลดหนี้คืนมีเท่าไร?',
  pc_price_week_heatmap: 'ราคาสินค้าเริ่มขึ้นสัปดาห์ไหน?',
  pc_movers: 'สินค้าไหนราคาขยับ?',
  pc_extra_by_product: 'ราคาที่ขยับทำให้จ่ายเพิ่มเท่าไร?',
  pc_extra_by_category: 'หมวดไหนกำลังแพงขึ้น?',
  pc_stale_recipe_cost: 'สูตรอาหารไหนยังใช้ราคาวัตถุดิบเก่า?',
  avt_branch_heatmap: 'สาขาไหนใช้วัตถุดิบเกินสูตร?',
  avt_summary: 'ใช้วัตถุดิบจริงเกินสูตรเท่าไร?',
  avt_explained_by_category: 'ใช้เกินสูตร อธิบายได้ด้วยของเสียแค่ไหน?',
  avt_items: 'วัตถุดิบไหนใช้เกินสูตรมากที่สุด?',
  ck_margin_kpi: 'กำไรจริงของครัวกลางเทียบกำไรตามสูตรเท่าไร?',
  ck_margin_table: 'กำไรครัวกลางรายเดือนเป็นอย่างไร?',
  ck_margin_trend: 'กำไรจริงห่างจากกำไรตามสูตรแค่ไหน?',
  ck_sales_vs_purchase: 'เดือนไหนครัวกลางซื้อเกินยอดขาย?',
  ck_category_mix: 'ครัวกลางขายและซื้ออะไรบ้าง?',
  bought_not_in_recipe: 'ซื้ออะไรมาที่ไม่อยู่ในสูตรไหนเลย?',
  pos_gm_recipe_vs_purchase: 'กำไรจากยอดขาย POS จริงเท่าไร?',
  pos_cogs_kpi: 'ยอดขาย POS ต้นทุน และกำไรขั้นต้นเท่าไร?',
  pos_cogs_trend: 'วันไหนขายดีแต่กำไรไม่ขึ้นตาม?',
  pos_menu_margin: 'แต่ละเมนูใน POS กำไรเท่าไร?',
  pos_low_margin: 'เมนูไหนใน POS มาร์จิ้นต่ำสุด?',
  pos_menu_gp: 'เมนูไหนใน POS สร้างกำไรมากที่สุด?',
  pos_branch_cogs: 'สาขาไหน COGS % สูงกว่าเพื่อน?',
  pos_category_mix: 'ยอดขายใน POS มาจากหมวดไหน?',
  pos_unmatched: 'เมนูไหนใน POS ยังไม่มีสูตร?',
  pos_branch_day_heatmap: 'สาขาไหนยอดตก หรือไม่ได้ส่งไฟล์?',
  cka_kpi: 'เดือนล่าสุดมีสาขาไหนควรตรวจไหม?',
  cka_heatmap: 'สาขาไหนซื้อจากครัวกลางน้อยผิดปกติ?',
  cka_ranking: 'สาขาไหนน่าสงสัยที่สุด?',
  cka_trend: 'สาขาไหนเริ่มซื้อจากครัวกลางน้อยลง?',
  cka_recipe: 'สาขาสั่งของครัวกลางพอดีกับที่ควรใช้ตามสูตรไหม?',
  cka_upt: 'แต่ละสาขาสั่งของหลักต่อการขายเท่าไร?',
  watch_price: 'วัตถุดิบไหนราคาขึ้นผิดปกติเมื่อเช้า?',
  watch_po: 'PO ไหนค้างไม่ปิดเกิน 7 วัน?',
  watch_so: 'SO ครัวกลางใบไหนค้างไม่ปิด?',
  watch_ck: 'สาขาไหนซื้อจากครัวกลางน้อยผิดปกติ 3 เดือนติด?',
};

// Role chips: which catalog categories each kind of reader usually wants.
const LIB_ROLES = [
  ['all', 'ทั้งหมด', null],
  ['owner', 'เจ้าของ / ผู้บริหาร', ['Alerts', 'Cost Control', 'Cross-report', 'Branch Audit', 'Branch']],
  ['purchasing', 'ฝ่ายจัดซื้อ', ['Alerts', 'Purchasing', 'Line Checks', 'Supplier Quality', 'Price Change']],
  ['ck', 'ครัวกลาง', ['Sales', 'Cross-report', 'Branch', 'Stock', 'Actual vs Theoretical']],
  ['branch', 'ผู้จัดการสาขา', ['Branch', 'Branch Audit', 'Stock', 'POS COGS']],
  ['menu', 'ต้นทุนเมนู', ['Menu Costing', 'Cost Control', 'POS COGS', 'Actual vs Theoretical']],
  ['accounting', 'บัญชี', ['Line Checks', 'Purchasing', 'Price Change', 'Cost Control']],
];
const LIB_PACK_ROLE = { owner_morning: 'owner', purchasing_check: 'purchasing', ck_margin: 'ck', menu_pricing: 'menu', branch_audit: 'branch' };
const LIB_CHART = {
  kpi: 'ตัวเลขสรุป', bar: 'แท่ง', line: 'เส้น', table: 'ตาราง', sensitivity: 'จำลองราคา', menu_breakdown: 'รายเมนู',
  donut: 'วงกลม', pareto: 'พาเรโต', scatter: 'จุด', treemap: 'กล่อง', range: 'ช่วงราคา', stack: 'แท่งซ้อน',
  panels: 'หลายกราฟ', tabs_bar: 'แท่งแยกแท็บ', heatmap: 'ตารางสี',
};
const LIB_SIZES = [['full', 'เต็มแถว'], ['half', 'ครึ่งแถว'], ['third', '1/3 แถว']];

const LIB_PAGE = 24;
const lib = { templates: [], usage: new Map(), packs: [], role: 'all', cat: '', q: '', hideUsed: false, detail: null, target: null, flash: '', shown: LIB_PAGE };

const libQuestion = (t) => LIB_QUESTIONS[t.template_key] || t.name;
const libDash = (id) => state.dashboards.find((d) => d.id === id);
function libSourceTag(t) {
  if (t.category === 'Alerts') return 'ตัวเตือน · LINE';
  if (t.category === 'Branch Audit') return 'FMH + ไฟล์ POS';
  if (String(t.report_source).startsWith('pos')) return 'ไฟล์ POS';
  return 'FMH';
}
// Short names for the category list (the Console keeps its longer ones).
const LIB_CAT_SHORT = {
  Alerts: 'ตัวเตือน (ส่ง LINE ได้)', 'Cost Control': 'ต้นทุนและกำไร', 'POS COGS': 'ต้นทุนจากยอดขาย POS', 'Branch Audit': 'ตรวจสาขา',
  'Cross-report': 'ข้ามรายงาน (ซื้อ × ขาย × สูตร)', 'Menu Costing': 'เมนูและสูตรอาหาร', 'Actual vs Theoretical': 'ใช้จริง vs ตามสูตร',
  Purchasing: 'จัดซื้อ', 'Price Change': 'ราคาที่ขยับ', 'Supplier Quality': 'คุณภาพซัพพลายเออร์', 'Line Checks': 'ตรวจเอกสารรายบรรทัด',
  Stock: 'สต็อกและของเสีย', Branch: 'สาขาและครัวกลาง', Sales: 'ยอดขายครัวกลาง',
};
const libCatLabel = (c) => LIB_CAT_SHORT[c] || (typeof catLabel === 'function' ? catLabel(c) : c);
const libCatRank = (c) => (typeof catRank === 'function' ? catRank(c) : 0);

// Small drawing of the chart type, so cards can be told apart at a glance.
function libThumb(type) {
  const c = 'var(--chili)', b = 'var(--series-blue)', g = 'var(--brass)', m = '#cfc6ad';
  const bars = (ws, col) => ws.map((w, i) => `<rect x="0" y="${4 + i * 21}" width="${w}" height="12" rx="3" fill="${col}" opacity="${1 - i * 0.17}"/>`).join('');
  const svg = {
    kpi: `<g fill="${m}" opacity=".5"><rect x="0" y="10" width="64" height="66" rx="8"/><rect x="78" y="10" width="64" height="66" rx="8"/><rect x="156" y="10" width="64" height="66" rx="8"/></g><g fill="var(--ink)"><rect x="10" y="40" width="40" height="10" rx="2"/><rect x="88" y="40" width="34" height="10" rx="2"/><rect x="166" y="40" width="44" height="10" rx="2"/></g>`,
    bar: bars([200, 150, 104, 70], c),
    tabs_bar: `<g fill="${m}"><rect x="40" y="0" width="30" height="6" rx="2"/><rect x="80" y="0" width="30" height="6" rx="2"/><rect x="120" y="0" width="30" height="6" rx="2"/></g><g transform="translate(0,14)">${bars([190, 130, 80], '#2F8F4E')}</g>`,
    stack: `<g transform="translate(0,4)">${[0, 1, 2, 3].map((i) => `<rect x="0" y="${i * 21}" width="${150 - i * 26}" height="12" rx="3" fill="${c}"/><rect x="${150 - i * 26}" y="${i * 21}" width="${44 - i * 6}" height="12" fill="${g}"/>`).join('')}</g>`,
    line: `<line x1="0" y1="18" x2="220" y2="18" stroke="${b}" stroke-width="3"/><polyline points="0,40 55,46 110,36 165,60 220,70" fill="none" stroke="${c}" stroke-width="3"/>`,
    pareto: `${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="${i * 36}" y="${20 + i * 10}" width="26" height="${66 - i * 10}" fill="${b}" opacity=".85"/>`).join('')}<polyline points="13,40 49,22 85,12 121,7 157,4 193,2" fill="none" stroke="${c}" stroke-width="2.5"/>`,
    table: `<rect x="0" y="0" width="220" height="14" rx="3" fill="${m}"/>${[0, 1, 2].map((i) => `<rect x="4" y="${24 + i * 20}" width="${80 - i * 12}" height="8" rx="2" fill="${m}"/><rect x="150" y="${24 + i * 20}" width="${60 - i * 18}" height="8" rx="2" fill="${c}" opacity="${1 - i * 0.25}"/>`).join('')}`,
    donut: `<circle cx="60" cy="43" r="32" fill="none" stroke="${c}" stroke-width="16" stroke-dasharray="90 200"/><circle cx="60" cy="43" r="32" fill="none" stroke="${b}" stroke-width="16" stroke-dasharray="60 200" stroke-dashoffset="-90"/><circle cx="60" cy="43" r="32" fill="none" stroke="${g}" stroke-width="16" stroke-dasharray="51 200" stroke-dashoffset="-150"/><g fill="${m}"><rect x="120" y="22" width="80" height="8" rx="2"/><rect x="120" y="40" width="64" height="8" rx="2"/><rect x="120" y="58" width="72" height="8" rx="2"/></g>`,
    scatter: `<line x1="110" y1="0" x2="110" y2="86" stroke="${m}"/><line x1="0" y1="43" x2="220" y2="43" stroke="${m}"/><g fill="${b}"><circle cx="150" cy="18" r="5"/><circle cx="174" cy="28" r="5"/><circle cx="60" cy="22" r="5"/></g><g fill="${c}"><circle cx="160" cy="64" r="5"/><circle cx="188" cy="70" r="5"/></g><g fill="${g}"><circle cx="40" cy="66" r="5"/><circle cx="78" cy="58" r="5"/></g>`,
    treemap: `<rect x="0" y="0" width="120" height="86" fill="${c}" opacity=".85"/><rect x="124" y="0" width="96" height="50" fill="${b}" opacity=".8"/><rect x="124" y="54" width="54" height="32" fill="${g}"/><rect x="182" y="54" width="38" height="32" fill="${m}"/>`,
    range: `<g stroke="${g}" stroke-width="3" stroke-linecap="round"><line x1="20" y1="12" x2="150" y2="12"/><line x1="60" y1="34" x2="200" y2="34"/><line x1="40" y1="56" x2="110" y2="56"/><line x1="90" y1="78" x2="170" y2="78"/></g><g fill="var(--ink)"><circle cx="20" cy="12" r="4"/><circle cx="60" cy="34" r="4"/><circle cx="40" cy="56" r="4"/><circle cx="90" cy="78" r="4"/></g>`,
    heatmap: [0, 1, 2].map((r) => [0, 1, 2, 3, 4, 5].map((k) => `<rect x="${k * 37}" y="${r * 30}" width="34" height="26" rx="3" fill="${c}" opacity="${[0.15, 0.3, 0.2, 0.85, 0.25, 0.15, 0.3, 0.2, 0.6, 0.9, 0.2, 0.25, 0.2, 0.25, 0.2, 0.95, 0.3, 0.2][r * 6 + k]}"/>`).join('')).join(''),
    panels: `<g fill="${m}" opacity=".5"><rect x="0" y="0" width="106" height="40" rx="6"/><rect x="114" y="0" width="106" height="40" rx="6"/><rect x="0" y="46" width="106" height="40" rx="6"/><rect x="114" y="46" width="106" height="40" rx="6"/></g><rect x="10" y="14" width="70" height="8" fill="${c}"/><polyline points="124,30 160,18 210,24" fill="none" stroke="${b}" stroke-width="2.5"/><rect x="10" y="60" width="50" height="8" fill="${g}"/><rect x="124" y="60" width="80" height="8" fill="${c}"/>`,
  };
  svg.sensitivity = svg.bar;
  svg.menu_breakdown = svg.donut;
  return `<svg aria-hidden="true" viewBox="0 0 220 86" preserveAspectRatio="xMidYMid meet">${svg[type] || svg.bar}</svg>`;
}

// ---------- entry ----------
async function openLibrary(opts = {}) {
  if (!el('admin-view').classList.contains('hidden')) {
    if (!leavePicker()) return;
    pickerDirty = false;
  }
  destroyCharts();
  el('dashboard-view').classList.add('hidden');
  el('admin-view').classList.add('hidden');
  el('library-view').classList.remove('hidden');
  // The library is part of settings: a company admin keeps the settings menu.
  el('app-shell').classList.remove('admin-mode');
  el('app-shell').classList.toggle('with-side', !isSuper());
  el('open-admin-btn').textContent = isSuper() ? adminBtnLabel() : '← กลับไปดู Dashboard';
  state.navCurrent = { kind: 'library' };
  renderSideNav();
  closeSideNav();
  lib.target = opts.dashboardId || null;
  lib.detail = opts.templateId || null;
  lib.flash = '';
  const view = el('library-view');
  view.innerHTML = '<p class="muted lib-loading">กำลังโหลดคลัง Widget...</p>';
  try {
    await libLoad();
  } catch (err) {
    view.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    return;
  }
  libRender();
}

async function libLoad() {
  const cid = state.viewCompanyId;
  const [tpl, usage, packs] = await Promise.all([
    api('/api/admin/widget-templates'),
    api(`/api/admin/companies/${cid}/widget-usage`),
    lib.packs.length ? Promise.resolve({ packs: lib.packs }) : api('/api/admin/widget-packs'),
    adminState.meta ? Promise.resolve() : api('/api/admin/meta').then((m) => (adminState.meta = m)),
  ]);
  lib.templates = tpl.templates.filter((t) => t.active);
  lib.packs = packs.packs;
  lib.usage = new Map();
  usage.usage.forEach((u) => {
    if (!lib.usage.has(u.template_id)) lib.usage.set(u.template_id, new Set());
    lib.usage.get(u.template_id).add(u.dashboard_id);
  });
}

function libRender() {
  window.scrollTo(0, 0);
  if (lib.detail) return libRenderDetail(lib.detail);
  libRenderGrid();
}

// ---------- browse ----------
function libFiltered() {
  const role = LIB_ROLES.find(([k]) => k === lib.role);
  const cats = role && role[2];
  const q = lib.q.trim().toLowerCase();
  return lib.templates
    .filter((t) => !cats || cats.includes(t.category))
    .filter((t) => !lib.cat || t.category === lib.cat)
    .filter((t) => !lib.hideUsed || !(lib.usage.get(t.id) || new Set()).size)
    .filter((t) => !q || [libQuestion(t), t.name, t.description, libCatLabel(t.category)].join(' ').toLowerCase().includes(q))
    .sort((a, b) => libCatRank(a.category) - libCatRank(b.category) || (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
}

function libUsedLine(t) {
  const on = [...(lib.usage.get(t.id) || [])].map(libDash).filter(Boolean);
  if (!on.length) return '';
  return `<span class="lib-in">✓ อยู่ใน: ${esc(on[0].display_name)}${on.length > 1 ? ` +${on.length - 1}` : ''}</span>`;
}

function libCard(t) {
  return `<button type="button" class="lib-card" data-tid="${t.id}">
    <span class="lib-thumb">${libThumb(t.chart_type)}</span>
    <span class="lib-card-body">
      <span class="lib-q">${esc(libQuestion(t))}</span>
      <span class="lib-sub">${esc(t.description || t.name)}</span>
      <span class="lib-foot">
        <span class="lib-tag">${esc(LIB_CHART[t.chart_type] || t.chart_type)}</span>
        <span class="lib-tag${t.category === 'Alerts' ? ' line' : ''}">${esc(libSourceTag(t))}</span>
        ${libUsedLine(t) || '<span class="lib-add-hint">+ เพิ่ม</span>'}
      </span>
    </span>
  </button>`;
}

function libRenderGrid() {
  const view = el('library-view');
  const list = libFiltered();
  const role = LIB_ROLES.find(([k]) => k === lib.role);
  const cats = [...new Set(lib.templates.map((t) => t.category))].sort((a, b) => libCatRank(a) - libCatRank(b));
  const roleCats = role && role[2];
  const count = (c) => lib.templates.filter((t) => t.category === c).length;
  const packs = lib.packs.filter((p) => lib.role === 'all' || LIB_PACK_ROLE[p.key] === lib.role);
  const showPacks = !lib.q && !lib.cat && packs.length && !lib.target;
  const target = lib.target && libDash(lib.target);
  view.innerHTML = `
    <div class="lib-wrap">
      <header class="lib-head">
        ${isSuper() ? '<button type="button" class="link-btn lib-home">← กลับไปดู Dashboard</button>' : ''}
        <h1 class="lib-h1">คลัง Widget</h1>
        <p class="lib-lead">เริ่มจากคำถามที่อยากรู้ ไม่ต้องจำชื่อ widget · กดดูตัวอย่างบนข้อมูลของบริษัท แล้วเพิ่มลง Dashboard ไหนก็ได้</p>
        ${target ? `<div class="lib-target"><span>กำลังเลือก widget ให้ <b>${esc(target.display_name)}</b></span><button type="button" class="link-btn lib-target-clear">เลือกให้ Dashboard อื่น</button></div>` : ''}
        ${lib.flash ? `<div class="ok-msg">${lib.flash}</div>` : ''}
        <label class="lib-search">
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <span class="sr-only">ค้นหา widget</span>
          <input type="search" class="lib-q-input" value="${esc(lib.q)}" placeholder="อยากรู้อะไร เช่น “ส่งของขาด” “กำไร” “ราคาขึ้น”">
        </label>
        <div class="lib-roles" role="group" aria-label="กรองตามบทบาท">
          ${LIB_ROLES.map(([k, label]) => `<button type="button" class="lib-chip${lib.role === k ? ' on' : ''}" data-role="${k}" aria-pressed="${lib.role === k}">${esc(label)}</button>`).join('')}
        </div>
      </header>
      ${
        showPacks
          ? `<section class="lib-packs" aria-labelledby="lib-packs-h">
              <div class="lib-sec-head"><h2 id="lib-packs-h">ชุด Dashboard สำเร็จรูป</h2><span class="muted">กดครั้งเดียวได้ Dashboard ใหม่ทั้งหน้า แก้ต่อได้ทีหลัง</span></div>
              <div class="lib-pack-grid">${packs
                .map(
                  (p) => `<div class="lib-pack">
                    <span class="lib-pack-role">${esc(p.role)}</span>
                    <b class="lib-pack-title">${esc(p.title)}</b>
                    <span class="lib-sub">${esc(p.description)}</span>
                    <span class="lib-pack-foot"><span class="lib-tag">${p.templates.length} widget</span>
                    <button type="button" class="btn small ghost lib-pack-use" data-pack="${esc(p.key)}">สร้าง Dashboard นี้</button></span>
                  </div>`
                )
                .join('')}</div>
            </section>`
          : ''
      }
      <section class="lib-browse" aria-label="widget ทั้งหมด">
        <div class="lib-cats">
          <h2 class="lib-cats-h">หมวด</h2>
          <button type="button" class="lib-cat${!lib.cat ? ' on' : ''}" data-cat="">ทั้งหมด <span>${roleCats ? lib.templates.filter((t) => roleCats.includes(t.category)).length : lib.templates.length}</span></button>
          ${cats
            .filter((c) => !roleCats || roleCats.includes(c))
            .map((c) => `<button type="button" class="lib-cat${lib.cat === c ? ' on' : ''}" data-cat="${esc(c)}">${esc(libCatLabel(c))} <span>${count(c)}</span></button>`)
            .join('')}
        </div>
        <div class="lib-results">
          <div class="lib-toolbar">
            <span>${list.length} widget</span>
            <label class="check-inline"><input type="checkbox" class="lib-hide-used"${lib.hideUsed ? ' checked' : ''}> ซ่อนตัวที่ใช้อยู่แล้ว</label>
          </div>
          ${list.length ? `<div class="lib-grid">${list.slice(0, lib.shown).map(libCard).join('')}</div>` : '<p class="muted lib-empty">ไม่พบ widget ที่ตรงกับคำค้น ลองคำอื่น หรือเลือก “ทั้งหมด”</p>'}
          ${list.length > lib.shown ? `<button type="button" class="btn ghost lib-more">ดูเพิ่มอีก ${list.length - lib.shown} widget</button>` : ''}
        </div>
      </section>
    </div>`;

  const input = view.querySelector('.lib-q-input');
  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      lib.q = input.value;
      lib.shown = LIB_PAGE;
      const pos = input.selectionStart;
      libRenderGrid();
      const again = el('library-view').querySelector('.lib-q-input');
      again.focus();
      again.setSelectionRange(pos, pos);
    }, 200);
  });
  view.querySelectorAll('.lib-chip').forEach((b) => b.addEventListener('click', () => { lib.role = b.dataset.role; lib.cat = ''; lib.shown = LIB_PAGE; libRenderGrid(); }));
  view.querySelectorAll('.lib-cat').forEach((b) => b.addEventListener('click', () => { lib.cat = b.dataset.cat; lib.shown = LIB_PAGE; libRenderGrid(); }));
  view.querySelector('.lib-hide-used').addEventListener('change', (e) => { lib.hideUsed = e.target.checked; libRenderGrid(); });
  const more = view.querySelector('.lib-more');
  if (more) more.addEventListener('click', () => {
    const y = window.scrollY;
    lib.shown += LIB_PAGE * 2;
    libRenderGrid();
    window.scrollTo(0, y);
  });
  view.querySelectorAll('.lib-card').forEach((b) => b.addEventListener('click', () => { lib.detail = Number(b.dataset.tid); lib.flash = ''; libRender(); }));
  const home = view.querySelector('.lib-home');
  if (home) home.addEventListener('click', () => goDashboard(lib.target || state.activeDashboardId || (state.dashboards[0] || {}).id));
  const clear = view.querySelector('.lib-target-clear');
  if (clear) clear.addEventListener('click', () => { lib.target = null; libRenderGrid(); });
  view.querySelectorAll('.lib-pack-use').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'กำลังสร้าง...';
      try {
        const r = await api(`/api/admin/companies/${state.viewCompanyId}/packs/${b.dataset.pack}`, { method: 'POST', body: '{}' });
        await refreshDashboardList();
        goDashboard(r.id);
      } catch (err) {
        b.disabled = false;
        b.textContent = 'สร้าง Dashboard นี้';
        lib.flash = '';
        b.closest('.lib-pack').insertAdjacentHTML('beforeend', `<div class="error-msg">${esc(err.message)}</div>`);
      }
    })
  );
}

// ---------- one widget ----------
async function libRenderDetail(tid) {
  const t = lib.templates.find((x) => x.id === tid);
  const view = el('library-view');
  if (!t) { lib.detail = null; return libRenderGrid(); }
  const on = lib.usage.get(t.id) || new Set();
  const defaultSize = (() => {
    try { return JSON.parse(t.default_config_json || '{}').size || 'half'; } catch (e) { return 'half'; }
  })();
  const inPacks = lib.packs.filter((p) => p.templates.includes(t.template_key));
  const relatedKeys = [...new Set(inPacks.flatMap((p) => p.templates))].filter((k) => k !== t.template_key);
  let related = lib.templates.filter((x) => relatedKeys.includes(x.template_key));
  if (related.length < 3) related = related.concat(lib.templates.filter((x) => x.category === t.category && x.id !== t.id && !related.includes(x)));
  related = related.slice(0, 3);
  const sources = (() => {
    const meta = adminState.meta && adminState.meta.report_sources;
    return meta && meta[t.report_source] ? meta[t.report_source].label : t.report_source;
  })();

  view.innerHTML = `
    <div class="lib-wrap lib-detail">
      <nav class="lib-crumb" aria-label="ตำแหน่ง"><button type="button" class="link-btn lib-back">คลัง Widget</button> <span aria-hidden="true">›</span> <span>${esc(libCatLabel(t.category))}</span></nav>
      <div class="lib-detail-grid">
        <div class="lib-detail-main">
          <header>
            <h1 class="lib-h1">${esc(libQuestion(t))}</h1>
            <p class="lib-lead"><b>${esc(t.name)}</b>${t.description ? ` · ${esc(t.description)}` : ''}</p>
          </header>
          <section class="lib-preview" aria-label="ตัวอย่าง">
            <div class="lib-preview-head"><b>ตัวอย่างบนข้อมูลของบริษัทนี้</b></div>
            <div class="lib-preview-body"><p class="muted">กำลังโหลดตัวอย่าง...</p></div>
          </section>
          <dl class="lib-facts">
            <div><dt>รูปแบบ</dt><dd>${esc(LIB_CHART[t.chart_type] || t.chart_type)}</dd></div>
            <div><dt>ข้อมูลที่ใช้</dt><dd>${esc(sources)}</dd></div>
            <div><dt>ส่งเข้า LINE</dt><dd>${t.category === 'Alerts' ? 'ได้ ตั้งค่าที่ ตัวเตือน &amp; LINE' : 'ไม่ได้ (ดูหมวดตัวเตือน)'}</dd></div>
            <div><dt>อยู่ใน Dashboard</dt><dd>${on.size ? [...on].map(libDash).filter(Boolean).map((d) => esc(d.display_name)).join(', ') : 'ยังไม่มี'}</dd></div>
          </dl>
          ${
            related.length
              ? `<section class="lib-related"><h2>มักใช้คู่กับ</h2><div class="lib-related-grid">${related
                  .map((r) => `<button type="button" class="lib-mini" data-tid="${r.id}"><b>${esc(libQuestion(r))}</b><span class="muted">${esc(LIB_CHART[r.chart_type] || r.chart_type)}${(lib.usage.get(r.id) || new Set()).size ? ' · ✓ ใช้อยู่' : ''}</span></button>`)
                  .join('')}</div></section>`
              : ''
          }
        </div>
        <aside class="lib-add" aria-labelledby="lib-add-h">
          <h2 id="lib-add-h">เพิ่มลง Dashboard</h2>
          <form class="lib-add-form">
            <div class="lib-dash-list">
              ${state.dashboards
                .map((d) => {
                  const had = on.has(d.id);
                  return `<label class="lib-dash${had ? ' had' : ''}"><input type="checkbox" name="d" value="${d.id}"${had ? ' checked disabled' : lib.target === d.id ? ' checked' : ''}> <span>${esc(d.display_name)}</span>${had ? '<span class="muted lib-had">มีอยู่แล้ว</span>' : ''}</label>`;
                })
                .join('') || '<p class="muted">ยังไม่มี dashboard</p>'}
              <label class="lib-dash lib-new"><input type="checkbox" name="new"> <span>สร้าง Dashboard ใหม่</span></label>
              <input type="text" name="new_name" class="lib-new-name" maxlength="120" placeholder="ชื่อ Dashboard ใหม่" hidden>
            </div>
            <label class="lib-size">ขนาดบน Dashboard
              <select name="size">${LIB_SIZES.map(([k, l]) => `<option value="${k}"${k === defaultSize ? ' selected' : ''}>${l}${k === defaultSize ? ' (แนะนำ)' : ''}</option>`).join('')}</select>
            </label>
            <button type="submit" class="btn primary lib-add-btn" disabled>เลือก Dashboard ก่อน</button>
            <div class="lib-add-msg" role="status"></div>
          </form>
          <p class="muted lib-add-note">จัดลำดับต่อได้ที่ Dashboard ด้วยปุ่ม “จัดเรียง / แก้ไข”</p>
        </aside>
      </div>
    </div>`;

  view.querySelector('.lib-back').addEventListener('click', () => { lib.detail = null; libRender(); });
  view.querySelectorAll('.lib-mini').forEach((b) => b.addEventListener('click', () => { lib.detail = Number(b.dataset.tid); libRender(); }));

  const form = view.querySelector('.lib-add-form');
  const btn = form.querySelector('.lib-add-btn');
  const newName = form.querySelector('.lib-new-name');
  const sync = () => {
    const n = form.querySelectorAll('input[name="d"]:checked:not(:disabled)').length + (form.new.checked ? 1 : 0);
    newName.hidden = !form.new.checked;
    btn.disabled = !n || (form.new.checked && !newName.value.trim());
    btn.textContent = n ? `เพิ่มลง ${n} Dashboard` : 'เลือก Dashboard ก่อน';
  };
  form.addEventListener('change', sync);
  newName.addEventListener('input', sync);
  form.new.addEventListener('change', () => { if (form.new.checked) newName.focus(); });
  sync();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ids = [...form.querySelectorAll('input[name="d"]:checked:not(:disabled)')].map((i) => Number(i.value));
    btn.disabled = true;
    btn.textContent = 'กำลังเพิ่ม...';
    const msg = form.querySelector('.lib-add-msg');
    try {
      const r = await api(`/api/admin/companies/${state.viewCompanyId}/library-add`, {
        method: 'POST',
        body: JSON.stringify({ template_id: t.id, dashboard_ids: ids, new_dashboard_name: form.new.checked ? newName.value : '', size: form.size.value }),
      });
      if (r.added.some((a) => a.created)) await refreshDashboardList();
      r.added.forEach((a) => { if (!lib.usage.has(t.id)) lib.usage.set(t.id, new Set()); lib.usage.get(t.id).add(a.id); });
      const first = r.added[0];
      libRenderDetail(t.id);
      const out = el('library-view').querySelector('.lib-add-msg');
      out.innerHTML = `<div class="ok-msg lib-done"><b>เพิ่มลง ${r.added.map((a) => `“${esc(a.display_name)}”`).join(', ')} แล้ว</b>
        <span><button type="button" class="link-btn lib-go" data-id="${first.id}">ไปดู Dashboard →</button>
        <button type="button" class="link-btn lib-more">เลือกต่อในคลัง</button></span></div>`;
      out.querySelector('.lib-go').addEventListener('click', () => goDashboard(first.id));
      out.querySelector('.lib-more').addEventListener('click', () => { lib.detail = null; libRender(); });
    } catch (err) {
      msg.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
      sync();
    }
  });

  // Live preview: the real renderer on this company's cached rows.
  const body = view.querySelector('.lib-preview-body');
  try {
    const payload = await api(`/api/dashboards/preview/${t.id}${isSuper() ? `?company_id=${state.viewCompanyId}` : ''}`);
    if (lib.detail !== t.id || !body.isConnected) return;
    if (payload.dashboard.data_source === 'demo') view.querySelector('.lib-preview-head').insertAdjacentHTML('beforeend', ' <span class="demo-pill">ข้อมูลตัวอย่าง</span>');
    new DashboardView(body, payload).load();
  } catch (err) {
    body.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}
