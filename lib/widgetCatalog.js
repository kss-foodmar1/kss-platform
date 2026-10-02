// The built-in Widget Catalog.
//
// A widget template = one report source + a chart_type (which generic renderer
// draws it) + a default config. Templates are company-agnostic: the KSS team
// builds them once here, then places instances of them onto any company's
// dashboards from the Admin Console (with per-instance config overrides).
//
// syncCatalog() upserts these into widget_templates on every boot, keyed by
// template_key — except templates the team has edited in the Admin Console
// (customized = TRUE), which are left alone so their edits aren't overwritten.
//
// Config mini-language (evaluated in public/app.js):
//   metric: { op: 'sum', field }          field may be an array = fallback list
//           { op: 'count' }
//           { op: 'count_distinct', field }
//           { op: 'div', a, b }            a / b
//           { op: 'ratio_pct', a, b }      a / b * 100
//           { op: 'pct_change', from, to } (to - from) / from * 100
//           { op: 'diff', a, b }           a - b
//   format: 'currency' | 'number' | 'decimal1' | 'pct' | 'pct_signed'
//   size:   'full' | 'half' | 'third'     width on the dashboard grid
//   color_mode (bar): 'signed' = diverging blue (+) / chili (-);
//                     'margin' = status red (<0) / amber (<20%) / green
// Series colors are validated for color-blind separation (dataviz validator,
// light + dark): PO gold #A9812F -> GRN blue #2F6FB0 -> Invoice chili #BE4229.
// Green is reserved for "good" status, so it's never used as a series color.
const pool = require('../db/pool');

const sum = (field) => ({ op: 'sum', field });
const MENU = ['menu_name', 'menu_code'];
const INGREDIENT = ['ingredient_name', 'ingredient_code'];

const CHART_TYPES = ['kpi', 'bar', 'line', 'table', 'sensitivity', 'menu_breakdown'];

