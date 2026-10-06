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
// An incremental cache is rebuilt in full this often, so anything that changed
// on an older order (a late invoice, a cancelled line) is picked up in the end.
const FULL_REFRESH_DAYS = 14;
// The nightly sync skips a pull refreshed this recently (boot sync, Refresh
// button, Admin sync) instead of paying for the same rows twice in a day.
const CRON_MIN_AGE_HOURS = 20;
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
//   rowDateField   the row column the range picker filters on, when it is not
//                  dateField (a report with no request-side date choice)
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
    // Incremental: re-read only orders placed in the last N days (invoices and
    // GRNs land on recent orders) and replace them PO by PO in the cache.
    incremental: { days: 21, rowKey: 'po_number' },
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
    // Recipes change rarely and have no date range: the nightly sync re-reads
    // them weekly instead of daily (Refresh / Admin sync can still force it).
    cronEveryDays: 7,
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
    incremental: { days: 7 },
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
  // What a central kitchen (or any seller on FMH) sold, line by line: to which
  // customer, which product, ordered and delivered when. One itemized pull
  // feeds every "ยอดขายครัวกลาง" widget. The range picker filters on the
  // delivery date; the request keeps FMH's own default date field, so a
  // field name FMH might not accept is never sent.
  'sales-analysis': {
    label: 'Sales Analysis (ยอดขายครัวกลาง)',
    reportKey: 'sales_analysis',
    cardKey: 'sales_analysis_table',
    ui: 'table',
    supportsDateRange: true,
    dateField: null,
    rowDateField: 'requested_delivery_date',
    orderStatuses: true,
    groupings: ['product'],
    // Re-read the last 7 days and replace them SO by SO; full rebuild every 14.
    incremental: { days: 7, rowKey: 'so_number', dateField: 'order_date', slackDays: 3 },
  },
  'pos-sales': {
    label: 'ยอดขาย POS (ไฟล์อัปโหลด) × ต้นทุนสูตร FMH',
    // Not an FMH report: computed from uploaded POS files (lib/posSales.js)
    // and FMH recipe costs, then cached like one. Free to rebuild — no quota.
    local: true,
    reportKey: null,
    cardKey: null,
    ui: 'table',
    supportsDateRange: true,
    dateField: null,
    rowDateField: 'sale_date',
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
    // No date column to choose in the REQUEST, but every row carries its
    // period, so the range picker can still filter it. Without this, CK sales
    // covered the whole 80-day sync while CK purchases followed the picker,
    // and the CK margin compared two different windows.
    rowDateField: 'period',
    // 'period' is the START of a bucket FMH chose (day / week / month), not
    // the date of a sale: a range must keep every bucket it overlaps, or the
    // September bucket (period 2026-09-01) vanishes from a 5 Sep–5 Oct range.
    rowDateIsBucket: true,
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
  // Actual vs theoretical. The variance table is per product per outlet over
  // the whole request window; the two stat cards give the valued totals that
  // the table only carries as quantities.
  'product-variance': {
    label: "ส่วนต่างการใช้วัตถุดิบ (รายสินค้า)",
    reportKey: 'product_variance',
    cardKey: 'product_variance_table',
    ui: 'table',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: false,
    groupings: [],
  },
  'avt-theoretical-stat': {
    label: "มูลค่าการใช้ตามสูตร",
    reportKey: 'product_variance',
    cardKey: 'variance_stat_theoretical_usage_value',
    ui: 'stat_card',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: false,
    groupings: [],
  },
  'avt-actual-stat': {
    label: "มูลค่าการใช้จริง",
    reportKey: 'product_variance',
    cardKey: 'variance_stat_actual_usage_value',
    ui: 'stat_card',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: false,
    groupings: [],
  },
  // Itemized wastage. Deliberately NOT filtered by the range picker: it is
  // joined to product variance, which covers the whole sync window, and the
  // two must cover the same days.
  'wastage-lines': {
    label: "ของเสีย (รายบรรทัด)",
    reportKey: 'stock_wastage',
    cardKey: 'wastage_table',
    ui: 'table',
    supportsDateRange: true,
    dateField: null,
    orderStatuses: false,
    groupings: [],
  },
  'credit-unutilized-stat': {
    label: "ใบลดหนี้ที่ยังไม่ได้ใช้",
    reportKey: 'credit_note_summary',
    cardKey: 'credit_note_stat_unutilized_amount',
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

function syncWindow(days = SYNC_WINDOW_DAYS) {
  const end = new Date();
  const start = new Date(Date.now() - days * 86400000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

// The exact request the sync would send for one pull. Diagnostics call this
// too, so a probe that says "this pull returns no rows" is a statement about
// the real sync and not about a request a probe happened to build its own way.
function requestFor(source, grouping = null, { limit = PAGE_SIZE, offset = 0, windowDays = SYNC_WINDOW_DAYS } = {}) {
  const cfg = FMH_REPORTS[source];
  if (!cfg) throw new Error(`Unknown report source: ${source}`);
  if (grouping && !cfg.groupings.includes(grouping)) {
    throw new Error(`Report source "${source}" does not support grouping "${grouping}"`);
  }

  const filters = {};
  if (cfg.supportsDateRange) {
    filters.date_range = { ...syncWindow(windowDays), ...(cfg.dateField ? { field: cfg.dateField } : {}) };
  }
  if (cfg.orderStatuses) filters.statuses = COMMITTED_STATUSES;

  const extra = { limit, offset, ...(Object.keys(filters).length ? { filters } : {}) };
  if (grouping) extra.group_by = grouping;
  return { cfg, reportKey: cfg.reportKey, cardKey: cfg.cardKey, extra };
}

async function fetchAll(companyId, cfg, extra) {
  let rows = [];
  let quota = null;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await callReport(companyId, cfg.reportKey, cfg.cardKey, { ...extra, offset: page * PAGE_SIZE });
    const got = result.data || [];
    rows = rows.concat(got);
    quota = result.quota || quota;
    if (got.length < PAGE_SIZE) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { rows, quota, truncated };
}

const dayOf = (row, field) => String((row && row[field]) || '').slice(0, 10);

// Old cache + a fresh pull of the last N days -> the new cache.
//  - every old row dated inside the fresh window is dropped (the fresh pull has it)
//  - with a rowKey (po_number), every old row of a document that appears in the
//    fresh pull is dropped too, so a timezone edge can never double a PO
//  - rows older than the full window fall off, exactly as a full pull would
//  - exact duplicates are removed as a last guard
function mergeIncremental(oldRows, freshRows, { dateField, rowKey, freshStart, windowStart }) {
  const freshKeys = rowKey ? new Set(freshRows.map((r) => r[rowKey]).filter((v) => v !== undefined && v !== null && v !== '')) : null;
  const kept = oldRows.filter((r) => {
    const d = dayOf(r, dateField);
    if (d >= freshStart) return false;
    if (d < windowStart) return false;
    if (freshKeys && freshKeys.has(r[rowKey])) return false;
    return true;
  });
  const seen = new Set();
  return kept.concat(freshRows).filter((r) => {
    const k = JSON.stringify(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Pulls one report source (optionally grouped) for one company and updates
// its cache row. Returns { data, quota, rowsFetched, truncated, mode }.
// opts.full forces a full re-read of an incremental source.
async function syncOne(companyId, source, grouping = null, opts = {}) {
  try {
    return await syncOneInner(companyId, source, grouping, opts);
  } catch (err) {
    await recordSyncError(companyId, cacheKeyFor(source, grouping), err);
    throw err;
  }
}

async function syncOneInner(companyId, source, grouping = null, opts = {}) {
  const cfg = FMH_REPORTS[source];
  if (cfg && cfg.local) return syncLocal(companyId, source);
  const inc = !grouping && cfg && cfg.incremental && (cfg.incremental.dateField || cfg.dateField) ? cfg.incremental : null;
  const incDate = inc ? inc.dateField || cfg.dateField : null;

  // Truncation has to be visible. An itemized pull that stops at the page cap
  // still fills the cache, and every widget on it then draws a confident
  // picture of part of the data — so the cache records it and the dashboard says so.
  if (inc && !opts.full) {
    const cached = await getCached(companyId, source, grouping);
    const meta = (cached && cached.quota) || {};
    // Caches written before incremental sync existed were always full pulls,
    // so their synced_at is when they were last full — no extra full pull on upgrade.
    const fullAtIso = meta.full_synced_at || (cached && cached.syncedAt && new Date(cached.syncedAt).toISOString());
    const fullAt = fullAtIso ? new Date(fullAtIso).getTime() : 0;
    const fresh = fullAt && Date.now() - fullAt < FULL_REFRESH_DAYS * 86400000;
    // An empty cache can't be extended: it may be empty because the last pull
    // failed silently, so start again from a full pull.
    // Rows from uploaded FMH files are set aside and re-added around the API rows.
    const cachedApi = cached ? cached.data.filter((r) => !r._file) : [];
    const dated = cached && cachedApi.length > 0 && cachedApi.every((r) => dayOf(r, incDate));
    if (cached && fresh && dated && !meta.truncated) {
      const { extra } = requestFor(source, null, { windowDays: inc.days });
      const got = await fetchAll(companyId, cfg, extra);
      const merged = mergeIncremental(cachedApi, got.rows, {
        dateField: incDate,
        rowKey: inc.rowKey,
        freshStart: extra.filters.date_range.start,
        // slackDays: when the request's date field and the merge's differ
        // (FMH's default vs order_date), keep a few edge days rather than
        // trimming rows the full pull would still have returned.
        windowStart: syncWindow(SYNC_WINDOW_DAYS + (inc.slackDays || 0)).start,
      });
      const { rows: data, history } = await addFileHistory(companyId, source, merged);
      const newMeta = { ...meta, ...(got.quota || {}), truncated: got.truncated, row_cap: MAX_PAGES * PAGE_SIZE, full_synced_at: fullAtIso, last_mode: 'incremental', history };
      await writeCache(companyId, source, grouping, data, newMeta);
      return { data, quota: newMeta, rowsFetched: got.rows.length, truncated: got.truncated, mode: 'incremental' };
    }
  }

  const { extra } = requestFor(source, grouping);
  const got = await fetchAll(companyId, cfg, extra);
  const { rows: data, history } = grouping ? { rows: got.rows, history: undefined } : await addFileHistory(companyId, source, got.rows);
  const meta = { ...(got.quota || {}), truncated: got.truncated, row_cap: MAX_PAGES * PAGE_SIZE, full_synced_at: new Date().toISOString(), last_mode: 'full', history };
  await writeCache(companyId, source, grouping, data, meta);
  // New recipe costs re-cost uploaded POS sales.
  if (source === 'menu-costing') await refreshPosAfterRecipes(companyId);
  return { data, quota: meta, rowsFetched: got.rows.length, truncated: got.truncated, mode: 'full' };
}

// The first day the API window covers; uploaded files fill in before it.
function apiWindowStart() {
  return syncWindow(SYNC_WINDOW_DAYS).start;
}

// API rows + rows from uploaded FMH export files older than the API window
// (lib/fmhFiles.js). Sources with no file support pass straight through.
async function addFileHistory(companyId, source, apiRows) {
  const files = require('./fmhFiles');
  if (!files.SOURCES.includes(source)) return { rows: apiRows, history: undefined };
  return files.withFileHistory(companyId, source, apiRows, apiRows.length ? apiWindowStart() : null);
}

// A report computed here rather than pulled from FMH. With nothing to compute
// (no POS file uploaded), the cache is left alone and the dashboard says so.
async function syncLocal(companyId, source) {
  const built = await require('./posSales').buildRows(companyId);
  if (!built) return { data: [], quota: null, rowsFetched: 0, truncated: false, mode: 'local' };
  const meta = { ...built.meta, local: true, last_mode: 'local' };
  await writeCache(companyId, source, null, built.rows, meta);
  return { data: built.rows, quota: meta, rowsFetched: 0, truncated: false, mode: 'local' };
}

async function refreshPosAfterRecipes(companyId) {
  try {
    const [[has]] = await pool.query(`SELECT 1 AS ok FROM fmh_report_cache WHERE company_id = ? AND cache_key = 'pos-sales'`, [companyId]);
    if (has) await syncLocal(companyId, 'pos-sales');
  } catch (err) {
    console.error(`POS re-cost after recipe sync failed (company ${companyId}):`, err.message);
  }
}

// opts.keepSyncedAt: a rebuild that read nothing from FMH (file upload) keeps
// the time FMH was last read.
async function writeCache(companyId, source, grouping, rows, meta, opts = {}) {
  const key = cacheKeyFor(source, grouping);
  const data = JSON.stringify(rows);
  const metaJson = JSON.stringify(meta);
  await pool.query(
    `INSERT INTO fmh_report_cache (company_id, cache_key, data_json, quota_json, synced_at)
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE data_json = VALUES(data_json), quota_json = VALUES(quota_json), synced_at = ${opts.keepSyncedAt ? 'synced_at' : 'NOW()'}`,
    [companyId, key, data, metaJson]
  );
  // Keep the last pull that had rows. An empty pull (a key with no access, a
  // quota that ran dry mid-month, a wrong window) must not erase it.
  if (rows.length) {
    await pool.query(
      `INSERT INTO fmh_cache_saved (company_id, cache_key, data_json, quota_json, synced_at)
       VALUES (?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE data_json = VALUES(data_json), quota_json = VALUES(quota_json), synced_at = ${opts.keepSyncedAt ? 'synced_at' : 'NOW()'}`,
      [companyId, key, data, metaJson]
    );
  }
  await pool.query(`DELETE FROM fmh_sync_errors WHERE company_id = ? AND cache_key = ?`, [companyId, key]);
}

async function recordSyncError(companyId, key, err) {
  try {
    await pool.query(
      `INSERT INTO fmh_sync_errors (company_id, cache_key, error_text, failed_at) VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE error_text = VALUES(error_text), failed_at = NOW()`,
      [companyId, key, String((err && err.message) || err).slice(0, 500)]
    );
  } catch (e) {
    console.error('Could not record sync error:', e.message);
  }
}

async function getSaved(companyId, source, grouping = null) {
  const [[row]] = await pool.query(
    `SELECT data_json, quota_json, synced_at FROM fmh_cache_saved WHERE company_id = ? AND cache_key = ?`,
    [companyId, cacheKeyFor(source, grouping)]
  );
  if (!row) return null;
  return { data: JSON.parse(row.data_json), quota: row.quota_json ? JSON.parse(row.quota_json) : null, syncedAt: row.synced_at };
}

async function getSyncHealth(companyId, source, grouping = null) {
  const key = cacheKeyFor(source, grouping);
  const [[saved]] = await pool.query(`SELECT synced_at FROM fmh_cache_saved WHERE company_id = ? AND cache_key = ?`, [companyId, key]);
  const [[err]] = await pool.query(`SELECT error_text, failed_at FROM fmh_sync_errors WHERE company_id = ? AND cache_key = ?`, [companyId, key]);
  return {
    saved_synced_at: saved ? saved.synced_at : null,
    last_error: err ? err.error_text : null,
    last_error_at: err ? err.failed_at : null,
  };
}

// Every (source, grouping) pair a company actually shows somewhere. A widget
// opts into a grouping with "group_by" in its config; without one it reads the
// itemized pull, as every widget did before grouping existed.
// Every pull one widget needs.
//
// Most widgets need one. A pivot widget declares config.sources and needs
// several, because its whole job is to put two reports side by side — CK sales
// against CK purchases, say. Sync, the boot warm-up, the dashboard payload and
// the per-source access check all have to agree on that list, so they all call
// this rather than each deciding for itself.
function pullsForWidget(reportSource, config = {}) {
  const out = [];
  const seen = new Set();
  const add = (source, groupBy) => {
    const cfg = FMH_REPORTS[source];
    if (!cfg) return;
    const grouping = groupBy && cfg.groupings.includes(groupBy) ? groupBy : null;
    const key = cacheKeyFor(source, grouping);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ source, grouping });
  };
  if (Array.isArray(config.sources) && config.sources.length) {
    config.sources.forEach((s) => s && add(s.source, s.group_by));
  } else {
    add(reportSource, typeof config.group_by === 'string' ? config.group_by : null);
  }
  return out;
}

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
    let merged = {};
    try {
      merged = { ...JSON.parse(r.default_config_json || '{}'), ...JSON.parse(r.config_json || '{}') };
    } catch {
      /* a malformed config falls back to itemized rather than dropping the widget */
    }
    pullsForWidget(r.report_source, merged).forEach((p) => seen.set(cacheKeyFor(p.source, p.grouping), p));
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
// opts.cron: skip pulls refreshed in the last CRON_MIN_AGE_HOURS, and sources
// with cronEveryDays that are not due yet. opts.full: no incremental shortcut.
async function syncCompany(companyId, pulls = null, opts = {}) {
  const isLocal = (e) => !!(FMH_REPORTS[typeof e === 'string' ? e : e.source] || {}).local;
  // Computed reports go last, so they read the recipes this run just pulled.
  const list = [...(pulls || (await pullsUsedByCompany(companyId)))].sort((a, b) => isLocal(a) - isLocal(b));
  const results = {};
  const [ages] = opts.cron
    ? await pool.query(`SELECT cache_key, synced_at FROM fmh_report_cache WHERE company_id = ?`, [companyId])
    : [[]];
  const syncedAt = new Map(ages.map((r) => [r.cache_key, new Date(r.synced_at).getTime()]));
  for (const entry of list) {
    const { source, grouping } = typeof entry === 'string' ? { source: entry, grouping: null } : entry;
    const key = cacheKeyFor(source, grouping);
    if (opts.cron && syncedAt.has(key) && !isLocal(source)) {
      const ageH = (Date.now() - syncedAt.get(key)) / 3600000;
      const every = (FMH_REPORTS[source] && FMH_REPORTS[source].cronEveryDays) || 0;
      if (ageH < CRON_MIN_AGE_HOURS || (every && ageH < every * 24 - 4)) {
        results[key] = { ok: true, skipped: true };
        continue;
      }
    }
    try {
      const r = await syncOne(companyId, source, grouping, { full: !!opts.full });
      results[key] = { ok: true, rows: r.data.length, fetched: r.rowsFetched, mode: r.mode };
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
    `SELECT id, name FROM companies WHERE (fmh_api_key_enc IS NOT NULL OR data_source = 'demo') AND status <> 'suspended'`
  );
  const out = {};
  for (const c of companies) out[`${c.id}:${c.name}`] = await syncCompany(c.id, null, { cron: true });
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
  FULL_REFRESH_DAYS,
  mergeIncremental,
  COMMITTED_STATUSES,
  cacheKeyFor,
  requestFor,
  pullsForWidget,
  syncOne,
  syncCompany,
  syncAllCompanies,
  pullsUsedByCompany,
  sourcesUsedByCompany,
  getCached,
  getSaved,
  getSyncHealth,
  getSyncStatus,
  writeCache,
  apiWindowStart,
};
