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
//           { op: 'min'|'max'|'avg', field }  across the rows in the group,
//                                          skipping rows where it is missing
//
//   The row layer runs BEFORE any of the above, per row rather than across
//   rows, and is what the Line Checks widgets are built on:
//     derived:     [{ field, expr }]       adds a column to each row
//     row_filter:  a predicate              keeps only the rows it selects
//     empty_message:                        what to say when the filter keeps
//                                           nothing — for an exception list
//                                           that is good news, not an error
//   expr:   number | 'field_name' | { field } | { const }
//           { op: 'add'|'sub'|'mul'|'div'|'pct_of'|'abs', a, b }
//           { op: 'days', from, to }       whole days between two date fields,
//                                          null when either end is missing
//   predicate: { op: 'and'|'or', rules } | { op: 'not', rule }
//           { op: 'blank'|'present', field }
//           { op: 'gt'|'gte'|'lt'|'lte', a, b }
//           { op: 'differs', a, b, tolerance }   |a-b| > tolerance
//           { op: 'matches', field, pattern }
//
//   The pivot runs BEFORE the row layer and is what makes a widget read two
//   reports at once — the dashboard joining them itself, the way someone would
//   in a spreadsheet, because FMH has no report that spans both:
//     sources: [{ as, source, group_by }]   the pulls this widget needs
//     pivot: { key_field, key: { <alias>: <field|{field,bucket}> }, columns }
//     columns: [{ field, from: <alias>, metric }]  aggregate that side, or
//              [{ field, from, first: <field> }]   carry a label across
//   Every bucket also gets <alias>_rows, so a month built from two lines of
//   data is visible rather than passing as a real number. The join is an outer
//   join: a key present on one side only still produces a row, which is how
//   "bought but in no recipe" works at all.
//
//   scripts/test-row-layer.js checks all of this against hand-worked answers.
//
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

