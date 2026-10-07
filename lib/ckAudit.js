// Branch purchase audit: does each branch still buy from the central kitchen
// in proportion to what it sells? Three views, one build:
//
//   ck-audit         branch × month: CK purchases ÷ POS sales (CK %), against
//                    the month's median across branches; a branch below 85% of
//                    it is flagged, three months running = "ควรตรวจ"
//   ck-audit-recipe  branch × month × CK item: what the recipes say the sales
//                    needed vs what the branch ordered from the CK
//   ck-audit-upt     branch × month × key CK item: units ordered per 1,000
//                    items sold — no recipes or unit conversion needed, for
//                    toppings and add-ons that can't be counted gram by gram
//
// Inputs, all already in the system: POS sales (pos_sales_daily, Foodstory or
// any POS file), FMH Sales Analysis (what the CK sold to whom; API + uploaded
// history files), FMH Menu & Ingredients (recipes). The only new setting is
// which FMH customer is which POS branch (ck_branch_map), guessed from names.
const pool = require('../db/pool');
const PosParse = require('../public/pos-parse');

const SOURCES = ['ck-audit', 'ck-audit-recipe', 'ck-audit-upt'];
const THRESHOLD = 0.85; // below 85% of the month's median CK % is "low"
const STREAK_FLAG = 3; // low this many months running → ควรตรวจ
const MIN_BRANCHES = 3; // a median of fewer branches says nothing
const KEY_ITEMS = 10; // UPT: the CK items with the most value delivered
const HISTORY_DAYS = 400;
const PARTIAL_DAYS = 20; // fewer sales days than this in a month = partial

const fc = () => require('./fmhCache');
const pos = () => require('./posSales');

