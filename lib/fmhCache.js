// Central place for FMH report syncing + reading the local cache.
//
// Why this exists: every dashboard page view used to call FMH live, which
// burns FMH's monthly row quota fast once more than a couple of people use
// the app. Instead, we pull each report once a day (cron in server.js) into
// fmh_report_cache, plus let any user trigger an on-demand refresh (routes/
// reports.js), and dashboards always read from this cache — never from FMH
// directly on a normal page load.
const pool = require('../db/pool');
const { callReport } = require('./fmh');

// FMH's own Reports API caps date_range lookback at 90 days, so a sync always
// pulls "today minus 90 days" through "today" — there's no reason to ask for
// less, since the cache serves every date-range filter the UI offers.
const SYNC_WINDOW_DAYS = 90;

// A page of up to this many rows per FMH call; synced reports are paginated
// until a page comes back shorter than this, capped at MAX_PAGES as a safety
// net against an unbounded loop if FMH's pagination ever behaves oddly.
const PAGE_SIZE = 1000;
const MAX_PAGES = 10;

// cacheKey (used in the URL, e.g. /api/reports/:cacheKey) -> how to pull it.
// dashboardKey matches dashboards.dashboard_key, used to check a client's
// per-user tab access before letting them trigger a manual refresh.
const FMH_REPORTS = {
  cogs: { reportKey: 'cogs', cardKey: 'cogs_table', dashboardKey: 'cogs', supportsDateRange: true },
  'menu-costing': {
    reportKey: 'menu_and_ingredients',
    cardKey: 'recipe_table',
    dashboardKey: 'menu_costing',
    supportsDateRange: false, // FMH's own catalog doesn't support date_range on this report
  },
  'sales-by-branch': {
    reportKey: 'order_items_by_branch',
    cardKey: 'oibb_table',
    dashboardKey: 'sales_by_branch',
    supportsDateRange: true,
  },
  'purchase-analysis': {
    reportKey: 'purchase_analysis',
    cardKey: null,
    dashboardKey: 'purchase_analysis',
    supportsDateRange: true,
  },
};

function ninetyDayRange() {
  const end = new Date();
  const start = new Date(Date.now() - SYNC_WINDOW_DAYS * 86400000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

// Pulls one report's full 90-day window from FMH (paginated) and overwrites
// its cache row. Returns { data, quota } — quota is whatever FMH returned on
// the LAST page fetched (the freshest figure we have).
async function syncOne(cacheKey) {
  const cfg = FMH_REPORTS[cacheKey];
  if (!cfg) throw new Error(`Unknown FMH cache key: ${cacheKey}`);

  const extra = { limit: PAGE_SIZE };
  if (cfg.supportsDateRange) extra.filters = { date_range: ninetyDayRange() };

  let allRows = [];
  let quota = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await callReport(cfg.reportKey, cfg.cardKey, { ...extra, offset: page * PAGE_SIZE });
    const rows = result.data || [];
    allRows = allRows.concat(rows);
    quota = result.quota || quota;
    if (rows.length < PAGE_SIZE) break; // last page
  }

  await pool.query(
    `INSERT INTO fmh_report_cache (cache_key, data_json, quota_json, synced_at)
     VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE data_json = VALUES(data_json), quota_json = VALUES(quota_json), synced_at = NOW()`,
    [cacheKey, JSON.stringify(allRows), quota ? JSON.stringify(quota) : null]
  );

  return { data: allRows, quota };
}

// Syncs every configured report. Failures are isolated per report (e.g. one
// bad report shouldn't block the others) and returned in the result rather
// than thrown, so the daily cron job can log a clean per-report summary.
async function syncAll() {
  const results = {};
  for (const key of Object.keys(FMH_REPORTS)) {
    try {
      results[key] = await syncOne(key);
    } catch (err) {
      console.error(`FMH sync failed for "${key}":`, err.message);
      results[key] = { error: err.message, code: err.code };
    }
  }
  return results;
}

async function getCached(cacheKey) {
  const [[row]] = await pool.query(
    `SELECT data_json, quota_json, synced_at FROM fmh_report_cache WHERE cache_key = ?`,
    [cacheKey]
  );
  if (!row) return null;
  return {
    data: JSON.parse(row.data_json),
    quota: row.quota_json ? JSON.parse(row.quota_json) : null,
    syncedAt: row.synced_at,
  };
}

async function getLastSyncedAt(cacheKey) {
  const [[row]] = await pool.query(`SELECT synced_at FROM fmh_report_cache WHERE cache_key = ?`, [cacheKey]);
  return row ? new Date(row.synced_at) : null;
}

module.exports = { FMH_REPORTS, SYNC_WINDOW_DAYS, syncOne, syncAll, getCached, getLastSyncedAt };