const BUILTIN_TEMPLATES = [
  // ---------- Purchasing (FMH purchase_analysis) ----------
  {
    template_key: 'pa_kpis',
    name: 'สรุปยอด PO / GRN / Invoice',
    description: 'ยอดรวม PO, GRN, Invoice และ % ส่วนต่างระหว่างกัน',
    category: 'Purchasing',
    report_source: 'purchase-analysis',
    chart_type: 'kpi',
    config: {
      size: 'full',
      metrics: [
        { label: 'Total PO value', format: 'currency', value: sum('po_total') },
        { label: 'Total GRN value', format: 'currency', value: sum('grn_total') },
        { label: 'Total Invoice value', format: 'currency', value: sum('invoice_total') },
        { label: 'GRN vs PO', format: 'pct_signed', value: { op: 'pct_change', from: sum('po_total'), to: sum('grn_total') } },
        { label: 'Invoice vs GRN', format: 'pct_signed', value: { op: 'pct_change', from: sum('grn_total'), to: sum('invoice_total') } },
      ],
    },
  },
  {
    template_key: 'pa_trend',
    name: 'PO vs GRN vs Invoice ตามเวลา',
    description: 'กราฟเส้นรายสัปดาห์ เทียบมูลค่า PO, GRN และ Invoice',
    category: 'Purchasing',
    report_source: 'purchase-analysis',
    chart_type: 'line',
    config: {
      size: 'full',
      date_fields: ['order_date', 'issued_date', 'grn_date', 'invoice_date'],
      bucket: 'week',
      format: 'currency',
      series: [
        { label: 'PO', value: sum('po_total'), color: '#A9812F' },
        { label: 'GRN', value: sum('grn_total'), color: '#2F6FB0' },
        { label: 'Invoice', value: sum('invoice_total'), color: '#BE4229' },
      ],
    },
  },
  {
    template_key: 'pa_attention_products',
    name: 'สินค้าที่ต้องจับตา (GRN ต่างจาก PO)',
    description: 'สินค้าที่มูลค่า GRN ต่างจาก PO มากที่สุด',
    category: 'Purchasing',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'third',
      group_by: ['product_name', 'product_code'],
      value: { op: 'pct_change', from: sum('po_total'), to: sum('grn_total') },
      rank_by: { op: 'diff', a: sum('grn_total'), b: sum('po_total') },
      sort: 'abs_desc',
      top_n: 10,
      format: 'pct_signed',
      color_mode: 'signed',
    },
  },
  {
    template_key: 'pa_top_suppliers',
    name: 'Top supplier ตามยอด PO',
    description: 'ซัพพลายเออร์ที่มียอดสั่งซื้อสูงสุด',
    category: 'Purchasing',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'third',
      group_by: ['supplier'],
      value: sum('po_total'),
      sort: 'desc',
      top_n: 10,
      format: 'currency',
      color: '#2F6FB0',
    },
  },
  {
    template_key: 'pa_category_variance',
    name: 'ส่วนต่าง GRN vs PO ตามหมวดหมู่',
    description: 'หมวดหมู่ที่ใช้จ่ายมากที่สุด พร้อม % ส่วนต่าง GRN เทียบ PO',
    category: 'Purchasing',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'third',
      group_by: ['category_name'],
      value: { op: 'pct_change', from: sum('po_total'), to: sum('grn_total') },
      rank_by: sum('po_total'),
      sort: 'desc',
      top_n: 10,
      format: 'pct_signed',
      color_mode: 'signed',
    },
  },
  {
    template_key: 'pa_table',
    name: 'ตารางข้อมูลจัดซื้อ (ละเอียด)',
    description: 'ข้อมูลดิบจาก purchase analysis พร้อม export',
    category: 'Purchasing',
    report_source: 'purchase-analysis',
    chart_type: 'table',
    config: { size: 'full', top_n: 200 },
  },

  // ---------- Menu costing (FMH menu_and_ingredients) ----------
  {
    template_key: 'mc_kpis',
    name: 'สรุปต้นทุนสูตรอาหาร',
    description: 'ต้นทุนสูตรรวม จำนวนเมนู วัตถุดิบ และค่าเฉลี่ยวัตถุดิบต่อเมนู',
    category: 'Menu Costing',
    report_source: 'menu-costing',
    chart_type: 'kpi',
    config: {
      size: 'full',
      metrics: [
        { label: 'Total recipe cost', format: 'currency', value: sum('total_cost') },
        { label: 'Menus', format: 'number', value: { op: 'count_distinct', field: MENU } },
        { label: 'Distinct ingredients', format: 'number', value: { op: 'count_distinct', field: INGREDIENT } },
        {
          label: 'Avg ingredients / menu',
          format: 'decimal1',
          value: { op: 'div', a: { op: 'count' }, b: { op: 'count_distinct', field: MENU } },
        },
      ],
    },
  },
  {
    template_key: 'mc_top_ingredients',
    name: 'วัตถุดิบที่กระทบต้นทุนมากที่สุด',
    description: 'วัตถุดิบเรียงตามต้นทุนรวมทุกเมนู พร้อมจำนวนเมนูที่ใช้',
    category: 'Menu Costing',
    report_source: 'menu-costing',
    chart_type: 'bar',
    config: {
      size: 'full',
      group_by: INGREDIENT,
      value: sum('total_cost'),
      sort: 'desc',
      top_n: 12,
      format: 'currency',
      color: '#BE4229',
      label_extra: { value: { op: 'count_distinct', field: MENU }, suffix: ' เมนู' },
    },
  },
  {
    template_key: 'mc_top_menus',
    name: 'เมนูต้นทุนสูงสุด',
    description: 'เมนูเรียงตามต้นทุนสูตรรวม',
    category: 'Menu Costing',
    report_source: 'menu-costing',
    chart_type: 'bar',
    config: { size: 'half', group_by: MENU, value: sum('total_cost'), sort: 'desc', top_n: 10, format: 'currency', color: '#A9812F' },
  },
  {
    template_key: 'mc_sensitivity',
    name: 'Ingredient price sensitivity',
    description: 'ถ้าราคาวัตถุดิบขยับ X% ต้นทุนเมนูที่ใช้วัตถุดิบนั้นขยับกี่ %',
    category: 'Menu Costing',
    report_source: 'menu-costing',
    chart_type: 'sensitivity',
    config: { size: 'half', top_n: 10, default_pct: 10 },
  },
  {
    template_key: 'mc_menu_breakdown',
    name: 'มุมมองรายเมนู — วัตถุดิบไหนคุมต้นทุน',
    description: 'เลือกเมนู ดูสัดส่วนต้นทุนวัตถุดิบ และผลกระทบถ้าราคาวัตถุดิบขยับ',
    category: 'Menu Costing',
    report_source: 'menu-costing',
    chart_type: 'menu_breakdown',
    config: { size: 'full', top_n: 10, default_pct: 10 },
  },

  // ---------- COGS (FMH cogs) ----------
  {
    template_key: 'cogs_kpis',
    name: 'สรุปยอดขาย / COGS / กำไรขั้นต้น',
    description: 'ยอดขาย ต้นทุน กำไรขั้นต้น และ gross margin',
    category: 'Cost Control',
    report_source: 'cogs',
    chart_type: 'kpi',
    config: {
      size: 'full',
      metrics: [
        { label: 'Total sales', format: 'currency', value: sum('total_sales') },
        { label: 'Total COGS', format: 'currency', value: sum('total_cost') },
        { label: 'Gross profit', format: 'currency', value: sum('gross_profit') },
        { label: 'Gross margin', format: 'pct', value: { op: 'ratio_pct', a: sum('gross_profit'), b: sum('total_sales') } },
      ],
    },
  },
  {
    template_key: 'cogs_lowest_margin',
    name: 'เมนูมาร์จิ้นต่ำสุด',
    description: 'เมนูที่ gross margin ต่ำที่สุด',
    category: 'Cost Control',
    report_source: 'cogs',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: ['menu_name', 'sku'],
      value: { op: 'ratio_pct', a: sum('gross_profit'), b: sum('total_sales') },
      sort: 'asc',
      top_n: 10,
      format: 'pct',
      color_mode: 'margin',
    },
  },
  {
    template_key: 'cogs_margin_by_branch',
    name: 'Gross margin ตามสาขา',
    description: 'เปรียบเทียบ gross margin ของแต่ละสาขา',
    category: 'Cost Control',
    report_source: 'cogs',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: ['branch_name'],
      value: { op: 'ratio_pct', a: sum('gross_profit'), b: sum('total_sales') },
      sort: 'desc',
      top_n: 20,
      format: 'pct',
      color_mode: 'margin',
    },
  },
  {
    template_key: 'cogs_table',
    name: 'ตาราง COGS (ละเอียด)',
    description: 'ข้อมูลดิบจากรายงาน COGS พร้อม export',
    category: 'Cost Control',
    report_source: 'cogs',
    chart_type: 'table',
    config: { size: 'full', top_n: 200 },
  },

  // ---------- Sales (FMH order_items_by_branch) ----------
  {
    template_key: 'sb_table',
    name: 'ตาราง Order Items by Branch',
    description: 'รายการสั่งของแต่ละสาขา (ข้อมูลดิบ) พร้อม export',
    category: 'Sales',
    report_source: 'sales-by-branch',
    chart_type: 'table',
    config: { size: 'full', top_n: 200 },
  },