const round = (n, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
const monthOf = (d) => (d ? String(d).slice(0, 7) + '-01' : null);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// ---------- branch names ----------
// "คุณป๊อป สาขา เซ็นจูรี่ - คุณป๊อป สาขา เซ็นจูรี่" → "เซ็นจูรี่"; else the part
// after " - ", else the whole name.
function branchPart(customer) {
  const s = String(customer || '').replace(/\s+/g, ' ').trim();
  const m = /สาขา\s*([^-]+?)\s*(?:-|$)/.exec(s);
  if (m && m[1].trim()) return m[1].trim();
  const dash = s.split(' - ');
  return (dash[1] || dash[0]).trim();
}
const normBranch = (s) => String(s || '').replace(/สาขา/g, '').replace(/[\s\-_.(),/]/g, '').toLowerCase();

function guessBranch(customer, posBranches) {
  const want = normBranch(branchPart(customer));
  if (!want) return null;
  let hit = posBranches.find((b) => normBranch(b) === want);
  if (hit) return hit;
  const loose = posBranches.filter((b) => {
    const n = normBranch(b);
    return n.length >= 2 && want.length >= 2 && (n.includes(want) || want.includes(n));
  });
  return loose.length === 1 ? loose[0] : null;
}

// ---------- units ----------
// Size of one CK unit, from its UOM or name: "BAG (5KG)", "500 กรัม/แพ็ค",
// "1 ลิตร/ขวด" → { base: grams or ml, dim }.
const UNIT = [
  [/^(kg|กก|กิโลกรัม|กิโล)\.?$/i, 1000, 'mass'], [/^(g|gm|กรัม|ก)\.?$/i, 1, 'mass'],
  [/^(l|lt|ltr|ลิตร|ล)\.?$/i, 1000, 'vol'], [/^(ml|มล|มิลลิลิตร)\.?$/i, 1, 'vol'],
];
function unitOf(word) {
  const w = String(word || '').trim();
  for (const [re, f, dim] of UNIT) if (re.test(w)) return { f, dim };
  return null;
}
function packSize(uom, name) {
  for (const text of [uom, name]) {
    const re = /(\d+(?:\.\d+)?)\s*(kg|กก\.?|กิโลกรัม|g|gm|กรัม|ml|มล\.?|ลิตร|l|ltr)(?![a-z])/gi;
    let m;
    while ((m = re.exec(String(text || '')))) {
      const u = unitOf(m[2].replace(/\.$/, ''));
      if (u) return { base: Number(m[1]) * u.f, dim: u.dim };
    }
  }
  const u = unitOf(uom); // a CK item sold by the kg itself
  return u ? { base: u.f, dim: u.dim } : null;
}
const normUom = (s) => String(s || '').toLowerCase().replace(/[\s.()]/g, '');

// ---------- branch map ----------
async function savedMap(companyId) {
  const [rows] = await pool.query(`SELECT fmh_customer, pos_branch, ignore_customer FROM ck_branch_map WHERE company_id = ?`, [companyId]);
  return new Map(rows.map((r) => [r.fmh_customer, r]));
}

// customer -> { branch, via: 'manual' | 'name' | null, ignored }
function resolveCustomers(customers, posBranches, saved) {
  const out = new Map();
  customers.forEach((c) => {
    const s = saved.get(c);
    if (s && s.ignore_customer) return out.set(c, { branch: null, via: 'manual', ignored: true });
    if (s && s.pos_branch && posBranches.includes(s.pos_branch)) return out.set(c, { branch: s.pos_branch, via: 'manual' });
    const g = guessBranch(c, posBranches);
    out.set(c, { branch: g, via: g ? 'name' : null, suggestion: g ? null : branchPart(c) });
  });
  return out;
}

// ---------- inputs ----------
async function companyInfo(companyId) {
  const [[c]] = await pool.query(`SELECT fmh_api_key_enc, data_source FROM companies WHERE id = ?`, [companyId]);
  return c || {};
}
async function cachedOrPull(companyId, source) {
  const { getCached, syncOne } = fc();
  const c = await getCached(companyId, source, null);
  if (c && c.data.length) return c.data;
  const info = await companyInfo(companyId);
  if (!info.fmh_api_key_enc && info.data_source !== 'demo') return c ? c.data : [];
  try {
    return (await syncOne(companyId, source, null)).data;
  } catch (err) {
    console.error(`CK audit: ${source} pull failed for company ${companyId}:`, err.message);
    return c ? c.data : [];
  }
}

const ckDate = (r) => String(r.requested_delivery_date || r.order_date || '').slice(0, 10);
const isFee = (r) => /ขนส่ง|delivery|shipping/i.test(`${r.category_name || ''} ${r.product_name || ''}`) || r.product_code === 'DLV-01';

async function inputs(companyId) {
  const P = pos();
  const { rows: posAll } = await P.salesLines(companyId, { allDays: true });
  const since = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString().slice(0, 10);
  const posLines = posAll.filter((l) => l.sale_date >= since);
  const ckAll = (await cachedOrPull(companyId, 'sales-analysis')).filter((r) => !isFee(r));
  // Only the days both sides cover: a month with POS sales but half its CK
  // data would read as a branch that stopped buying.
  const ckDays = ckAll.map(ckDate).filter(Boolean).sort();
  const posDays = posLines.map((l) => l.sale_date).sort();
  if (!ckDays.length || !posDays.length) return { posLines, ck: ckAll, window: null };
  const from = ckDays[0] > posDays[0] ? ckDays[0] : posDays[0];
  const to = ckDays[ckDays.length - 1] < posDays[posDays.length - 1] ? ckDays[ckDays.length - 1] : posDays[posDays.length - 1];
  return {
    posLines: posLines.filter((l) => l.sale_date >= from && l.sale_date <= to),
    ck: ckAll.filter((r) => { const d = ckDate(r); return d >= from && d <= to; }),
    window: { from, to },
  };
}

// ---------- the build ----------
async function build(companyId) {
  const { posLines, ck, window } = await inputs(companyId);
  if (!posLines.length || !ck.length) return null;
  const P = pos();
  const posBranches = [...new Set(posLines.map((l) => l.branch))].sort();
  const customers = [...new Set(ck.map((r) => r.customer).filter(Boolean))];
  const custMap = resolveCustomers(customers, posBranches, await savedMap(companyId));
  const branchOfRow = (r) => (custMap.get(r.customer) || {}).branch || null;

  const ckMonths = new Set(ck.map((r) => monthOf(ckDate(r))).filter(Boolean));

  // POS per branch-month: sales and items sold (non-food lines left out).
  const { menus } = await P.recipeCosts(companyId);
  const maps = await P.mappings(companyId);
  const memo = new Map();
  const res = (name) => { if (!memo.has(name)) memo.set(name, P.resolve(name, menus, maps)); return memo.get(name); };
  const posBM = new Map();
  posLines.forEach((l) => {
    const r = res(l.menu_name);
    if (r.status === 'ignored') return;
    const k = l.branch + '|' + monthOf(l.sale_date);
    const e = posBM.get(k) || { branch: l.branch, month: monthOf(l.sale_date), sales: 0, items: 0, days: new Set(), byMenu: new Map(), matched: 0 };
    e.sales += num(l.net_sales);
    e.items += num(l.qty);
    e.days.add(l.sale_date);
    if (r.status === 'matched') {
      e.matched += num(l.net_sales);
      e.byMenu.set(r.menu.name, (e.byMenu.get(r.menu.name) || 0) + num(l.qty));
    }
    posBM.set(k, e);
  });

  // CK per branch-month and per item.
  const ckBM = new Map();
  const ckItem = new Map(); // branch|month|code -> {qty,value}
  const items = new Map(); // code -> {name,uom,value,qty}
  ck.forEach((r) => {
    const b = branchOfRow(r);
    const m = monthOf(ckDate(r));
    if (!b || !m) return;
    const v = num(r.total);
    const q = num(r.qty);
    ckBM.set(b + '|' + m, (ckBM.get(b + '|' + m) || 0) + v);
    const code = r.product_code || r.product_name;
    const k = `${b}|${m}|${code}`;
    const e = ckItem.get(k) || { qty: 0, value: 0 };
    e.qty += q;
    e.value += v;
    ckItem.set(k, e);
    const it = items.get(code) || { code, name: r.product_name, uom: r.uom, value: 0, qty: 0 };
    it.value += v;
    it.qty += q;
    items.set(code, it);
  });

  // ---- layer 1 ----
  const audit = [];
  posBM.forEach((e) => {
    if (!ckMonths.has(e.month) || e.sales <= 0) return;
    const purchase = ckBM.get(e.branch + '|' + e.month) || 0;
    audit.push({
      month: e.month, branch: e.branch, pos_sales: round(e.sales), ck_purchase: round(purchase),
      ck_pct: round((purchase / e.sales) * 100), pos_days: e.days.size,
    });
  });
  const byMonth = new Map();
  audit.forEach((r) => { if (!byMonth.has(r.month)) byMonth.set(r.month, []); byMonth.get(r.month).push(r); });
  byMonth.forEach((rs) => {
    const v = rs.map((r) => r.ck_pct).sort((a, b) => a - b);
    const med = rs.length >= MIN_BRANCHES ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null;
    rs.forEach((r) => {
      r.median_pct = med === null ? null : round(med);
      r.vs_median = med ? round((r.ck_pct / med) * 100, 1) : null;
      r.is_low = med && r.ck_pct < med * THRESHOLD ? 1 : 0;
    });
  });
  // A month with few sales days (the window's first or the running month) is
  // partial: low there still counts, but normal there doesn't clear a flag —
  // a week of data is not evidence a branch came back.
  audit.forEach((r) => { r.is_partial = r.pos_days < PARTIAL_DAYS ? 1 : 0; });
  const months = [...byMonth.keys()].sort();
  const complete = months.filter((m) => byMonth.get(m).some((r) => !r.is_partial));
  const latest = complete[complete.length - 1] || months[months.length - 1];
  const byBranch = new Map();
  audit.forEach((r) => { if (!byBranch.has(r.branch)) byBranch.set(r.branch, []); byBranch.get(r.branch).push(r); });
  const statusOf = new Map(); // branch|month -> status
  byBranch.forEach((rs) => {
    rs.sort((a, b) => a.month.localeCompare(b.month));
    let streak = 0;
    rs.forEach((r) => {
      streak = r.is_low ? streak + 1 : r.is_partial ? streak : 0;
      r.low_streak = streak;
      r.status = r.median_pct === null ? 'เทียบไม่ได้' : streak >= STREAK_FLAG ? 'ควรตรวจ' : streak ? 'เฝ้าดู' : 'ปกติ';
      r.is_flagged = r.status === 'ควรตรวจ' ? 1 : 0;
      r.is_latest = r.month === latest ? 1 : 0;
      statusOf.set(r.branch + '|' + r.month, r.status);
    });
  });

  // ---- layer 2: recipes ----
  const recipeRows = await cachedOrPull(companyId, 'menu-costing');
  const recipe = new Map(); // menuKey -> [{code,name,qty,uom}]
  recipeRows.forEach((r) => {
    if (!r.menu_name || !r.ingredient_code) return;
    const k = PosParse.menuKey(r.menu_name);
    if (!recipe.has(k)) recipe.set(k, []);
    recipe.get(k).push({ code: r.ingredient_code, name: r.ingredient_name, qty: num(r.ingredient_qty), uom: r.ingredient_uom });
  });
  const recipeOut = [];
  posBM.forEach((e) => {
    if (!ckMonths.has(e.month)) return;
    const need = new Map(); // code -> {qty in recipe uom, uom, name, menus:Set}
    e.byMenu.forEach((sold, menuName) => {
      (recipe.get(PosParse.menuKey(menuName)) || []).forEach((ing) => {
        if (!items.has(ing.code)) return; // only what the CK supplies
        const n = need.get(ing.code) || { qty: 0, uom: ing.uom, name: ing.name, menus: new Map() };
        n.qty += sold * ing.qty;
        n.menus.set(menuName, (n.menus.get(menuName) || 0) + sold);
        need.set(ing.code, n);
      });
    });
    need.forEach((n, code) => {
      const it = items.get(code);
      const got = ckItem.get(`${e.branch}|${e.month}|${code}`) || { qty: 0, value: 0 };
      const price = it.qty ? it.value / it.qty : 0;
      const ru = unitOf(n.uom);
      const size = packSize(it.uom, it.name);
      let factor = null; // recipe units per CK unit
      if (ru && size && ru.dim === size.dim) factor = size.base / ru.f;
      else if (normUom(n.uom) === normUom(it.uom)) factor = 1;
      const needUnits = factor ? n.qty / factor : null;
      const menusTop = [...n.menus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m]) => m).join(', ');
      recipeOut.push({
        month: e.month, branch: e.branch, ingredient_code: code, ingredient_name: it.name || n.name, ck_uom: it.uom || '',
        menus: menusTop, recipe_qty: round(n.qty, 3), recipe_uom: n.uom || '',
        need_units: needUnits === null ? 0 : round(needUnits, 2), got_units: round(got.qty, 2), got_value: round(got.value),
        need_value: needUnits === null ? 0 : round(needUnits * price), convertible: factor ? 1 : 0,
        unit_note: factor ? '' : `หน่วยสูตร (${n.uom || '-'}) แปลงเป็น ${it.uom || '-'} ไม่ได้`,
        branch_status: statusOf.get(e.branch + '|' + e.month) || '',
      });
    });
  });

  // ---- layer 3: units per 1,000 items sold ----
  const key = [...items.values()].sort((a, b) => b.value - a.value).slice(0, KEY_ITEMS);
  const upt = [];
  posBM.forEach((e) => {
    if (!ckMonths.has(e.month) || e.items <= 0) return;
    key.forEach((it) => {
      const got = ckItem.get(`${e.branch}|${e.month}|${it.code}`) || { qty: 0, value: 0 };
      upt.push({
        month: e.month, branch: e.branch, product_code: it.code, product_name: it.name, uom: it.uom || '',
        ordered_units: round(got.qty, 2), ordered_value: round(got.value), items_sold: round(e.items, 0), items_k: e.items / 1000,
        upt: round((got.qty / e.items) * 1000, 2),
      });
    });
  });

  const dates = posLines.map((l) => l.sale_date).sort();
  const mapped = [...custMap.values()].filter((m) => m.branch).length;
  const meta = { ck_audit: { pos_from: dates[0], pos_to: dates[dates.length - 1], window, branches: posBranches.length, customers: customers.length, mapped, latest_month: latest } };
  return { 'ck-audit': audit, 'ck-audit-recipe': recipeOut, 'ck-audit-upt': upt, meta };
}

