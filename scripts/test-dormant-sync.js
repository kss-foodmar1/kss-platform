// Nightly sync only feeds companies someone opened lately; a quiet company is
// caught up by its next visitor. A fake FMH counts every row it hands out.
//   node db/migrate.js && node scripts/test-dormant-sync.js
const http = require('http');
const assert = require('assert');
process.env.FMH_BASE_URL = 'http://127.0.0.1:4778/v1/public/reports';
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
}).listen(4778, '127.0.0.1', main);

async function main() {
  const pool = require('../db/pool');
  const { encrypt } = require('../lib/crypto');
  const cache = require('../lib/fmhCache');
  let pass = 0;
  const ok = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL ' + name + '\n  ' + e.message); process.exitCode = 1; } };
  const [[tpl]] = await pool.query(`SELECT id FROM widget_templates WHERE report_source = 'stock-balance-product' LIMIT 1`);
  assert.ok(tpl, 'stock balance template exists');

  const mk = async (name, viewedDaysAgo) => {
    const [c] = await pool.query(
      `INSERT INTO companies (name, status, fmh_api_key_enc, last_viewed_at) VALUES (?, 'active', ?, NOW() - INTERVAL ? DAY)`,
      [name, encrypt('fmh_rpt_test'), viewedDaysAgo]
    );
    const [d] = await pool.query(`INSERT INTO dashboards (company_id, display_name) VALUES (?, 'T')`, [c.insertId]);
    await pool.query(`INSERT INTO dashboard_widgets (dashboard_id, widget_template_id) VALUES (?, ?)`, [d.insertId, tpl.id]);
    return c.insertId;
  };
  const busy = await mk('Dormant Test Busy', 0);
  const quiet = await mk('Dormant Test Quiet', cache.ACTIVE_DAYS + 3);
  const rowsOf = async (id) => (await cache.getCached(id, 'stock-balance-product')) || null;
  const nightly = async () => {
    served = 0;
    const all = await cache.syncAllCompanies();
    return Object.keys(all);
  };

  await ok('nightly sync pulls the company that was opened lately and skips the quiet one', async () => {
    const synced = await nightly();
    assert.ok(synced.some((k) => k.startsWith(busy + ':')), 'busy company synced');
    assert.ok(!synced.some((k) => k.startsWith(quiet + ':')), 'quiet company skipped');
    assert.ok(await rowsOf(busy), 'busy has a cache');
    assert.strictEqual(await rowsOf(quiet), null, 'quiet has none');
  });
  await ok('opening a dashboard just now does not start a catch-up for an active company', async () => {
    const r = await cache.touchCompanyView(busy);
    assert.strictEqual(r.catchingUp, false);
  });
  await ok('the quiet company\'s first visitor starts a background catch-up and is told so', async () => {
    served = 0;
    const r = await cache.touchCompanyView(quiet);
    assert.strictEqual(r.catchingUp, true);
    for (let i = 0; i < 40 && !(await rowsOf(quiet)); i++) await new Promise((x) => setTimeout(x, 100));
    assert.ok(await rowsOf(quiet), 'caught up');
    assert.strictEqual(served, 30, `one full pull, served ${served}`);
    const [[c]] = await pool.query(`SELECT last_viewed_at > NOW() - INTERVAL 1 MINUTE AS fresh FROM companies WHERE id = ?`, [quiet]);
    assert.ok(Number(c.fresh), 'last_viewed_at updated');
  });
  await ok('a second visit right after does not pull again', async () => {
    served = 0;
    const r = await cache.touchCompanyView(quiet);
    assert.strictEqual(r.catchingUp, false);
    assert.strictEqual(served, 0);
  });
  await ok('after the visit the company is back in the nightly sync (pull skipped: <20h old)', async () => {
    const synced = await nightly();
    assert.ok(synced.some((k) => k.startsWith(quiet + ':')));
    assert.strictEqual(served, 0, `served ${served}`);
  });

  console.log(`\n${pass} checks passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
  for (const id of [busy, quiet]) {
    await pool.query(`DELETE FROM fmh_report_cache WHERE company_id = ?`, [id]);
    await pool.query(`DELETE FROM fmh_cache_saved WHERE company_id = ?`, [id]);
    await pool.query(`DELETE FROM fmh_usage_log WHERE company_id = ?`, [id]);
    await pool.query(`DELETE FROM dashboards WHERE company_id = ?`, [id]);
    await pool.query(`DELETE FROM companies WHERE id = ?`, [id]);
  }
  process.exit(process.exitCode || 0);
}
