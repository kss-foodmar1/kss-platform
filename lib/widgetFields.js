// Which FMH fields each widget reads, so they can be checked against what FMH
// really returns (Admin Console → FMH Diagnostics → "widget ใช้ฟิลด์ที่มีจริงไหม").
//
// A widget names fields in many shapes (metrics, group_by_field fallbacks,
// pivot keys, row filters…). Rather than a list per shape, the config is walked:
// every identifier-looking string is a field reference, except values under
// keys that hold text, ops or settings. A list of strings is one reference with
// alternatives (["branch_name", "branch"]: either is enough).
//
// Which pull a reference belongs to:
//   - one-source widget: that pull
//   - a property named after an alias (pivot.key.p) or an object with
//     `from: 'p'` / `from_any: [...]`: that alias's pull
//   - anything else on a multi-source widget: fields the widget makes itself
//     (pivot columns, derived) — checked against those, never against FMH
const { FMH_REPORTS, cacheKeyFor, pullsForWidget } = require('./fmhCache');

const TEXT_KEYS = new Set([
  'label', 'foot', 'caption', 'empty_message', 'description', 'name', 'text', 'title', 'note', 'hint', 'suffix', 'prefix',
  'color', 'palette', 'format', 'x_format', 'y_format', 'size', 'op', 'dir', 'sort', 'bucket', 'as', 'source', 'scale',
  'mark', 'unit', 'quadrant_labels', 'x_label', 'y_label', 'marker_label', 'row_label', 'bar_label', 'color_mode',
  'chart', 'type', 'agg', 'legend', 'bucket_toggle', 'default_tab', 'col_sort', 'lower_is_better', 'diverge_rel',
  'tabs_label', 'why', 'headline_label', 'unit_label', 'pattern', 'flags', 're', 'where_fallback_note',
]);
// identifier-like values that are settings, not fields
const NOT_FIELDS = new Set([
  'sum', 'count', 'avg', 'min', 'max', 'desc', 'asc', 'currency', 'pct', 'number', 'int', 'date', 'month', 'week', 'day',
  'wom', 'quarter', 'year', 'table', 'bar', 'line', 'half', 'third', 'full', 'two_thirds', 'text', 'first', 'last',
  'distinct', 'all', 'none', 'true', 'false', 'up', 'down', 'both', 'auto', 'key', 'diverging_row', 'diverging', 'seq',
]);
const IDENT = /^[a-z][a-z0-9_]*$/;

function aliasesOf(cfg) {
  return (cfg.sources || []).map((s) => s.as);
}

// Fields the widget computes itself.
function madeFields(cfg) {
  const made = new Set();
  (cfg.derived || []).forEach((d) => d && d.field && made.add(d.field));
  if (cfg.pivot) {
    made.add(cfg.pivot.key_field || 'key');
    (cfg.pivot.columns || []).forEach((c) => c.field && made.add(c.field));
    Object.keys(cfg.pivot.key || {}).forEach((a) => made.add(`${a}_rows`));
  }
  // a table column the renderer computes (share of a total)
  (cfg.columns || []).forEach((c) => c && c.share_of && made.add(c.field));
  return made;
}

// [{ ctx: null | [alias…], alts: [field…] }]
function references(cfg) {
  const aliases = new Set(aliasesOf(cfg));
  const refs = [];
  const walk = (v, key, ctx) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      if (v.length && v.every((x) => typeof x === 'string')) {
        if (key === 'from_any') return;
        const alts = v.filter((x) => IDENT.test(x) && !NOT_FIELDS.has(x));
        if (alts.length) refs.push({ ctx, alts });
        return;
      }
      v.forEach((x) => walk(x, key, ctx));
      return;
    }
    if (typeof v === 'object') {
      let here = ctx;
      if (typeof v.from === 'string' && aliases.has(v.from)) here = [v.from];
      if (Array.isArray(v.from_any)) here = v.from_any.filter((a) => aliases.has(a));
      Object.entries(v).forEach(([k, x]) => {
        if (TEXT_KEYS.has(k) || k === 'sources' || k === 'const') return;
        if (k === 'from' && typeof x === 'string' && aliases.has(x)) return;
        walk(x, k, aliases.has(k) ? [k] : here);
      });
      return;
    }
    if (typeof v === 'string' && IDENT.test(v) && !NOT_FIELDS.has(v)) refs.push({ ctx, alts: [v] });
  };
  walk(cfg, null, null);
  return refs;
}

// The pulls a widget reads: alias (or null) -> { source, grouping, key }.
function pullsOf(tpl) {
  const cfg = tpl.config || {};
  if ((cfg.sources || []).length) {
    return cfg.sources.map((s) => {
      const c = FMH_REPORTS[s.source];
      const g = c && s.group_by && c.groupings.includes(s.group_by) ? s.group_by : null;
      return { as: s.as, source: s.source, grouping: g, key: cacheKeyFor(s.source, g) };
    });
  }
  const own = FMH_REPORTS[tpl.report_source];
  // built here from other reports (alerts, CK audit): its rows are ours, not FMH's
  if (own && own.local) return [{ as: null, source: tpl.report_source, grouping: null, key: tpl.report_source }];
  const p = pullsForWidget(tpl.report_source, cfg)[0] || { source: tpl.report_source, grouping: null };
  return [{ as: null, source: p.source, grouping: p.grouping, key: cacheKeyFor(p.source, p.grouping) }];
}

// fieldsFor(pull) -> Set of field names, or null when unknown (no rows, not checked).
// Returns { checked, missing: [{ pull, alts }], unknown: [pull key…], local }.
function check(tpl, fieldsFor) {
  const cfg = tpl.config || {};
  const pulls = pullsOf(tpl);
  const byAlias = new Map(pulls.map((p) => [p.as, p]));
  const made = madeFields(cfg);
  const missing = [];
  const unknown = new Set();
  let local = false;
  const avail = (p) => {
    const r = FMH_REPORTS[p.source];
    if (!r || r.local) { local = true; return 'local'; }
    const f = fieldsFor(p);
    if (!f) unknown.add(p.key);
    return f;
  };
  references(cfg).forEach(({ ctx, alts }) => {
    if (alts.some((a) => made.has(a))) return;
    let targets;
    if (ctx) targets = ctx.map((a) => byAlias.get(a)).filter(Boolean);
    else if (pulls.length === 1) targets = pulls;
    else return; // on a multi-source widget, a field outside any alias must be made by the widget: checked by tests
    // the server grouping name itself ("menu", "branch") is a setting, not a field
    if (targets.some((p) => p.grouping && alts.includes(p.grouping)) && alts.length === 1) return;
    const sets = targets.map(avail);
    if (sets.includes('local') || sets.includes(null) || sets.includes(undefined)) return;
    if (!sets.some((s) => alts.some((a) => s.has(a)))) missing.push({ pull: targets.map((p) => p.key).join(' / '), alts });
  });
  return { missing, unknown: [...unknown], local };
}

module.exports = { references, pullsOf, check, madeFields };
