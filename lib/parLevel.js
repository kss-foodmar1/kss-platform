// Auto PAR Level: how much of each ingredient a branch uses on an average day,
// worked out from POS sales × FMH recipes. The report ('par-usage') holds only
// the usage; the Min / Max PAR themselves are computed in the widget from the
// company's per-category settings (par_settings), so changing a setting never
// needs a rebuild:
//
//   Min PAR (reorder point) = avg daily usage × (lead time + safety days)
//   Max PAR (order-up-to)   = avg daily usage × (order every N days + lead time + safety days)
//                           = Min PAR + avg daily usage × N
//
// Inputs, all already in the system: POS sales (pos_sales_daily), FMH Menu &
// Ingredients (itemized recipes: quantity per serving + yield loss), and — as a
// hint only — the real order→receipt days from Purchase Analysis if cached.
const pool = require('../db/pool');
const PosParse = require('../public/pos-parse');

const SOURCE = 'par-usage';
const WINDOW_DAYS = 28; // four of each weekday
const MIN_DAYS = 7; // fewer days than this is a guess, and the widget says so
const DEFAULTS = { lead_days: 2, safety_days: 1, order_days: 3 };

const fc = () => require('./fmhCache');
const pos = () => require('./posSales');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round = (n, dp = 3) => Math.round(n * 10 ** dp) / 10 ** dp;

// ---------- units ----------
// Recipes are written in g / kg / ml / l / pieces. Mass and volume are brought
// to g and ml so the same ingredient in "0.2 kg" and "50 g" lines adds up.
const UNIT = [
  [/^(kg|กก|กิโลกรัม|กิโล)\.?$/i, 1000, 'g'], [/^(g|gm|gram|กรัม|ก)\.?$/i, 1, 'g'],
  [/^(l|lt|ltr|ลิตร|ล)\.?$/i, 1000, 'ml'], [/^(ml|มล|มิลลิลิตร)\.?$/i, 1, 'ml'],
];
function baseUnit(uom) {
  const w = String(uom || '').replace(/\s*\(.*\)\s*$/, '').trim();
  for (const [re, f, base] of UNIT) if (re.test(w)) return { f, base };
  return { f: 1, base: w || 'หน่วย' };
}

// ---------- inputs ----------
async function companyInfo(companyId) {
  const [[c]] = await pool.query(`SELECT fmh_api_key_enc, data_source FROM companies WHERE id = ?`, [companyId]);
  return c || {};
}
async function recipeLines(companyId) {
  const { getCached, syncOne } = fc();
  const c = await getCached(companyId, 'menu-costing', null);
  if (c && c.data.length) return c.data;
  const info = await companyInfo(companyId);
  if (!info.fmh_api_key_enc && info.data_source !== 'demo') return [];
  try {
    return (await syncOne(companyId, 'menu-costing', null)).data;
  } catch (err) {
    console.error(`PAR: recipe pull failed for company ${companyId}:`, err.message);
    return [];
  }
}

// menuKey -> the ingredient lines of that menu. A menu that appears for several
// branches uses the first branch's lines, as the recipe costs do.
function recipesByMenu(lines) {
  const out = new Map();
  lines.forEach((r) => {
    const key = PosParse.menuKey(r.menu_name);
    if (!key || !(r.ingredient_code || r.ingredient_name)) return;
    const e = out.get(key) || { branch: r.branch || '', lines: [] };
    if ((r.branch || '') !== e.branch) return;
    e.lines.push(r);
    out.set(key, e);
  });
  return out;
}

// Median days from order to receipt per product code, when Purchase Analysis
// is already cached (never pulled here: it is a hint, not an input).
async function observedLeadTimes(companyId) {
  const got = await fc().getCached(companyId, 'purchase-analysis', null);
  const by = new Map();
  ((got && got.data) || []).forEach((r) => {
    const a = String(r.order_date || '').slice(0, 10);
    const b = String(r.grn_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b) || !r.product_code) return;
    const d = Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
    if (d < 0 || d > 60) return;
    (by.get(r.product_code) || by.set(r.product_code, []).get(r.product_code)).push(d);
  });
  const out = new Map();
  by.forEach((v, k) => {
    if (v.length < 3) return;
    v.sort((x, y) => x - y);
    const mid = v.length >> 1;
    out.set(k, { days: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2, n: v.length });
  });
  return out;
}

