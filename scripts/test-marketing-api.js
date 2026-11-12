// Marketing budget vs actual over HTTP: access, upload, re-upload without double counting,
// a bad file saves nothing, delete, templates, and the report rows the widgets read.
//
//   node scripts/test-marketing-api.js        (server on BASE, default http://127.0.0.1:3100, same DB as DB_*)
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const cacheBlob = require('../lib/cacheBlob');

const BASE = process.env.BASE || 'http://127.0.0.1:3100';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
function session() {
  let cookie = '';
  return async (method, p, body) => {
    const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    let json = {}; try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, json, text, bom: buf.slice(0, 3).toString('hex'), type: res.headers.get('content-type') || '' };
  };
}
const sum = (rows, f) => Math.round(rows.reduce((s, r) => s + Number(r[f] || 0), 0) * 100) / 100;

(async () => {
  const hash = await bcrypt.hash('MktTest#2026', 10);
  await pool.query(`DELETE FROM companies WHERE name IN ('Mkt Test Co','Mkt Test Other Co')`);
  const [c1] = await pool.query(`INSERT INTO companies (name, status, plan_tier) VALUES ('Mkt Test Co', 'active', 'starter')`);
  const [c2] = await pool.query(`INSERT INTO companies (name, status, plan_tier) VALUES ('Mkt Test Other Co', 'active', 'starter')`);
  const co = c1.insertId, other = c2.insertId;
  for (const [email, role, cid] of [['mkt-kss@test.co', 'kss_superadmin', null], ['mkt-ca@test.co', 'company_admin', co], ['mkt-client@test.co', 'client', co], ['mkt-other@test.co', 'company_admin', other]]) {
    await pool.query(`DELETE FROM users WHERE email = ?`, [email]);
    await pool.query(`INSERT INTO users (email, password_hash, display_name, role, company_id, must_change_password) VALUES (?, ?, ?, ?, ?, 0)`, [email, hash, email, role, cid]);
  }
  const login = async (email) => { const s = session(); const r = await s('POST', '/api/auth/login', { email, password: 'MktTest#2026' }); if (r.status !== 200) throw new Error(`login ${email}: ${r.status}`); return s; };
  const kss = await login('mkt-kss@test.co'), ca = await login('mkt-ca@test.co'), client = await login('mkt-client@test.co'), oth = await login('mkt-other@test.co'), anon = session();

  const reportRows = async () => {
    const [[r]] = await pool.query(`SELECT data_gz, data_json FROM fmh_report_cache WHERE company_id = ? AND cache_key = 'marketing'`, [co]);
    return r ? cacheBlob.unpack(r) : null;
  };

  // ---------- access ----------
  check('access: anonymous refused', (await anon('GET', `/api/marketing/companies/${co}`)).status === 401);
  check('access: company admin reads own company', (await ca('GET', `/api/marketing/companies/${co}`)).status === 200);
  check('access: KSS staff reads any company', (await kss('GET', `/api/marketing/companies/${co}`)).status === 200);
  check('access: company admin of another company 403', (await oth('GET', `/api/marketing/companies/${co}`)).status === 403);
  check('access: plain client 403 on read and upload', (await client('GET', `/api/marketing/companies/${co}`)).status === 403 && (await client('POST', `/api/marketing/companies/${co}/uploads`, { kind: 'budget', table: [['เดือน']] })).status === 403);

  // ---------- templates ----------
  const tb = await ca('GET', '/api/marketing/template/budget');
  check('template: budget CSV with BOM and Thai header', tb.status === 200 && /csv/.test(tb.type) && tb.bom === 'efbbbf' && tb.text.includes('ช่องทาง'));
  check('template: unknown kind 404', (await ca('GET', '/api/marketing/template/other')).status === 404);

  // ---------- upload ----------
  const budget = [['เดือน', 'ช่องทาง', 'จำนวนเงิน (บาท)'], ['2026-11', 'Meta', 50000], ['2026-11', 'TikTok', 30000], ['2026-11', 'Influencer', 40000]];
  const up1 = await ca('POST', `/api/marketing/companies/${co}/uploads`, { kind: 'budget', filename: 'budget.csv', table: budget });
  check('upload: budget saved', up1.status === 200 && up1.json.rows === 3 && up1.json.total === 120000, JSON.stringify(up1.json).slice(0, 200));
  let rows = await reportRows();
  check('report: budget spread over 30 days, sums to the baht', rows && sum(rows, 'budget_to_date') === 120000 && sum(rows, 'month_budget') === 120000, rows && String(sum(rows, 'budget_to_date')));
  check('report: month_budget only on the 1st', rows.filter((r) => r.month_budget > 0).every((r) => r.spend_date === '2026-11-01'));

  const actual = [['วันที่', 'ช่องทาง', 'จำนวนเงิน (บาท)', 'หมายเหตุ'], ['2026-11-01', 'Meta', 1650, 'a'], ['2026-11-01', 'facebook', 350, 'b'], ['2026-11-02', 'TikTok', 980, ''], ['2026-11-03', 'Google', 500, 'no budget']];
  const up2 = await kss('POST', `/api/marketing/companies/${co}/uploads`, { kind: 'actual', filename: 'actual.xlsx', table: actual });
  check('upload: actual saved by KSS staff (same-day Meta + facebook merged to 3 rows)', up2.status === 200 && up2.json.rows === 3 && up2.json.total === 3480, JSON.stringify(up2.json).slice(0, 200));
  rows = await reportRows();
  check('report: actual total 3,480', sum(rows, 'actual') === 3480);
  const meta1 = rows.find((r) => r.spend_date === '2026-11-01' && r.channel === 'Meta');
  check('report: Meta on the 1st = 2,000 (merged), budget share 50000/30', meta1 && meta1.actual === 2000 && Math.abs(meta1.budget_to_date - 1666.66) < 0.02, JSON.stringify(meta1));
  const goog = rows.find((r) => r.channel === 'Google Ads');
  check('report: a channel with spend but no budget shows budget 0', goog && goog.actual === 500 && goog.budget_to_date === 0);

  // ---------- re-upload does not double count ----------
  await ca('POST', `/api/marketing/companies/${co}/uploads`, { kind: 'actual', filename: 'actual-again.csv', table: actual });
  await ca('POST', `/api/marketing/companies/${co}/uploads`, { kind: 'budget', filename: 'budget-again.csv', table: budget });
  rows = await reportRows();
  check('re-upload: totals unchanged (actual 3,480 / budget 120,000)', sum(rows, 'actual') === 3480 && sum(rows, 'budget_to_date') === 120000);
  const revised = [['วันที่', 'ช่องทาง', 'จำนวนเงิน (บาท)'], ['2026-11-02', 'TikTok', 1200]];
  await ca('POST', `/api/marketing/companies/${co}/uploads`, { kind: 'actual', filename: 'fix.csv', table: revised });
  rows = await reportRows();
  check('re-upload: a later file replaces the same day x channel (TikTok 980 -> 1,200)', sum(rows, 'actual') === 3700, String(sum(rows, 'actual')));

  // ---------- a bad file saves nothing ----------
  const before = await pool.query(`SELECT COUNT(*) AS n FROM marketing_actual WHERE company_id = ?`, [co]);
  const badFile = [['วันที่', 'ช่องทาง', 'จำนวนเงิน (บาท)'], ['2026-11-10', 'Meta', 100], ['2026-13-40', 'Meta', 100], ['2026-11-11', 'Meta', 'abc']];
  const bad = await ca('POST', `/api/marketing/companies/${co}/uploads`, { kind: 'actual', filename: 'bad.csv', table: badFile });
  const after = await pool.query(`SELECT COUNT(*) AS n FROM marketing_actual WHERE company_id = ?`, [co]);
  check('bad file: 422 naming rows 3 and 4', bad.status === 422 && (bad.json.details || []).map((d) => d.row).join() === '3,4', JSON.stringify(bad.json).slice(0, 250));
  check('bad file: nothing saved, not even the good row', before[0][0].n === after[0][0].n);
  const noCols = await ca('POST', `/api/marketing/companies/${co}/uploads`, { kind: 'budget', filename: 'x.csv', table: [['a', 'b'], [1, 2]] });
  check('wrong file: names the missing columns', noCols.status === 422 && /เดือน/.test(noCols.json.error));
  check('wrong kind refused', (await ca('POST', `/api/marketing/companies/${co}/uploads`, { kind: 'x', filename: 'x', table: budget })).status === 400);

  // ---------- company isolation ----------
  await oth('POST', `/api/marketing/companies/${other}/uploads`, { kind: 'actual', filename: 'o.csv', table: [['วันที่', 'ช่องทาง', 'จำนวนเงิน (บาท)'], ['2026-11-01', 'Meta', 999999]] });
  rows = await reportRows();
  check('isolation: another company\'s spend never enters this report', sum(rows, 'actual') === 3700);

  // ---------- overview + delete ----------
  const ov = (await ca('GET', `/api/marketing/companies/${co}`)).json;
  check('overview: totals and channels', ov.budget.total === 120000 && ov.actual.total === 3700 && ov.channels.includes('Meta') && ov.channels.includes('Google Ads'), JSON.stringify(ov).slice(0, 300));
  const fix = ov.uploads.find((u) => u.filename === 'fix.csv');
  const del = await ca('DELETE', `/api/marketing/companies/${co}/uploads/${fix.id}`);
  rows = await reportRows();
  check('delete: removes the rows that file wrote last (TikTok day gone)', del.status === 200 && sum(rows, 'actual') === 2500, String(sum(rows, 'actual')));
  check('delete: another company\'s upload id is 404', (await ca('DELETE', `/api/marketing/companies/${co}/uploads/999999`)).status === 404);

  // ---------- preview (dry run), monthly actual, VAT, clear, copy ----------
  const cnt = async (t) => (await pool.query(`SELECT COUNT(*) AS n FROM ${t} WHERE company_id = ?`, [co]))[0][0].n;
  const wideB = [['ช่องทาง', '2026-12', '2027-01', 'รวม'], ['Facebook', 1000, 2000, 3000], ['IG', 500, '', 500], ['TikTok', 700, '-', 700], ['รวม', 2200, 2000, 4200]];
  const nb = await cnt('marketing_budget');
  const dupe = await ca('POST', `/api/marketing/companies/${co}/uploads`, { kind: 'budget', filename: 'w.csv', table: wideB, dry_run: true });
  check('dry run: alias clash (Facebook + IG) is an error naming both raw names', dupe.status === 422 && /Facebook/.test(JSON.stringify(dupe.json.details)) && /IG/.test(JSON.stringify(dupe.json.details)), JSON.stringify(dupe.json).slice(0, 300));
  const wideOk = [['ช่องทาง', '2026-12', '2027-01', 'รวม'], ['Facebook', 1000, 2000, 3000], ['TikTok', 700, '-', 900], ['รวม', 1700, 2000, 3700]];
  const pv = await ca('POST', `/api/marketing/companies/${co}/uploads`, { kind: 'budget', filename: 'w.csv', table: wideOk, dry_run: true });
  check('dry run: preview lists months, channels, warnings; writes nothing', pv.status === 200 && pv.json.dry_run && pv.json.months.length === 2 && pv.json.channels.length === 2 && pv.json.warnings.some((w) => /คอลัมน์รวม/.test(w)) && (await cnt('marketing_budget')) === nb, JSON.stringify(pv.json).slice(0, 400));
  const pv2 = await ca('POST', `/api/marketing/companies/${co}/uploads`, { kind: 'budget', filename: 'w.csv', table: [['ช่องทาง', '2026-11'], ['Meta', 1]], dry_run: true });
  check('dry run: counts rows that would be replaced', pv2.json.replaces === 1 && pv2.json.warnings.some((w) => /แทนที่/.test(w)), JSON.stringify(pv2.json).slice(0, 300));
  const vatUp = await ca('POST', `/api/marketing/companies/${co}/uploads`, { kind: 'budget', filename: 'vat.csv', table: [['ช่องทาง', '2026-12'], ['Meta', 10700]], vat_included: true });
  const [[vrow]] = await pool.query(`SELECT amount FROM marketing_budget WHERE company_id = ? AND budget_month = '2026-12-01' AND channel = 'Meta'`, [co]);
  check('VAT included: stored ex-VAT (10,700 -> 10,000) and remembered on the upload', vatUp.status === 200 && Number(vrow.amount) === 10000 && vatUp.json.vat_included === true);
  const mon = await ca('POST', `/api/marketing/companies/${co}/uploads`, { kind: 'actual', filename: 'monthly.csv', table: [['ช่องทาง', '2026-11', '2026-12'], ['Meta', 9999, 4000], ['Influencer', 5000, ''] ] });
  check('monthly actual: saved as month columns', mon.status === 200 && mon.json.monthly === true && mon.json.rows === 3, JSON.stringify(mon.json).slice(0, 250));
  rows = await reportRows();
  const sumOf = (f) => Math.round(rows.filter(f).reduce((t, r) => t + r.actual, 0) * 100) / 100;
  const metaNovMonthly = rows.filter((r) => r.channel === 'Meta' && r.spend_date.startsWith('2026-11')).reduce((t, r) => t + r.actual, 0);
  check('monthly actual: a month with daily rows keeps only the daily figures (Meta Nov = 2,000, not + 9,999)', Math.round(metaNovMonthly) === 2000, String(metaNovMonthly));
  check('monthly actual: a month without daily rows is spread over every day and sums back to the month', sumOf((r) => r.channel === 'Influencer' && r.spend_date.startsWith('2026-11')) === 5000 && sumOf((r) => r.channel === 'Meta' && r.spend_date.startsWith('2026-12')) === 4000 && rows.filter((r) => r.channel === 'Meta' && r.spend_date.startsWith('2026-12')).length === 31);
  check('monthly actual: a range inside the month takes its share (Dec 1-15 of 4,000 ~ 1,935)', Math.abs(sumOf((r) => r.channel === 'Meta' && r.spend_date >= '2026-12-01' && r.spend_date <= '2026-12-15') - 1935.48) < 0.1);
  const tm = await ca('GET', '/api/marketing/template/actual?granularity=month&from=2026-11');
  check('template: monthly actual has 12 month columns', tm.status === 200 && tm.text.split('\r\n')[0].split(',').length === 13);
  const nbc = await cnt('marketing_budget');
  const cp0 = await ca('POST', `/api/marketing/companies/${co}/copy-budget`, { from: '2026-11', to: '2027-02', dry_run: true });
  check('copy budget: dry run reports channels and writes nothing', cp0.status === 200 && cp0.json.copied === 3 && (await cnt('marketing_budget')) === nbc, JSON.stringify(cp0.json));
  const cp = await ca('POST', `/api/marketing/companies/${co}/copy-budget`, { from: '2026-11', to: '2027-02' });
  const cp2 = await ca('POST', `/api/marketing/companies/${co}/copy-budget`, { from: '2026-11', to: '2027-02' });
  check('copy budget: copies once, a second copy adds nothing (fills only channels without budget)', cp.json.copied === 3 && cp2.json.copied === 0 && cp2.json.skipped === 3, JSON.stringify([cp.json, cp2.json]).slice(0, 300));
  check('copy budget: empty source month is refused', (await ca('POST', `/api/marketing/companies/${co}/copy-budget`, { from: '2030-01', to: '2030-02' })).status === 422);
  const cl0 = await ca('POST', `/api/marketing/companies/${co}/clear`, { kind: 'budget', month: '2027-02', dry_run: true });
  const nbBefore = await cnt('marketing_budget');
  check('clear: dry run counts without deleting', cl0.json.count === 3 && (await cnt('marketing_budget')) === nbBefore);
  const cl1 = await ca('POST', `/api/marketing/companies/${co}/clear`, { kind: 'budget', month: '2027-02', channel: 'facebook' });
  check('clear: one channel of one month (alias respected)', cl1.json.count === 1 && (await cnt('marketing_budget')) === nbBefore - 1, JSON.stringify(cl1.json));
  const cl2 = await ca('POST', `/api/marketing/companies/${co}/clear`, { kind: 'budget', month: '2027-02' });
  const [[ups]] = await pool.query(`SELECT COUNT(*) AS n FROM marketing_uploads WHERE company_id = ? AND filename = 'คัดลอกจาก 2026-11'`, [co]);
  check('clear: whole month; the copy record disappears with its last row', cl2.json.count === 2 && ups.n === 0, JSON.stringify([cl2.json, ups]));
  const cl3 = await ca('POST', `/api/marketing/companies/${co}/clear`, { kind: 'actual', month: '2026-12' });
  check('clear: actual month removes monthly rows too', cl3.json.count === 1 && (await cnt('marketing_actual_month')) === 2, JSON.stringify(cl3.json));
  check('clear: bad month refused', (await ca('POST', `/api/marketing/companies/${co}/clear`, { kind: 'budget', month: '2026-13' })).status === 400);
  check('clear: another company admin refused', (await oth('POST', `/api/marketing/companies/${co}/clear`, { kind: 'budget', month: '2026-11' })).status === 403);

  // ---------- everything removed -> an empty report, not an error ----------
  for (const u of (await ca('GET', `/api/marketing/companies/${co}`)).json.uploads) await ca('DELETE', `/api/marketing/companies/${co}/uploads/${u.id}`);
  rows = await reportRows();
  check('empty: report is empty after all uploads are deleted', Array.isArray(rows) && rows.length === 0);

  await pool.query(`DELETE FROM companies WHERE name IN ('Mkt Test Co','Mkt Test Other Co')`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'mkt-%@test.co'`);
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
