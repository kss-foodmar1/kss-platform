// First-run questions: which starter packs a setup / role / goal gets.
// No server or database needed.   node scripts/test-starter.js
const assert = require('assert');
process.env.DB_NAME = process.env.DB_NAME || 'x';
const S = require('../lib/starter');
const { PACKS } = require('../lib/widgetPacks');
const catalog = require('../lib/widgetCatalog');
let pass = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log('PASS  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };
// every option "ready" so only the mapping is under test
const opts = S.OPTIONS.map((o) => ({ key: o.key, title: o.title, role: o.role || null, description: o.description, ready: [{ key: 'x', name: 'x' }], skipped: [] }));
const rank = (p) => S.recommend(opts, p).map((o) => o.key);

ok('every pack widget exists in the catalog', () => {
  const keys = new Set((catalog.BUILTIN_TEMPLATES || []).map((t) => t.template_key));
  if (!keys.size) return console.log('      (catalog list not exported, skipped)');
  PACKS.forEach((p) => p.templates.forEach((k) => assert(keys.has(k), `${p.key}: ${k} is not a template`)));
});
ok('every pack has a META entry', () => PACKS.forEach((p) => assert(S.META[p.key], p.key)));
ok('no answers = the original list', () => assert.strictEqual(S.recommend(opts, {}), opts));
ok('single outlet never gets central-kitchen or branch packs', () => {
  const r = rank({ setup: 'single', role: 'owner', goals: ['price'] });
  ['owner_morning', 'ck_margin', 'ck_daily', 'branch_audit', 'branch_daily', 'multi_branches', 'hotel_outlets'].forEach((k) => assert(!r.includes(k), k));
  assert.strictEqual(r[0], 'owner_simple');
});
ok('hotel does not get the central-kitchen margin pack', () => {
  const r = rank({ setup: 'hotel', role: 'owner', goals: ['profit'] });
  assert(!r.includes('owner_morning') && !r.includes('ck_margin'));
  assert(r.includes('hotel_outlets'));
});
ok('multi-outlet without a kitchen can ask about outlets that buy oddly', () => {
  assert.strictEqual(rank({ setup: 'multi', role: 'owner', goals: ['branch'] })[0], 'multi_branches');
});
ok('chef gets the kitchen cost pack first', () => assert.strictEqual(rank({ setup: 'single', role: 'chef', goals: ['waste'] })[0], 'chef_kitchen'));
ok('supplier goal does not promise due dates', () => {
  assert(!/ครบกำหนด/.test(S.GOALS.supplier));
  assert.strictEqual(rank({ setup: 'ck', role: 'accounting', goals: ['supplier'] })[0], 'supplier_money');
});
ok('"looks after everything" is offered to every setup and ranks a pack', () => {
  Object.keys(S.SETUPS).forEach((s) => assert(rank({ setup: s, role: 'all', goals: [] }).length > 0, s));
});
ok('cloud kitchen with menu goal gets delivery pricing', () => assert.strictEqual(rank({ setup: 'cloud', role: 'all', goals: ['menu'] })[0], 'cloud_pricing'));
ok('profile is cleaned: unknown values dropped, goals capped at 2', () => {
  const p = S.cleanProfile({ setup: 'zzz', role: 'chef', goals: ['price', 'waste', 'menu', 'nope'] });
  assert.deepStrictEqual(p, { setup: null, role: 'chef', goals: ['price', 'waste'] });
});
console.log(`\n${pass} passed`);
