// History from files the customer downloads from FMH and uploads here.
//
// FMH's API only serves the last ~90 days (the sync reads 80). For six months
// or a year, the customer exports older months from FMH's report screen and
// uploads them. The browser reads the file (public/fmh-file.js) into rows
// shaped like the API's, and they are stored here per upload.
//
// The report cache then holds:  file rows older than the API window
//                             + API rows (the API always wins where it has data)
// File rows carry `_file: 1`, so an incremental sync can strip them and add
// them back around the fresh API rows. Building this costs no FMH quota.
//
// Replacement is per document, not per date range: FMH exports filter on a
// date the export doesn't name, so a month file can hold an SO dated the last
// day of the previous month. Uploading a document again (same SO/PO number)
// replaces its lines; nothing else is touched.
const pool = require('../db/pool');
const { PROFILES } = require('../public/fmh-file');

const SOURCES = Object.keys(PROFILES); // 'sales-analysis', 'purchase-analysis'
// How far back history is kept, and the most rows one company may store per
// report — a year of a busy central kitchen is ~40k lines.
const HISTORY_DAYS = 731;
const MAX_ROWS_PER_SOURCE = 250000;
const CHUNK_MAX = 5000;

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const iso = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : d ? String(d).slice(0, 10) : null);
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function profileFor(source) {
  const p = PROFILES[source];
  if (!p) throw bad('ยังไม่รองรับไฟล์ของรายงานนี้');
  return p;
}

// ---------- upload: begin -> rows (in chunks) -> commit ----------
async function begin(companyId, userId, { source, filename }) {
  profileFor(source);
  // Uploads abandoned mid-way (closed tab) never become visible; clear them.
  await pool.query(`DELETE FROM fmh_file_uploads WHERE company_id = ? AND status = 'pending' AND created_at < NOW() - INTERVAL 1 DAY`, [companyId]);
  const [r] = await pool.query(
    `INSERT INTO fmh_file_uploads (company_id, source, filename, status, uploaded_by) VALUES (?, ?, ?, 'pending', ?)`,
    [companyId, source, String(filename || 'fmh-export.xlsx').slice(0, 255), userId || null]
  );
  return { upload_id: r.insertId };
}

async function pendingUpload(companyId, uploadId) {
  const [[u]] = await pool.query(`SELECT * FROM fmh_file_uploads WHERE id = ? AND company_id = ?`, [uploadId, companyId]);
  if (!u) throw bad('ไม่พบการอัปโหลดนี้', 404);
  if (u.status !== 'pending') throw bad('การอัปโหลดนี้บันทึกไปแล้ว', 409);
  return u;
}

async function addRows(companyId, uploadId, rows) {
  const u = await pendingUpload(companyId, uploadId);
  const p = profileFor(u.source);
  if (!Array.isArray(rows) || !rows.length) throw bad('ไม่มีรายการในชุดนี้');
  if (rows.length > CHUNK_MAX) throw bad(`ส่งได้ครั้งละไม่เกิน ${CHUNK_MAX} แถว`);
  const oldest = iso(new Date(Date.now() - HISTORY_DAYS * 86400000));
  const values = [];
  let tooOld = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object') throw bad('รูปแบบข้อมูลไม่ถูกต้อง');
    const doc = String(r[p.docField] ?? '').trim().slice(0, 80);
    const date = String(r[p.dateField] ?? '');
    if (!doc || !ISO_RE.test(date)) throw bad('ทุกแถวต้องมีเลขเอกสารและวันที่');
    if (date < oldest) { tooOld++; continue; }
    // Only plain values: the cache is served to the browser as-is.
    const clean = {};
    for (const [k, v] of Object.entries(r)) {
      if (!/^[a-z_]{1,40}$/.test(k) || k === '_file') continue;
      if (typeof v === 'number') clean[k] = Number.isFinite(v) ? v : 0;
      else if (v == null) clean[k] = '';
      else clean[k] = String(v).slice(0, 300);
    }
    values.push([uploadId, companyId, u.source, doc, date, JSON.stringify(clean)]);
  }
  if (values.length) {
    await pool.query(`INSERT INTO fmh_file_rows (upload_id, company_id, source, doc_no, row_date, data_json) VALUES ?`, [values]);
  }
  return { stored: values.length, too_old: tooOld };
}

