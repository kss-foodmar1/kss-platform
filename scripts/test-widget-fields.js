#!/usr/bin/env node
// Every widget reads fields that exist. No DB, no API key.
//  1. itemized and card pulls: against FMH's published catalog (docs/fmh-catalog-fields.json)
//  2. every pull, grouped ones included: against the demo generator, which is what
//     the demo company and the tests render (a widget that drifts from it renders blank)
//  3. the checker itself catches a wrong field
// Grouped field names are FMH's to confirm: run FMH Diagnostics > widget_fields on a real client.
const { FMH_REPORTS } = require('../lib/fmhCache');
const { BUILTIN_TEMPLATES } = require('../lib/widgetCatalog');
const wf = require('../lib/widgetFields');
const demo = require('../lib/demoData');
const { cards } = require('../docs/fmh-catalog-fields.json');

let pass = 0, fail = 0;
const t = (name, ok, detail) => { if (ok) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, detail || ''); } };

const catalogFields = (p) => {
  const r = FMH_REPORTS[p.source];
  if (p.grouping) return null;
  return cards[r.cardKey] ? new Set(cards[r.cardKey].fields) : null;
};
const demoCache = new Map();
const demoFields = (p) => {
  if (demoCache.has(p.key)) return demoCache.get(p.key);
  const r = FMH_REPORTS[p.source];
  let set = null;
  try {
    const rows = demo.respond(r.reportKey, r.cardKey, { group_by: p.grouping || undefined, limit: 5000 }).data;
    if (rows.length) { set = new Set(); rows.forEach((x) => Object.keys(x).forEach((k) => set.add(k))); }
  } catch (e) { /* no demo card */ }
  demoCache.set(p.key, set);
  return set;
};

const cardsUsed = new Set(Object.values(FMH_REPORTS).filter((r) => !r.local).map((r) => r.cardKey));
const unknownCards = [...cardsUsed].filter((c) => !cards[c]);
t('every FMH card the app requests is in FMH catalog', !unknownCards.length, unknownCards.join(', '));

const vsCatalog = BUILTIN_TEMPLATES.map((tpl) => [tpl.template_key, wf.check(tpl, catalogFields).missing]).filter(([, m]) => m.length);
t(`${BUILTIN_TEMPLATES.length} widgets: itemized/card fields exist in FMH catalog`, !vsCatalog.length, JSON.stringify(vsCatalog));

const vsDemo = BUILTIN_TEMPLATES.map((tpl) => [tpl.template_key, wf.check(tpl, demoFields).missing]).filter(([, m]) => m.length);
t('every widget field exists in the demo data (grouped pulls included)', !vsDemo.length, JSON.stringify(vsDemo));

// demo rows must not carry fields FMH does not have, or widgets pass here and fail on real data
const extra = [];
Object.entries(FMH_REPORTS).forEach(([source, r]) => {
  if (r.local || !cards[r.cardKey]) return;
  const f = demoFields({ source, grouping: null, key: source });
  if (!f) return;
  const doc = new Set(cards[r.cardKey].fields);
  const odd = [...f].filter((k) => !doc.has(k) && !k.startsWith('_'));
  if (odd.length) extra.push(`${source}: ${odd.join(', ')}`);
});
t('demo itemized/card rows use only fields FMH documents', !extra.length, '\n    ' + extra.join('\n    '));

const fake = { template_key: 'x', report_source: 'wastage-lines', config: { group_by: ['outlet_name'], value: { op: 'sum', field: 'wastage_value' } } };
const m = wf.check(fake, catalogFields).missing;
t('checker flags a field FMH does not have (outlet_name)', m.length === 1 && m[0].alts[0] === 'outlet_name', JSON.stringify(m));
const okAlt = { template_key: 'y', report_source: 'cogs', config: { col_field: ['branch_name', 'branch'], value: { op: 'sum', field: 'total_sales' } } };
t('a fallback list passes when one name exists', !wf.check(okAlt, catalogFields).missing.length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
