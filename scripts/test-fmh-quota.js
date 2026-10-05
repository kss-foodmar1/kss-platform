// Quota-saving sync test: a fake FMH serves purchase_analysis lines with real
// date filtering and counts every row it hands out. Needs a MySQL in DB_* env.
//   node db/migrate.js && node scripts/test-fmh-quota.js
const http = require('http');
const assert = require('assert');
process.env.FMH_BASE_URL = 'http://127.0.0.1:4777/v1/public/reports';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
// 80 days x 25 lines/day, 5 lines per PO. Each PO lives on one order_date.
let LINES = [];
for (let d = 0; d < 80; d++) for (let i = 0; i < 25; i++) {
  LINES.push({ po_number: `PO-${d}-${Math.floor(i / 5)}`, order_date: `${day(d)}T03:00:00Z`, product_code: `P${i % 5}`, po_total: 100, invoice_total: 0 });
}
let served = 0;
http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const body = JSON.parse(b || '{}');
    const r = (body.filters && body.filters.date_range) || {};
    let rows = LINES.filter((l) => (!r.start || l.order_date.slice(0, 10) >= r.start) && (!r.end || l.order_date.slice(0, 10) <= r.end));
    if (body.group_by) rows = [...new Set(rows.map((x) => x.product_code))].map((p) => ({ product: p }));
    rows = rows.slice(body.offset || 0, (body.offset || 0) + (body.limit || 500));
    served += rows.length;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: rows, quota: { monthly_row_limit: 4000, rows_used: served } }));
  });
}).listen(4777, '127.0.0.1', main);

