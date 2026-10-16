// "Start with a basic dashboard?" — fill an empty dashboard in one click, but
// only with widgets that will show numbers straight away for this company.
// A first look full of empty widgets reads as a broken product, which matters
// most in a 30-day trial.
//
// A widget is ready when every report it reads is:
//   - a demo company's (demo data covers everything), or
//   - an FMH report already cached with rows, or not synced yet on a company
//     with a key (it is fetched the moment the widget is added), or
//   - an alert (built from FMH reports the rules above already cover), or
//   - POS based (pos-sales, branch audit) and the company has uploaded a POS file.
// A report cached with no rows is not ready: FMH returned nothing for it.
const pool = require('../db/pool');
const { FMH_REPORTS, cacheKeyFor, pullsForWidget } = require('./fmhCache');
const { PACKS } = require('./widgetPacks');
const { STARTER } = require('./selfServe');

const BASIC = {
  key: 'basic',
  title: 'Dashboard พื้นฐาน',
  description: 'ภาพรวมจัดซื้อ ราคาที่ขยับ ยอดซื้อแยกตามซัพพลายเออร์ และตัวเตือนที่ส่ง LINE ได้',
  templates: STARTER,
  highlights: ['ยอดซื้อและราคาที่ขยับ', 'ยอดซื้อแยกตามซัพพลายเออร์', 'ตัวเตือนที่ส่งเข้า LINE ได้'],
};
const OPTIONS = [BASIC, ...PACKS];

async function companyFacts(companyId) {
  const [[c]] = await pool.query(`SELECT data_source, fmh_api_key_enc IS NOT NULL AS has_key FROM companies WHERE id = ?`, [companyId]);
  const [cache] = await pool.query(`SELECT cache_key, row_count FROM fmh_report_cache WHERE company_id = ?`, [companyId]);
  const [[pos]] = await pool.query(`SELECT COUNT(*) AS n FROM pos_uploads WHERE company_id = ?`, [companyId]);
  return {
    demo: !!c && c.data_source === 'demo',
    hasKey: !!c && !!c.has_key,
    hasPos: Number(pos.n) > 0,
    rows: new Map(cache.map((r) => [r.cache_key, r.row_count === null ? null : Number(r.row_count)])),
  };
}

// null when ready, else why not (Thai, shown to the customer).
function whyNotReady(tpl, facts) {
  if (facts.demo) return null;
  let cfg = {};
  try { cfg = JSON.parse(tpl.default_config_json || '{}'); } catch (e) { /* none */ }
  for (const p of pullsForWidget(tpl.report_source, cfg)) {
    const rep = FMH_REPORTS[p.source] || {};
    if (rep.localBuild === 'alerts') continue;
    if (rep.local) {
      if (!facts.hasPos) return 'ต้องอัปโหลดไฟล์ยอดขาย POS ก่อน';
      continue;
    }
    if (!facts.hasKey) return 'ยังไม่ได้เชื่อม FMH';
    if (facts.rows.get(cacheKeyFor(p.source, p.grouping)) === 0) return 'FMH ยังไม่มีข้อมูลรายงานนี้';
  }
  return null;
}

async function templatesByKey(keys) {
  const [rows] = await pool.query(
    `SELECT id, template_key, name, report_source, default_config_json FROM widget_templates WHERE active = TRUE AND template_key IN (?)`,
    [keys.length ? keys : ['-']]
  );
  return new Map(rows.map((t) => [t.template_key, t]));
}

// Every option with what it would add for this company now.
async function options(companyId) {
  const facts = await companyFacts(companyId);
  const tpls = await templatesByKey([...new Set(OPTIONS.flatMap((o) => o.templates))]);
  return OPTIONS.map((o) => {
    const ready = [];
    const skipped = [];
    o.templates.forEach((k) => {
      const t = tpls.get(k);
      if (!t) return;
      const why = whyNotReady(t, facts);
      if (why) skipped.push({ key: k, name: t.name, reason: why });
      else ready.push({ key: k, name: t.name });
    });
    return { key: o.key, title: o.title, role: o.role || null, description: o.description, highlights: o.highlights || [], ready, skipped };
  });
}

// The ready templates of one option, in its order.
async function readyTemplates(companyId, key) {
  const opt = OPTIONS.find((o) => o.key === key);
  if (!opt) return null;
  const facts = await companyFacts(companyId);
  const tpls = await templatesByKey(opt.templates);
  return opt.templates.map((k) => tpls.get(k)).filter((t) => t && !whyNotReady(t, facts));
}