// The unit the ingredient is BOUGHT in, from Purchase Analysis when it is already
// cached: the most used UOM per product code, and how many base units (g / ml /
// pieces) one of them holds when the UOM or the product name says so
// ("BAG (5KG)", "500 กรัม/แพ็ค"). A person can override both in the widget.
function orderUnitOf(uom, name, base) {
  const ck = require('./ckAudit');
  const pack = ck.packSize(uom, name);
  const want = base === 'g' ? 'mass' : base === 'ml' ? 'vol' : null;
  if (want && pack && pack.dim === want) return pack.base;
  const norm = (x) => String(x || '').toLowerCase().replace(/[\s.()]/g, '');
  if (!want && norm(uom) && norm(uom) === norm(base)) return 1;
  return null;
}
async function orderUnits(companyId) {
  const got = await fc().getCached(companyId, 'purchase-analysis', null);
  const by = new Map();
  ((got && got.data) || []).forEach((r) => {
    if (!r.product_code || !r.uom) return;
    const e = by.get(r.product_code) || by.set(r.product_code, { uoms: new Map(), name: r.product_name }).get(r.product_code);
    e.uoms.set(r.uom, (e.uoms.get(r.uom) || 0) + 1);
  });
  const out = new Map();
  by.forEach((e, code) => { out.set(code, { uom: [...e.uoms.entries()].sort((a, b) => b[1] - a[1])[0][0], name: e.name }); });
  return out;
}

