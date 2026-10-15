// Rolling history (lib/fmhArchive.js): days that leave the API window come back from the archive.
// Uses its own throw-away company, so it never touches a real company's history.
const pool = require('../db/pool');
const arc = require('../lib/fmhArchive');
let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, extra || ''); } };
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
(async () => {
  const [ins] = await pool.query(`INSERT INTO companies (name, data_source) VALUES ('archive test (temp)', 'fmh')`).catch(() => pool.query(`INSERT INTO companies (name) VALUES ('archive test (temp)')`));
  const id = ins.insertId, S = 'purchase-analysis';
  try {
    const row = (day, po, status = 'RECEIVED') => ({ order_date: day, po_number: po, status, qty: 1, price: 10 });
    const win1 = []; for (let i = 79; i >= 0; i--) win1.push(row(addDays(today, -i), 'PO' + i));
    const c1 = await arc.capture(id, S, win1);
    check('first capture files every day except the 3 edge days', c1.days === 77, JSON.stringify(c1));
    check('same rows again: nothing rewritten', (await arc.capture(id, S, win1)).days === 0);
    check('same rows in another order: nothing rewritten', (await arc.capture(id, S, [...win1].reverse().map((r) => ({ price: r.price, ...r })))).days === 0);
    const changed = win1.map((r) => (r.po_number === 'PO10' ? { ...r, status: 'COMPLETED' } : r));
    check('a changed day is rewritten, alone', (await arc.capture(id, S, changed)).days === 1);
    check('a truncated pull files nothing', (await arc.capture(id, S, changed.map((r) => ({ ...r, status: 'X' })), null, { truncated: true })).days === 0);
    // 30 days later the API window starts at today-49.
    const winStart = addDays(today, -49);
    const api = changed.filter((r) => r.order_date >= winStart);
    const { rows, archive } = await arc.withArchive(id, S, api, winStart);
    check('days before the window come back from the archive (edge days were never filed)', archive && archive.archive_from === addDays(today, -76) && archive.archive_days === 27, JSON.stringify(archive));
    check('archived rows are marked and come first', rows[0]._arch === 1 && !rows[rows.length - 1]._arch);
    check('no day inside the API window comes from the archive', rows.filter((r) => r._arch).every((r) => r.order_date < winStart));
    check('API rows are never duplicated', new Set(rows.map((r) => r.po_number)).size === rows.length);
    check('archived rows are not re-filed as API rows', (await arc.capture(id, S, rows)).days === 0);
    check('the kept version is the last one seen', changed.find((r) => r.po_number === 'PO10').status === 'COMPLETED');
    check('an empty pull gets nothing from the archive', (await arc.withArchive(id, S, [], winStart)).rows.length === 0);
    const moved = [...api, { ...row(today, 'PO70'), status: 'COMPLETED' }];
    const r2 = await arc.withArchive(id, S, moved, winStart);
    check('a document the API still has is taken from the API', r2.rows.filter((r) => r.po_number === 'PO70').length === 1 && !r2.rows.find((r) => r.po_number === 'PO70')._arch);
    check('bucketed, snapshot and total reports are not archived', !arc.archivable('cogs-trend') && !arc.archivable('batch') && !arc.archivable('cogs'));
    check('grouped pulls are not archived', !arc.archivable(S, 'supplier'));
    await pool.query(`UPDATE fmh_archive SET day = ? WHERE company_id = ? AND source = ? AND day = ?`, [addDays(today, -800), id, S, addDays(today, -76)]);
    await arc.capture(id, S, win1.map((r) => ({ ...r, qty: 2 })));
    const [[old]] = await pool.query(`SELECT COUNT(*) n FROM fmh_archive WHERE company_id = ? AND day < ?`, [id, addDays(today, -400)]);
    check('days past the retention are deleted', old.n === 0);
    check('overview reports days and size', (await arc.overview(id)).some((o) => o.source === S && o.days > 0 && o.bytes > 0));
    const [[demo]] = await pool.query(`SELECT id FROM companies WHERE data_source = 'demo' LIMIT 1`);
    if (demo) check('demo companies are never archived', (await arc.capture(demo.id, S, win1)).days === 0 && (await arc.withArchive(demo.id, S, api, winStart)).archive === null);
  } finally {
    await pool.query(`DELETE FROM companies WHERE id = ?`, [id]);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
