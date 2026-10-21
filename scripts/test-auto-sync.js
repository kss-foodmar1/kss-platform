// Per-company switch for the automatic FMH pull. A fake FMH counts rows served.
//   node db/migrate.js && node scripts/test-auto-sync.js
const http = require('http');
const assert = require('assert');
process.env.FMH_BASE_URL = 'http://127.0.0.1:4779/v1/public/reports';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
let served = 0;
http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const body = JSON.parse(b || '{}');
    const rows = Array.from({ length: 30 }, (_, i) => ({ product: `P${i}`, sku: `S${i}`, branch: 'CK', quantity_on_hand: i })).slice(body.offset || 0, (body.offset || 0) + (body.limit || 1000));
    served += rows.length;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: rows, quota: { monthly_row_limit: 10000, rows_used: served } }));
  });
}).listen(4779, '127.0.0.1', main);

async function main() {
  const pool = require('../db/pool');
  const { encrypt } = require('../lib/crypto');
  const cache = require('../lib/fmhCache');
  let pass = 0;
  const ok = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL ' + name + '\n  ' + e.message); process.exitCode = 1; } };
  const [[tpl]] = await pool.query(`SELECT id FROM widget_templates WHERE report_source = 'stock-balance-product' LIMIT 1`);
  const mk = async (name, auto) => {
    const [c] = await pool.query(`INSERT INTO companies (name, status, fmh_api_key_enc, auto_sync) VALUES (?, 'active', ?, ?)`, [name, encrypt('fmh_rpt_test'), auto]);
    const [d] = await pool.query(`INSERT INTO dashboards (company_id, display_name) VALUES (?, 'T')`, [c.insertId]);
    await pool.query(`INSERT INTO dashboard_widgets (dashboard_id, widget_template_id) VALUES (?, ?)`, [d.insertId, tpl.id]);
    return c.insertId;
  };
  const on = await mk('AutoSync Test On', 1);
  const off = await mk('AutoSync Test Off', 0);

  await ok('new companies default to auto-fetch on', async () => {
    const [r] = await pool.query(`INSERT INTO companies (name, status) VALUES ('AutoSync Test Default', 'active')`);
    const [[c]] = await pool.query(`SELECT auto_sync FROM companies WHERE id = ?`, [r.insertId]);
    await pool.query(`DELETE FROM companies WHERE id = ?`, [r.insertId]);
    assert.strictEqual(Number(c.auto_sync), 1);
  });
  await ok('nightly sync pulls the company with auto-fetch on and leaves the one with it off', async () => {
    served = 0;
    const all = await cache.syncAllCompanies();
    const keys = Object.keys(all);
    assert.ok(keys.some((k) => k.startsWith(on + ':')), 'on synced');
    assert.ok(!keys.some((k) => k.startsWith(off + ':')), 'off not synced');
    assert.ok(await cache.getCached(on, 'stock-balance-product'));
    assert.strictEqual(await cache.getCached(off, 'stock-balance-product'), null);
  });
  await ok('the manual path (syncOne) still works for a company with auto-fetch off', async () => {
    served = 0;
    const r = await cache.syncOne(off, 'stock-balance-product');
    assert.strictEqual(r.rowsFetched, 30);
    assert.ok(await cache.getCached(off, 'stock-balance-product'));
  });
  await ok('switching it back on puts the company in the next nightly sync', async () => {
    await pool.query(`UPDATE companies SET auto_sync = 1 WHERE id = ?`, [off]);
    const all = await cache.syncAllCompanies();
    assert.ok(Object.keys(all).some((k) => k.startsWith(off + ':')));
  });
  console.log(`\n${pass} checks passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
  for (const id of [on, off]) {
    for (const t of ['fmh_report_cache', 'fmh_cache_saved', 'fmh_usage_log']) await pool.query(`DELETE FROM ${t} WHERE company_id = ?`, [id]);
    await pool.query(`DELETE FROM dashboards WHERE company_id = ?`, [id]);
    await pool.query(`DELETE FROM companies WHERE id = ?`, [id]);
  }
  process.exit(process.exitCode || 0);
}