const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const weekdayOf = (iso) => (new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7; // Mon = 0

// ---------- the build ----------
// Pure: POS lines + recipe lines + the menu resolver in, rows out. Exported so
// the test can run it with hand-worked numbers and no database.
function compute({ posLines, recipeRows, resolve, leadHints = new Map(), orderHints = new Map(), windowDays = WINDOW_DAYS }) {
  if (!posLines.length) return null;
  const last = posLines.reduce((m, l) => (l.sale_date > m ? l.sale_date : m), '');
  const from = addDays(last, -(windowDays - 1));
  const lines = posLines.filter((l) => l.sale_date >= from && l.sale_date <= last);
  const recipes = recipesByMenu(recipeRows);

  // branch -> first day it sold inside the window (a branch opened last week
  // is averaged over its own days, not over a month it did not exist)
  const firstDay = new Map();
  lines.forEach((l) => { if (!firstDay.has(l.branch) || l.sale_date < firstDay.get(l.branch)) firstDay.set(l.branch, l.sale_date); });
  const salesDays = new Map();
  lines.forEach((l) => { (salesDays.get(l.branch) || salesDays.set(l.branch, new Set()).get(l.branch)).add(l.sale_date); });

  let food = 0, matchedSales = 0, noRecipe = 0, mixedUnitLines = 0;
  const unmatched = new Map();
  const acc = new Map(); // code|branch -> { info, byDate: Map, menus: Set }
  const unitVotes = new Map(); // code -> Map(base -> qty)
  const usedBase = (code, base, q) => {
    const v = unitVotes.get(code) || unitVotes.set(code, new Map()).get(code);
    v.set(base, (v.get(base) || 0) + q);
  };

  lines.forEach((l) => {
    const res = resolve(l.menu_name);
    if (res.status === 'ignored') return;
    food += num(l.net_sales);
    if (res.status !== 'matched') { unmatched.set(l.menu_name, (unmatched.get(l.menu_name) || 0) + num(l.net_sales)); return; }
    matchedSales += num(l.net_sales);
    const rec = recipes.get(PosParse.menuKey(res.menu.name));
    if (!rec) { noRecipe += 1; return; }
    rec.lines.forEach((r) => {
      const code = r.ingredient_code || r.ingredient_name;
      const u = baseUnit(r.ingredient_uom);
      const q = num(l.qty) * num(r.ingredient_qty) * u.f * (1 + num(r.yield_loss_pct) / 100);
      if (!q) return;
      usedBase(code, u.base, q);
      const k = code + '\u0001' + l.branch;
      const e = acc.get(k) || { code, name: r.ingredient_name, category: r.ingredient_category || '', branch: l.branch, byDate: new Map(), menus: new Set(), byBase: new Map() };
      e.byDate.set(l.sale_date, (e.byDate.get(l.sale_date) || 0) + q);
      e.byBase.set(u.base, (e.byBase.get(u.base) || 0) + q);
      e.menus.add(res.menu.name);
      acc.set(k, e);
    });
  });

  // One unit per ingredient: the one most of its quantity is written in.
  const baseOf = new Map();
  unitVotes.forEach((v, code) => baseOf.set(code, [...v.entries()].sort((a, b) => b[1] - a[1])[0][0]));

  const rows = [];
  acc.forEach((e) => {
    const base = baseOf.get(e.code);
    const total = e.byBase.get(base) || 0;
    mixedUnitLines += [...e.byBase.keys()].filter((b) => b !== base).length;
    const start = firstDay.get(e.branch);
    const days = Math.round((Date.parse(last) - Date.parse(start)) / 86400000) + 1;
    // average per weekday over the branch's own calendar days: a closed day counts as 0
    const wd = Array.from({ length: 7 }, () => ({ sum: 0, n: 0 }));
    for (let i = 0; i < days; i++) wd[weekdayOf(addDays(start, i))].n += 1;
    e.byDate.forEach((q, d) => { if (d >= start) wd[weekdayOf(d)].sum += q; });
    let peak = 0, peakDay = 0;
    wd.forEach((w, i) => { const a = w.n ? w.sum / w.n : 0; if (a > peak) { peak = a; peakDay = i; } });
    const lead = leadHints.get(e.code);
    const ou = orderHints.get(e.code);
    const ratio = ou ? orderUnitOf(ou.uom, ou.name, base) : null;
    rows.push({
      ingredient_code: e.code,
      ingredient_name: e.name,
      category: e.category || 'ไม่ระบุหมวด',
      branch: e.branch,
      uom: base,
      avg_daily: round(total / days),
      peak_daily: round(peak),
      peak_weekday: peakDay + 1, // 1 = Monday … 7 = Sunday
      total_qty: round(total),
      days,
      sales_days: (salesDays.get(e.branch) || new Set()).size,
      menus: e.menus.size,
      obs_lead_days: lead ? lead.days : null,
      obs_lead_n: lead ? lead.n : 0,
      order_uom: ou ? ou.uom : null,
      order_ratio: ratio, // base units in one order unit, when the data says so
      missing_days: Math.max(0, days - (salesDays.get(e.branch) || new Set()).size),
    });
  });
  rows.sort((a, b) => a.category.localeCompare(b.category, 'th') || a.ingredient_name.localeCompare(b.ingredient_name, 'th') || a.branch.localeCompare(b.branch, 'th'));

  return {
    rows,
    meta: {
      par: {
        from, to: last, window_days: windowDays, min_days: MIN_DAYS,
        branches: [...firstDay.keys()].length,
        coverage_pct: food ? Math.round((matchedSales / food) * 1000) / 10 : null,
        unmatched_menus: unmatched.size,
        menus_without_recipe: noRecipe,
        mixed_unit_lines: mixedUnitLines,
        lead_hints: leadHints.size,
        order_units_known: rows.filter((r) => r.order_ratio).length,
      },
    },
  };
}

async function build(companyId) {
  const P = pos();
  const { rows: posLines } = await P.salesLines(companyId, { allDays: true });
  if (!posLines.length) return null;
  const { menus } = await P.recipeCosts(companyId);
  const maps = await P.mappings(companyId);
  const memo = new Map();
  const resolve = (name) => { if (!memo.has(name)) memo.set(name, P.resolve(name, menus, maps)); return memo.get(name); };
  return compute({ posLines, recipeRows: await recipeLines(companyId), resolve, leadHints: await observedLeadTimes(companyId), orderHints: await orderUnits(companyId) });
}

// Writes the cache and returns the rows (null when there is nothing to build from).
async function buildFor(companyId) {
  const built = await build(companyId);
  if (!built) return null;
  await fc().writeCache(companyId, SOURCE, null, built.rows, { ...built.meta, local: true, last_mode: 'local' });
  return built;
}

// After a POS upload, a mapping change or a recipe sync: only if someone shows it.
async function rebuildIfShown(companyId) {
  try {
    const [[has]] = await pool.query(`SELECT 1 ok FROM fmh_report_cache WHERE company_id = ? AND cache_key = ?`, [companyId, SOURCE]);
    if (has) await buildFor(companyId);
  } catch (err) {
    console.error(`PAR rebuild failed (company ${companyId}):`, err.message);
  }
}

// ---------- settings (per category) ----------
function clean(v, max, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw Object.assign(new Error(`${label}ต้องเป็นตัวเลข 0–${max} วัน`), { status: 400 });
  return Math.round(n * 100) / 100;
}

async function getSettings(companyId) {
  const [rows] = await pool.query(`SELECT category, lead_days, safety_days, order_days FROM par_settings WHERE company_id = ?`, [companyId]);
  const byCat = {};
  let def = { ...DEFAULTS };
  rows.forEach((r) => {
    const s = { lead_days: Number(r.lead_days), safety_days: Number(r.safety_days), order_days: Number(r.order_days) };
    if (r.category === '') def = s; else byCat[r.category] = s;
  });
  const [u] = await pool.query(`SELECT ingredient_code, order_uom, ratio FROM par_uom WHERE company_id = ?`, [companyId]);
  const uoms = {};
  u.forEach((r) => { uoms[r.ingredient_code] = { order_uom: r.order_uom, ratio: Number(r.ratio) }; });
  return { defaults: def, categories: byCat, uoms, built_in: DEFAULTS };
}

// One ingredient's order unit: "1 BAG = 5,000 g". reset removes the override.
async function setUom(companyId, userId, { code, order_uom, ratio, reset }) {
  const c = String(code || '').slice(0, 190);
  if (!c) throw Object.assign(new Error('ไม่ระบุวัตถุดิบ'), { status: 400 });
  if (reset) {
    await pool.query(`DELETE FROM par_uom WHERE company_id = ? AND ingredient_code = ?`, [companyId, c]);
    return getSettings(companyId);
  }
  const u = String(order_uom || '').trim().slice(0, 60);
  const r = Number(ratio);
  if (!u) throw Object.assign(new Error('ระบุชื่อหน่วยสั่ง เช่น BAG, กก., ลัง'), { status: 400 });
  if (!Number.isFinite(r) || r <= 0 || r > 1e9) throw Object.assign(new Error('อัตราส่วนต้องเป็นตัวเลขมากกว่า 0'), { status: 400 });
  await pool.query(
    `INSERT INTO par_uom (company_id, ingredient_code, order_uom, ratio, updated_by) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE order_uom = VALUES(order_uom), ratio = VALUES(ratio), updated_by = VALUES(updated_by)`,
    [companyId, c, u, Math.round(r * 10000) / 10000, userId || null]
  );
  return getSettings(companyId);
}

// category '' sets the company default; reset removes a category's own row.
async function setSettings(companyId, userId, { category, lead_days, safety_days, order_days, reset }) {
  const cat = String(category || '').slice(0, 190);
  if (reset) {
    if (cat === '') throw Object.assign(new Error('ค่าเริ่มต้นของบริษัทลบไม่ได้ แก้ตัวเลขแทน'), { status: 400 });
    await pool.query(`DELETE FROM par_settings WHERE company_id = ? AND category = ?`, [companyId, cat]);
    return getSettings(companyId);
  }
  const l = clean(lead_days, 60, 'Lead time ');
  const s = clean(safety_days, 60, 'วันสำรอง');
  const o = clean(order_days, 60, 'ความถี่สั่ง');
  await pool.query(
    `INSERT INTO par_settings (company_id, category, lead_days, safety_days, order_days, updated_by) VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE lead_days = VALUES(lead_days), safety_days = VALUES(safety_days), order_days = VALUES(order_days), updated_by = VALUES(updated_by)`,
    [companyId, cat, l, s, o, userId || null]
  );
  return getSettings(companyId);
}

module.exports = { SOURCE, DEFAULTS, WINDOW_DAYS, MIN_DAYS, compute, build, buildFor, rebuildIfShown, getSettings, setSettings, setUom, baseUnit, orderUnitOf };
