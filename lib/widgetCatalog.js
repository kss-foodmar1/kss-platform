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