async function commit(companyId, uploadId) {
  const u = await pendingUpload(companyId, uploadId);
  const [[agg]] = await pool.query(
    `SELECT COUNT(*) n, COUNT(DISTINCT doc_no) docs, MIN(row_date) f, MAX(row_date) t,
            COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(data_json, '$.total')) AS DECIMAL(16,2))), 0) total
     FROM fmh_file_rows WHERE upload_id = ?`,
    [uploadId]
  );
  if (!agg.n) {
    await pool.query(`DELETE FROM fmh_file_uploads WHERE id = ?`, [uploadId]);
    throw bad(`ไม่มีรายการที่เก็บได้ — ระบบเก็บย้อนหลังได้ไม่เกิน ${Math.round(HISTORY_DAYS / 30)} เดือน`);
  }
  // Documents in this file replace the same documents from older uploads.
  const [del] = await pool.query(
    `DELETE r FROM fmh_file_rows r
       JOIN (SELECT DISTINCT doc_no FROM fmh_file_rows WHERE upload_id = ?) n ON n.doc_no = r.doc_no
     WHERE r.company_id = ? AND r.source = ? AND r.upload_id <> ?`,
    [uploadId, companyId, u.source, uploadId]
  );
  const [[cnt]] = await pool.query(`SELECT COUNT(*) n FROM fmh_file_rows WHERE company_id = ? AND source = ? AND upload_id <> ?`, [companyId, u.source, uploadId]);
  if (cnt.n + agg.n > MAX_ROWS_PER_SOURCE) {
    await pool.query(`DELETE FROM fmh_file_uploads WHERE id = ?`, [uploadId]);
    throw bad(`ข้อมูลย้อนหลังของรายงานนี้เกิน ${MAX_ROWS_PER_SOURCE.toLocaleString('en-US')} แถว — ลบไฟล์เก่าที่ไม่ใช้แล้วก่อน`);
  }
  await pool.query(
    `UPDATE fmh_file_uploads SET status = 'active', row_count = ?, doc_count = ?, date_from = ?, date_to = ?, total = ? WHERE id = ?`,
    [agg.n, agg.docs, agg.f, agg.t, agg.total, uploadId]
  );
  const replaced = await recountUploads(companyId, u.source);
  await rebuild(companyId, u.source);
  return { rows: agg.n, docs: agg.docs, date_from: iso(agg.f), date_to: iso(agg.t), replaced_lines: del.affectedRows, replaced_uploads: replaced };
}

// Older uploads lose lines when a newer one re-covers their documents; keep
// their counts honest and drop the ones left empty. Returns how many went.
async function recountUploads(companyId, source) {
  const [ups] = await pool.query(`SELECT id FROM fmh_file_uploads WHERE company_id = ? AND source = ? AND status = 'active'`, [companyId, source]);
  let gone = 0;
  for (const { id } of ups) {
    const [[a]] = await pool.query(
      `SELECT COUNT(*) n, COUNT(DISTINCT doc_no) docs, MIN(row_date) f, MAX(row_date) t,
              COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(data_json, '$.total')) AS DECIMAL(16,2))), 0) total
       FROM fmh_file_rows WHERE upload_id = ?`,
      [id]
    );
    if (!a.n) {
      await pool.query(`DELETE FROM fmh_file_uploads WHERE id = ?`, [id]);
      gone++;
    } else {
      await pool.query(`UPDATE fmh_file_uploads SET row_count = ?, doc_count = ?, date_from = ?, date_to = ?, total = ? WHERE id = ?`, [a.n, a.docs, a.f, a.t, a.total, id]);
    }
  }
  return gone;
}

async function deleteUpload(companyId, uploadId) {
  const [[u]] = await pool.query(`SELECT source FROM fmh_file_uploads WHERE id = ? AND company_id = ?`, [uploadId, companyId]);
  if (!u) return false;
  await pool.query(`DELETE FROM fmh_file_uploads WHERE id = ?`, [uploadId]);
  await rebuild(companyId, u.source);
  return true;
}

