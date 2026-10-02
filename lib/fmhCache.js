// FMH report syncing + reading the local cache, per company.
//
// Dashboards never call FMH on a page view — they read fmh_report_cache.
// The cache is filled by the daily 1am sync (server.js) and by on-demand
// refreshes (routes/dashboards.js), and only for the report sources a company
// actually has widgets for, so no FMH quota is spent on reports nobody shows.
//
// Grouping: FMH can aggregate server-side (group_by on the card), returning one
// row per branch / supplier / category / product instead of one row per order
// line. The monthly row quota is the binding constraint on this product — a
// company with a few thousand order lines can burn a month's quota in days of
// itemized syncing — so a widget that only needs totals asks for a grouping and
// costs a handful of rows instead of thousands. Verified against FMH on
// 2026-10-02: every grouping below returned 200 with pre-aggregated fields.
//
// A grouped pull is cached under "<source>|<grouping>"; itemized keeps the bare
// source as its key, so widgets written before grouping existed are untouched.
const pool = require('../db/pool');
const { callReport } = require('./fmh');

// FMH requires both ends of a date range to fall inside the last 90 UTC
// calendar dates (stated in the catalog's date_semantics, and enforced: a
// 90-day range was rejected on staging with "Reports can span at most 3 months
// at a time"). 80 stays clear of both the 3-calendar-month and 90-day rules.
const SYNC_WINDOW_DAYS = 80;
const PAGE_SIZE = 1000;
const MAX_PAGES = 10;

// Order statuses that represent spend the company committed to. PENDING is not
// yet approved; CANCELLED, REJECTED and NOT_APPROVED never became purchases.
// Sending this explicitly makes the numbers deterministic: FMH's default is
// undocumented, and a probe on 2026-10-02 showed it currently matches this set,
// but relying on an unstated default is how totals silently change later.
const COMMITTED_STATUSES = ['APPROVED', 'IN_PROCESS', 'DISPATCHED', 'RECEIVED', 'INVOICED', 'COMPLETED'];

