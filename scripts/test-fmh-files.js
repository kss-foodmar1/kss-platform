// History from uploaded FMH export files: reading the real export, storing it,
// merging it before the API window, replacing per document, and access.
// Needs a running server (BASE, default :3100) on the DB in the env.
//   node scripts/test-fmh-files.js [Report-SALES_ANALYSIS.xlsx]
const fs = require('fs');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const FmhFile = require('../public/fmh-file');
const files = require('../lib/fmhFiles');
const fc = require('../lib/fmhCache');

const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const SAMPLE = process.argv[2] || process.env.FMH_SAMPLE;
let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };
function session() {
  let cookie = '';
  return async (method, p, body) => {
    const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
}
const iso = (d) => d.toISOString().slice(0, 10);
const shift = (s, days) => (s ? iso(new Date(Date.parse(s + 'T00:00:00Z') - days * 86400000)) : s);
const DATE_FIELDS = ['issued_date', 'order_date', 'requested_delivery_date', 'grn_date', 'do_date', 'completed_date'];
// The same lines, as if exported for an older month: dates moved back, SO numbers made unique.
const older = (rows, days, tag) => rows.map((r) => {
  const o = { ...r, so_number: `${r.so_number}-${tag}` };
  DATE_FIELDS.forEach((f) => (o[f] = shift(r[f], days)));
  return o;
});

async function upload(s, cid, source, filename, rows) {
  const b = await s('POST', `/api/fmh-files/companies/${cid}/uploads`, { source, filename });
  if (b.status !== 200) return b;
  for (let i = 0; i < rows.length; i += 2000) {
    const r = await s('POST', `/api/fmh-files/companies/${cid}/uploads/${b.json.upload_id}/rows`, { rows: rows.slice(i, i + 2000) });
    if (r.status !== 200) return r;
  }
  return s('POST', `/api/fmh-files/companies/${cid}/uploads/${b.json.upload_id}/commit`);
}

(async () => {
  // ---------- reading the file ----------
  let base;
  if (SAMPLE && fs.existsSync(SAMPLE)) {
    const r = await FmhFile.read(fs.readFileSync(SAMPLE), SAMPLE);
    check('real Sales Analysis export is recognised', r.profile === 'sales-analysis' && !r.error, r.error);
    check('dates read day-first and converted to ISO', r.dateOrder === 'dmy' && /^\d{4}-\d{2}-\d{2}$/.test(r.rows[0].order_date), r.rows[0].order_date);
    check('header names mapped to API field names', ['so_number', 'customer', 'product_code', 'total', 'so_total', 'requested_delivery_date'].every((f) => f in r.rows[0]), Object.keys(r.rows[0]).join(','));
    check('number columns are numbers', typeof r.rows[0].total === 'number' && typeof r.rows[0].do_total === 'number');
    base = r.rows;
  } else {
    console.log('(no sample file given — using generated rows)');
    const day = iso(new Date());
    base = Array.from({ length: 300 }, (_, i) => ({ so_number: `SO-T-${Math.floor(i / 10)}`, order_date: day, requested_delivery_date: day, customer: `ลูกค้า ${i % 7}`, product_code: `P${i % 20}`, product_name: `สินค้า ${i % 20}`, qty: 1, total: 100, so_total: 100, branch: '', department: '', category_name: 'x' }));
  }
  const csv = 'Report,,\nProduct,Product Code,Order Date,Customers,SO Number,Total Value\nก,P1,31/12/2025,ร้าน ก,SO-1,"1,250.50"\nข,P2,13/01/2026,ร้าน ข,SO-2,(20)\nรวม,,,,,1230.5\n';
  const c = FmhFile.toRows(FmhFile.readCsv(csv));
  check('CSV: title line skipped, footer skipped, "1,250.50" and (20) parsed', c.rows && c.rows.length === 2 && c.rows[0].total === 1250.5 && c.rows[1].total === -20 && c.stats.skipped === 1, JSON.stringify(c.stats || c.error));
  check('Buddhist-era year handled', FmhFile.toIsoDate('05/02/2569') === '2026-02-05');
  const miss = FmhFile.toRows([['Product', 'Product Code', 'Order Date', 'Customers', 'Total Value']]);
  check('missing SO Number is named in the error', miss.error && /SO Number/.test(miss.error), miss.error);

  // ---------- setup ----------
  const hash = await bcrypt.hash('FileTest#2026', 10);
  await pool.query(`DELETE FROM companies WHERE name LIKE 'FileTest%'`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'filetest-%@test.co'`);
  await pool.query(`INSERT INTO users (email, password_hash, display_name, role, company_id, must_change_password) VALUES ('filetest-kss@test.co', ?, 'k', 'kss_superadmin', NULL, 0)`, [hash]);
  const login = async (email) => { const s = session(); const r = await s('POST', '/api/auth/login', { email, password: 'FileTest#2026' }); if (r.status !== 200) throw new Error('login ' + email); return s; };
  const kss = await login('filetest-kss@test.co');
  const a = (await kss('POST', '/api/admin/companies', { name: 'FileTest A' })).json.id;
  const b = (await kss('POST', '/api/admin/companies', { name: 'FileTest B' })).json.id;
  for (const [e, role, cid] of [['filetest-ca@test.co', 'company_admin', a], ['filetest-cl@test.co', 'client', a], ['filetest-cb@test.co', 'company_admin', b]]) {
    await pool.query(`INSERT INTO users (email, password_hash, display_name, role, company_id, must_change_password) VALUES (?, ?, ?, ?, ?, 0)`, [e, hash, e, role, cid]);
  }
  const ca = await login('filetest-ca@test.co');
  const cl = await login('filetest-cl@test.co');
  const cb = await login('filetest-cb@test.co');
  const [[tpl]] = await pool.query(`SELECT id FROM widget_templates WHERE template_key = 'cks_overview'`);
  const [d] = await pool.query(`INSERT INTO dashboards (company_id, display_name) VALUES (?, 'ยอดขายย้อนหลัง')`, [a]);
  await pool.query(`INSERT INTO dashboard_widgets (dashboard_id, widget_template_id) VALUES (?, ?)`, [d.insertId, tpl.id]);

  // ---------- access ----------
  check('client (view only) cannot upload', (await cl('POST', `/api/fmh-files/companies/${a}/uploads`, { source: 'sales-analysis', filename: 'x' })).status === 403);
  check('another company admin cannot upload here', (await cb('POST', `/api/fmh-files/companies/${a}/uploads`, { source: 'sales-analysis', filename: 'x' })).status === 403);
  check('unknown report refused', (await ca('POST', `/api/fmh-files/companies/${a}/uploads`, { source: 'stock-card', filename: 'x' })).status === 400);

  // ---------- a company on files only ----------
  const m4 = older(base, 120, 'M4');
  const m5 = older(base, 150, 'M5');
  // An upload is invisible until committed.
  const beg = await ca('POST', `/api/fmh-files/companies/${a}/uploads`, { source: 'sales-analysis', filename: 'half.xlsx' });
  await ca('POST', `/api/fmh-files/companies/${a}/uploads/${beg.json.upload_id}/rows`, { rows: m4.slice(0, 10) });
  check('half-sent upload is not listed', (await ca('GET', `/api/fmh-files/companies/${a}`)).json.uploads.length === 0);
  check('chunk over 5,000 rows refused', (await ca('POST', `/api/fmh-files/companies/${a}/uploads/${beg.json.upload_id}/rows`, { rows: Array(5001).fill(m4[0]) })).status === 400);
  await pool.query(`DELETE FROM fmh_file_uploads WHERE id = ?`, [beg.json.upload_id]);

  let r = await upload(ca, a, 'sales-analysis', 'Report-SALES_ANALYSIS-may.xlsx', m4);
  check('company admin uploads an older month', r.status === 200 && r.json.rows === m4.length, JSON.stringify(r.json).slice(0, 200));
  r = await upload(ca, a, 'sales-analysis', 'Report-SALES_ANALYSIS-apr.xlsx', m5);
  check('second month adds to the first', r.status === 200 && r.json.replaced_lines === 0);
  let cached = await fc.getCached(a, 'sales-analysis');
  check('cache built from files with no FMH key', cached && cached.data.length === m4.length + m5.length && cached.data.every((x) => x._file === 1), cached && cached.data.length);
  check('coverage recorded (files only, no API window)', cached.quota.history && cached.quota.history.api_from === null && cached.quota.history.file_from === m5.map((x) => x.order_date).sort()[0], JSON.stringify(cached.quota.history));
  const data = await ca('GET', `/api/dashboards/${d.insertId}/data/sales-analysis`);
  check('dashboard serves file history and says where it comes from', data.status === 200 && data.json.data.length === m4.length + m5.length && data.json.meta.history.file_rows === m4.length + m5.length, data.status);

  // Same documents again (a re-export of the month): replaced, not doubled.
  const again = m4.slice(0, Math.ceil(m4.length / 2)).map((x) => ({ ...x, total: x.total + 1 }));
  const docsAgain = new Set(again.map((x) => x.so_number));
  const linesOfThoseDocs = m4.filter((x) => docsAgain.has(x.so_number)).length;
  r = await upload(ca, a, 'sales-analysis', 'Report-SALES_ANALYSIS-may-fixed.xlsx', again);
  check('re-uploading documents replaces their lines', r.status === 200 && r.json.replaced_lines === linesOfThoseDocs, `${r.json.replaced_lines} vs ${linesOfThoseDocs}`);
  cached = await fc.getCached(a, 'sales-analysis');
  check('no document counted twice', cached.data.length === m4.length - linesOfThoseDocs + again.length + m5.length, cached.data.length);
  let ov = (await ca('GET', `/api/fmh-files/companies/${a}`)).json;
  const may = ov.uploads.find((u) => u.filename === 'Report-SALES_ANALYSIS-may.xlsx');
  check('older upload keeps only its untouched lines', may && may.row_count === m4.length - linesOfThoseDocs, may && may.row_count);
  // A full re-export of the month leaves the partial upload empty: it goes.
  r = await upload(ca, a, 'sales-analysis', 'Report-SALES_ANALYSIS-may-full.xlsx', m4);
  ov = (await ca('GET', `/api/fmh-files/companies/${a}`)).json;
  check('an upload whose lines were all replaced is removed', r.json.replaced_uploads === 2 && ov.uploads.length === 2, `${r.json.replaced_uploads} ${ov.uploads.map((u) => u.filename)}`);

  // Too old to keep.
  const ancient = older(base.slice(0, 5), 800, 'OLD');
  r = await upload(ca, a, 'sales-analysis', 'ancient.xlsx', ancient);
  check('rows older than ~2 years are refused with a reason', r.status === 400 && /เดือน/.test(r.json.error), JSON.stringify(r.json));

  // ---------- merging with API rows ----------
  const apiFrom = fc.apiWindowStart();
  const apiRows = [{ so_number: m4[0].so_number, order_date: shift(apiFrom, -1), total: 999 }, { so_number: 'SO-API-1', order_date: shift(apiFrom, -5), total: 5 }];
  const merged = await files.withFileHistory(a, 'sales-analysis', apiRows, apiFrom);
  check('API wins for a document both have', merged.rows.filter((x) => x.so_number === m4[0].so_number).length === 1 && merged.rows.find((x) => x.so_number === m4[0].so_number).total === 999);
  check('only file rows before the API window are added', merged.rows.filter((x) => x._file).every((x) => x.order_date < apiFrom) && merged.history.api_from === apiFrom);

  // ---------- with real syncs (demo company: the API is the demo generator) ----------
  await pool.query(`UPDATE companies SET data_source = 'demo' WHERE id = ?`, [a]);
  await fc.syncOne(a, 'sales-analysis', null, { full: true });
  cached = await fc.getCached(a, 'sales-analysis');
  const fileN = cached.data.filter((x) => x._file).length;
  const apiN = cached.data.length - fileN;
  check('full sync keeps file history before the API window', fileN === m4.length + m5.length && apiN > 0 && cached.quota.history.api_from === apiFrom, `${fileN} file, ${apiN} api`);
  await fc.syncOne(a, 'sales-analysis', null);
  const after = await fc.getCached(a, 'sales-analysis');
  check('incremental sync neither drops nor doubles file rows', after.quota.last_mode === 'incremental' && after.data.filter((x) => x._file).length === fileN && after.data.length === cached.data.length, `${after.quota.last_mode} ${after.data.length} vs ${cached.data.length}`);
  const syncedAt = String(after.syncedAt);
  await new Promise((res) => setTimeout(res, 1100));
  const del = ov.uploads.find((u) => u.filename === 'Report-SALES_ANALYSIS-apr.xlsx');
  r = await ca('DELETE', `/api/fmh-files/companies/${a}/uploads/${del.id}`);
  const afterDel = await fc.getCached(a, 'sales-analysis');
  check('deleting a file removes its rows and keeps API rows', r.status === 200 && afterDel.data.filter((x) => x._file).length === m4.length && afterDel.data.filter((x) => !x._file).length === apiN);
  check('a file change does not pretend FMH was just read', String(afterDel.syncedAt) === syncedAt, `${afterDel.syncedAt} vs ${syncedAt}`);
  check('grouped pulls are untouched by files', !(await fc.getCached(a, 'sales-analysis', 'product')) || (await fc.getCached(a, 'sales-analysis', 'product')).data.every((x) => !x._file));

  await pool.query(`DELETE FROM dashboards WHERE id = ?`, [d.insertId]);
  await pool.query(`DELETE FROM companies WHERE id IN (?, ?)`, [a, b]);
  await pool.query(`DELETE FROM users WHERE email LIKE 'filetest-%@test.co'`);
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
