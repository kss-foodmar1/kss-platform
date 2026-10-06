// POS sales upload + COGS: parser, matching, replace-on-re-upload, access.
//
//   node scripts/test-pos.js [path/to/foodstory.csv]
//
// Needs a running server (BASE, default http://127.0.0.1:3100) on the same DB
// as the env (DB_*) and the
// "Demo Co" company in demo data mode. Creates its own test users and a test
// company; the demo company's POS uploads are removed again at the end.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const PosParse = require('../public/pos-parse');

const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const SAMPLE = process.argv[2];
let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
}
function session() {
  let cookie = '';
  return async (method, p, body) => {
    const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
}
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

(async () => {
  // ---------- parser ----------
  const csv = [
    'ชื่อสาขา,วันที่ชำระเงิน,หมายเลขใบเสร็จ / ID,รหัสเมนู,ชื่อเมนู   ,จำนวน,ยอดก่อนลด,ส่วนลดสินค้า,ราคาสุทธิ,ชื่อลูกค้า,เบอร์โทรศัพท์,หมายเหตุ,หมวดสินค้า',
    'สยาม,05/10/2026,A1,X1,"Cappuccino - นมโอ๊ต  x 1, - คั่วเข้ม x 1,",1,95,0,95,สมชาย,0812345678,"มีหมายเหตุ, หลายบรรทัด\nบรรทัดสอง",กาแฟ',
    'สยาม,05/10/2026,A2,X1,Cappuccino,2,190,10,180,,,,กาแฟ',
    'สยาม,05/10/2569,A3,M01,กะเพราหมูสับ  ไข่ดาว,1,69,0,69,,,,อาหาร',
    ',รวม,,,,4,354,10,344,,,,',
  ].join('\n');
  const parsed = PosParse.aggregate(csv);
  check('parser: Foodstory columns detected', parsed.format === 'foodstory');
  check('parser: options stripped, Cappuccino lines merged', parsed.rows.filter((r) => r.menu_name === 'Cappuccino').length === 1 && parsed.rows.find((r) => r.menu_name === 'Cappuccino').qty === 3);
  check('parser: net is ราคาสุทธิ', near(parsed.stats.net_sales, 344));
  check('parser: Buddhist-era year read as CE', parsed.rows.every((r) => r.sale_date === '2026-10-05'));
  check('parser: summary row skipped', parsed.stats.skipped === 1 && parsed.stats.lines === 3);
  check('parser: no customer data in output', !JSON.stringify(parsed.rows).includes('สมชาย') && !JSON.stringify(parsed.rows).includes('0812345678'));
  check('parser: base name helper', PosParse.baseMenuName('ต้มยำรวมทะเล - น้ำใส x 1,') === 'ต้มยำรวมทะเล');
  check('parser: name key ignores spacing', PosParse.menuKey('กะเพราหมูสับ  ไข่ดาว') === PosParse.menuKey('กะเพราหมูสับไข่ดาว'));
  let threw = '';
  try { PosParse.aggregate('a,b\n1,2'); } catch (e) { threw = e.message; }
  check('parser: missing columns named in the error', /ไม่พบคอลัมน์/.test(threw), threw);

  let sample = null;
  if (SAMPLE && fs.existsSync(SAMPLE)) {
    sample = PosParse.aggregate(PosParse.decode(fs.readFileSync(SAMPLE)));
    check('sample: total matches the file footer (55,299.25)', near(sample.stats.net_sales, 55299.25), sample.stats.net_sales);
    check('sample: 353 sale lines, footer skipped', sample.stats.lines === 353 && sample.stats.skipped === 1, JSON.stringify(sample.stats));
    check('sample: payment date 06/07/2025', sample.stats.date_from === '2025-07-06' && sample.stats.date_to === '2025-07-06');
  }

  // ---------- setup ----------
  const hash = await bcrypt.hash('PosTest#2026', 10);
  const [[demo]] = await pool.query(`SELECT id FROM companies WHERE data_source = 'demo' ORDER BY id LIMIT 1`);
  if (!demo) throw new Error('needs a company in demo data mode');
  await pool.query(`DELETE FROM pos_uploads WHERE company_id = ?`, [demo.id]);
  await pool.query(`DELETE FROM pos_menu_map WHERE company_id = ?`, [demo.id]);
  await pool.query(`DELETE FROM companies WHERE name = 'POS Test Other Co'`);
  const [oc] = await pool.query(`INSERT INTO companies (name, status, plan_tier) VALUES ('POS Test Other Co', 'active', 'starter')`);
  const otherId = oc.insertId;
  for (const [email, role, cid] of [['pos-kss@test.co', 'kss_superadmin', null], ['pos-ca@test.co', 'company_admin', demo.id], ['pos-client@test.co', 'client', demo.id], ['pos-other@test.co', 'company_admin', otherId]]) {
    await pool.query(`DELETE FROM users WHERE email = ?`, [email]);
    await pool.query(`INSERT INTO users (email, password_hash, display_name, role, company_id, must_change_password) VALUES (?, ?, ?, ?, ?, 0)`, [email, hash, email, role, cid]);
  }
  const login = async (email, password = 'PosTest#2026') => {
    const s = session();
    const r = await s('POST', '/api/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.json)}`);
    return s;
  };
  const kss = await login('pos-kss@test.co');
  const ca = await login('pos-ca@test.co');
  const client = await login('pos-client@test.co');
  const other = await login('pos-other@test.co');

  // ---------- access ----------
  check('access: company admin reads own company', (await ca('GET', `/api/pos/companies/${demo.id}`)).status === 200);
  check('access: company admin of another company gets 403', (await other('GET', `/api/pos/companies/${demo.id}`)).status === 403);
  check('access: client (view only) gets 403', (await client('GET', `/api/pos/companies/${demo.id}`)).status === 403);
  check('access: client cannot upload', (await client('POST', `/api/pos/companies/${demo.id}/uploads`, { filename: 'x.csv', rows: parsed.rows })).status === 403);

  // ---------- demo company: demo POS file, name matching ----------
  let o = (await ca('GET', `/api/pos/companies/${demo.id}`)).json;
  const st = (n) => (o.menus.find((m) => m.pos_menu_name === n) || {}).status;
  check('demo: uses the demo POS file when nothing is uploaded', o.demo_data === true && o.menus.length > 10);
  check('demo: spacing difference still matches by name', st('กะเพราหมูสับ ไข่ดาว') === 'matched');
  check('demo: English POS name is unmatched', st('Thai Tea เย็น') === 'unmatched');
  const cov0 = o.summary.coverage_pct;

  let r = await ca('PUT', `/api/pos/companies/${demo.id}/map`, { pos_menu_name: 'Thai Tea เย็น', fmh_menu_name: 'ชาไทยเย็น' });
  check('map: manual match saved', r.status === 200, JSON.stringify(r.json));
  o = r.json.overview;
  check('map: Thai Tea now matched (manual)', st('Thai Tea เย็น') === 'matched' && o.menus.find((m) => m.pos_menu_name === 'Thai Tea เย็น').via === 'manual');
  r = await ca('PUT', `/api/pos/companies/${demo.id}/map`, { pos_menu_name: 'ค่าบริการ Delivery', ignore: true });
  o = r.json.overview;
  check('map: delivery fee ignored', st('ค่าบริการ Delivery') === 'ignored');
  check('map: coverage went up', o.summary.coverage_pct > cov0, `${cov0} -> ${o.summary.coverage_pct}`);
  r = await ca('PUT', `/api/pos/companies/${demo.id}/map`, { pos_menu_name: 'ข้าวสวย', fmh_menu_name: 'ไม่มีเมนูนี้' });
  check('map: unknown FMH menu rejected', r.status === 400);

  // ---------- the report rows ----------
  const posDash = (await kss('POST', `/api/admin/companies/${demo.id}/dashboards`, { display_name: 'POS COGS (test)' })).json.id;
  const [tpls] = await pool.query(`SELECT id, template_key FROM widget_templates WHERE report_source = 'pos-sales' ORDER BY sort_order`);
  check('catalog: 9 POS widgets', tpls.length === 9, tpls.length);
  r = await kss('PUT', `/api/admin/dashboards/${posDash}/layout`, { items: tpls.map((t) => ({ template_id: t.id })) });
  check('layout saved', r.status === 200, JSON.stringify(r.json));
  r = await ca('GET', `/api/dashboards/${posDash}`);
  check('dashboard lists pos-sales with sale_date as its date field', r.json.sources && r.json.sources['pos-sales'] && r.json.sources['pos-sales'].date_field === 'sale_date');
  r = await ca('GET', `/api/dashboards/${posDash}/data/pos-sales`);
  check('data: pos-sales rows served', r.status === 200 && r.json.data.length > 100, r.status);
  const rows = r.json.data || [];
  const recipe = new Map(o.menus.filter((m) => m.status === 'matched').map((m) => [m.pos_menu_name, m.unit_cost]));
  const bad = rows.filter((x) => recipe.has(x.menu_name) && !near(x.cogs, Math.round(recipe.get(x.menu_name) * x.qty * 100) / 100, 0.011));
  check('data: COGS = qty × recipe cost per serving', !bad.length, JSON.stringify(bad[0]));
  check('data: unmatched lines carry no cost', rows.filter((x) => x.is_unmatched).every((x) => x.cogs === 0 && x.matched_sales === 0));
  check('data: ignored lines left out of food sales', rows.filter((x) => x.menu_name === 'ค่าบริการ Delivery').every((x) => x.food_sales === 0));
  check('data: no FMH quota block on the computed report', !(r.json.meta.quota && r.json.meta.quota.monthly_row_limit));
  check('data: POS date span in meta', r.json.meta.quota && r.json.meta.quota.pos && r.json.meta.quota.pos.date_to);

  // ---------- real Foodstory file into the demo company ----------
  if (sample) {
    r = await ca('POST', `/api/pos/companies/${demo.id}/uploads`, { filename: path.basename(SAMPLE), format: sample.format, rows: sample.rows });
    check('upload: sample accepted', r.status === 200, JSON.stringify(r.json).slice(0, 200));
    check('upload: total stored = file total', near(r.json.net_sales, 55299.25), r.json.net_sales);
    o = r.json.overview;
    check('upload: real file replaces the demo file', o.demo_data === false && o.summary.date_from === '2025-07-06');
    r = await ca('POST', `/api/pos/companies/${demo.id}/uploads`, { filename: 'again.csv', format: sample.format, rows: sample.rows });
    o = r.json.overview;
    check('re-upload: same day replaced, not doubled', near(o.summary.net_sales, 55299.25) && r.json.replaced === true, o.summary.net_sales);
    check('re-upload: the replaced upload is gone', o.uploads.length === 1, o.uploads.length);
    r = await ca('GET', `/api/dashboards/${posDash}/data/pos-sales`);
    check('data: rows follow the upload', r.json.data.every((x) => x.sale_date === '2025-07-06'));
    r = await ca('DELETE', `/api/pos/companies/${demo.id}/uploads/${o.uploads[0].id}`);
    check('delete: back to the demo file', r.status === 200 && r.json.overview.demo_data === true);
  }
  check('upload: bad rows rejected', (await ca('POST', `/api/pos/companies/${demo.id}/uploads`, { filename: 'x.csv', rows: [{ sale_date: 'nope', menu_name: '' }] })).status === 400);

  // ---------- a company with no file ----------
  const od = (await kss('POST', `/api/admin/companies/${otherId}/dashboards`, { display_name: 'POS' })).json.id;
  await kss('PUT', `/api/admin/dashboards/${od}/layout`, { items: [{ template_id: tpls[0].id }] });
  r = await other('GET', `/api/dashboards/${od}/data/pos-sales`);
  check('no file: 409 POS_NO_UPLOAD', r.status === 409 && r.json.code === 'POS_NO_UPLOAD', JSON.stringify(r.json));
  r = await other('POST', `/api/pos/companies/${otherId}/uploads`, { filename: 't.csv', format: parsed.format, rows: parsed.rows });
  check('no recipes yet: upload still works, nothing matched', r.status === 200 && r.json.overview.summary.coverage_pct === 0, JSON.stringify(r.json).slice(0, 300));
  check('isolation: other company does not see demo uploads', !r.json.overview.uploads.some((u) => u.filename === 'again.csv'));

  // ---------- cleanup ----------
  await pool.query(`DELETE FROM dashboards WHERE id = ?`, [posDash]);
  await pool.query(`DELETE FROM pos_menu_map WHERE company_id = ?`, [demo.id]);
  await pool.query(`DELETE FROM fmh_report_cache WHERE company_id = ? AND cache_key = 'pos-sales'`, [demo.id]);
  await pool.query(`DELETE FROM companies WHERE id = ?`, [otherId]);
  await pool.query(`DELETE FROM users WHERE email IN ('pos-kss@test.co','pos-ca@test.co','pos-client@test.co','pos-other@test.co')`);
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