// Writes all three caches; returns the rows of the one asked for.
async function buildFor(companyId, source) {
  const built = await build(companyId);
  if (!built) return null;
  const { writeCache } = fc();
  for (const s of SOURCES) {
    await writeCache(companyId, s, null, built[s], { ...built.meta, local: true, last_mode: 'local' });
  }
  return { rows: built[source], meta: built.meta };
}

// ---------- the mapping screen ----------
async function overview(companyId) {
  const { posLines, ck } = await inputs(companyId);
  const posBranches = [...new Set(posLines.map((l) => l.branch))].sort();
  const totals = new Map();
  ck.forEach((r) => { if (r.customer) totals.set(r.customer, (totals.get(r.customer) || 0) + num(r.total)); });
  const custMap = resolveCustomers([...totals.keys()], posBranches, await savedMap(companyId));
  return {
    pos_branches: posBranches,
    customers: [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([c, v]) => ({ customer: c, ck_value: round(v), ...custMap.get(c) })),
    has_pos: posLines.length > 0,
    has_ck: ck.length > 0,
  };
}

async function setMap(companyId, { fmh_customer, pos_branch, ignore }) {
  const c = String(fmh_customer || '').slice(0, 255);
  if (!c) throw Object.assign(new Error('ไม่ระบุลูกค้า'), { status: 400 });
  if (!pos_branch && !ignore) {
    await pool.query(`DELETE FROM ck_branch_map WHERE company_id = ? AND fmh_customer = ?`, [companyId, c]);
  } else {
    await pool.query(
      `INSERT INTO ck_branch_map (company_id, fmh_customer, pos_branch, ignore_customer) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE pos_branch = VALUES(pos_branch), ignore_customer = VALUES(ignore_customer)`,
      [companyId, c, ignore ? null : String(pos_branch).slice(0, 255), ignore ? 1 : 0]
    );
  }
  await rebuildIfShown(companyId);
}

async function rebuildIfShown(companyId) {
  try {
    const [[has]] = await pool.query(`SELECT 1 ok FROM fmh_report_cache WHERE company_id = ? AND cache_key = 'ck-audit'`, [companyId]);
    if (has) await buildFor(companyId, 'ck-audit');
  } catch (err) {
    console.error(`CK audit rebuild failed (company ${companyId}):`, err.message);
  }
}

module.exports = { SOURCES, THRESHOLD, build, buildFor, overview, setMap, rebuildIfShown, branchPart, guessBranch, packSize, unitOf };