// ---------- Batch 1: FMH cards and server-side groupings ----------
  //
  // These read either a card FMH has already aggregated, or a card with
  // group_by so FMH does the grouping. Both cost a handful of rows against the
  // monthly quota instead of the thousands an itemized pull costs, which is the
  // constraint that actually limits how many widgets a client can run.
  //
  // Eight of them share one pull (cogs grouped by menu), so a dashboard built
  // from those costs exactly one request no matter how many of them it shows.

  // --- COGS: cards ---
  {
    template_key: 'cogs_overview',
    name: 'สรุป COGS และกำไรขั้นต้น',
    description: 'ยอดขาย ต้นทุนขาย กำไรขั้นต้น และ COGS % ที่ FMH สรุปมาให้แล้ว',
    category: 'Cost Control',
    report_source: 'cogs-stat',
    chart_type: 'kpi',
    config: {
      size: 'full',
      metrics: [
        { label: 'ยอดขาย', format: 'currency', value: sum('total_sales') },
        { label: 'ต้นทุนขาย', format: 'currency', value: sum('total_cogs') },
        { label: 'กำไรขั้นต้น', format: 'currency', value: sum('gross_profit') },
        { label: 'COGS %', format: 'pct', value: sum('cogs_percentage') },
      ],
    },
  },
  {
    template_key: 'cogs_trend',
    name: 'ยอดขาย ต้นทุน กำไร ตามเวลา',
    description: 'สามเส้นตามงวด เห็นว่ากำไรที่หายไปมาจากยอดขายตกหรือต้นทุนขึ้น',
    category: 'Cost Control',
    report_source: 'cogs-trend',
    chart_type: 'line',
    config: {
      size: 'full',
      date_fields: ['period'],
      bucket: 'day', // each row is already one period; don't re-bucket it
      format: 'currency',
      series: [
        { label: 'ยอดขาย', value: sum('sales'), color: '#A9812F' },
        { label: 'ต้นทุนขาย', value: sum('cogs'), color: '#2F6FB0' },
        { label: 'กำไรขั้นต้น', value: sum('gross_profit'), color: '#BE4229' },
      ],
    },
  },
  {
    template_key: 'cogs_low_margin',
    name: 'เมนูมาร์จิ้นต่ำสุด',
    description: 'เมนูที่ gross margin ต่ำที่สุด เทียบเส้นเป้าของร้าน',
    category: 'Cost Control',
    report_source: 'cogs-low-margin',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: ['menu_name'],
      value: sum('gross_margin_percentage'),
      sort: 'asc',
      top_n: 10,
      format: 'pct',
      threshold: 60,
      lower_is_better: false,
    },
  },

  // --- COGS: one grouped pull, eight widgets ---
  {
    template_key: 'cogs_yield_loss',
    name: 'ต้นทุนที่หายไปกับ yield loss',
    description: 'เมนูที่สูญเสียต้นทุนจากการตัดแต่งและของเหลือมากที่สุด เป็นบาท',
    category: 'Cost Control',
    report_source: 'cogs',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: 'menu',
      group_by_field: ['menu_name'],
      value: sum('total_yield_loss_cost'),
      sort: 'desc',
      top_n: 10,
      format: 'currency',
      color: '#BE4229',
    },
  },
  {
    template_key: 'cogs_menu_gp',
    name: 'กำไรขั้นต้นเป็นบาท เรียงอันดับ',
    description: 'เมนูเรียงตามกำไรเป็นบาท ไม่ใช่ตาม % เพื่อไม่ให้ไปตัดเมนูที่ทำเงินจริง',
    category: 'Cost Control',
    report_source: 'cogs',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: 'menu',
      group_by_field: ['menu_name'],
      value: sum('gross_profit'),
      sort: 'desc',
      top_n: 12,
      format: 'currency',
      color: '#A9812F',
    },
  },
  {
    template_key: 'cogs_menu_table',
    name: 'เมนูที่ควรปรับราคา',
    description: 'ทุกเมนูพร้อมจำนวนที่ขาย ราคาขายเฉลี่ย ต้นทุนต่อหน่วย และ COGS % — เรียงและ export ได้',
    category: 'Cost Control',
    report_source: 'cogs',
    chart_type: 'table',
    config: { size: 'full', group_by: 'menu', top_n: 200 },
  },
  {
    template_key: 'cogs_branch_league',
    name: 'อันดับ COGS ตามสาขา',
    description: 'เมนูชุดเดียวกันแต่ COGS ต่างกัน แปลว่าปัญหาอยู่ที่การคุมของในครัวของสาขานั้น',
    category: 'Branch',
    report_source: 'cogs',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: 'branch',
      group_by_field: ['branch_name'],
      value: sum('cogs_percentage'),
      sort: 'desc',
      top_n: 20,
      format: 'pct',
      threshold: 34,
    },
  },

  // --- Purchasing ---
  {
    template_key: 'pa_supplier_spend',
    name: 'ยอดซื้อตามซัพพลายเออร์',
    description: 'FMH รวมยอดต่อซัพพลายเออร์ให้แล้ว คืนมาแถวเดียวต่อเจ้า ไม่ใช่แถวเดียวต่อบรรทัดสั่งซื้อ',
    category: 'Purchasing',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: 'supplier',
      group_by_field: ['supplier'],
      value: sum('total_spend'),
      sort: 'desc',
      top_n: 12,
      format: 'currency',
      color: '#2F6FB0',
      label_extra: { value: sum('order_count'), suffix: ' ใบ' },
    },
  },
  {
    template_key: 'price_variance_top',
    name: 'สินค้าที่ราคาต่างกันมากที่สุดระหว่างเจ้า',
    description: 'ตัวบนสุดคือจุดที่ประหยัดได้ทันทีโดยแค่ย้ายไปสั่งจากอีกเจ้า',
    category: 'Purchasing',
    report_source: 'price-variance-top',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: ['product'],
      value: sum('variance_pct'),
      sort: 'desc',
      top_n: 10,
      format: 'pct',
      color: '#BE4229',
    },
  },
  {
    template_key: 'price_avg_trend',
    name: 'ราคาเฉลี่ยที่จ่ายจริงตามเวลา',
    description: 'ใช้ตอบว่าต้นทุนขึ้นจริงไหม และอ้างอิงเวลาซัพพลายเออร์บอกว่าของขึ้นทั้งตลาด',
    category: 'Purchasing',
    report_source: 'price-avg-trend',
    chart_type: 'line',
    config: {
      size: 'half',
      date_fields: ['period'],
      bucket: 'day',
      format: 'currency',
      series: [{ label: 'ราคาเฉลี่ย', value: sum('avg_price'), color: '#2F6FB0' }],
    },
  },
  {
    template_key: 'credit_note_by_supplier',
    name: 'ใบลดหนี้ตามซัพพลายเออร์',
    description: 'เจ้าที่ต้องออกใบลดหนี้บ่อยคือเจ้าที่สร้างต้นทุนแฝงให้ทีม แม้ราคาต่อหน่วยจะดูถูก',
    category: 'Purchasing',
    report_source: 'credit-notes',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: 'supplier',
      group_by_field: ['supplier'],
      value: sum('total_amount'),
      sort: 'desc',
      top_n: 10,
      format: 'currency',
      color: '#BE4229',
      label_extra: { value: sum('credit_note_count'), suffix: ' ใบ' },
    },
  },

  // --- Menu usage ---
  {
    template_key: 'menu_ingredient_usage',
    name: 'วัตถุดิบที่ถูกใช้จริงตามยอดขาย',
    description: 'ถ่วงน้ำหนักด้วยยอดขายจริงแล้ว วัตถุดิบในสูตรแพงที่ไม่มีใครสั่งจะไม่ขึ้นมาหลอก',
    category: 'Menu Costing',
    report_source: 'menu-usage-top',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: ['ingredient'],
      value: sum('total_cost'),
      sort: 'desc',
      top_n: 12,
      format: 'currency',
      color: '#BE4229',
    },
  },

  // --- Stock & wastage ---
  {
    template_key: 'stock_flow',
    name: 'ของเข้าออกตามมูลค่า',
    description: 'ถ้าเส้นเข้าสูงกว่าเส้นออกต่อเนื่อง สต็อกกำลังพอกขึ้น ซึ่งเป็นเงินจมและความเสี่ยงของหมดอายุ',
    category: 'Stock',
    report_source: 'stock-flow',
    chart_type: 'line',
    config: {
      size: 'half',
      date_fields: ['period'],
      bucket: 'day',
      format: 'currency',
      series: [
        { label: 'เข้า', value: sum('value_in'), color: '#2F6FB0' },
        { label: 'ออก', value: sum('value_out'), color: '#A9812F' },
      ],
    },
  },
  {
    template_key: 'wastage_trend',
    name: 'ของเสียตามเวลา',
    description: 'ของเสียคือกำไรที่หายไปตรง ๆ และเป็นตัวเลขที่สื่อสารกับทีมหน้าร้านได้ง่ายที่สุด',
    category: 'Stock',
    report_source: 'wastage-trend',
    chart_type: 'line',
    config: {
      size: 'half',
      date_fields: ['period'],
      bucket: 'day',
      format: 'currency',
      series: [{ label: 'มูลค่าของเสีย', value: sum('total_wastage_value'), color: '#BE4229' }],
    },
  },
  {
    template_key: 'wastage_top_products',
    name: 'ของเสียมากที่สุด รายสินค้า',
    description: 'ชี้จุดที่แก้แล้วเห็นผลทันที',
    category: 'Stock',
    report_source: 'wastage-top-products',
    chart_type: 'bar',
    config: { size: 'third', group_by: ['product'], value: sum('total_wastage_value'), sort: 'desc', top_n: 10, format: 'currency', color: '#BE4229' },
  },
  {
    template_key: 'wastage_top_branches',
    name: 'ของเสียมากที่สุด รายสาขา',
    description: 'ดูคู่กับปริมาณที่สาขารับไป เพราะตัวเลขดิบจะทำให้สาขาใหญ่ดูแย่เสมอ',
    category: 'Branch',
    report_source: 'wastage-top-branches',
    chart_type: 'bar',
    config: { size: 'third', group_by: ['branch'], value: sum('total_wastage_value'), sort: 'desc', top_n: 10, format: 'currency', color: '#BE4229' },
  },
  {
    template_key: 'stock_count_variance',
    name: 'ผลการนับสต็อก',
    description: 'ส่วนต่างระหว่างยอดในระบบกับยอดที่นับได้จริง ถ้าตัวนี้แดงตลอด ตัวเลขต้นทุนทุกตัวก็ยังเชื่อไม่ได้',
    category: 'Stock',
    report_source: 'stock-count',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: 'product',
      group_by_field: ['product'],
      value: sum('variance_value'),
      sort: 'abs_desc',
      top_n: 12,
      format: 'currency',
      color_mode: 'signed',
      label_extra: { value: sum('times_counted'), suffix: ' ครั้ง' },
    },
  },
  {
    template_key: 'batch_remaining',
    name: 'ของค้างในล็อต',
    description: 'สัดส่วนที่ยังเหลือเทียบกับที่รับเข้ามา สูงผิดปกติแปลว่าไม่ได้ใช้ของตามลำดับเข้าก่อนออกก่อน',
    category: 'Stock',
    report_source: 'batch',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: 'product',
      group_by_field: ['product'],
      value: { op: 'ratio_pct', a: sum('total_remaining_qty'), b: sum('total_received_qty') },
      rank_by: sum('total_remaining_qty'),
      sort: 'desc',
      top_n: 10,
      format: 'pct',
      color: '#A9812F',
      label_extra: { value: sum('batch_count'), suffix: ' ล็อต' },
    },
  },

  // --- Central kitchen ---
  {
    template_key: 'avt_variance',
    name: 'ใช้จริงเทียบใช้ตามสูตร',
    description: 'มูลค่าส่วนต่างระหว่างวัตถุดิบที่ควรใช้ตามสูตรกับที่ใช้ไปจริง FMH คำนวณจากสต็อกจริงให้แล้ว',
    category: 'Cost Control',
    report_source: 'avt-stat',
    chart_type: 'kpi',
    config: {
      size: 'third',
      metrics: [{ label: 'ส่วนต่างการใช้วัตถุดิบ', format: 'currency', value: sum('variance_value') }],
    },
  },
  {
    template_key: 'production_yield',
    name: 'yield ของรอบผลิต',
    description: 'ผลผลิตจริงเทียบแผน ตั้งเป้าต่อสินค้า ไม่ใช่เป้าเดียวทั้งครัว',
    category: 'Cost Control',
    report_source: 'production',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: 'product',
      group_by_field: ['product'],
      value: sum('yield_pct'),
      sort: 'asc',
      top_n: 12,
      format: 'pct',
      threshold: 90,
      lower_is_better: false,
      label_extra: { value: sum('production_count'), suffix: ' รอบ' },
    },
  },
  {
    template_key: 'picking_fill_rate',
    name: 'จัดของได้ครบตามที่สาขาขอ',
    description: 'fill rate ที่สาขารู้สึกจริง วัดผลงานครัวกลางเอง ถ้าต่ำสาขาจะเริ่มสั่งเผื่อ',
    category: 'Branch',
    report_source: 'picking',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by: 'branch',
      group_by_field: ['branch'],
      value: sum('picked_pct'),
      sort: 'asc',
      top_n: 20,
      format: 'pct',
      threshold: 95,
      lower_is_better: false,
    },
  },
  {
    template_key: 'picking_trend',
    name: 'งานจัดของตามเวลา',
    description: 'ช่องว่างระหว่างที่สาขาขอกับที่จัดได้คืองานที่ค้าง ซึ่งแปลเป็นของที่สาขาจะไม่ได้ตามกำหนด',
    category: 'Branch',
    report_source: 'picking-trend',
    chart_type: 'line',
    config: {
      size: 'half',
      date_fields: ['period'],
      bucket: 'day',
      format: 'number',
      series: [
        { label: 'สาขาขอ', value: sum('requested_qty'), color: '#A9812F' },
        { label: 'จัดได้', value: sum('picked_qty'), color: '#2F6FB0' },
      ],
    },
  },
  {
    template_key: 'branch_order_volume',
    name: 'ปริมาณที่แต่ละสาขาสั่ง',
    description: 'ครัวกลางใช้วางแผนกำลังผลิตและรอบรถส่ง',
    category: 'Sales',
    report_source: 'branch-order-top',
    chart_type: 'bar',
    config: { size: 'half', group_by: ['branch'], value: sum('total_quantity'), sort: 'desc', top_n: 15, format: 'number', color: '#2F6FB0' },
  },
];

