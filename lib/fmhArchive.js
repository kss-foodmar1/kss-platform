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

// source -> the row's own day, and the document id that de-duplicates against the API.
const ARCHIVE = {
  'purchase-analysis': { dateField: 'order_date', docField: 'po_number' },
  'sales-analysis': { dateField: 'order_date', docField: 'so_number' },
  'sales-by-branch': { dateField: 'requested_delivery_date' },
  picking: { dateField: 'issued_date' },
  'picking-trend': { dateField: 'period' },
  'wastage-lines': { dateField: 'wastage_date' },
  'wastage-trend': { dateField: 'period' },
  'cogs-trend': { dateField: 'period' },
  'price-avg-trend': { dateField: 'period' },
  'stock-flow': { dateField: 'period' },
  'stock-count': { dateField: 'count_date' },
  production: { dateField: 'production_date' },
  'credit-notes': { dateField: 'credit_note_date' },
  batch: { dateField: 'received_date' },
};
const KEEP_DAYS = () => Math.max(120, Number(process.env.FMH_ARCHIVE_DAYS) || 731); // two years by default
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (r, f) => { const d = String((r && r[f]) || '').slice(0, 10); return ISO.test(d) ? d : null; };
const isApi = (r) => !r._file && !r._arch;
const strip = (r) => { const { _arch, ...rest } = r; return rest; };
const bkkToday = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

const archivable = (source, grouping) => !grouping && !!ARCHIVE[source];

// File the API rows of one pull, a day at a time. Unchanged days are skipped (hash).
async function capture(companyId, source, rows, grouping = null) {
  if (!archivable(source, grouping) || !Array.isArray(rows)) return { days: 0 };
  const f = ARCHIVE[source].dateField;
  const byDay = new Map();
  rows.filter(isApi).forEach((r) => { const d = dayOf(r, f); if (d) (byDay.get(d) || byDay.set(d, []).get(d)).push(r); });
  if (!byDay.size) return { days: 0 };
  const [have] = await pool.query(`SELECT day, row_hash FROM fmh_archive WHERE company_id = ? AND source = ? AND day IN (?)`, [companyId, source, [...byDay.keys()]]);
  const known = new Map(have.map((h) => [(h.day instanceof Date ? h.day.toISOString() : String(h.day)).slice(0, 10), h.row_hash]));
  let written = 0;
  for (const [day, list] of byDay) {
    const json = JSON.stringify(list);
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
async function withArchive(companyId, source, apiRows, grouping = null) {
  if (!archivable(source, grouping)) return { rows: apiRows, archive: null };
  const { dateField: f, docField } = ARCHIVE[source];
  let apiFrom = null;
  apiRows.forEach((r) => { const d = dayOf(r, f); if (d && (!apiFrom || d < apiFrom)) apiFrom = d; });
  const params = [companyId, source, addDays(bkkToday(), -KEEP_DAYS())];
  let where = '';
  if (apiFrom) { where = 'AND day < ?'; params.push(apiFrom); }
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
    try { const c = await fc.getCached(r.company_id, source, null); if (c) n += (await capture(r.company_id, source, c.data)).days; }
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
