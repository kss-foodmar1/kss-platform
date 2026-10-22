// Auto-fetch modes (all / light / off) for the nightly FMH pull, and the row estimates. A fake FMH counts rows served.
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
  const tpl = async (src) => { const [[t]] = await pool.query(`SELECT id FROM widget_templates WHERE report_source = ? LIMIT 1`, [src]); assert.ok(t, src + ' template'); return t.id; };
  const heavyT = await tpl('stock-balance-product');
  const lightT = await tpl('po-status');
  const mk = async (name, mode) => {
    const [c] = await pool.query(`INSERT INTO companies (name, status, fmh_api_key_enc, auto_sync_mode) VALUES (?, 'active', ?, ?)`, [name, encrypt('fmh_rpt_test'), mode]);
    const [d] = await pool.query(`INSERT INTO dashboards (company_id, display_name) VALUES (?, 'T')`, [c.insertId]);
    for (const t of [heavyT, lightT]) await pool.query(`INSERT INTO dashboard_widgets (dashboard_id, widget_template_id) VALUES (?, ?)`, [d.insertId, t]);
    return c.insertId;
  };
  const all = await mk('AutoSync Test All', 'all');
  const light = await mk('AutoSync Test Light', 'light');
  const off = await mk('AutoSync Test Off', 'off');
  const age = (id, key, hours) => pool.query(`UPDATE fmh_report_cache SET synced_at = NOW() - INTERVAL ? HOUR WHERE company_id = ? AND cache_key = ?`, [hours, id, key]);
  const has = async (id, key) => !!(await cache.getCached(id, key));
  const nightly = async () => { served = 0; const r = await cache.syncAllCompanies(); return r; };

  await ok('new companies default to every report, every night', async () => {
    const [r] = await pool.query(`INSERT INTO companies (name, status) VALUES ('AutoSync Test Default', 'active')`);
    const [[c]] = await pool.query(`SELECT auto_sync_mode FROM companies WHERE id = ?`, [r.insertId]);
    await pool.query(`DELETE FROM companies WHERE id = ?`, [r.insertId]);
    assert.strictEqual(c.auto_sync_mode, 'all');
  });
  await ok('first nightly: all and light companies get everything, off gets nothing', async () => {
    const r = await nightly();
    const keys = Object.keys(r);
    assert.ok(keys.some((k) => k.startsWith(all + ':')) && keys.some((k) => k.startsWith(light + ':')));
    assert.ok(!keys.some((k) => k.startsWith(off + ':')));
    for (const id of [all, light]) { assert.ok(await has(id, 'stock-balance-product')); assert.ok(await has(id, 'po-status')); }
    assert.ok(!(await has(off, 'stock-balance-product')));
  });
  await ok('next night (cache a day old): light skips the big stock table, still pulls the small report; all pulls both', async () => {
    for (const id of [all, light]) for (const k of ['stock-balance-product', 'po-status']) await age(id, k, 25);
    const r = await nightly();
    const L = Object.entries(r).find(([k]) => k.startsWith(light + ':'))[1];
    const A = Object.entries(r).find(([k]) => k.startsWith(all + ':'))[1];
    assert.strictEqual(L['stock-balance-product'].skipped, true);
    assert.strictEqual(L['stock-balance-product'].weekly, true);
    assert.ok(L['po-status'].ok && !L['po-status'].skipped, 'light pulled the small report');
    assert.ok(A['stock-balance-product'].ok && !A['stock-balance-product'].skipped, 'all pulled the big one');
  });
  await ok('a week later light pulls the big table too', async () => {
    await age(light, 'stock-balance-product', 24 * 8);
    const r = await nightly();
    const L = Object.entries(r).find(([k]) => k.startsWith(light + ':'))[1];
    assert.ok(L['stock-balance-product'].ok && !L['stock-balance-product'].skipped);
  });
  await ok('the manual path (syncOne) works in every mode, including off', async () => {
    const r = await cache.syncOne(off, 'stock-balance-product');
    assert.strictEqual(r.rowsFetched, 30);
  });
  await ok('estimatePulls: sizes from the last pull, big table flagged, quota line carried', async () => {
    const pulls = await cache.pullsUsedByCompany(light);
    const { items, quota } = await cache.estimatePulls(light, pulls);
    const stock = items.find((i) => i.source === 'stock-balance-product');
    assert.strictEqual(stock.est_rows, 30);
    assert.strictEqual(stock.heavy, true);
    assert.strictEqual(items.find((i) => i.source === 'po-status').heavy, false);
    assert.strictEqual(quota.limit, 10000);
    assert.ok(quota.remaining <= 10000);
  });
  await ok('estimatePulls: a report never pulled has no estimate', async () => {
    const fresh = await mk('AutoSync Test Fresh', 'all');
    const { items } = await cache.estimatePulls(fresh, await cache.pullsUsedByCompany(fresh));
    assert.ok(items.length && items.every((i) => i.est_rows === null));
    for (const t of ['dashboards', 'companies']) await pool.query(`DELETE FROM ${t} WHERE ${t === 'companies' ? 'id' : 'company_id'} = ?`, [fresh]);
  });
  await ok('switching off back to light/all puts the company back in the nightly sync', async () => {
    await pool.query(`UPDATE companies SET auto_sync_mode = 'light' WHERE id = ?`, [off]);
    const r = await nightly();
    assert.ok(Object.keys(r).some((k) => k.startsWith(off + ':')));
  });
  console.log(`\n${pass} checks passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
  for (const id of [all, light, off]) {
    for (const t of ['fmh_report_cache', 'fmh_cache_saved', 'fmh_usage_log']) await pool.query(`DELETE FROM ${t} WHERE company_id = ?`, [id]);
    await pool.query(`DELETE FROM dashboards WHERE company_id = ?`, [id]);
    await pool.query(`DELETE FROM companies WHERE id = ?`, [id]);
  }
  process.exit(process.exitCode || 0);
}