// How the four fixed tabs of the old single-tenant app map onto catalog
// templates — used once, by db/migrate.js, to convert the legacy dashboards
// into widget-based dashboards that look like they did before.
const LEGACY_DASHBOARD_WIDGETS = {
  purchase_analysis: ['pa_kpis', 'pa_trend', 'pa_attention_products', 'pa_top_suppliers', 'pa_category_variance'],
  cogs: ['cogs_table'],
  menu_costing: ['mc_kpis', 'mc_top_ingredients', ['mc_sensitivity', { size: 'full' }], 'mc_menu_breakdown'],
  sales_by_branch: ['sb_table'],
};

async function syncCatalog(conn = pool) {
  for (const t of BUILTIN_TEMPLATES) {
    await conn.query(
      `INSERT INTO widget_templates
         (template_key, name, description, category, report_source, chart_type, default_config_json, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = IF(customized, name, VALUES(name)),
         description = IF(customized, description, VALUES(description)),
         category = IF(customized, category, VALUES(category)),
         report_source = IF(customized, report_source, VALUES(report_source)),
         chart_type = IF(customized, chart_type, VALUES(chart_type)),
         default_config_json = IF(customized, default_config_json, VALUES(default_config_json)),
         sort_order = VALUES(sort_order)`,
      [
        t.template_key,
        t.name,
        t.description,
        t.category,
        t.report_source,
        t.chart_type,
        JSON.stringify(t.config),
        BUILTIN_TEMPLATES.indexOf(t) + 1,
      ]
    );
  }
}