// The FMH reports and cards this app reads, generated from FMH's own catalog
// rather than typed by hand. A "source" is one (report, card) pair, because a
// report's stat cards and chart cards are separate requests — cogs_stat_total
// and cogs_over_time come from the same report but are not the same call.
//
//   cardKey        the exact card to request
//   ui             what FMH intends the card to be drawn as
//   dateField      the column FMH filters the range on, where the report
//                  offers a choice (null = the report has no such choice)
//   orderStatuses  true only where the report's status filter is the
//                  order-status vocabulary. credit_note_summary also has a
//                  "statuses" filter, but its values are UTILIZED/UNUTILIZED —
//                  sending order statuses there would filter on nothing real.
//   groupings      server-side group_by values, "itemized" omitted since that
//                  is what a request without group_by already returns
const FMH_REPORTS = {
  'purchase-analysis': {
    label: "Purchase Analysis (PO / GRN / Invoice)",
    reportKey: 'purchase_analysis',
    cardKey: 'purchase_analysis_table',
    ui: 'table',
    supportsDateRange: true,
    dateField: 'order_date',
    orderStatuses: true,
    groupings: ['branch', 'supplier', 'category', 'product'],
  },
  'menu-costing': {
    label: "Menu & Ingredients (สูตร / ต้นทุนเมนู)",
    reportKey: 'menu_and_ingredients',
    cardKey: 'recipe_table',
    ui: 'table',
    supportsDateRange: false,
    dateField: null,
    orderStatuses: false,
    groupings: ['by_menu', 'by_ingredient'],
  },
  'cogs': {
    label: "COGS (Central Kitchen)",
    reportKey: 'cogs',
    cardKey: 'cogs_table',
    ui: 'table',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: false,
    groupings: ['menu', 'branch', 'category', 'period'],
  },
  'sales-by-branch': {
    label: "Order Items by Branch",
    reportKey: 'order_items_by_branch',
    cardKey: 'oibb_table',
    ui: 'table',
    supportsDateRange: true,
    dateField: 'requested_delivery_date',
    orderStatuses: true,
    groupings: ['branch', 'product'],
  },
  'cogs-stat': {
    label: "COGS — ตัวเลขสรุป",
    reportKey: 'cogs',
    cardKey: 'cogs_stat_total',
    ui: 'stat_card',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: false,
    groupings: [],
  },
  'cogs-trend': {
    label: "COGS — ตามเวลา",
    reportKey: 'cogs',
    cardKey: 'cogs_over_time',
    ui: 'line_chart',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: false,
    groupings: [],
  },
  'cogs-low-margin': {
    label: "COGS — เมนูมาร์จิ้นต่ำ",
    reportKey: 'cogs',
    cardKey: 'cogs_low_margin_items',
    ui: 'bar_chart',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: false,
    groupings: [],
  },
  'menu-usage-top': {
    label: "วัตถุดิบที่ถูกใช้จริง — อันดับสูงสุด",
    reportKey: 'menu_ingredients',
    cardKey: 'menu_ingredients_top_ingredients',
    ui: 'bar_chart',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: false,
    groupings: [],
  },
  'price-variance-top': {
    label: "ส่วนต่างราคาข้ามซัพพลายเออร์ — อันดับสูงสุด",
    reportKey: 'price_comparison',
    cardKey: 'price_variance_top_products',
    ui: 'bar_chart',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: true,
    groupings: [],
  },
  'price-comparison': {
    label: "เทียบราคาข้ามซัพพลายเออร์",
    reportKey: 'price_comparison',
    cardKey: 'price_comparison_table',
    ui: 'table',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: true,
    groupings: ['product_supplier', 'product'],
  },
  'price-avg-trend': {
    label: "ราคาเฉลี่ยตามเวลา",
    reportKey: 'purchase_price_history',
    cardKey: 'price_history_avg_price_over_time',
    ui: 'line_chart',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: true,
    groupings: [],
  },
  'po-status': {
    label: "สถานะใบสั่งซื้อ",
    reportKey: 'purchase_order_history',
    cardKey: 'po_history_orders_by_status',
    ui: 'doughnut_chart',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: true,
    groupings: [],
  },
  'stock-by-category': {
    label: "มูลค่าสต็อกตามหมวด",
    reportKey: 'stock_balance',
    cardKey: 'stock_balance_by_category',
    ui: 'pie_chart',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: false,
    groupings: [],
  },
  'stock-flow': {
    label: "ของเข้าออกตามมูลค่า",
    reportKey: 'stock_card',
    cardKey: 'stock_card_value_over_time',
    ui: 'line_chart',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: false,
    groupings: [],
  },
  'wastage-trend': {
    label: "ของเสียตามเวลา",
    reportKey: 'stock_wastage',
    cardKey: 'wastage_over_time',
    ui: 'line_chart',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: false,
    groupings: [],
  },
  'wastage-top-products': {
    label: "ของเสียมากสุด รายสินค้า",
    reportKey: 'stock_wastage',
    cardKey: 'wastage_top_products',
    ui: 'bar_chart',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: false,
    groupings: [],
  },
  'wastage-top-branches': {
    label: "ของเสียมากสุด รายสาขา",
    reportKey: 'stock_wastage',
    cardKey: 'wastage_top_outlets',
    ui: 'bar_chart',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: false,
    groupings: [],
  },
  'branch-order-top': {
    label: "ปริมาณที่สาขาสั่ง",
    reportKey: 'order_items_by_branch',
    cardKey: 'oibb_top_branches',
    ui: 'bar_chart',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: true,
    groupings: [],
  },
  'picking-trend': {
    label: "งานจัดของตามเวลา",
    reportKey: 'picking',
    cardKey: 'picking_over_time',
    ui: 'line_chart',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: true,
    groupings: [],
  },
  'picking': {
    label: "งานจัดของ (รายบรรทัด)",
    reportKey: 'picking',
    cardKey: 'picking_table',
    ui: 'table',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: true,
    groupings: ['picker', 'branch'],
  },
  'avt-stat': {
    label: "ส่วนต่างการใช้วัตถุดิบ",
    reportKey: 'product_variance',
    cardKey: 'variance_stat_variance_value',
    ui: 'stat_card',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: false,
    groupings: [],
  },
  'credit-notes': {
    label: "ใบลดหนี้",
    reportKey: 'credit_note_summary',
    cardKey: 'credit_note_table',
    ui: 'table',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: false,
    groupings: ['supplier'],
  },
  'stock-count': {
    label: "ผลการนับสต็อก",
    reportKey: 'stock_count',
    cardKey: 'stock_count_table',
    ui: 'table',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: false,
    groupings: ['branch', 'product'],
  },
  'production': {
    label: "รอบผลิตครัวกลาง",
    reportKey: 'production_history',
    cardKey: 'production_history_table',
    ui: 'table',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: false,
    groupings: ['product', 'branch'],
  },
  'batch': {
    label: "ล็อตและอายุของ",
    reportKey: 'batch_tracing',
    cardKey: 'batch_tracing_table',
    ui: 'table',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: false,
    groupings: ['product', 'supplier'],
  },
};

