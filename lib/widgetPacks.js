// Ready-made dashboards for the Widget library ("ชุด Dashboard สำเร็จรูป").
// One click makes a new dashboard with these widgets, in this order; the
// customer edits it afterwards like any other. Keys are widget template_keys —
// a key whose template is missing or inactive is simply skipped.
const PACKS = [
  {
    key: 'owner_morning',
    role: 'เจ้าของ / ผู้บริหาร',
    title: 'เช้านี้ต้องดูอะไร',
    description: 'ตัวเตือนที่ส่ง LINE กำไรจริงของครัวกลาง ของเสีย และราคาที่ขยับ',
    templates: ['watch_price', 'watch_po', 'ck_margin_kpi', 'ck_margin_trend', 'wastage_top_branches', 'pc_extra_by_category'],
  },
  {
    key: 'purchasing_check',
    role: 'ฝ่ายจัดซื้อ',
    title: 'ตรวจ PO / รับของ / วางบิล',
    description: 'งานค้างวันนี้ บิลเกิน ส่งขาด PO ค้าง และของที่รอใบแจ้งหนี้',
    templates: ['ops_snapshot', 'watch_po', 'ita_overbilled', 'ita_short_delivery', 'ita_not_received', 'ita_grn_not_invoiced', 'sq_scorecard'],
  },
  {
    key: 'ck_margin',
    role: 'ครัวกลาง',
    title: 'กำไรจริง เทียบ กำไรตามสูตร',
    description: 'GM สองแบบ ช่องว่างรายเดือน ยอดขายเทียบยอดซื้อ และ SO ที่ค้าง',
    templates: ['ck_margin_kpi', 'ck_margin_table', 'ck_margin_trend', 'ck_sales_vs_purchase', 'cks_overview', 'watch_so'],
  },
  {
    key: 'menu_pricing',
    role: 'ต้นทุนเมนู',
    title: 'เมนูไหนควรปรับราคา',
    description: 'มาร์จิ้นต่ำ เมทริกซ์เมนู เมนูที่สร้างกำไร และต้นทุนสูตรที่ล้าหลังราคาซื้อ',
    templates: ['cogs_overview', 'cogs_low_margin', 'menu_matrix', 'cogs_menu_gp', 'pc_stale_recipe_cost', 'cogs_menu_table'],
  },
  {
    key: 'branch_audit',
    role: 'ผู้จัดการสาขา',
    title: 'ตรวจสาขา: ซื้อจากครัวกลางสมส่วนไหม',
    description: 'ต้องมีไฟล์ยอดขาย POS · สาขาที่ซื้อน้อยผิดปกติเทียบยอดขาย รายเดือน',
    templates: ['watch_ck', 'cka_kpi', 'cka_ranking', 'cka_heatmap', 'cka_trend'],
  },
  {
    key: 'branch_daily',
    role: 'ผู้จัดการสาขา',
    title: 'สาขาประจำวัน',
    description: 'ใบสั่งซื้อที่รอรับ ของเสีย สต็อกที่นับไม่ตรง และของที่ซื้อเข้าสาขา',
    templates: ['branch_purchase_tabs', 'po_status_mix', 'wastage_top_branches', 'wastage_trend', 'stock_count_variance', 'stock_flow'],
  },
  {
    key: 'accounting_close',
    role: 'บัญชี',
    title: 'ปิดเดือน: ใบแจ้งหนี้และใบลดหนี้',
    description: 'รับของแล้วยังไม่มีใบแจ้งหนี้ บิลเกิน ใบลดหนี้ที่ต้องตามเก็บ และยอดซื้อแยกหมวด/ซัพพลายเออร์',
    templates: ['pa_kpis', 'ita_grn_not_invoiced', 'ita_overbilled', 'sq_overbill_credit', 'credit_note_by_supplier', 'pa_supplier_spend', 'pa_category_trend'],
  },
  {
    key: 'ck_daily',
    role: 'ครัวกลาง',
    title: 'ครัวกลางประจำวัน',
    description: 'SO ค้าง งานจัดของ ส่งครบตามสั่งไหม ของค้างในล็อต และวันที่ส่งหนักที่สุด',
    templates: ['watch_so', 'picking_fill_rate', 'picking_trend', 'cks_fulfilment', 'batch_remaining', 'cks_weekday'],
  },
];

module.exports = { PACKS };
