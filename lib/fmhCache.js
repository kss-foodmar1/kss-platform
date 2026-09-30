// FMH report syncing + reading the local cache, per company.
//
// Dashboards never call FMH on a page view — they read fmh_report_cache.
// The cache is filled by the daily 1am sync (server.js) and by on-demand
// refreshes (routes/dashboards.js), and only for the report sources a company
// actually has widgets for, so no FMH quota is spent on reports nobody shows.
const pool = require('../db/pool');
const { callReport } = require('./fmh');

// FMH's own Reports API caps date_range lookback at 90 days.
const SYNC_WINDOW_DAYS = 90;
const PAGE_SIZE = 1000;
const MAX_PAGES = 10;

// Report Sources. The key is what widget_templates.report_source refers to.
// dateField: the per-row date the dashboard's date-range picker filters on
// (null = the source has no usable per-row date, so it ignores the picker).
const FMH_REPORTS = {
  'purchase-analysis': {
    label: 'Purchase Analysis (PO / GRN / Invoice)',
    reportKey: 'purchase_analysis',
    cardKey: null,
    supportsDateRange: true,
    dateField: 'order_date',
  },
  'menu-costing': {
    label: 'Menu & Ingredients (สูตร / ต้นทุนเมนู)',
    reportKey: 'menu_and_ingredients',
    cardKey: 'recipe_table',
    supportsDateRange: false,
    dateField: null,
  },
  cogs: {
    label: 'COGS (Central Kitchen)',
    reportKey: 'cogs',
    cardKey: 'cogs_table',
    supportsDateRange: true,
    dateField: null,
  },
  'sales-by-branch': {
    label: 'Order Items by Branch',
    reportKey: 'order_items_by_branch',
    cardKey: 'oibb_table',
    supportsDateRange: true,
    dateField: 'requested_delivery_date',
  },
};

function ninetyDayRange() {
  const end = new Date();
  const start = new Date(Date.now() - SYNC_WINDOW_DAYS * 86400000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

// Pulls one report source's full 90-day window for one company and
// overwrites its cache row. Returns { data, quota }.
async function syncOne(companyId, source) {
  const cfg = FMH_REPORTS[source];
  if (!cfg) throw new Error(`Unknown report source: ${source}`);

  const extra = { limit: PAGE_SIZE };
  if (cfg.supportsDateRange) extra.filters = { date_range: ninetyDayRange() };

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
    [companyId, source, JSON.stringify(allRows), quota ? JSON.stringify(quota) : null]
  );
  return { data: allRows, quota };
}

// Report sources a company actually uses somewhere on its dashboards.
async function sourcesUsedByCompany(companyId) {
  const [rows] = await pool.query(
    `SELECT DISTINCT t.report_source
     FROM dashboard_widgets w
     JOIN dashboards d ON d.id = w.dashboard_id
     JOIN widget_templates t ON t.id = w.widget_template_id
     WHERE d.company_id = ? AND d.active = TRUE`,
    [companyId]
  );
  return rows.map((r) => r.report_source).filter((s) => FMH_REPORTS[s]);
}

// Syncs every source a company uses. Per-source failures are isolated and
// returned rather than thrown.
async function syncCompany(companyId, sources = null) {
  const list = sources || (await sourcesUsedByCompany(companyId));
  const results = {};
  for (const source of list) {
    try {
      const { data } = await syncOne(companyId, source);
      results[source] = { ok: true, rows: data.length };
    } catch (err) {
      console.error(`FMH sync failed for company ${companyId} / "${source}":`, err.message);
      results[source] = { ok: false, error: err.message, code: err.code };
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

async function getCached(companyId, source) {
  const [[row]] = await pool.query(
    `SELECT data_json, quota_json, synced_at FROM fmh_report_cache WHERE company_id = ? AND cache_key = ?`,
    [companyId, source]
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
  syncOne,
  syncCompany,
  syncAllCompanies,
  sourcesUsedByCompany,
  getCached,
  getSyncStatus,
};