// "<source>" for itemized, "<source>|<grouping>" otherwise.
function cacheKeyFor(source, grouping) {
  return grouping ? `${source}|${grouping}` : source;
}

function syncWindow() {
  const end = new Date();
  const start = new Date(Date.now() - SYNC_WINDOW_DAYS * 86400000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

// The exact request the sync would send for one pull. Diagnostics call this
// too, so a probe that says "this pull returns no rows" is a statement about
// the real sync and not about a request a probe happened to build its own way.
function requestFor(source, grouping = null, { limit = PAGE_SIZE, offset = 0 } = {}) {
  const cfg = FMH_REPORTS[source];
  if (!cfg) throw new Error(`Unknown report source: ${source}`);
  if (grouping && !cfg.groupings.includes(grouping)) {
    throw new Error(`Report source "${source}" does not support grouping "${grouping}"`);
  }

  const filters = {};
  if (cfg.supportsDateRange) {
    filters.date_range = { ...syncWindow(), ...(cfg.dateField ? { field: cfg.dateField } : {}) };
  }
  if (cfg.orderStatuses) filters.statuses = COMMITTED_STATUSES;

  const extra = { limit, offset, ...(Object.keys(filters).length ? { filters } : {}) };
  if (grouping) extra.group_by = grouping;
  return { cfg, reportKey: cfg.reportKey, cardKey: cfg.cardKey, extra };
}

// Pulls one report source (optionally grouped) for one company and overwrites
// its cache row. Returns { data, quota, rowsFetched }.
async function syncOne(companyId, source, grouping = null) {
  const { cfg, extra } = requestFor(source, grouping);

  let allRows = [];
  let quota = null;
  // Truncation has to be visible. An itemized pull that stops at the page cap
  // still fills the cache, and every widget on it then draws a confident
  // picture of part of the data — an exception list that silently omits the
  // last few thousand lines is worse than no exception list, because someone
  // acts on it. So the cache records that it was cut short and the dashboard
  // says so.
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await callReport(companyId, cfg.reportKey, cfg.cardKey, { ...extra, offset: page * PAGE_SIZE });
    const rows = result.data || [];
    allRows = allRows.concat(rows);
    quota = result.quota || quota;
    if (rows.length < PAGE_SIZE) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  const meta = { ...(quota || {}), truncated, row_cap: MAX_PAGES * PAGE_SIZE };

  await pool.query(
    `INSERT INTO fmh_report_cache (company_id, cache_key, data_json, quota_json, synced_at)
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE data_json = VALUES(data_json), quota_json = VALUES(quota_json), synced_at = NOW()`,
    [companyId, cacheKeyFor(source, grouping), JSON.stringify(allRows), JSON.stringify(meta)]
  );
  return { data: allRows, quota: meta, rowsFetched: allRows.length, truncated };
}

// Every (source, grouping) pair a company actually shows somewhere. A widget
// opts into a grouping with "group_by" in its config; without one it reads the
// itemized pull, as every widget did before grouping existed.
async function pullsUsedByCompany(companyId) {
  const [rows] = await pool.query(
    `SELECT t.report_source, t.default_config_json, w.config_json
     FROM dashboard_widgets w
     JOIN dashboards d ON d.id = w.dashboard_id
     JOIN widget_templates t ON t.id = w.widget_template_id
     WHERE d.company_id = ? AND d.active = TRUE`,
    [companyId]
  );
  const seen = new Map();
  rows.forEach((r) => {
    const cfg = FMH_REPORTS[r.report_source];
    if (!cfg) return;
    let grouping = null;
    try {
      const merged = { ...JSON.parse(r.default_config_json || '{}'), ...JSON.parse(r.config_json || '{}') };
      if (merged.group_by && cfg.groupings.includes(merged.group_by)) grouping = merged.group_by;
    } catch {
      /* a malformed config falls back to itemized rather than dropping the widget */
    }
    seen.set(cacheKeyFor(r.report_source, grouping), { source: r.report_source, grouping });
  });
  return [...seen.values()];
}

// Kept for callers that only care which reports a company uses.
async function sourcesUsedByCompany(companyId) {
  const pulls = await pullsUsedByCompany(companyId);
  return [...new Set(pulls.map((p) => p.source))];
}

// Syncs every pull a company needs. Per-pull failures are isolated and
// returned rather than thrown, so one bad report can't stop the rest.
// `pulls` accepts {source, grouping} entries, or plain source strings.
async function syncCompany(companyId, pulls = null) {
  const list = pulls || (await pullsUsedByCompany(companyId));
  const results = {};
  for (const entry of list) {
    const { source, grouping } = typeof entry === 'string' ? { source: entry, grouping: null } : entry;
    const key = cacheKeyFor(source, grouping);
    try {
      const { data } = await syncOne(companyId, source, grouping);
      results[key] = { ok: true, rows: data.length };
    } catch (err) {
      console.error(`FMH sync failed for company ${companyId} / "${key}":`, err.message);
      results[key] = { ok: false, error: err.message, code: err.code };
    }
  }
  return results;
}

// Every company that has an FMH key and isn't suspended. Used by the 1am cron.
async function syncAllCompanies() {
  const [companies] = await pool.query(
    `SELECT id, name FROM companies WHERE fmh_api_key_enc IS NOT NULL AND status <> 'suspended'`
  );
  const out = {};
  for (const c of companies) out[`${c.id}:${c.name}`] = await syncCompany(c.id);
  return out;
}

async function getCached(companyId, source, grouping = null) {
  const [[row]] = await pool.query(
    `SELECT data_json, quota_json, synced_at FROM fmh_report_cache WHERE company_id = ? AND cache_key = ?`,
    [companyId, cacheKeyFor(source, grouping)]
  );
  if (!row) return null;
  return {
    data: JSON.parse(row.data_json),
    quota: row.quota_json ? JSON.parse(row.quota_json) : null,
    syncedAt: row.synced_at,
  };
}

async function getSyncStatus(companyId) {
  const [rows] = await pool.query(
    `SELECT cache_key, synced_at, JSON_LENGTH(data_json) AS rows_cached
     FROM fmh_report_cache WHERE company_id = ?`,
    [companyId]
  );
  return rows;
}

module.exports = {
  FMH_REPORTS,
  SYNC_WINDOW_DAYS,
  COMMITTED_STATUSES,
  cacheKeyFor,
  requestFor,
  syncOne,
  syncCompany,
  syncAllCompanies,
  pullsUsedByCompany,
  sourcesUsedByCompany,
  getCached,
  getSyncStatus,
};
