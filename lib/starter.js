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
  description: 'ภาพรวมจัดซื้อ ราคาที่ขยับ ยอดซื้อต่อสาขา และตัวเตือนที่ส่ง LINE ได้',
  templates: STARTER,
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
    return { key: o.key, title: o.title, role: o.role || null, description: o.description, ready, skipped };
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
const SETUPS = { single: 'ร้านเดียว', multi: 'หลายสาขา ไม่มีครัวกลาง', ck: 'หลายสาขา มีครัวกลาง' };
const ROLES = { owner: 'เจ้าของ / ผู้บริหาร', purchasing: 'จัดซื้อ', branch: 'ผู้จัดการสาขา', ck: 'ครัวกลาง', accounting: 'บัญชี' };
const GOALS = {
  profit: 'กำไรและต้นทุนจริง',
  price: 'ราคาซื้อที่ขยับ',
  waste: 'ของเสียและสต็อก',
  bills: 'ตรวจ PO ใบแจ้งหนี้ ปิดบัญชี',
  menu: 'ต้นทุนเมนู / ปรับราคาขาย',
  branch: 'สาขาที่ซื้อผิดปกติ',
};
const ALL = Object.keys(SETUPS);
// setups: where the pack makes sense. roles / goals: who and what it fits.
const META = {
  basic: { setups: ALL, roles: ['owner', 'purchasing'], goals: ['price'] },
  owner_simple: { setups: ['single', 'multi'], roles: ['owner'], goals: ['price', 'waste', 'profit'] },
  owner_morning: { setups: ['ck'], roles: ['owner'], goals: ['profit', 'price', 'waste'] },
  purchasing_check: { setups: ALL, roles: ['purchasing'], goals: ['bills', 'price'] },
  ck_margin: { setups: ['ck'], roles: ['owner', 'ck'], goals: ['profit'] },
  menu_pricing: { setups: ALL, roles: ['owner'], goals: ['menu', 'profit'] },
  branch_audit: { setups: ['ck'], roles: ['owner', 'branch'], goals: ['branch'] },
  branch_daily: { setups: ['multi', 'ck'], roles: ['branch'], goals: ['waste'] },
  accounting_close: { setups: ALL, roles: ['accounting'], goals: ['bills'] },
  ck_daily: { setups: ['ck'], roles: ['ck'], goals: ['waste', 'bills'] },
};

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
      const m = META[o.key] || { roles: [], goals: [] };
      const roleHit = pr.role && m.roles.includes(pr.role);
      const goalHits = pr.goals.filter((g) => m.goals.includes(g));
      const parts = [];
      if (roleHit) parts.push(`ตรงกับบทบาท “${ROLES[pr.role]}”`);
      if (goalHits.length) parts.push(`ตอบเรื่อง ${goalHits.map((g) => GOALS[g]).join(' และ ')}`);
      return { ...o, score: (roleHit ? 3 : 0) + goalHits.length * 2 + (o.ready.length ? 1 : 0), why: parts.join(' · ') };
    });
  return scored.sort((a, b) => b.score - a.score);
}

module.exports = { options, readyTemplates, whyNotReady, OPTIONS, SETUPS, ROLES, GOALS, cleanProfile, recommend };
