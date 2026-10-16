// Rolling history beyond FMH's API window.
//
// FMH's API only serves about the last 90 days (the sync reads 80). Every time a
// report is written to the cache, its API rows are filed here one calendar day
// at a time; the cache is then rebuilt as
//     archived days older than the API's first day  +  the API rows.
// So on day 91 the rows of day 1 are still here — the history grows by itself,
// with no file uploads and no extra FMH quota. A day keeps the last version the
// API returned while it was in the window (statuses settle long before 80 days).
//
// Only reports whose rows carry their own calendar day are archived. Reports
// that come back as one total for the whole range (COGS by menu, top-10 lists,
// stock balance, variance) cannot be stitched day by day and stay API-only.
const crypto = require('crypto');
const pool = require('../db/pool');
const { pack, unpack } = require('./cacheBlob');

// source -> the row's own day (the same date FMH filters the request on, and the dashboard filters
// the range on), and the document id that de-duplicates against the API. Only line-level reports
// whose day is fixed are kept: bucketed trends ("period" = a day/week/month FMH picks), snapshots
// (batch remaining, credit-note utilisation) and range totals cannot be stitched day by day.
const ARCHIVE = {
  'purchase-analysis': { dateField: 'order_date', docField: 'po_number' },
  'sales-analysis': { dateField: 'order_date', docField: 'so_number' },
  'sales-by-branch': { dateField: 'requested_delivery_date' },
};
// The first days of a pull may be partial (FMH's filter date and our day key can differ by a day or
// two, time zones): never file them — they were filed whole while further inside the window.
const EDGE_DAYS = 3;
const KEEP_DAYS = () => Math.max(120, Number(process.env.FMH_ARCHIVE_DAYS) || 400); // ~13 months: a year back plus this month's year-ago
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (r, f) => { const d = String((r && r[f]) || '').slice(0, 10); return ISO.test(d) ? d : null; };
const isApi = (r) => !r._file && !r._arch;
const strip = (r) => { const { _arch, ...rest } = r; return rest; };
const bkkToday = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

const archivable = (source, grouping) => !grouping && !!ARCHIVE[source];
// Demo data is generated against today's date (prices drift with it): archiving it would file a
// different "history" every night. Demo companies stay on their generated 90 days.
async function isDemo(companyId) {
  const [[c]] = await pool.query(`SELECT data_source FROM companies WHERE id = ?`, [companyId]);
  return !!(c && c.data_source === 'demo');
}

// File the API rows of one pull, a day at a time. Unchanged days are skipped (hash).
async function capture(companyId, source, rows, grouping = null, opts = {}) {
  if (!archivable(source, grouping) || !Array.isArray(rows) || opts.truncated || (await isDemo(companyId))) return { days: 0 };
  const f = ARCHIVE[source].dateField;
  const byDay = new Map();
  rows.filter(isApi).forEach((r) => { const d = dayOf(r, f); if (d) (byDay.get(d) || byDay.set(d, []).get(d)).push(r); });
  if (!byDay.size) return { days: 0 };
  const first = [...byDay.keys()].sort()[0];
  const edge = addDays(first, EDGE_DAYS);
  [...byDay.keys()].forEach((d) => { if (d < edge) byDay.delete(d); });
  if (!byDay.size) return { days: 0 };
  const [have] = await pool.query(`SELECT day, row_hash FROM fmh_archive WHERE company_id = ? AND source = ? AND day IN (?)`, [companyId, source, [...byDay.keys()]]);
  const known = new Map(have.map((h) => [(h.day instanceof Date ? h.day.toISOString() : String(h.day)).slice(0, 10), h.row_hash]));
  let written = 0;
  for (const [day, list] of byDay) {
    // Row order from FMH is not guaranteed: hash a canonical order so an unchanged day is not rewritten.
    const json = list.map((r) => JSON.stringify(r, Object.keys(r).sort())).sort().join('\n');
    const hash = crypto.createHash('sha1').update(json).digest('hex');
    if (known.get(day) === hash) continue;
    const { gz, count } = pack(list);
    await pool.query(
      `INSERT INTO fmh_archive (company_id, source, day, data_gz, row_count, row_hash) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE data_gz = VALUES(data_gz), row_count = VALUES(row_count), row_hash = VALUES(row_hash), updated_at = NOW()`,
      [companyId, source, day, gz, count, hash]
    );
    written++;
  }
  // Older than the retention: gone.
  await pool.query(`DELETE FROM fmh_archive WHERE company_id = ? AND source = ? AND day < ?`, [companyId, source, addDays(bkkToday(), -KEEP_DAYS())]);
  return { days: written };
}

// API rows + the archived days before the API's first day. Returns the rows and what was added.
// windowStart: the first day the API request covers. Archived days from there on are never added
// (the API is the truth inside its window, even where it has no rows). An empty pull gets nothing
// added either, so a failed pull cannot pass old days off as current.
async function withArchive(companyId, source, apiRows, windowStart, grouping = null) {
  if (!archivable(source, grouping) || !apiRows.length || !windowStart || (await isDemo(companyId))) return { rows: apiRows, archive: null };
  const { docField } = ARCHIVE[source];
  const params = [companyId, source, addDays(bkkToday(), -KEEP_DAYS()), windowStart];
  const where = 'AND day < ?';
  const [days] = await pool.query(`SELECT day, data_gz FROM fmh_archive WHERE company_id = ? AND source = ? AND day >= ? ${where} ORDER BY day`, params);
  if (!days.length) return { rows: apiRows, archive: null };
  const apiDocs = docField ? new Set(apiRows.map((r) => r[docField]).filter(Boolean)) : null;
  const old = [];
  days.forEach((d) => unpack(d).forEach((r) => { if (!apiDocs || !apiDocs.has(r[docField])) old.push({ ...strip(r), _arch: 1 }); }));
  const iso = (v) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
  return { rows: old.concat(apiRows), archive: { archive_from: iso(days[0].day), archive_to: iso(days[days.length - 1].day), archive_days: days.length, archive_rows: old.length } };
}

// One pass over every cache at boot, so history starts from what is cached today.
async function captureAllCached() {
  const fc = require('./fmhCache');
  const [rows] = await pool.query(`SELECT r.company_id, r.cache_key FROM fmh_report_cache r JOIN companies c ON c.id = r.company_id`);
  let n = 0;
  for (const r of rows) {
    const [source, grouping] = r.cache_key.split('|');
    if (!archivable(source, grouping || null)) continue;
    try { const c = await fc.getCached(r.company_id, source, null); if (c) n += (await capture(r.company_id, source, c.data, null, { truncated: c.quota && c.quota.truncated })).days; }
    catch (err) { console.error(`archive capture failed (${r.company_id}/${source}):`, err.message); }
  }
  return n;
}

// Admin view: how far back each report's history now reaches.
async function overview(companyId) {
  const [rows] = await pool.query(
    `SELECT source, MIN(day) AS first_day, MAX(day) AS last_day, COUNT(*) AS days, SUM(row_count) AS rows_kept, SUM(LENGTH(data_gz)) AS bytes
       FROM fmh_archive WHERE company_id = ? GROUP BY source`, [companyId]);
  return rows;
}

module.exports = { ARCHIVE, archivable, capture, withArchive, captureAllCached, overview, isApi };