// ---- first-run questions -------------------------------------------------
// Three answers pick the packs: the shape of the business (which widgets can
// make sense at all), who is looking, and what they want to find out.
const SETUPS = {
  single: 'ร้านเดียว',
  multi: 'หลายสาขา ไม่มีครัวกลาง',
  ck: 'หลายสาขา มีครัวกลาง',
  hotel: 'โรงแรม / รีสอร์ต (หลายห้องอาหาร)',
  cloud: 'Cloud kitchen / เดลิเวอรี่ (ครัวเดียว หลายแบรนด์)',
};
// What each shape has: several outlets to compare, a kitchen that supplies them.
const SETUP_INFO = {
  single: { branches: false, ck: false },
  multi: { branches: true, ck: false },
  ck: { branches: true, ck: true },
  hotel: { branches: true, ck: true },
  cloud: { branches: false, ck: false },
};
const ROLES = {
  owner: 'เจ้าของ / ผู้บริหาร (ดูภาพรวม)',
  all: 'ดูแลเองทุกอย่าง (ซื้อ ครัว บัญชี)',
  purchasing: 'จัดซื้อ',
  chef: 'เชฟ / ผู้จัดการครัว',
  branch: 'ผู้จัดการสาขา',
  ck: 'ครัวกลาง',
  accounting: 'บัญชี',
};
const GOALS = {
  profit: 'กำไรและต้นทุนจริง',
  price: 'ราคาซื้อที่ขยับ',
  waste: 'ของเสียและสต็อก',
  bills: 'ตรวจใบสั่งซื้อและใบแจ้งหนี้ก่อนปิดบัญชี',
  menu: 'ต้นทุนเมนู / ปรับราคาขาย',
  supplier: 'บิลและใบลดหนี้ของซัพพลายเออร์',
  branch: 'สาขาที่ซื้อผิดปกติ',
};
const ALL = Object.keys(SETUPS);
// Packs for a business that does not run a kitchen that sells to its outlets at a margin.
const OWNER_SIMPLE_SETUPS = ['single', 'multi', 'cloud', 'hotel'];
// setups: where the pack makes sense. roles / goals: who and what it fits.
const META = {
  basic: { setups: ALL, roles: ['owner', 'purchasing'], goals: ['price'] },
  owner_simple: { setups: OWNER_SIMPLE_SETUPS, roles: ['owner'], goals: ['price', 'waste'] },
  owner_morning: { setups: ['ck'], roles: ['owner'], goals: ['profit', 'price', 'waste'] },
  purchasing_check: { setups: ALL, roles: ['purchasing'], goals: ['bills', 'price'] },
  ck_margin: { setups: ['ck'], roles: ['owner', 'ck'], goals: ['profit'] },
  menu_pricing: { setups: ALL, roles: ['owner', 'chef'], goals: ['menu', 'profit'] },
  chef_kitchen: { setups: ALL, roles: ['chef'], goals: ['menu', 'waste', 'profit'] },
  hotel_outlets: { setups: ['hotel'], roles: ['owner', 'branch', 'accounting'], goals: ['profit', 'branch', 'waste'] },
  cloud_pricing: { setups: ['cloud'], roles: ['owner', 'all', 'chef'], goals: ['menu', 'profit'] },
  supplier_money: { setups: ALL, roles: ['purchasing', 'accounting'], goals: ['supplier', 'bills'] },
  branch_audit: { setups: ['ck'], roles: ['owner', 'branch'], goals: ['branch'] },
  branch_daily: { setups: ['multi', 'ck', 'hotel'], roles: ['branch'], goals: ['waste', 'branch'] },
  multi_branches: { setups: ['multi'], roles: ['owner', 'branch'], goals: ['branch', 'waste'] },
  accounting_close: { setups: ALL, roles: ['accounting'], goals: ['bills', 'supplier'] },
  ck_daily: { setups: ['ck', 'hotel'], roles: ['ck', 'chef'], goals: ['waste', 'bills'] },
};
// "Looks after everything" fits every pack that one person would run.
const ALL_ROUNDER = ['owner', 'purchasing', 'accounting', 'chef'];

// Clean answers: unknown values are dropped, goals capped at 2.
function cleanProfile(p) {
  p = p || {};
  const goals = (Array.isArray(p.goals) ? p.goals : []).filter((g) => GOALS[g]);
  return {
    setup: SETUPS[p.setup] ? p.setup : null,
    role: ROLES[p.role] ? p.role : null,
    goals: [...new Set(goals)].slice(0, 2),
  };
}

// The options for these answers: packs that cannot fit the business are left
// out, the rest ranked by role (3), goal (2 each) and a pack that is ready now.
// `why` is one line for the customer. No answers = the original list.
function recommend(opts, profile) {
  const pr = cleanProfile(profile);
  if (!pr.setup && !pr.role && !pr.goals.length) return opts;
  const scored = opts
    .filter((o) => !pr.setup || !META[o.key] || META[o.key].setups.includes(pr.setup))
    .map((o) => {
      const m = META[o.key] || { roles: [], goals: [], setups: ALL };
      const roleHit = pr.role === 'all' ? m.roles.some((r) => ALL_ROUNDER.includes(r)) : pr.role && m.roles.includes(pr.role);
      const goalHits = pr.goals.filter((g) => m.goals.includes(g));
      const parts = [];
      if (roleHit) parts.push(pr.role === 'all' ? 'ครอบคลุมงานที่คุณดูแลเอง' : `เหมาะกับงานของ “${ROLES[pr.role]}”`);
      if (goalHits.length) parts.push(`ตอบโจทย์: ${goalHits.map((g) => GOALS[g]).join(' · ')}`);
      // a pack made for fewer setups wins a tie (the 0.5 / n term)
      return { ...o, score: (roleHit ? 3 : 0) + goalHits.length * 2 + (o.ready.length ? 1 : 0) + 0.5 / ((m.setups || ALL).length), why: parts.join(' · ') };
    });
  scored.sort((a, b) => b.score - a.score);
  // "basic" is a smaller owner_simple: once the owner pack is offered it only repeats it
  return scored.some((o) => o.key === 'owner_simple') ? scored.filter((o) => o.key !== 'basic') : scored;
}

module.exports = { options, readyTemplates, whyNotReady, OPTIONS, SETUPS, SETUP_INFO, ROLES, GOALS, META, cleanProfile, recommend };