const CHART_TYPES = ['kpi', 'bar', 'line', 'table', 'sensitivity', 'menu_breakdown', 'donut', 'pareto', 'scatter', 'treemap', 'range'];

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
    description: 'เมนูเรียงตามกำไรเป็นบาท พร้อมเส้นสะสมบอกว่ากี่เมนูแรกสร้างกำไร 80%',
    category: 'Cost Control',
    report_source: 'cogs',
    chart_type: 'pareto',
    config: {
      size: 'full',
      group_by: 'menu',
      group_by_field: ['menu_name'],
      value: sum('gross_profit'),
      sort: 'desc',
      top_n: 12,
      format: 'currency',
      bar_label: 'กำไรขั้นต้น',
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
// --- Needs the chart types added alongside these ---
  {
    template_key: 'menu_matrix',
    name: 'เมทริกซ์ menu engineering',
    description: 'แบ่งเมนูเป็นสี่กลุ่มตามความนิยมและกำไรต่อจาน เส้นตัดคำนวณจากเมนูที่แสดงอยู่จริง',
    category: 'Menu Costing',
    report_source: 'cogs',
    chart_type: 'scatter',
    config: {
      size: 'full',
      group_by: 'menu',
      group_by_field: ['menu_name'],
      x: sum('total_quantity'),
      x_share: true, // ส่วนแบ่งจำนวนจานของเมนูที่แสดงอยู่
      x_label: 'ส่วนแบ่งจำนวนจาน %',
      x_format: 'pct',
      y: { op: 'div', a: sum('gross_profit'), b: sum('total_quantity') },
      y_label: 'กำไรต่อจาน',
      y_format: 'currency',
      // กฎ 70% ของ Kasavana & Smith: (100 ÷ จำนวนเมนู) × 0.70
      qx: { op: 'share_rule', factor: 0.7 },
      qy: { op: 'mean' },
      quadrant_labels: ['ดาวเด่น', 'กำไรดีแต่ขายน้อย', 'ขายดีกำไรบาง', 'ควรทบทวน'],
    },
  },
  {
    template_key: 'menu_mix_qty',
    name: 'สัดส่วนจำนวนจานที่ขาย',
    description: 'พื้นที่กล่องแทนสัดส่วนจำนวนจาน บอกภาระงานครัวจริง ต่างจากสัดส่วนยอดขาย',
    category: 'Menu Costing',
    report_source: 'cogs',
    chart_type: 'treemap',
    config: { size: 'half', group_by: 'menu', group_by_field: ['menu_name'], value: sum('total_quantity'), top_n: 10, format: 'number' },
  },
  {
    template_key: 'menu_price_vs_cost',
    name: 'ราคาขายเทียบต้นทุนต่อหน่วย',
    description: 'ระยะห่างจากเส้นทแยงคือกำไรต่อจาน เมนูที่อยู่ใกล้เส้นคือเมนูที่เกือบไม่เหลืออะไร',
    category: 'Menu Costing',
    report_source: 'cogs',
    chart_type: 'scatter',
    config: {
      size: 'half',
      group_by: 'menu',
      group_by_field: ['menu_name'],
      x: sum('average_unit_cost'),
      x_label: 'ต้นทุนต่อหน่วย',
      x_format: 'currency',
      y: sum('average_selling_price'),
      y_label: 'ราคาขายเฉลี่ย',
      y_format: 'currency',
    },
  },
  {
    template_key: 'price_compare_suppliers',
    name: 'เทียบราคาข้ามซัพพลายเออร์',
    description: 'สินค้าเดียวกันแต่ละเจ้าขายเท่าไร ช่วงที่กว้างคือจุดที่ประหยัดได้มากที่สุด',
    category: 'Purchasing',
    report_source: 'price-comparison',
    chart_type: 'range',
    config: {
      size: 'half',
      group_by: 'product',
      group_by_field: ['product'],
      min: sum('min_price'),
      max: sum('max_price'),
      last: sum('avg_price'),
      top_n: 10,
      format: 'currency',
      marker_label: 'เฉลี่ย',
      foot: 'แถบคือช่วงราคาระหว่างซัพพลายเออร์ของสินค้านั้น จุดเข้มคือราคาเฉลี่ยที่จ่ายจริง',
    },
  },
  {
    template_key: 'po_status_mix',
    name: 'สถานะใบสั่งซื้อ',
    description: 'สัดส่วนใบสั่งซื้อตามสถานะ ถ้ากลุ่มที่ยังไม่ปิดโตขึ้นแปลว่ากระบวนการติดก่อนถึงบัญชี',
    category: 'Purchasing',
    report_source: 'po-status',
    chart_type: 'donut',
    config: { size: 'half', group_by: ['status'], value: sum('order_count'), top_n: 8, format: 'number' },
  },
  {
    template_key: 'stock_value_by_category',
    name: 'มูลค่าสต็อกตามหมวด',
    description: 'เงินที่จมอยู่ในสต็อก หมวดที่กินสัดส่วนใหญ่ผิดปกติมักแปลว่าสั่งเกินหรือของค้าง',
    category: 'Stock',
    report_source: 'stock-by-category',
    chart_type: 'donut',
    config: { size: 'half', group_by: ['category'], value: sum('total_stock_value'), top_n: 8, format: 'currency' },
  },

  // ---------- Line checks (FMH purchase_analysis, itemized) ----------
  // Every template below reads the plain `purchase-analysis` pull the app has
  // synced since day one, so the whole group adds nothing to a company's
  // monthly row quota. That is deliberate: itemized is the expensive shape, so
  // the sixteen widgets share one pull instead of asking for sixteen.
  //
  // What itemized buys that a grouping cannot: a grouped row has already added
  // PO, GRN and invoice together, so a line where they disagree is invisible.
  // These widgets exist to find the disagreements.
  {
    template_key: 'ita_three_way_match',
    name: 'บรรทัดที่ PO / รับของ / ใบแจ้งหนี้ ไม่ตรงกัน',
    description: 'ตรวจสามทางรายบรรทัด — สั่งเท่าไร รับเท่าไร ถูกวางบิลเท่าไร เผื่อไว้ 1 บาทกันเศษปัดเศษ',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'table',
    config: {
      size: 'full',
      derived: [
        { field: 'grn_minus_po', expr: { op: 'sub', a: { field: 'grn_total' }, b: { field: 'po_total' } } },
        { field: 'invoice_minus_grn', expr: { op: 'sub', a: { field: 'invoice_total' }, b: { field: 'grn_total' } } },
      ],
      // Only lines that have been through all three stages. A line still
      // waiting to be received has GRN 0, which "differs" from its PO without
      // anything being wrong — letting those in buries the real mismatches
      // under rows that are merely in progress, and those have their own two
      // widgets already.
      row_filter: {
        op: 'and',
        rules: [
          { op: 'present', field: 'grn_number' },
          { op: 'present', field: 'invoice_number' },
          {
            op: 'or',
            rules: [
              { op: 'differs', a: { field: 'grn_total' }, b: { field: 'po_total' }, tolerance: 1 },
              { op: 'differs', a: { field: 'invoice_total' }, b: { field: 'grn_total' }, tolerance: 1 },
            ],
          },
        ],
      },
      empty_message: 'ทุกบรรทัดที่ครบสามขั้นตอนแล้วตรงกันทั้ง PO รับของ และใบแจ้งหนี้',
      columns: [
        { field: 'po_number', label: 'PO' },
        { field: 'order_date', label: 'วันสั่ง' },
        { field: 'supplier', label: 'ซัพพลายเออร์' },
        { field: 'product_name', label: 'สินค้า' },
        { field: 'po_total', label: 'PO', format: 'currency' },
        { field: 'grn_total', label: 'รับของ', format: 'currency' },
        { field: 'invoice_total', label: 'ใบแจ้งหนี้', format: 'currency' },
        { field: 'grn_minus_po', label: 'รับ − สั่ง', format: 'currency' },
        { field: 'invoice_minus_grn', label: 'บิล − รับ', format: 'currency' },
      ],
      top_n: 200,
    },
  },
  {
    template_key: 'ita_overbilled',
    name: 'วางบิลเกินของที่รับจริง',
    description: 'รวมส่วนที่ใบแจ้งหนี้สูงกว่ามูลค่าของที่รับ แยกตามซัพพลายเออร์ — เงินที่ควรทวงคืน',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'half',
      derived: [{ field: 'overbilled', expr: { op: 'sub', a: { field: 'invoice_total' }, b: { field: 'grn_total' } } }],
      row_filter: { op: 'gt', a: { field: 'invoice_total' }, b: { field: 'grn_total' } },
      empty_message: 'ไม่มีบรรทัดไหนถูกวางบิลเกินของที่รับ',
      group_by_field: ['supplier'],
      value: { op: 'sum', field: 'overbilled' },
      top_n: 10,
      format: 'currency',
      foot: 'นับเฉพาะบรรทัดที่ใบแจ้งหนี้สูงกว่ามูลค่ารับของ',
    },
  },
  {
    template_key: 'ita_short_delivery',
    name: 'ส่งของขาด แยกตามซัพพลายเออร์',
    description: 'รวมจำนวนที่สั่งแล้วได้ไม่ครบ ตัวที่ขาดบ่อยคือตัวที่ทำให้ครัวต้องแก้เมนูหน้างาน',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'half',
      derived: [{ field: 'short_qty', expr: { op: 'sub', a: { field: 'po_qty' }, b: { field: 'grn_quantity' } } }],
      row_filter: {
        op: 'and',
        rules: [
          { op: 'present', field: 'grn_number' },
          { op: 'gt', a: { field: 'po_qty' }, b: { field: 'grn_quantity' } },
        ],
      },
      empty_message: 'ไม่มีบรรทัดที่ส่งขาด',
      group_by_field: ['supplier'],
      value: { op: 'sum', field: 'short_qty' },
      top_n: 10,
      format: 'number',
      foot: 'นับเฉพาะบรรทัดที่รับของแล้วและได้น้อยกว่าที่สั่ง',
    },
  },
  {
    template_key: 'ita_not_received',
    name: 'สั่งแล้วยังไม่ได้รับของ',
    description: 'บรรทัดที่มี PO แต่ยังไม่มีใบรับของ เรียงตามวันที่นัดส่ง',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'table',
    config: {
      size: 'full',
      row_filter: { op: 'blank', field: 'grn_number' },
      empty_message: 'รับของครบทุกบรรทัดแล้ว',
      columns: [
        { field: 'requested_delivery_date', label: 'นัดส่ง' },
        { field: 'po_number', label: 'PO' },
        { field: 'supplier', label: 'ซัพพลายเออร์' },
        { field: 'branch', label: 'สาขา' },
        { field: 'product_name', label: 'สินค้า' },
        { field: 'po_qty', label: 'จำนวน', format: 'number' },
        { field: 'po_total', label: 'มูลค่า', format: 'currency' },
        { field: 'order_status', label: 'สถานะ' },
      ],
      top_n: 200,
    },
  },
  {
    template_key: 'ita_grn_not_invoiced',
    name: 'รับของแล้วแต่ยังไม่มีใบแจ้งหนี้',
    description: 'มูลค่าของที่รับเข้ามาแล้วแต่ซัพพลายเออร์ยังไม่วางบิล — ภาระที่ยังไม่เข้าบัญชี',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'half',
      row_filter: {
        op: 'and',
        rules: [
          { op: 'present', field: 'grn_number' },
          { op: 'blank', field: 'invoice_number' },
        ],
      },
      empty_message: 'ของที่รับแล้วถูกวางบิลครบทุกบรรทัด',
      group_by_field: ['supplier'],
      value: { op: 'sum', field: 'grn_total' },
      top_n: 10,
      format: 'currency',
      foot: 'ยอดนี้คือค่าใช้จ่ายที่เกิดแล้วแต่ยังไม่มีเอกสารตั้งหนี้',
    },
  },
  {
    template_key: 'ita_lead_time',
    name: 'ระยะเวลาส่งของเฉลี่ย แยกตามซัพพลายเออร์',
    description: 'นับจากวันสั่งถึงวันรับของจริง ใช้ตั้งรอบสั่งซื้อและจุดสั่งซ้ำ',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'half',
      derived: [{ field: 'lead_days', expr: { op: 'days', from: 'order_date', to: 'grn_date' } }],
      row_filter: { op: 'present', field: 'lead_days' },
      empty_message: 'ยังไม่มีบรรทัดที่มีทั้งวันสั่งและวันรับของ',
      group_by_field: ['supplier'],
      value: { op: 'avg', field: 'lead_days' },
      sort: 'desc',
      top_n: 10,
      format: 'decimal1',
      foot: 'หน่วยเป็นวัน นับเฉพาะบรรทัดที่รับของแล้ว',
    },
  },
  {
    template_key: 'ita_late_delivery',
    name: 'ส่งช้ากว่าที่นัด แยกตามซัพพลายเออร์',
    description: 'เฉลี่ยจำนวนวันที่รับของช้ากว่าวันนัด ค่าติดลบคือมาก่อนกำหนด',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'half',
      derived: [{ field: 'days_late', expr: { op: 'days', from: 'requested_delivery_date', to: 'grn_date' } }],
      row_filter: { op: 'present', field: 'days_late' },
      empty_message: 'ยังไม่มีบรรทัดที่มีทั้งวันนัดส่งและวันรับของ',
      group_by_field: ['supplier'],
      value: { op: 'avg', field: 'days_late' },
      sort: 'desc',
      top_n: 10,
      format: 'decimal1',
      color_mode: 'signed',
      foot: 'บวกคือช้ากว่านัด ลบคือมาก่อนนัด',
    },
  },
  {
    template_key: 'ita_price_dispersion',
    name: 'ราคาต่อหน่วยที่จ่ายจริง กว้างแค่ไหน',
    description: 'สินค้าตัวเดียวกันแต่ละบรรทัดจ่ายไม่เท่ากัน แถบยิ่งกว้างยิ่งควรไปคุยเรื่องราคา',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'range',
    config: {
      size: 'half',
      group_by_field: ['product_name', 'product_code'],
      min: { op: 'min', field: 'price' },
      max: { op: 'max', field: 'price' },
      last: { op: 'avg', field: 'price' },
      top_n: 12,
      format: 'currency',
      marker_label: 'เฉลี่ย',
      foot: 'แถบคือช่วงราคาต่อหน่วยที่เคยจ่ายของสินค้านั้น จุดเข้มคือราคาเฉลี่ย',
    },
  },
  {
    template_key: 'ita_price_gap_saving',
    name: 'ส่วนต่างราคาต่อหน่วย สูงสุด–ต่ำสุด',
    description: 'ถ้าซื้อได้ที่ราคาต่ำสุดทุกครั้ง จะประหยัดต่อหน่วยเท่าไร เรียงจากช่องว่างกว้างที่สุด',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by_field: ['product_name', 'product_code'],
      value: { op: 'diff', a: { op: 'max', field: 'price' }, b: { op: 'min', field: 'price' } },
      top_n: 12,
      format: 'currency',
      foot: 'ช่องว่างต่อหน่วย ไม่ใช่ยอดประหยัดรวม — ต้องคูณจำนวนที่ซื้อเองก่อนเอาไปคุย',
    },
  },
  {
    template_key: 'ita_uom_mix',
    name: 'สินค้าที่หน่วยนับไม่ตรงกัน',
    description: 'สินค้าตัวเดียวแต่ถูกบันทึกหลายหน่วย ทำให้การรวมจำนวนผิดโดยไม่มีใครเห็น',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by_field: ['product_name', 'product_code'],
      value: { op: 'count_distinct', field: 'uom' },
      sort: 'desc',
      top_n: 10,
      format: 'number',
      foot: 'ค่า 1 คือปกติ ตั้งแต่ 2 ขึ้นไปแปลว่าหน่วยนับปนกัน ควรแก้ที่ต้นทาง',
    },
  },
  {
    template_key: 'ita_missing_code',
    name: 'บรรทัดที่ไม่มีรหัสสินค้า',
    description: 'บรรทัดที่ไม่มีรหัส จะเชื่อมกับสูตรและยอดขายไม่ได้ ต้นทุนของมันจึงหายไปจากรายงานอื่น',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'table',
    config: {
      size: 'half',
      row_filter: { op: 'blank', field: 'product_code' },
      empty_message: 'ทุกบรรทัดมีรหัสสินค้าครบ',
      columns: [
        { field: 'order_date', label: 'วันสั่ง' },
        { field: 'supplier', label: 'ซัพพลายเออร์' },
        { field: 'product_name', label: 'สินค้า' },
        { field: 'category_name', label: 'หมวด' },
        { field: 'total', label: 'มูลค่า', format: 'currency' },
      ],
      top_n: 200,
    },
  },
  {
    template_key: 'ita_code_convention',
    name: 'รหัสสินค้าที่ไม่เข้ารูปแบบ',
    description: 'รหัสที่ไม่ใช่รูปแบบ ABC-123 เช่น CH01 หรือ 116 — ตอนนี้ยัง join ได้เพราะมาจากทะเบียนเดียวกัน แต่จะพังเงียบเมื่อมีการคีย์มือหรือ import',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'table',
    config: {
      size: 'half',
      row_filter: {
        op: 'and',
        rules: [
          { op: 'present', field: 'product_code' },
          { op: 'not', rule: { op: 'matches', field: 'product_code', pattern: '^[A-Za-z]{2,4}-[0-9]{2,4}$' } },
        ],
      },
      empty_message: 'รหัสสินค้าทุกตัวเข้ารูปแบบเดียวกัน',
      columns: [
        { field: 'product_code', label: 'รหัส' },
        { field: 'product_name', label: 'สินค้า' },
        { field: 'category_name', label: 'หมวด' },
        { field: 'supplier', label: 'ซัพพลายเออร์' },
      ],
      top_n: 200,
    },
  },
  {
    template_key: 'ita_order_frequency',
    name: 'สินค้าที่สั่งบ่อยที่สุด',
    description: 'นับจำนวนใบสั่งซื้อที่มีสินค้านั้น ของที่สั่งถี่ครั้งละน้อยคือจุดที่รวมรอบสั่งแล้วลดงานเอกสารได้',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'half',
      group_by_field: ['product_name', 'product_code'],
      value: { op: 'count_distinct', field: 'po_number' },
      label_extra: { value: { op: 'avg', field: 'total' }, suffix: ' บาท/ครั้ง' },
      top_n: 12,
      format: 'number',
      foot: 'ในวงเล็บคือมูลค่าเฉลี่ยต่อบรรทัด',
    },
  },
  {
    template_key: 'ita_top_lines',
    name: 'บรรทัดที่มูลค่าสูงสุด',
    description: 'รายการซื้อรายบรรทัดเรียงตามมูลค่า ใช้สุ่มตรวจเอกสารจริง',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'table',
    config: {
      size: 'full',
      columns: [
        { field: 'total', label: 'มูลค่า', format: 'currency' },
        { field: 'order_date', label: 'วันสั่ง' },
        { field: 'po_number', label: 'PO' },
        { field: 'supplier', label: 'ซัพพลายเออร์' },
        { field: 'branch', label: 'สาขา' },
        { field: 'product_name', label: 'สินค้า' },
        { field: 'qty', label: 'จำนวน', format: 'number' },
        { field: 'uom', label: 'หน่วย' },
        { field: 'price', label: 'ราคา/หน่วย', format: 'currency' },
      ],
      top_n: 50,
    },
  },
  {
    template_key: 'ita_split_orders',
    name: 'ใบสั่งที่ถูกแตกส่ง',
    description: 'บรรทัดที่มีสถานะแตกใบสั่ง ส่งหลายรอบหมายถึงงานรับของและงานเอกสารเพิ่มขึ้นทุกรอบ',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'bar',
    config: {
      size: 'half',
      row_filter: { op: 'present', field: 'split_order_status' },
      empty_message: 'ไม่มีใบสั่งที่ถูกแตกส่ง',
      group_by_field: ['supplier'],
      value: { op: 'count_distinct', field: 'po_number' },
      top_n: 10,
      format: 'number',
      foot: 'นับเป็นจำนวนใบสั่ง ไม่ใช่จำนวนบรรทัด',
    },
  },
  {
    template_key: 'ita_do_vs_grn',
    name: 'ของที่ส่งมากับของที่รับไม่ตรงกัน',
    description: 'เทียบจำนวนบนใบส่งของกับจำนวนที่รับเข้าจริง ส่วนต่างตรงนี้คือของเสียหายระหว่างทางหรือการนับผิดตอนรับ',
    category: 'Line Checks',
    report_source: 'purchase-analysis',
    chart_type: 'table',
    config: {
      size: 'full',
      derived: [{ field: 'qty_gap', expr: { op: 'sub', a: { field: 'grn_quantity' }, b: { field: 'do_quantity' } } }],
      row_filter: {
        op: 'and',
        rules: [
          { op: 'present', field: 'do_number' },
          { op: 'present', field: 'grn_number' },
          { op: 'differs', a: { field: 'grn_quantity' }, b: { field: 'do_quantity' }, tolerance: 0.001 },
        ],
      },
      empty_message: 'จำนวนบนใบส่งของตรงกับที่รับเข้าทุกบรรทัด',
      columns: [
        { field: 'do_date', label: 'วันส่ง' },
        { field: 'do_number', label: 'ใบส่งของ' },
        { field: 'grn_number', label: 'ใบรับของ' },
        { field: 'supplier', label: 'ซัพพลายเออร์' },
        { field: 'product_name', label: 'สินค้า' },
        { field: 'do_quantity', label: 'ส่งมา', format: 'number' },
        { field: 'grn_quantity', label: 'รับเข้า', format: 'number' },
        { field: 'qty_gap', label: 'ส่วนต่าง', format: 'number' },
      ],
      top_n: 200,
    },
  },

  // ---------- Cross-report (the dashboard does the join itself) ----------
  // FMH has no report that spans procurement and sales, so these compute the
  // answer here: bucket each report by a shared key, total what matters, line
  // the buckets up. KSS is the only party holding both halves.
  //
  // The headline is that there are TWO gross margins and they are not the same
  // number. FMH's COGS report values what was sold at RECIPE cost — what the
  // dishes should have cost. Purchase analysis holds what was actually paid to
  // suppliers. The gap between the two margins is waste, over-buying, stock
  // movement and price drift, and it is invisible inside either report alone.
  {
    template_key: 'ck_margin_kpi',
    name: 'CK gross margin — จริงเทียบกับตามสูตร',
    description: 'ยอดขาย CK เทียบยอดซื้อจริง และเทียบต้นทุนตามสูตร ส่วนต่างสองค่านี้คือของที่หายไประหว่างทาง',
    category: 'Cross-report',
    report_source: 'cogs-trend',
    chart_type: 'kpi',
    config: {
      size: 'full',
      sources: [
        { as: 'sales', source: 'cogs-trend' },
        { as: 'purchase', source: 'purchase-analysis' },
      ],
      pivot: {
        key_field: 'period',
        key: { sales: { field: 'period', bucket: 'month' }, purchase: { field: 'order_date', bucket: 'month' } },
        columns: [
          { field: 'sales_value', from: 'sales', metric: sum('sales') },
          { field: 'recipe_cost', from: 'sales', metric: sum('cogs') },
          { field: 'purchase_value', from: 'purchase', metric: sum('total') },
        ],
      },
      metrics: [
        { label: 'ยอดขาย CK', format: 'currency', value: sum('sales_value') },
        { label: 'ยอดซื้อจริง', format: 'currency', value: sum('purchase_value') },
        { label: 'ต้นทุนตามสูตร', format: 'currency', value: sum('recipe_cost') },
        { label: 'GM จ่ายจริง', format: 'pct', value: { op: 'ratio_pct', a: { op: 'diff', a: sum('sales_value'), b: sum('purchase_value') }, b: sum('sales_value') } },
        { label: 'GM ตามสูตร', format: 'pct', value: { op: 'ratio_pct', a: { op: 'diff', a: sum('sales_value'), b: sum('recipe_cost') }, b: sum('sales_value') } },
      ],
    },
  },
  {
    template_key: 'ck_margin_table',
    name: 'CK gross margin รายเดือน',
    description: 'แยกรายเดือน ยอดขาย ยอดซื้อ ต้นทุนตามสูตร และช่องว่างระหว่าง GM สองแบบ',
    category: 'Cross-report',
    report_source: 'cogs-trend',
    chart_type: 'table',
    config: {
      size: 'full',
      sources: [
        { as: 'sales', source: 'cogs-trend' },
        { as: 'purchase', source: 'purchase-analysis' },
      ],
      pivot: {
        key_field: 'period',
        key: { sales: { field: 'period', bucket: 'month' }, purchase: { field: 'order_date', bucket: 'month' } },
        columns: [
          { field: 'sales_value', from: 'sales', metric: sum('sales') },
          { field: 'recipe_cost', from: 'sales', metric: sum('cogs') },
          { field: 'purchase_value', from: 'purchase', metric: sum('total') },
        ],
      },
      derived: [
        { field: 'gm_cash', expr: { op: 'sub', a: { field: 'sales_value' }, b: { field: 'purchase_value' } } },
        { field: 'gm_cash_pct', expr: { op: 'pct_of', a: { op: 'sub', a: { field: 'sales_value' }, b: { field: 'purchase_value' } }, b: { field: 'sales_value' } } },
        { field: 'gm_recipe_pct', expr: { op: 'pct_of', a: { op: 'sub', a: { field: 'sales_value' }, b: { field: 'recipe_cost' } }, b: { field: 'sales_value' } } },
        { field: 'gap_pct', expr: { op: 'sub', a: { op: 'pct_of', a: { op: 'sub', a: { field: 'sales_value' }, b: { field: 'recipe_cost' } }, b: { field: 'sales_value' } }, b: { op: 'pct_of', a: { op: 'sub', a: { field: 'sales_value' }, b: { field: 'purchase_value' } }, b: { field: 'sales_value' } } } },
      ],
      columns: [
        { field: 'period', label: 'เดือน' },
        { field: 'sales_value', label: 'ยอดขาย', format: 'currency' },
        { field: 'purchase_value', label: 'ยอดซื้อจริง', format: 'currency' },
        { field: 'recipe_cost', label: 'ต้นทุนตามสูตร', format: 'currency' },
        { field: 'gm_cash', label: 'GM จ่ายจริง', format: 'currency' },
        { field: 'gm_cash_pct', label: 'GM จ่ายจริง %', format: 'pct' },
        { field: 'gm_recipe_pct', label: 'GM ตามสูตร %', format: 'pct' },
        { field: 'gap_pct', label: 'ช่องว่าง', format: 'pct' },
        { field: 'purchase_rows', label: 'บรรทัดซื้อ', format: 'number' },
      ],
      top_n: 24,
      foot: 'เดือนเดียวอ่านแล้วแกว่ง เพราะของที่ซื้อเดือนนี้อาจขายเดือนหน้า ดูแนวโน้มสามเดือนขึ้นไปจะตรงกว่า',
    },
  },
  {
    template_key: 'ck_margin_trend',
    name: 'ช่องว่าง GM จริงกับ GM ตามสูตร',
    description: 'สองเส้นที่ควรวิ่งใกล้กัน ถ้าถ่างออกเรื่อย ๆ แปลว่าของหายระหว่างทางมากขึ้น',
    category: 'Cross-report',
    report_source: 'cogs-trend',
    chart_type: 'line',
    config: {
      size: 'full',
      sources: [
        { as: 'sales', source: 'cogs-trend' },
        { as: 'purchase', source: 'purchase-analysis' },
      ],
      pivot: {
        key_field: 'period',
        key: { sales: { field: 'period', bucket: 'month' }, purchase: { field: 'order_date', bucket: 'month' } },
        columns: [
          { field: 'sales_value', from: 'sales', metric: sum('sales') },
          { field: 'recipe_cost', from: 'sales', metric: sum('cogs') },
          { field: 'purchase_value', from: 'purchase', metric: sum('total') },
        ],
      },
      date_fields: ['period'],
      bucket: 'month',
      series: [
        { label: 'GM ตามสูตร %', color: '#2F6FB0', value: { op: 'ratio_pct', a: { op: 'diff', a: sum('sales_value'), b: sum('recipe_cost') }, b: sum('sales_value') } },
        { label: 'GM จ่ายจริง %', color: '#BE4229', value: { op: 'ratio_pct', a: { op: 'diff', a: sum('sales_value'), b: sum('purchase_value') }, b: sum('sales_value') } },
      ],
      format: 'pct',
      foot: 'เส้นจ่ายจริงจะแกว่งกว่าเสมอ เพราะรอบซื้อกับรอบขายไม่ตรงกัน ดูระยะห่างเฉลี่ย อย่าดูเดือนเดียว',
    },
  },
  {
    template_key: 'bought_not_in_recipe',
    name: 'ของที่ซื้อแต่ไม่อยู่ในสูตรไหนเลย',
    description: 'วัตถุดิบที่จ่ายเงินซื้อจริง แต่ไม่ปรากฏในสูตรใด ต้นทุนของมันจึงไม่เคยถูกคิดเข้าเมนู',
    category: 'Cross-report',
    report_source: 'purchase-analysis',
    chart_type: 'table',
    config: {
      size: 'full',
      sources: [
        { as: 'purchase', source: 'purchase-analysis' },
        { as: 'recipe', source: 'menu-costing' },
      ],
      pivot: {
        key_field: 'product_code',
        key: { purchase: 'product_code', recipe: 'ingredient_code' },
        columns: [
          { field: 'product_name', from: 'purchase', first: 'product_name' },
          { field: 'category_name', from: 'purchase', first: 'category_name' },
          { field: 'supplier', from: 'purchase', first: 'supplier' },
          { field: 'spend', from: 'purchase', metric: sum('total') },
        ],
      },
      // Bought at least once, and in no recipe line at all.
      row_filter: {
        op: 'and',
        rules: [
          { op: 'gt', a: { field: 'purchase_rows' }, b: 0 },
          { op: 'lte', a: { field: 'recipe_rows' }, b: 0 },
        ],
      },
      empty_message: 'ของที่ซื้อทุกตัวอยู่ในสูตรแล้ว',
      columns: [
        { field: 'product_code', label: 'รหัส' },
        { field: 'product_name', label: 'สินค้า' },
        { field: 'category_name', label: 'หมวด' },
        { field: 'supplier', label: 'ซัพพลายเออร์' },
        { field: 'spend', label: 'ยอดซื้อ', format: 'currency' },
        { field: 'purchase_rows', label: 'ครั้งที่ซื้อ', format: 'number' },
      ],
      top_n: 200,
      foot: 'ของขายต่อ เช่น น้ำอัดลมกระป๋อง จะโผล่ที่นี่โดยไม่ผิด ที่ต้องดูคือวัตถุดิบจริงที่ตกสำรวจ',
    },
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
