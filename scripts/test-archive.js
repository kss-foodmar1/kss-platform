// Rolling history (lib/fmhArchive.js): days that leave the API window come back from the archive.
const pool = require('../db/pool');
const arc = require('../lib/fmhArchive');
let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra || ''); } };
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
(async () => {
  const [[co]] = await pool.query(`SELECT id FROM companies ORDER BY id LIMIT 1`);
  const id = co.id, S = 'purchase-analysis';
  await pool.query(`DELETE FROM fmh_archive WHERE company_id = ? AND source = ?`, [id, S]);
  const row = (day, po, status = 'RECEIVED') => ({ order_date: day, po_number: po, status, qty: 1, price: 10 });
  // Day 1 sync: the window holds days -89..0.
  const win1 = []; for (let i = 89; i >= 0; i--) win1.push(row(addDays(today, -i), 'PO' + i));
  const c1 = await arc.capture(id, S, win1);
  check('first capture files every day', c1.days === 90, JSON.stringify(c1));
  check('same rows again: nothing rewritten', (await arc.capture(id, S, win1)).days === 0);
  // Status of day -10 changes while still in the window: that day is rewritten.
  const changed = win1.map((r) => (r.po_number === 'PO10' ? { ...r, status: 'COMPLETED' } : r));
  check('a changed day is rewritten, alone', (await arc.capture(id, S, changed)).days === 1);
  // 30 days later the API only serves days -59..0 of the old calendar: days -89..-60 are gone from the API.
  const api = changed.filter((r) => r.order_date >= addDays(today, -59));
  const { rows, archive } = await arc.withArchive(id, S, api);
  check('older days come back from the archive', rows.length === 90 && archive && archive.archive_days === 30 && archive.archive_from === addDays(today, -89), JSON.stringify(archive));
  check('archived rows are marked and come first', rows[0]._arch === 1 && rows[0].order_date === addDays(today, -89) && !rows[rows.length - 1]._arch);
  check('API rows are never duplicated by the archive', new Set(rows.map((r) => r.po_number)).size === rows.length);
  check('archived rows are not re-filed as API rows', (await arc.capture(id, S, rows)).days === 0);
  check('the kept version is the last one seen', rows.find((r) => r.po_number === 'PO10').status === 'COMPLETED');
  // A document re-dated into the window wins over its archived copy.
  const moved = [...api, { ...row(today, 'PO80'), status: 'COMPLETED' }];
  const r2 = await arc.withArchive(id, S, moved);
  check('a document the API still has is taken from the API', r2.rows.filter((r) => r.po_number === 'PO80').length === 1 && !r2.rows.find((r) => r.po_number === 'PO80')._arch);
  check('reports without a row date are not archived', !arc.archivable('cogs') && (await arc.capture(id, 'cogs', [{ x: 1 }])).days === 0);
  check('grouped pulls are not archived', !arc.archivable(S, 'supplier'));
  // Retention: a day older than the limit is dropped on the next capture.
  await pool.query(`UPDATE fmh_archive SET day = ? WHERE company_id = ? AND source = ? AND day = ?`, [addDays(today, -800), id, S, addDays(today, -89)]);
  await arc.capture(id, S, [row(today, 'PONEW')]);
  const [[old]] = await pool.query(`SELECT COUNT(*) n FROM fmh_archive WHERE company_id = ? AND source = ? AND day < ?`, [id, S, addDays(today, -731)]);
  check('days past the two-year retention are deleted', old.n === 0);
  const ov = await arc.overview(id);
  check('overview reports days and size', ov.some((o) => o.source === S && o.days > 0 && o.bytes > 0));
  await pool.query(`DELETE FROM fmh_archive WHERE company_id = ? AND source = ?`, [id, S]);
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