async function overview(companyId) {
  const [uploads] = await pool.query(
    `SELECT f.id, f.source, f.filename, f.date_from, f.date_to, f.row_count, f.doc_count, f.total, f.created_at, u.email AS uploaded_by_email
     FROM fmh_file_uploads f LEFT JOIN users u ON u.id = f.uploaded_by
     WHERE f.company_id = ? AND f.status = 'active' ORDER BY f.source, f.date_from DESC`,
    [companyId]
  );
  const { getCached } = require('./fmhCache');
  const sources = [];
  for (const s of SOURCES) {
    const p = PROFILES[s];
    const cached = await getCached(companyId, s).catch(() => null);
    const h = (cached && cached.quota && cached.quota.history) || null;
    sources.push({
      source: s, name: p.name, fmh_menu: p.fmhMenu,
      api_from: h ? h.api_from : null, file_from: h ? h.file_from : null, file_to: h ? h.file_to : null,
      file_rows_used: h ? h.file_rows : 0,
      has_api: !!(cached && cached.data.some((r) => !r._file)),
    });
  }
  return {
    uploads: uploads.map((u) => ({ ...u, date_from: iso(u.date_from), date_to: iso(u.date_to), total: Number(u.total) })),
    sources,
    history_days: HISTORY_DAYS,
  };
}

// ---------- merging into the report cache ----------

// apiRows: the API's rows for this source (no file rows). apiFrom: the first
// day the API covers, or null when there is no API data at all (a company on
// files only) — then every file row is used.
async function withFileHistory(companyId, source, apiRows, apiFrom) {
  const p = PROFILES[source];
  if (!p) return { rows: apiRows, history: null };
  const params = [companyId, source];
  let where = '';
  if (apiFrom) { where = 'AND row_date < ?'; params.push(apiFrom); }
  const [rows] = await pool.query(
    `SELECT data_json FROM fmh_file_rows r JOIN fmh_file_uploads u ON u.id = r.upload_id AND u.status = 'active'
     WHERE r.company_id = ? AND r.source = ? ${where} ORDER BY r.row_date, r.id`,
    params
  );
  if (!rows.length) return { rows: apiRows, history: apiFrom ? { api_from: apiFrom, file_from: null, file_to: null, file_rows: 0 } : null };
  const apiDocs = new Set(apiRows.map((r) => r[p.docField]).filter(Boolean));
  const fileRows = [];
  let from = null, to = null;
  rows.forEach(({ data_json }) => {
    const r = JSON.parse(data_json);
    if (apiDocs.has(r[p.docField])) return; // the API has this document: it wins
    r._file = 1;
    fileRows.push(r);
    const d = String(r[p.dateField] || '').slice(0, 10);
    if (!from || d < from) from = d;
    if (!to || d > to) to = d;
  });
  return { rows: fileRows.concat(apiRows), history: { api_from: apiFrom, file_from: from, file_to: to, file_rows: fileRows.length } };
}

const stripFile = (rows) => rows.filter((r) => !r._file);

// Rebuild one source's cache from what is cached + the stored files, with no
// FMH call (after an upload or delete). Keeps synced_at: that still says when
// FMH was last read.
async function rebuild(companyId, source) {
  const fc = require('./fmhCache');
  const cached = await fc.getCached(companyId, source);
  const apiRows = cached ? stripFile(cached.data) : [];
  const meta = (cached && cached.quota) || {};
  const apiFrom = apiRows.length ? (meta.history && meta.history.api_from) || fc.apiWindowStart() : null;
  const { rows, history } = await withFileHistory(companyId, source, apiRows, apiFrom);
  if (!cached && !rows.length) return null;
  await fc.writeCache(companyId, source, null, rows, { ...meta, history }, { keepSyncedAt: !!cached });
  if (source === 'sales-analysis') await require('./ckAudit').rebuildIfShown(companyId);
  return { rows: rows.length, history };
}

async function hasFiles(companyId, source) {
  if (!PROFILES[source]) return false;
  const [[r]] = await pool.query(`SELECT 1 ok FROM fmh_file_uploads WHERE company_id = ? AND source = ? AND status = 'active' LIMIT 1`, [companyId, source]);
  return !!r;
}

module.exports = { SOURCES, HISTORY_DAYS, CHUNK_MAX, begin, addRows, commit, deleteUpload, overview, withFileHistory, stripFile, rebuild, hasFiles };