async function main() {
  const pool = require('../db/pool');
  const { encrypt } = require('../lib/crypto');
  const cache = require('../lib/fmhCache');
  const { withTrigger, usageSummary } = require('../lib/fmhUsage');
  let pass = 0;
  const ok = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL ' + name + '\n  ' + e.message); process.exitCode = 1; } };
  const [r] = await pool.query(`INSERT INTO companies (name, status, fmh_api_key_enc) VALUES ('Quota Test', 'active', ?)`, [encrypt('fmh_rpt_test')]);
  const cid = r.insertId;
  const sorted = (rows) => rows.map((x) => JSON.stringify(x)).sort();
  const truth = () => sorted(LINES.filter((l) => l.order_date.slice(0, 10) >= day(80)));

  await ok('first sync is a full 80-day pull', async () => {
    served = 0;
    const res = await withTrigger('admin', () => cache.syncOne(cid, 'purchase-analysis'));
    assert.strictEqual(res.mode, 'full'); assert.strictEqual(served, 2000);
  });
  await ok('next sync is incremental: ~21 days of rows, cache identical to a full pull', async () => {
    served = 0;
    const res = await withTrigger('cron', () => cache.syncOne(cid, 'purchase-analysis'));
    assert.strictEqual(res.mode, 'incremental');
    assert.ok(served <= 22 * 25, `served ${served}`);
    assert.deepStrictEqual(sorted(res.data), truth());
  });
  await ok('late invoice on a 15-day-old PO is picked up; no duplicates', async () => {
    LINES.filter((l) => l.po_number === 'PO-15-2').forEach((l) => (l.invoice_total = 100));
    const res = await cache.syncOne(cid, 'purchase-analysis');
    assert.deepStrictEqual(sorted(res.data), truth());
    assert.strictEqual(res.data.filter((l) => l.po_number === 'PO-15-2' && l.invoice_total === 100).length, 5);
  });
  await ok('a PO line deleted in FMH disappears from the cache', async () => {
    LINES = LINES.filter((l) => !(l.po_number === 'PO-3-1' && l.product_code === 'P5'));
    LINES = LINES.filter((l) => !(l.po_number === 'PO-3-1' && l.product_code === 'P6'));
    LINES = LINES.filter((l) => !(l.po_number === 'PO-3-1' && l.product_code === 'P7'));
    LINES.splice(LINES.findIndex((l) => l.po_number === 'PO-4-0'), 1);
    const res = await cache.syncOne(cid, 'purchase-analysis');
    assert.deepStrictEqual(sorted(res.data), truth());
  });
  await ok('a change to a 40-day-old PO waits for the full refresh, which then catches it', async () => {
    LINES.filter((l) => l.po_number === 'PO-40-0').forEach((l) => (l.invoice_total = 7));
    let res = await cache.syncOne(cid, 'purchase-analysis');
    assert.strictEqual(res.data.filter((l) => l.po_number === 'PO-40-0' && l.invoice_total === 7).length, 0);
    await pool.query(`UPDATE fmh_report_cache SET quota_json = JSON_SET(quota_json, '$.full_synced_at', ?) WHERE company_id = ?`, [new Date(Date.now() - 15 * 86400000).toISOString(), cid]);
    res = await cache.syncOne(cid, 'purchase-analysis');
    assert.strictEqual(res.mode, 'full');
    assert.deepStrictEqual(sorted(res.data), truth());
  });
  await ok('a cache from before this change (no full_synced_at) goes incremental, not full', async () => {
    await pool.query(`UPDATE fmh_report_cache SET quota_json = JSON_REMOVE(quota_json, '$.full_synced_at') WHERE company_id = ?`, [cid]);
    served = 0;
    const res = await cache.syncOne(cid, 'purchase-analysis');
    assert.strictEqual(res.mode, 'incremental'); assert.ok(served <= 22 * 25);
    assert.deepStrictEqual(sorted(res.data), truth());
  });
  await ok('{full:true} forces a full pull', async () => {
    assert.strictEqual((await cache.syncOne(cid, 'purchase-analysis', null, { full: true })).mode, 'full');
  });
  await ok('grouped pulls are never incremental', async () => {
    assert.strictEqual((await cache.syncOne(cid, 'purchase-analysis', 'product')).mode, 'full');
  });
  await ok('nightly sync skips pulls refreshed in the last 20 hours (zero rows)', async () => {
    served = 0;
    const res = await cache.syncCompany(cid, [{ source: 'purchase-analysis', grouping: null }, { source: 'purchase-analysis', grouping: 'product' }], { cron: true });
    assert.strictEqual(served, 0); assert.ok(Object.values(res).every((x) => x.skipped));
    await pool.query(`UPDATE fmh_report_cache SET synced_at = NOW() - INTERVAL 21 HOUR WHERE company_id = ?`, [cid]);
    await cache.syncCompany(cid, [{ source: 'purchase-analysis', grouping: null }], { cron: true });
    assert.ok(served > 0 && served <= 22 * 25, `served ${served}`);
  });
  await ok('usage log attributes rows to what triggered them', async () => {
    const u = await usageSummary(cid);
    const t = Object.fromEntries(u.by_trigger.map((x) => [x.trig, x.rows_fetched]));
    assert.strictEqual(t.admin, 2000); assert.ok(t.cron > 0 && t.cron <= 22 * 25);
    assert.ok(u.by_pull.some((p) => p.pull_key === 'purchase_analysis/purchase_analysis_table|product'));
  });
  await ok('mergeIncremental: timezone-edge duplicates of the same PO never double', () => {
    const old = [{ po_number: 'A', order_date: '2026-10-01T23:00:00Z', q: 1 }, { po_number: 'B', order_date: '2026-09-20', q: 1 }];
    const fresh = [{ po_number: 'A', order_date: '2026-10-02T06:00:00+07:00', q: 2 }];
    const out = cache.mergeIncremental(old, fresh, { dateField: 'order_date', rowKey: 'po_number', freshStart: '2026-10-02', windowStart: '2026-07-15' });
    assert.deepStrictEqual(out.map((r) => r.po_number + r.q).sort(), ['A2', 'B1']);
  });
  // savings estimate for a month of nightly syncs: before = 30 full pulls
  console.log(`\n${pass} checks passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
  await pool.query(`DELETE FROM fmh_report_cache WHERE company_id = ?`, [cid]);
  await pool.query(`DELETE FROM fmh_usage_log WHERE company_id = ?`, [cid]);
  await pool.query(`DELETE FROM companies WHERE id = ?`, [cid]);
  process.exit(process.exitCode || 0);
}
