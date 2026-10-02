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

// Report Sources. The key is what widget_templates.report_source refers to.
//
//   cardKey     the card to request — FMH's own default_card for that report
//   dateField   the per-row date the dashboard's range picker filters on, and
//               the column FMH filters on server-side (null = the source has no
//               usable per-row date, so it ignores the picker)
//   statuses    whether the report accepts the order-status filter
//   groupings   the server-side group_by values this report's card accepts
const FMH_REPORTS = {
  'purchase-analysis': {
    label: 'Purchase Analysis (PO / GRN / Invoice)',
    reportKey: 'purchase_analysis',
    cardKey: 'purchase_analysis_table',
    supportsDateRange: true,
    dateField: 'order_date',
    statuses: true,
    groupings: ['branch', 'supplier', 'category', 'product'],
  },
  'menu-costing': {
    label: 'Menu & Ingredients (สูตร / ต้นทุนเมนู)',
    reportKey: 'menu_and_ingredients',
    cardKey: 'recipe_table',
    supportsDateRange: false,
    dateField: null,
    statuses: false,
    groupings: ['by_menu', 'by_ingredient'],
  },
  cogs: {
    label: 'COGS (Central Kitchen)',
    reportKey: 'cogs',
    cardKey: 'cogs_table',
    supportsDateRange: true,
    dateField: null,
    statuses: false,
    // cogs defaults to "menu" rather than itemized, and "period" is what gives
    // this report a time axis at all — its table carries no date column.
    groupings: ['menu', 'branch', 'category', 'period'],
  },
  'sales-by-branch': {
    label: 'Order Items by Branch',
    reportKey: 'order_items_by_branch',
    cardKey: 'oibb_table',
    supportsDateRange: true,
    dateField: 'requested_delivery_date',
    statuses: true,
    groupings: ['branch', 'product'],
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

// Pulls one report source (optionally grouped) for one company and overwrites
// its cache row. Returns { data, quota, rowsFetched }.
async function syncOne(companyId, source, grouping = null) {
  const cfg = FMH_REPORTS[source];
  if (!cfg) throw new Error(`Unknown report source: ${source}`);
  if (grouping && !cfg.groupings.includes(grouping)) {
    throw new Error(`Report source "${source}" does not support grouping "${grouping}"`);
  }

  const filters = {};
  if (cfg.supportsDateRange) {
    filters.date_range = { ...syncWindow(), ...(cfg.dateField ? { field: cfg.dateField } : {}) };
  }
  if (cfg.statuses) filters.statuses = COMMITTED_STATUSES;

  const extra = { limit: PAGE_SIZE, ...(Object.keys(filters).length ? { filters } : {}) };
  if (grouping) extra.group_by = grouping;

  let allRows = [];
  let quota = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await callReport(companyId, cfg.reportKey, cfg.cardKey, { ...extra, offset: page * PAGE_SIZE });
    const rows = result.data || [];
    allRows = allRows.concat(rows);
    quota = result.quota || quota;
    if (rows.length < PAGE_SIZE) break;
  }

  await pool.query(
    `INSERT INTO fmh_report_cache (company_id, cache_key, data_json, quota_json, synced_at)
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE data_json = VALUES(data_json), quota_json = VALUES(quota_json), synced_at = NOW()`,
    [companyId, cacheKeyFor(source, grouping), JSON.stringify(allRows), quota ? JSON.stringify(quota) : null]
  );
  return { data: allRows, quota, rowsFetched: allRows.length };
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
  syncOne,
  syncCompany,
  syncAllCompanies,
  pullsUsedByCompany,
  sourcesUsedByCompany,
  getCached,
  getSyncStatus,
};