// Adds templates, in order, to a dashboard (skips unknown keys). Each entry is
// a template key, or [key, configOverrides] to place it with overrides.
async function addTemplatesToDashboard(conn, dashboardId, entries) {
  for (let i = 0; i < entries.length; i++) {
    const [key, overrides] = Array.isArray(entries[i]) ? entries[i] : [entries[i], null];
    const [[tpl]] = await conn.query(`SELECT id FROM widget_templates WHERE template_key = ?`, [key]);
    if (!tpl) continue;
    await conn.query(
      `INSERT INTO dashboard_widgets (dashboard_id, widget_template_id, position, config_json) VALUES (?, ?, ?, ?)`,
      [dashboardId, tpl.id, i + 1, overrides ? JSON.stringify(overrides) : null]
    );
  }
}

function parseJson(text, fallback) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

// A dashboard's widgets, each with its template's default config merged
// under the instance's overrides.
async function listWidgets(dashboardId) {
  const [rows] = await pool.query(
    `SELECT w.id, w.title, w.position, w.config_json,
            t.id AS template_id, t.template_key, t.name AS template_name,
            t.report_source, t.chart_type, t.default_config_json
     FROM dashboard_widgets w
     JOIN widget_templates t ON t.id = w.widget_template_id
     WHERE w.dashboard_id = ?
     ORDER BY w.position, w.id`,
    [dashboardId]
  );
  return rows.map((r) => {
    const defaults = parseJson(r.default_config_json, {});
    const overrides = parseJson(r.config_json, {});
    return {
      id: r.id,
      title: r.title || r.template_name,
      custom_title: r.title,
      position: r.position,
      template_id: r.template_id,
      template_key: r.template_key,
      template_name: r.template_name,
      report_source: r.report_source,
      chart_type: r.chart_type,
      config: { ...defaults, ...overrides },
      config_overrides: overrides,
    };
  });
}

module.exports = {
  BUILTIN_TEMPLATES,
  CHART_TYPES,
  LEGACY_DASHBOARD_WIDGETS,
  syncCatalog,
  addTemplatesToDashboard,
  listWidgets,
};
