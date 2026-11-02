// KSS Platform — vanilla JS SPA, no build step.
//
//   app.js   — login, app shell, dashboard view, the generic widget renderers
//   admin.js — KSS Internal Admin Console + the shared user manager
//
// A dashboard is a list of widgets. Each widget = one report source + a
// chart_type (which renderer below draws it) + a config. The page fetches
// each report source once from the server-side cache and every widget that
// uses that source renders from the same rows.

// ---- Theme-aware colours: read from CSS tokens at draw time (style.css :root / [data-theme="dark"]) ----
const cssv = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
// Widget configs saved before the redesign carry the old brand hexes; map them to the new series tokens.
const LEGACY_COLOR = { '#BE4229': '--danger', '#2F6FB0': '--s1', '#A9812F': '--s2', '#2F8F4E': '--s3', '#7A6A9E': '--s4', '#C2410C': '--s7', '#1B2B22': '--ink', '#D6CFBC': '--s-other', '#B8B09A': '--s-other', '#8FB4DC': '--s6', '#C9A15A': '--s7' };
const themed = (c) => (typeof c === 'string' && LEGACY_COLOR[c.toUpperCase()] ? cssv(LEGACY_COLOR[c.toUpperCase()]) : c);
const themedCfg = (v) => {
  if (Array.isArray(v)) return v.map(themedCfg);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, themedCfg(x)]));
  return themed(v);
};
// Readable text colour for any background: dark ink on light fills, white on dark fills.
function onColor(bg) {
  let c = String(bg).trim(), r, g, b;
  const hx = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hx) { let h = hx[1]; if (h.length === 3) h = h.replace(/./g, (x) => x + x); [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); }
  else { const m = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(c); if (!m) return '#fff'; [r, g, b] = [m[1], m[2], m[3]].map(Number); }
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.32 ? '#101828' : '#fff';
}
const withAlpha = (c, a) => {
  const h = /^#([0-9a-f]{6})$/i.exec(String(c).trim());
  if (h) return `rgba(${parseInt(h[1].slice(0, 2), 16)}, ${parseInt(h[1].slice(2, 4), 16)}, ${parseInt(h[1].slice(4, 6), 16)}, ${a})`;
  const m = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(String(c));
  return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${a})` : c;
};
// Thai text, or the English one when the user's language is English (for text built in code).
const L = (th, en) => (window.I18N && window.I18N.lang === 'en' ? en : th);
const SKELETON = '<div class="skel" role="status" aria-label="กำลังโหลด"><span></span><span></span><span></span></div>';
const tokenList = (names) => new Proxy(names, { get: (t, k) => (/^\d+$/.test(String(k)) ? cssv(t[k]) : t[k]) });

const state = {
  user: null,
  viewCompanyId: null, // company whose dashboards are shown (KSS staff can switch)
  companies: [], // KSS staff only
  dashboards: [],
  activeDashboardId: null,
};

const el = (id) => document.getElementById(id);
const isSuper = () => state.user && state.user.role === 'kss_superadmin';
const isCompanyAdmin = () => state.user && state.user.role === 'company_admin';

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Trial or plan ended mid-session: only the plan page is left (selfserve.js).
    if (data.code === 'SUBSCRIPTION_LOCKED' && typeof showLockScreen === 'function') showLockScreen();
    const err = new Error(data.error || 'Request failed');
    err.code = data.code;
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Everything that ends up in innerHTML and came from data or user input goes
// through esc() — product names from FMH, company names, widget titles, etc.
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode etc. — non-essential */
  }
}

// ---------- number formatting ----------
const compactFmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
function fmtValue(v, format) {
  const n = Number(v) || 0;
  switch (format) {
    case 'currency': {
      // "−฿11,485", never "฿-11,485" or "฿-0"
      const r = Math.round(n);
      return (r < 0 ? '−฿' : '฿') + Math.abs(r).toLocaleString('th-TH');
    }
    case 'pct':
      return n.toFixed(1) + '%';
    case 'pct_signed':
      return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
    case 'decimal1':
      return n.toFixed(1);
    // stock quantities and unit costs, where 2.2 kg or ฿15.50 must not round away
    case 'qty':
      return n.toLocaleString('th-TH', { maximumFractionDigits: 2 });
    case 'currency2':
      return (n < 0 ? '−฿' : '฿') + Math.abs(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    default:
      return Math.round(n).toLocaleString('th-TH');
  }
}
function fmtAxis(v, format) {
  if (format === 'currency') return (v < 0 ? '−฿' : '฿') + compactFmt.format(Math.abs(v));
  if (format === 'pct' || format === 'pct_signed') return v + '%';
  return compactFmt.format(v);
}
function fmtDateTime(iso) {
  if (!iso) return null;
  return new Date(String(iso).replace(' ', 'T')).toLocaleString(I18N.locale(), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------- metric engine (see lib/widgetCatalog.js for the config language) ----------
function pick(row, field) {
  if (Array.isArray(field)) {
    for (const f of field) {
      const v = row[f];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }
  return row[field];
}
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
function evalMetric(m, rows) {
  if (!m) return 0;
  switch (m.op) {
    case 'sum':
      return rows.reduce((s, r) => s + num(pick(r, m.field)), 0);
    case 'count':
      return rows.length;
    // min/max/avg ignore rows where the field is missing, so one blank line
    // can't drag an average down or make a minimum read as zero.
    case 'min':
    case 'max':
    case 'avg': {
      const vals = rows
        .map((r) => pick(r, m.field))
        .filter((v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)))
        .map(Number);
      if (!vals.length) return 0;
      if (m.op === 'avg') return vals.reduce((a, b) => a + b, 0) / vals.length;
      return vals.reduce((a, b) => (m.op === 'min' ? Math.min(a, b) : Math.max(a, b)));
    }
    case 'count_distinct':
      return new Set(rows.map((r) => pick(r, m.field)).filter((v) => v !== undefined && v !== null && v !== '')).size;
    case 'div': {
      const b = evalMetric(m.b, rows);
      return b ? evalMetric(m.a, rows) / b : 0;
    }
    case 'ratio_pct': {
      const b = evalMetric(m.b, rows);
      return b ? (evalMetric(m.a, rows) / b) * 100 : 0;
    }
    case 'pct_change': {
      const from = evalMetric(m.from, rows);
      return from ? ((evalMetric(m.to, rows) - from) / from) * 100 : 0;
    }
    case 'diff':
      return evalMetric(m.a, rows) - evalMetric(m.b, rows);
    // A sum over only the rows a rule keeps: "GRN value of lines received but
    // not yet invoiced" is one segment of a stacked bar, not its own widget.
    case 'sum_where':
      return rows
        .filter((r) => rowMatches(m.where, r))
        .reduce((s, r) => s + (m.expr !== undefined ? num(evalRow(m.expr, r)) : num(pick(r, m.field))), 0);
    case 'count_where':
      return rows.filter((r) => rowMatches(m.where, r)).length;
    case 'count_distinct_where':
      return new Set(rows.filter((r) => rowMatches(m.where, r)).map((r) => pick(r, m.field)).filter((v) => !isBlank(v))).size;
    // The rest of a whole, never below zero: a stack's remainder segment.
    case 'floor0':
      return Math.max(0, evalMetric(m.a, rows));
    default:
      return 0;
  }
}
// ---------- the pivot ----------
// Up to here a widget reads one report. The numbers that only KSS can produce
// need two: CK sales sit in the COGS report, CK purchases in purchase
// analysis, and the margin that matters is the one between them. FMH will not
// compute that, because no single report spans both.
//
// So the dashboard does it, the way someone would in a spreadsheet: bucket
// each report by a shared key (a month, a product code), total the columns
// that matter inside each bucket, and line the buckets up side by side. The
// result is an ordinary row array, which means every renderer, the row layer
// and the CSV export all work on it unchanged.
//
// The join is an outer join on purpose: a month with purchases but no sales is
// exactly the kind of thing worth seeing, and an inner join would hide it.
function bucketOf(value, bucket) {
  const d = dateOnly(value);
  if (!d) return null;
  // The first of the month rather than "2026-09": still one bucket per month,
  // but a real date, so it sorts right and the line renderer can plot it.
  if (bucket === 'month') return d.slice(0, 7) + '-01';
  if (bucket === 'week') {
    const t = new Date(d + 'T00:00:00Z');
    const dow = (t.getUTCDay() + 6) % 7; // Monday = 0
    t.setUTCDate(t.getUTCDate() - dow);
    return t.toISOString().slice(0, 10);
  }
  return d;
}

// The join key for one row, as a string. `spec` is a field name, an array of
// fallback field names, or { field, bucket } for dates.
function keyOf(row, spec) {
  if (!spec) return null;
  // One bucket for everything: lines up single-row stat cards from different
  // reports (theoretical total next to actual total).
  if (spec.const !== undefined) return String(spec.const);
  // A composite key — invoice number AND product code — for reports that
  // only line up on the pair. Any blank part means the row has no key.
  if (spec.fields) {
    const parts = spec.fields.map((f) => pick(row, f));
    if (parts.some((v) => v === undefined || v === null || String(v).trim() === '')) return null;
    return parts.map((v) => String(v).trim()).join('|');
  }
  if (spec.bucket) {
    const v = bucketOf(pick(row, spec.field), spec.bucket);
    return v;
  }
  // The same outlet is written "Company - Outlet" in one FMH report and "Outlet" in
  // another: line them up on the outlet part, ignoring case and spacing.
  if (spec.short) {
    const v = pick(row, spec.field);
    return isBlank(v) ? null : partyShort(v).toLowerCase().replace(/\s+/g, ' ');
  }
  const v = pick(row, spec.field || spec);
  return v === undefined || v === null || v === '' ? null : String(v).trim();
}

function pivotRows(rowsByAlias, cfg) {
  const spec = cfg.pivot;
  if (!spec) return null;
  const aliases = Object.keys(spec.key);

  // One bucket per key value, per alias.
  const buckets = new Map(); // key -> { [alias]: rows[] }
  aliases.forEach((alias) => {
    (rowsByAlias[alias] || []).forEach((row) => {
      const k = keyOf(row, spec.key[alias]);
      if (k === null) return; // a row with no key cannot be lined up with anything
      if (!buckets.has(k)) buckets.set(k, {});
      (buckets.get(k)[alias] ||= []).push(row);
    });
  });

  const out = [...buckets.entries()].map(([key, byAlias]) => {
    const row = { [spec.key_field || 'key']: key };
    (spec.columns || []).forEach((c) => {
      const side = c.from_any ? c.from_any.flatMap((a) => byAlias[a] || []) : byAlias[c.from] || [];
      // `first` carries a label across (a product name next to its code);
      // everything else is an aggregate over that side's rows.
      if (c.first) {
        const hit = side.find((r) => !isBlank(pick(r, c.first)));
        row[c.field] = hit ? pick(hit, c.first) : '';
      } else if (c.latest || c.earliest) {
        // The value on the most recent (or oldest) row by a date field: the
        // first and last price paid in the window, the current supplier.
        const spec = c.latest || c.earliest;
        const dated = side
          .filter((r) => dateOnly(pick(r, spec.by)) && !isBlank(pick(r, spec.value)))
          .sort((x, y) => dateOnly(pick(x, spec.by)).localeCompare(dateOnly(pick(y, spec.by))));
        const hit = c.latest ? dated[dated.length - 1] : dated[0];
        row[c.field] = hit ? pick(hit, spec.value) : '';
      } else {
        row[c.field] = evalMetric(c.metric, side);
      }
    });
    // Keeping the per-side row counts makes a thin month obvious instead of
    // letting it read as a real number built from two lines of data.
    aliases.forEach((a) => { row[`${a}_rows`] = (byAlias[a] || []).length; });
    return row;
  });
  out.sort((a, b) => String(a[spec.key_field || 'key']).localeCompare(String(b[spec.key_field || 'key'])));
  return out;
}

// ---------- the row layer ----------
// evalMetric aggregates ACROSS rows. Itemized widgets need the other axis:
// arithmetic WITHIN a row, so a widget can say "invoice total minus GRN total"
// and then keep only the lines where that is not zero. Three-way match, short
// deliveries, lead times and the data-quality checks are all that same shape,
// so it is one small evaluator rather than a flag per widget.
//
// An expression is a number, a field name, {field}, {const}, or {op, a, b}.
function evalRow(expr, row) {
  if (expr === null || expr === undefined) return 0;
  if (typeof expr === 'number') return expr;
  if (typeof expr === 'string') return num(row[expr]);
  if (expr.const !== undefined) return expr.const;
  if (expr.text !== undefined && expr.op === undefined) return expr.text;
  if (expr.field !== undefined) return num(pick(row, expr.field));
  const a = () => evalRow(expr.a, row);
  const b = () => evalRow(expr.b, row);
  switch (expr.op) {
    case 'add': return a() + b();
    case 'sub': return a() - b();
    case 'mul': return a() * b();
    case 'div': { const d = b(); return d ? a() / d : 0; }
    case 'pct_of': { const d = b(); return d ? (a() / d) * 100 : 0; }
    // Text instead of a number when the gate field is zero: "not recorded" must not
    // read as 0%. `a` is the number shown otherwise.
    // `then` (a number) instead of `text` keeps such rows sortable.
    case 'if0': return evalRow(expr.gate, row) === 0 ? (expr.then !== undefined ? evalRow(expr.then, row) : expr.text) : a();
    // gate not zero -> then, else -> else (each a number or { text })
    case 'if': return evalRow(expr.gate, row) !== 0 ? evalRow(expr.then, row) : evalRow(expr.else, row);
    case 'gte': return a() >= b() ? 1 : 0;
    // 1 when the field matches a pattern (case-insensitive): "ครัวกลาง", "Central Kitchen"
    case 'match': return new RegExp(expr.re, 'i').test(String(pick(row, expr.from) ?? '')) ? 1 : 0;
    case 'abs': return Math.abs(a());
    case 'max0': return Math.max(0, a());
    // Wilson score lower bound of a rate k/n, as a percent. Ranks suppliers by
    // the rate we can be confident of, so 1 short line out of 2 does not
    // outrank 30 out of 200. z defaults to 1.96 (95%).
    case 'wilson_lb': {
      const k = a(), n = b(), z = expr.z || 1.96;
      if (!n) return 0;
      const p = k / n, z2 = z * z;
      const lb = (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
      return Math.max(0, lb) * 100;
    }
    // Text, for labels. A buyer in FMH reads "คุณป๊อป สาขา เซ็นจูรี่ - คุณป๊อป
    // สาขา เซ็นจูรี่": the outlet name is the part a chart has room for.
    case 'party_short': return partyShort(pick(row, expr.from));
    // Product names written in Thai and Burmese side by side: keep the
    // Thai/Latin part so a bar label fits.
    case 'clean_name': return cleanName(pick(row, expr.from));
    // "Fish sauce (BOTTLE)": one row per product AND unit, so prices in
    // different units never average together.
    case 'join': {
      const x = pick(row, expr.a), y = pick(row, expr.b);
      return isBlank(y) ? String(x ?? 'ไม่ระบุ') : `${x ?? 'ไม่ระบุ'} (${y})`;
    }
    // "1 จ" … "7 อา": sorts Monday first and reads as a weekday.
    case 'weekday': {
      const d = dateOnly(pick(row, expr.from));
      if (!d) return null;
      const w = (new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7;
      return `${w + 1} ${['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสฯ', 'ศุกร์', 'เสาร์', 'อาทิตย์'][w]}`;
    }
    // Whole days between two date fields, later minus earlier. Returns null
    // when either end is missing, so "not delivered yet" never reads as 0 days.
    case 'days': {
      const x = dateOnly(pick(row, expr.from)), y = dateOnly(pick(row, expr.to));
      if (!x || !y) return null;
      return Math.round((Date.parse(y) - Date.parse(x)) / 86400000);
    }
    default: return 0;
  }
}

function partyShort(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return 'ไม่ระบุ';
  const parts = s.split(' - ').map((x) => x.trim()).filter(Boolean);
  const withBranch = parts.find((x) => /สาขา/.test(x));
  if (withBranch) return withBranch.replace(/^.*?สาขา\s*/, '').trim() || withBranch;
  return parts[parts.length - 1];
}
function cleanName(v) {
  return String(v ?? '').replace(/[\u1000-\u109F\uAA60-\uAA7F\uA9E0-\uA9FF]+/g, ' ').replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim() || 'ไม่ระบุ';
}

function dateOnly(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

// A predicate over one row. Numeric comparisons run through evalRow, so either
// side can be a field, a constant or arithmetic.
function rowMatches(rule, row) {
  if (!rule) return true;
  switch (rule.op) {
    case 'and': return (rule.rules || []).every((r) => rowMatches(r, row));
    case 'or': return (rule.rules || []).some((r) => rowMatches(r, row));
    case 'not': return !rowMatches(rule.rule, row);
    case 'blank': return isBlank(pick(row, rule.field));
    case 'in': return (rule.values || []).includes(String(pick(row, rule.field) ?? 'ไม่ระบุ'));
    case 'present': return !isBlank(pick(row, rule.field));
    // Values that should agree but don't. The tolerance is what keeps rounding
    // noise out of an exception list nobody would then trust.
    case 'differs': return Math.abs(evalRow(rule.a, row) - evalRow(rule.b, row)) > (rule.tolerance ?? 0.01);
    case 'gt': return evalRow(rule.a, row) > evalRow(rule.b, row);
    case 'gte': return evalRow(rule.a, row) >= evalRow(rule.b, row);
    case 'lt': return evalRow(rule.a, row) < evalRow(rule.b, row);
    case 'lte': return evalRow(rule.a, row) <= evalRow(rule.b, row);
    // flags: 'i' for a name in any case ("Central Kitchen")
    case 'matches': return new RegExp(rule.pattern, rule.flags || '').test(String(pick(row, rule.field) ?? ''));
    // The last N days counting today (1 = today only), in the viewer's calendar.
    case 'within_days': {
      const d = dateOnly(pick(row, rule.field));
      return !!d && d >= daysAgoIso((rule.days || 1) - 1) && d <= todayIso();
    }
    default: return true;
  }
}

// Adds the widget's derived columns, then keeps the rows its filter selects.
// Returns a new array; the cached rows other widgets read stay untouched.
function applyRowLayer(rows, cfg) {
  if (!rows) return [];
  const derived = cfg.derived || [];
  let out = derived.length
    ? rows.map((r) => {
        const copy = { ...r };
        // in order, so a derived field can use the ones before it
        derived.forEach((d) => { copy[d.field] = evalRow(d.expr, copy); });
        return copy;
      })
    : rows;
  if (cfg.row_filter) out = out.filter((r) => rowMatches(cfg.row_filter, r));
  return out;
}

// A widget's "group_by" is the grouping FMH applied server-side when it is a
// string ('supplier', 'menu'); the fields the renderer groups rows by are
// `group_by_field`. Where no server-side grouping is used, `group_by` is itself
// that field list, which is how every widget written before grouping existed
// still reads correctly.
function rowFields(cfg) {
  if (cfg.group_by_field) return cfg.group_by_field;
  return Array.isArray(cfg.group_by) ? cfg.group_by : null;
}

function groupRows(rows, groupBy) {
  const groups = new Map();
  rows.forEach((r) => {
    const k = pick(r, groupBy) ?? 'ไม่ระบุ';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });
  return groups;
}

// ---------- screens / auth ----------
function showScreen(name) {
  el('lock-screen').classList.toggle('hidden', name !== 'lock');
  el('login-screen').classList.toggle('hidden', name !== 'login');
  el('force-change-screen').classList.toggle('hidden', name !== 'force-change');
  el('app-shell').classList.toggle('hidden', name !== 'app');
}

// Light / dark: follows the system until the user picks; the pick is remembered on this device.
(function themeToggle() {
  const root = document.documentElement;
  const effective = () => root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const sync = () => {
    const b = document.getElementById('theme-btn');
    if (b) b.setAttribute('aria-pressed', effective() === 'dark' ? 'true' : 'false');
  };
  const redraw = () => {
    sync();
    const v = state.currentView;
    if (v && v.wrap && v.wrap.isConnected && typeof v.renderWidgets === 'function') v.renderWidgets();
  };
  document.getElementById('theme-btn').addEventListener('click', () => {
    const next = effective() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('kss_theme', next); } catch (e) { /* private window */ }
    redraw();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!root.getAttribute('data-theme')) redraw(); });
  sync();
})();

// One button: shows the language you would switch TO.
document.querySelectorAll('.lang-toggle').forEach((b) => {
  b.textContent = I18N.lang === 'en' ? 'ไทย' : 'EN';
  b.title = I18N.lang === 'en' ? 'เปลี่ยนเป็นภาษาไทย' : 'Switch to English';
  b.addEventListener('click', async () => {
    const next = I18N.lang === 'en' ? 'th' : 'en';
    if (state.user) {
      try {
        await api('/api/auth/language', { method: 'PUT', body: JSON.stringify({ language: next }) });
      } catch (e) {
        /* still switch locally */
      }
    }
    I18N.adopt(next);
  });
});

async function boot() {
  try {
    const { user } = await api('/api/auth/me');
    I18N.adopt(user.language);
    state.user = user;
    if (user.must_change_password) showScreen('force-change');
    else await enterApp();
  } catch {
    // Only if nobody has logged in meanwhile — this check can resolve late
    // (slow network) after a login already succeeded.
    if (!state.user) showScreen('login');
  }
}

el('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  el('login-error').classList.add('hidden');
  try {
    const { user } = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: el('login-email').value.trim(), password: el('login-password').value }),
    });
    // The account's saved language wins over what the login page was showing.
    if ((user.language || 'th') !== I18N.lang) return I18N.adopt(user.language);
    state.user = user;
    if (user.must_change_password) showScreen('force-change');
    else await enterApp();
  } catch (err) {
    el('login-error').textContent = err.message;
    el('login-error').classList.remove('hidden');
  }
});

el('force-change-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  el('force-change-error').classList.add('hidden');
  try {
    await api('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ new_password: el('force-new-password').value }),
    });
    const { user } = await api('/api/auth/me');
    state.user = user;
    await enterApp();
  } catch (err) {
    el('force-change-error').textContent = err.message;
    el('force-change-error').classList.remove('hidden');
  }
});

el('logout-btn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  location.reload();
});

// ---------- app shell ----------
async function enterApp() {
  if (state.user.subscription && state.user.subscription.state === 'locked') return showLockScreen();
  el('user-display-name').textContent = state.user.display_name;
  renderSubBanner();
  // KSS staff keep the Admin Console button; a company admin's settings live
  // in the left menu (renderSideNav), so the topbar shortcuts go.
  el('open-admin-btn').classList.toggle('hidden', !isSuper() && !isCompanyAdmin());
  el('open-admin-btn').innerHTML = adminBtnLabel();
  el('open-manage-users-btn').classList.add('hidden');
  el('open-settings-btn').classList.add('hidden');
  el('company-picker-wrap').classList.toggle('hidden', !isSuper());
  el('company-name').classList.add('hidden');
  el('company-name').textContent = (state.user.company_name || '') + (state.user.company_code ? ` · ${state.user.company_code}` : '');
  showScreen('app');
  loadNotifications();

  if (isSuper()) {
    await loadCompanyPicker();
  } else {
    state.viewCompanyId = state.user.company_id;
  }
  await loadDashboards();
}

async function loadCompanyPicker(preferredId) {
  const { companies } = await api('/api/admin/companies');
  state.companies = companies;
  const saved = Number(preferredId || storageGet('kss_view_company'));
  const initial = companies.find((c) => c.id === saved) || companies[0];
  state.viewCompanyId = initial ? initial.id : null;
  const picker = el('company-picker');
  picker.innerHTML = companies
    .map((c) => `<option value="${c.id}">${esc(c.name)}${c.status === 'demo' ? ' · DEMO' : c.status === 'suspended' ? ' · ระงับ' : ''}</option>`)
    .join('');
  if (state.viewCompanyId) picker.value = String(state.viewCompanyId);
}

el('company-picker').addEventListener('change', (e) => {
  state.viewCompanyId = Number(e.target.value);
  storageSet('kss_view_company', String(state.viewCompanyId));
  showDashboardView();
  loadDashboards();
});

// Used by the Admin Console's "view this company's dashboards" shortcut.
async function viewCompanyDashboards(companyId, dashboardId) {
  storageSet('kss_view_company', String(companyId));
  if (isSuper()) await loadCompanyPicker(companyId);
  showDashboardView();
  await loadDashboards(dashboardId);
}

function showDashboardView() {
  el('dashboard-view').classList.remove('hidden');
  el('admin-view').classList.add('hidden');
  el('library-view').classList.add('hidden');
  el('app-shell').classList.remove('admin-mode', 'with-side');
  el('open-admin-btn').innerHTML = adminBtnLabel();
}

// From anywhere (library, settings, picker) to one dashboard.
function goDashboard(id) {
  if (!el('admin-view').classList.contains('hidden')) {
    if (typeof leavePicker === 'function' && !leavePicker()) return;
    if (typeof pickerDirty !== 'undefined') pickerDirty = false;
  }
  closeSideNav();
  showDashboardView();
  selectDashboard(id);
}

// The dashboard list changed (new one, pack) without leaving the page.
async function refreshDashboardList() {
  const qs = isSuper() ? `?company_id=${state.viewCompanyId}` : '';
  state.dashboards = (await api(`/api/dashboards${qs}`)).dashboards;
  renderSideNav();
}

// ---------- left menu ----------
// Dashboards are listed like pages in Notion; below them the Widget library
// and (company admins) the settings pages, one item each instead of one long
// page. On a phone it is a drawer behind the ☰ button.
const NAV_ICON = {
  dash: '<path d="M4 5h16M4 12h10M4 19h7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  library: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  layout: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M10 10v10"/>',
  data: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21h4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.6.8 2.7 2.5 3 5.2"/>',
  plan: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/>',
  building: '<path d="M4 21V5l8-2v18M12 9l8 2v10M8 8v1M8 12v1M8 16v1M16 13v1M16 17v1M2 21h20"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  home: '<path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10"/>',
  inbox: '<path d="M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  megaphone: '<path d="M3 10v4l11 4V6zM14 8c3 0 5 1.5 5 4s-2 4-5 4M6 14l1 5h3l-1-4"/>',
  pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1.9-1.1 1.8M12 17h.01"/>',
};
const navIcon = (k) => `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${NAV_ICON[k]}</svg>`;

function renderSideNav() {
  const nav = el('side-nav');
  if (!nav || !state.user) return;
  const cur = state.navCurrent || {};
  const sub = state.user.subscription;
  const link = (attrs, icon, label, on) =>
    `<button type="button" class="side-link${on ? ' on' : ''}" ${attrs}${on ? ' aria-current="page"' : ''}>${icon ? navIcon(icon) : ''}<span class="side-label">${esc(label)}</span></button>`;
  const settings = [
    ['status', 'pulse', 'สถานะระบบ'],
    ['dashboards', 'layout', 'จัดการ Dashboard'],
    ['data', 'data', 'การเชื่อมข้อมูล'],
    ['alerts', 'bell', 'ตัวเตือน & LINE'],
    ['users', 'users', 'ผู้ใช้'],
    ...(sub && sub.self_serve ? [['plan', 'plan', 'แพ็กเกจและการชำระเงิน']] : []),
  ];
  const coName = state.user.company_name || '';
  nav.innerHTML = `
    ${coName ? `<div class="side-company"><span class="side-co-mark" aria-hidden="true">${esc(coName.trim().charAt(0) || 'K')}</span><span class="side-co-text"><b>${esc(coName)}</b>${state.user.company_code ? `<span>${esc(state.user.company_code)}</span>` : ''}</span></div>` : ''}
    <div class="side-group">${link('data-go="back"', 'back', 'กลับไปดู Dashboard', false)}</div>
    <div class="side-group"><div class="side-title">ตั้งค่า</div>${settings.map(([k, ic, label]) => link(`data-settings="${k}"`, ic, label, cur.kind === 'settings' && cur.tab === k)).join('')}</div>
    <div class="side-group">${link('data-go="library"', 'library', 'คลัง Widget', cur.kind === 'library')}${link('data-go="support"', 'help', 'แจ้งทีมงาน', false)}${link('data-go="wish"', 'library', 'ขอข้อมูลเพิ่ม / ความเห็น', false)}</div>`;
  nav.querySelector('[data-go="back"]').addEventListener('click', () => goDashboard(state.activeDashboardId || (state.dashboards[0] || {}).id));
  nav.querySelector('[data-go="library"]').addEventListener('click', () => openLibrary());
  nav.querySelector('[data-go="support"]').addEventListener('click', () => openSupportForm());
  nav.querySelector('[data-go="wish"]').addEventListener('click', () => openSupportForm({ kind: 'wish' }));
  nav.querySelectorAll('[data-settings]').forEach((b) => b.addEventListener('click', () => openCompanySettings(b.dataset.settings)));
}

// ---------- dashboard switcher (title ▾), HubSpot-style ----------
// Favorites and recently viewed are per user, per browser: conveniences, not data.
const dashPrefs = {
  key: (k) => `kss_${k}_${state.user ? state.user.id : 0}_${state.viewCompanyId || 0}`,
  get(k) { try { return JSON.parse(storageGet(this.key(k)) || '[]'); } catch (e) { return []; } },
  set(k, v) { storageSet(this.key(k), JSON.stringify(v)); },
  touch(id) { this.set('recent', [id, ...this.get('recent').filter((x) => x !== id)].slice(0, 10)); },
  toggleFav(id) { const f = this.get('fav'); this.set('fav', f.includes(id) ? f.filter((x) => x !== id) : [...f, id]); },
};

function bindDashSwitcher(wrap, current) {
  const btn = wrap.querySelector('.dash-switch');
  const pop = wrap.querySelector('.dash-pop');
  if (!btn || !pop) return;
  const admin = isSuper() || isCompanyAdmin();
  let tab = 'all';
  let q = '';
  const star = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill="currentColor"/></svg>';
  const list = () => {
    const fav = dashPrefs.get('fav');
    const recent = dashPrefs.get('recent');
    let ds = state.dashboards.slice();
    if (tab === 'recent') ds = recent.map((id) => ds.find((d) => d.id === id)).filter(Boolean);
    else if (tab === 'fav') ds = ds.filter((d) => fav.includes(d.id));
    else ds.sort((a, b) => (fav.includes(b.id) ? 1 : 0) - (fav.includes(a.id) ? 1 : 0));
    const needle = q.trim().toLowerCase();
    if (needle) ds = ds.filter((d) => `${d.display_name} ${d.description || ''}`.toLowerCase().includes(needle));
    return { ds, fav };
  };
  const draw = () => {
    const { ds, fav } = list();
    pop.querySelector('.dash-pop-list').innerHTML = ds.length
      ? ds
          .map(
            (d) => `<li class="dash-pop-row${d.id === current ? ' on' : ''}">
              <button type="button" class="dash-pop-star${fav.includes(d.id) ? ' faved' : ''}" data-fav="${d.id}" aria-pressed="${fav.includes(d.id)}" aria-label="${fav.includes(d.id) ? 'เอาออกจากรายการโปรด' : 'เพิ่มในรายการโปรด'}">${star}</button>
              <button type="button" class="dash-pop-go" data-go="${d.id}"${d.id === current ? ' aria-current="page"' : ''}><span>${esc(d.display_name)}</span>${d.description ? `<small>${esc(d.description)}</small>` : ''}</button>
            </li>`
          )
          .join('')
      : `<li class="dash-pop-empty">${tab === 'fav' ? 'ยังไม่มีรายการโปรด กดดาวหน้า dashboard เพื่อเพิ่ม' : tab === 'recent' ? 'ยังไม่ได้เปิด dashboard ไหน' : 'ไม่พบ dashboard'}</li>`;
    pop.querySelectorAll('.dash-pop-tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === tab));
    pop.querySelectorAll('[data-fav]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); dashPrefs.toggleFav(Number(b.dataset.fav)); draw(); }));
    pop.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { close(); goDashboard(Number(b.dataset.go)); }));
  };
  pop.innerHTML = `
    <div class="dash-pop-tabs" role="tablist">
      <button type="button" class="dash-pop-tab on" data-tab="all" role="tab">ทั้งหมด</button>
      <button type="button" class="dash-pop-tab" data-tab="recent" role="tab">ดูล่าสุด</button>
      <button type="button" class="dash-pop-tab" data-tab="fav" role="tab">รายการโปรด</button>
    </div>
    <label class="dash-pop-search"><span class="sr-only">ค้นหา dashboard</span><input type="search" placeholder="ค้นหา dashboard"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg></label>
    <ul class="dash-pop-list"></ul>
    ${
      admin
        ? `<div class="dash-pop-foot">
             <form class="dash-pop-new" hidden><input name="name" maxlength="120" required placeholder="ชื่อ Dashboard ใหม่" aria-label="ชื่อ Dashboard ใหม่"><button type="submit" class="btn small primary">สร้าง</button></form>
             <div class="dash-pop-actions"><button type="button" class="link-btn dash-pop-add">+ Dashboard ใหม่</button><button type="button" class="link-btn dash-pop-manage">จัดการ Dashboard</button></div>
           </div>`
        : ''
    }`;
  const open = () => {
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    draw();
    pop.querySelector('input[type="search"]').focus();
    setTimeout(() => document.addEventListener('click', outside), 0);
  };
  const close = () => {
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', outside);
  };
  const outside = (e) => { if (!wrap.contains(e.target)) close(); };
  btn.addEventListener('click', () => (pop.hidden ? open() : close()));
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { close(); btn.focus(); } });
  pop.querySelectorAll('.dash-pop-tab').forEach((t) => t.addEventListener('click', () => { tab = t.dataset.tab; draw(); }));
  const search = pop.querySelector('input[type="search"]');
  search.addEventListener('input', () => { q = search.value; draw(); });
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = pop.querySelector('[data-go]');
    if (first) first.click();
  });
  if (admin) {
    const form = pop.querySelector('.dash-pop-new');
    pop.querySelector('.dash-pop-add').addEventListener('click', () => { form.hidden = !form.hidden; if (!form.hidden) form.name.focus(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api(`/api/admin/companies/${state.viewCompanyId}/dashboards`, { method: 'POST', body: JSON.stringify({ display_name: form.name.value }) });
        close();
        await refreshDashboardList();
        goDashboard(r.id);
      } catch (err) {
        form.insertAdjacentHTML('beforeend', `<div class="error-msg">${esc(err.message)}</div>`);
      }
    });
    pop.querySelector('.dash-pop-manage').addEventListener('click', () => {
      close();
      if (isSuper()) { adminState.selected = { type: 'company', id: state.viewCompanyId }; openAdminConsole(); }
      else openCompanySettings('dashboards');
    });
  }
}

function openSideNav() {
  el('app-shell').classList.add('side-open');
  el('side-scrim').hidden = false;
  el('side-toggle').setAttribute('aria-expanded', 'true');
}
function closeSideNav() {
  if (!el('app-shell').classList.contains('side-open')) return;
  el('app-shell').classList.remove('side-open');
  el('side-scrim').hidden = true;
  el('side-toggle').setAttribute('aria-expanded', 'false');
}
el('side-toggle').addEventListener('click', () => (el('app-shell').classList.contains('side-open') ? closeSideNav() : openSideNav()));
el('side-scrim').addEventListener('click', closeSideNav);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSideNav(); });

// KSS staff get the whole Admin Console; a client's company admin gets the
// same composer and widget picker, for their own company only.
const ICON = {
  gear: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  building: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1M10 21v-3h4v3"/></svg>',
};
function adminBtnLabel() {
  return isSuper() ? `${ICON.building}<span>Admin Console</span>` : `${ICON.gear}<span>ตั้งค่า</span>`;
}

async function loadDashboards(preferredDashboardId) {
  const wrap = el('tab-panel-wrap');
  if (!state.viewCompanyId) {
    state.dashboards = [];
    renderTabs();
    wrap.innerHTML = `<p class="muted">${isSuper() ? 'ยังไม่มีบริษัทในระบบ — เพิ่มได้ใน Admin Console' : 'บัญชีนี้ยังไม่ได้ผูกกับบริษัท'}</p>`;
    return;
  }
  const qs = isSuper() ? `?company_id=${state.viewCompanyId}` : '';
  const { dashboards } = await api(`/api/dashboards${qs}`);
  state.dashboards = dashboards;
  renderTabs();
  const target = dashboards.find((d) => d.id === preferredDashboardId) || dashboards[0];
  if (target) selectDashboard(target.id);
  else {
    destroyCharts();
    if (isCompanyAdmin()) renderFirstRun(wrap, state.viewCompanyId);
    else if (isSuper()) wrap.innerHTML = '<p class="muted">บริษัทนี้ยังไม่มี dashboard — สร้างได้ใน Admin Console</p>';
    else renderNoAccess(wrap);
  }
}

// A member whose company admin has not shared a dashboard yet: say what
// happened and who can fix it, instead of a blank page.
function renderNoAccess(wrap) {
  wrap.innerHTML = `<div class="dash-empty firstrun-noaccess">
    <h2 class="starter-h">ยังไม่มี dashboard ให้คุณดู</h2>
    <p class="muted starter-lead">บัญชีของคุณเข้าระบบได้แล้ว แต่ผู้ดูแลบริษัทยังไม่ได้เปิดสิทธิ์ dashboard ให้ ขอให้ผู้ดูแลบริษัทเปิดให้ หรือกดแจ้งทีมงานด้านล่าง ระบบจะแนบข้อมูลบัญชีให้เอง</p>
    <div class="starter-actions"><button type="button" class="btn primary" id="noaccess-report">แจ้งทีมงาน</button></div>
  </div>`;
  wrap.querySelector('#noaccess-report').addEventListener('click', () =>
    openSupportForm({ kind: 'other', message: 'ล็อกอินแล้วยังไม่เห็น dashboard — ขอให้เปิดสิทธิ์ให้' }));
}

// "Ready for real data?" — asks first, says what stays and what is cleared,
// and when nothing real is connected yet explains how to connect it.
// 'ดึงข้อมูลใหม่' spends FMH rows from a monthly quota. Under this many estimated rows it just runs.
const REFRESH_WARN_ROWS = 100;
function refreshNearQuota(est) {
  const q = est.quota;
  return !!(q && q.limit && (q.remaining - est.total) / q.limit < 0.2);
}
function showRefreshConfirm(bar, est, go) {
  bar.querySelectorAll('.refresh-confirm').forEach((n) => n.remove());
  const nf = (n) => Number(n).toLocaleString('th-TH');
  const q = est.quota;
  const left = q ? q.remaining - est.total : null;
  const over = q && left < 0;
  const biggest = est.items.filter((i) => !i.wait_min && i.est_rows).sort((a, b) => b.est_rows - a.est_rows).slice(0, 3);
  const box = document.createElement('div');
  box.className = 'refresh-confirm' + (over ? ' refresh-confirm-over' : '');
  box.setAttribute('role', 'alert');
  box.innerHTML = `
    <div class="rc-head"></div>
    ${biggest.length ? '<ul class="rc-list"></ul>' : ''}
    ${q ? '<div class="rc-quota"></div>' : ''}
    ${est.unknown ? '<div class="rc-unknown"></div>' : ''}
    <div class="rc-actions"><button type="button" class="btn small primary rc-go"></button><button type="button" class="btn small ghost rc-cancel">ยกเลิก</button></div>`;
  box.querySelector('.rc-head').textContent = est.total ? `จะดึงข้อมูลใหม่ประมาณ ${nf(est.total)} แถว` : 'จะดึงข้อมูลใหม่';
  const ul = box.querySelector('.rc-list');
  if (ul) biggest.forEach((i) => { const li = document.createElement('li'); li.textContent = `${i.label}: ประมาณ ${nf(i.est_rows)} แถว`; ul.appendChild(li); });
  if (q) box.querySelector('.rc-quota').textContent = over
    ? `โควตา FMH เดือนนี้เหลือ ${nf(q.remaining)} แถว น้อยกว่าที่ต้องใช้ ข้อมูลบางรายงานอาจดึงไม่ครบ`
    : `โควตา FMH เดือนนี้เหลือ ${nf(q.remaining)} แถว จะเหลือประมาณ ${nf(left)} หลังดึง`;
  if (est.unknown) box.querySelector('.rc-unknown').textContent = `มี ${est.unknown} รายงานที่ยังไม่เคยดึง จึงบอกจำนวนแถวไม่ได้`;
  box.querySelector('.rc-go').textContent = 'ดึงเลย';
  box.querySelector('.rc-cancel').addEventListener('click', () => box.remove());
  box.querySelector('.rc-go').addEventListener('click', () => { box.remove(); go(); });
  bar.appendChild(box);
  box.querySelector('.rc-go').focus();
}

function showRealConfirm(bar, dashboardId, force = false) {
  bar.querySelector('.real-confirm')?.remove();
  const box = document.createElement('div');
  box.className = 'real-confirm';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'สลับเป็นข้อมูลจริง');
  bar.appendChild(box);
  const close = () => { box.remove(); bar.querySelector('.use-real-btn')?.focus(); };
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  const show = (html, wire) => { box.innerHTML = html; (wire || (() => {}))(); const f = box.querySelector('button'); if (f) f.focus(); };
  const ask = () => show(`
    <b>สลับเป็นข้อมูลจริง?</b>
    <ul>
      <li>dashboard, widget และการจัดวางที่คุณทำไว้ <b>อยู่ครบ</b> (widget ที่ใช้ข้อมูล FMH จะแสดงตัวเลขเมื่อดึงเสร็จ)</li>
      <li>ตัวเลขตัวอย่างจะหายไป รวมถึงรายการ "เช้านี้ต้องทำ" ของตัวอย่าง (ไม่กระทบข้อมูลจริงของร้าน) รายการเตือนจริงจะขึ้นตามข้อมูลที่ดึงมา</li>
      <li>ตัวเลขจริงใช้เวลาดึงสักครู่ (ปกติไม่กี่นาที) และเดือนปัจจุบันยังไม่จบ ตัวเลขต้นทุนช่วงแรกอาจยังไม่ครบ</li>
      <li>สลับแล้วกลับไปใช้ข้อมูลตัวอย่างเองไม่ได้ (ทีม KSS ช่วยเปลี่ยนกลับได้)</li>
    </ul>
    <div class="real-actions"><button type="button" class="btn small primary real-yes">ยืนยันสลับ</button><button type="button" class="btn small ghost real-no">ยังก่อน</button></div>
    <div class="real-msg" role="status"></div>`, () => {
      box.querySelector('.real-no').addEventListener('click', close);
      box.querySelector('.real-yes').addEventListener('click', go);
    });
  const noData = () => show(`
    <b>ยังไม่ได้เชื่อมข้อมูลจริง</b>
    <p class="muted">ต้องมีอย่างใดอย่างหนึ่งก่อน: <b>FMH API Key</b> (รหัสเชื่อมระบบจัดซื้อ FMH ของร้านคุณ ขอได้จากทีม KSS หรือผู้ดูแล FMH) หรือ <b>ไฟล์ยอดขาย POS</b> ไม่แน่ใจว่ามีไหม ให้ทีม KSS ช่วยตั้งให้ได้เลย ระหว่างนี้จัดเรียง dashboard ต่อได้</p>
    <div class="real-actions"><button type="button" class="btn small primary real-help">ให้ทีม KSS ช่วยตั้งให้</button><button type="button" class="btn small ghost real-connect">ใส่ key / อัปโหลดไฟล์เอง</button><button type="button" class="btn small ghost real-no">ปิด</button></div>`, () => {
      box.querySelector('.real-connect').addEventListener('click', () => openCompanySettings('data'));
      box.querySelector('.real-help').addEventListener('click', () => openSupportForm({ kind: 'connect', message: 'อยากเริ่มใช้ข้อมูลจริง ขอให้ช่วยเชื่อม FMH key หรือไฟล์ POS' }));
      box.querySelector('.real-no').addEventListener('click', close);
    });
  const posOnly = (msg) => show(`
    <b>มีเฉพาะไฟล์ยอดขาย POS</b>
    <p class="muted">${esc(msg)}</p>
    <div class="real-actions"><button type="button" class="btn small primary real-connect">ใส่ FMH key ก่อน</button><button type="button" class="btn small ghost real-force">สลับเลย (ส่วน FMH ว่างก่อน)</button><button type="button" class="btn small ghost real-no">ยังก่อน</button></div>`, () => {
      box.querySelector('.real-connect').addEventListener('click', () => openCompanySettings('data'));
      box.querySelector('.real-force').addEventListener('click', () => go(true));
      box.querySelector('.real-no').addEventListener('click', close);
    });
  async function go(forceNow) {
    const yes = box.querySelector('.real-yes') || box.querySelector('.real-force');
    box.querySelectorAll('button').forEach((b) => (b.disabled = true));
    if (yes) yes.textContent = 'กำลังสลับ...';
    try {
      await api('/api/settings/use-real-data', { method: 'POST', body: JSON.stringify({ force: forceNow === true }) });
      state.realNoteUntil = Date.now() + 15 * 60 * 1000;
      await loadDashboards(dashboardId);
    } catch (err) {
      if (err.code === 'NO_DATA') return noData();
      if (err.code === 'POS_ONLY') return posOnly(err.message);
      ask();
      box.querySelector('.real-msg').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    }
  }
  ask();
}

// First login of a company admin with no dashboard: a guided start in place of
// a blank page. Three short questions (the shape of the business, who is
// looking, what they want to find out) pick and rank the starter packs, so the
// first dashboard already answers their question. One click then makes it.
// If no data is connected yet, the first step is connecting it.
async function renderFirstRun(wrap, cid) {
  wrap.innerHTML = '<div class="dash-empty starter firstrun"><p class="muted">กำลังเตรียมหน้าเริ่มต้น...</p></div>';
  const box = wrap.firstElementChild;
  let options;
  let choices;
  let sample = false;
  try {
    // Nothing connected yet: start on sample data so the first look has numbers.
    ({ sample } = await api('/api/settings/start-sample', { method: 'POST', body: JSON.stringify({}) }));
    ({ options, choices } = await api(`/api/admin/companies/${cid}/starter-options`));
  } catch (err) {
    box.innerHTML = `<div class="error-msg">${esc(err.message)}<div><button type="button" class="btn ghost fr-retry">ลองอีกครั้ง</button></div></div>`;
    box.querySelector('.fr-retry').addEventListener('click', () => renderFirstRun(wrap, cid));
    return;
  }
  const name = (state.user && state.user.company_name) || '';
  const anyReady = options.some((o) => o.ready.length);
  const ans = { setup: null, role: null, goals: [] };
  const wizard = ['setup', 'role', 'goals'];

  const head = (kicker, title) => `<p class="starter-role">${esc(kicker)}</p><h2 class="starter-h" tabindex="-1">${title}</h2>`;
  const sampleNote = sample
    ? '<p class="muted starter-lead">ช่วงแรกคุณจะได้ลองกับข้อมูลตัวอย่าง ยังไม่ต้องเชื่อมอะไร ลองดู widget ต่างๆ และจัด dashboard ให้ถูกใจ พอพร้อมใช้ข้อมูลจริง กดปุ่ม “พร้อมใช้ข้อมูลจริงแล้ว” ที่แถบด้านบน dashboard และการจัดวางที่ทำไว้จะอยู่ครบ</p>'
    : '';

  // No data to show anything with: connect first, questions come after.
  if (!anyReady) {
    box.innerHTML = `${head('เริ่มต้นใช้งาน', `ยินดีต้อนรับ${name ? ` ${esc(name)}` : ''}`)}
      <div class="fr-connect"><b>ยังไม่มีข้อมูลให้แสดง</b><span class="muted">ใส่ FMH API Key หรืออัปโหลดไฟล์ POS ก่อน แล้ว dashboard จะมีตัวเลขจริงตั้งแต่เปิดครั้งแรก</span><button type="button" class="btn primary fr-data">เชื่อมข้อมูลตอนนี้</button></div>
      <div class="starter-actions fr-actions"><button type="button" class="btn ghost fr-empty">เริ่มจาก dashboard ว่าง</button></div>
      <div class="starter-msg" role="status"></div>`;
    box.querySelector('.fr-data').addEventListener('click', () => openCompanySettings('data'));
    const e0 = box.querySelector('.fr-empty');
    e0.addEventListener('click', () => create(e0, { empty: true }, 'เริ่มจาก dashboard ว่าง'));
    return;
  }

  async function create(btn, body, idle) {
    box.querySelectorAll('button').forEach((b) => (b.disabled = true));
    btn.textContent = body.empty ? 'กำลังสร้าง...' : 'กำลังเตรียมตัวเลขของร้านคุณ...';
    try {
      const r = await api(`/api/admin/companies/${cid}/first-dashboard`, { method: 'POST', body: JSON.stringify({ ...body, profile: ans }) });
      // The dashboard opens with a "ready" strip naming what it was built from (DashboardView.renderInsights).
      if (!body.empty) {
        const chosen = (window.__frList || []).find((o) => o.key === body.key);
        const said = [ans.setup && choices.setups[ans.setup], ans.role && choices.roles[ans.role], ...ans.goals.map((g) => choices.goals[g])].filter(Boolean);
        try { sessionStorage.setItem(`kss_welcome_${r.id}`, JSON.stringify({ title: chosen ? chosen.title : '', said })); } catch (e) { /* private window */ }
      }
      await loadDashboards(r.id);
    } catch (err) {
      box.querySelectorAll('button').forEach((b) => (b.disabled = false));
      btn.textContent = idle;
      box.querySelector('.starter-msg').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    }
  }

  // Which choices make sense for the answers so far.
  const info = () => (choices.setupInfo || {})[ans.setup] || { branches: true, ck: true };
  const rolesFor = () => Object.keys(choices.roles).filter((r) =>
    (r !== 'ck' || info().ck) && (r !== 'branch' || info().branches));
  const goalsFor = () => Object.keys(choices.goals).filter((g) => g !== 'branch' || info().branches);
  const hints = {
    single: 'มีหน้าร้านเดียว ซื้อวัตถุดิบเข้ามาขายเอง',
    multi: 'หลายสาขา แต่แต่ละสาขาซื้อเองหรือไม่มีครัวกลางผลิตให้',
    ck: 'ครัวกลางหรือศูนย์กระจายวัตถุดิบผลิตหรือจัดของส่งให้สาขา',
    hotel: 'หลายห้องอาหารหรือเอาท์เล็ต ใช้ครัวใหญ่หรือฝ่ายจัดซื้อกลางของโรงแรม',
    cloud: 'ครัวเดียวทำหลายแบรนด์ ขายผ่านแอปเดลิเวอรี่เป็นหลัก',
  };

  function renderQuestion(step, focus = false) {
    const key = wizard[step];
    const multi = key === 'goals';
    const items = key === 'setup' ? Object.keys(choices.setups) : key === 'role' ? rolesFor() : goalsFor();
    const labels = choices[key === 'setup' ? 'setups' : key === 'role' ? 'roles' : 'goals'];
    const titles = {
      setup: 'ร้านของคุณเป็นแบบไหน',
      role: 'คุณดูแลงานด้านไหน',
      goals: 'อยากรู้อะไรจาก dashboard มากที่สุด',
    };
    const sel = (v) => (multi ? ans.goals.includes(v) : ans[key] === v);
    const done = () => (multi ? ans.goals.length > 0 : !!ans[key]);
    box.innerHTML = `
      <p class="starter-role">เริ่มต้นใช้งาน · คำถามที่ ${step + 1} จาก 3</p>
      <div class="fr-progress" aria-hidden="true">${wizard.map((_, i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>
      <h2 class="starter-h" tabindex="-1">${step === 0 && name ? `ยินดีต้อนรับ ${esc(name)} — ` : ''}${titles[key]}</h2>
      ${step === 0 ? sampleNote : ''}
      ${multi ? '<p class="starter-lead fr-cap" role="status"></p>' : ''}
      <div class="starter-grid fr-q" role="${multi ? 'group' : 'radiogroup'}" aria-label="${esc(titles[key])}">
        ${items.map((v) => `<label class="starter-opt${sel(v) ? ' on' : ''}${multi && !sel(v) && ans.goals.length >= 2 ? ' off' : ''}">
          <input type="${multi ? 'checkbox' : 'radio'}" name="fr-q" value="${esc(v)}"${sel(v) ? ' checked' : ''}${multi && !sel(v) && ans.goals.length >= 2 ? ' aria-disabled="true"' : ''}>
          <b class="starter-title">${esc(labels[v])}</b>
          ${key === 'setup' ? `<span class="starter-desc">${esc(hints[v])}</span>` : ''}
        </label>`).join('')}
      </div>
      <div class="starter-actions fr-actions">
        <button type="button" class="btn primary fr-next"${done() ? '' : ' disabled'}>${step === 2 ? 'ดูชุดที่แนะนำ' : 'ต่อไป'}</button>
        ${step > 0 ? '<button type="button" class="btn ghost fr-back">ย้อนกลับ</button>' : ''}
        <button type="button" class="btn link fr-skip">ข้ามคำถาม</button>
      </div>
      <div class="starter-msg" role="status"></div>`;
    const next = box.querySelector('.fr-next');
    // One line says how many are picked and what to do at the limit.
    const capLine = (refused = false) => {
      const cap = box.querySelector('.fr-cap');
      if (!cap) return;
      const names = ans.goals.map((g) => choices.goals[g]).join(' · ');
      cap.classList.toggle('full', ans.goals.length >= 2);
      cap.textContent = (refused ? 'เลือกครบ 2 ข้อแล้ว — ' : '') + (ans.goals.length >= 2 ? `เลือกแล้ว: ${names} — กดติ๊กออกจากข้อใดข้อหนึ่งเพื่อเปลี่ยน` : ans.goals.length ? `เลือกแล้ว: ${names} — เลือกได้อีก 1 ข้อ` : 'เลือกได้สูงสุด 2 ข้อ');
    };
    capLine();
    // A third pick is refused, not disabled: the option stays reachable by keyboard,
    // and refusing it points at the line that says why (outlined, scrolled into view,
    // re-announced), which works with reduced motion too.
    let nudgeTimer;
    const nudge = () => {
      const cap = box.querySelector('.fr-cap');
      if (!cap) return;
      capLine(true);
      cap.classList.remove('flash'); void cap.offsetWidth; cap.classList.add('flash');
      const top = cap.getBoundingClientRect().top;
      if (top < 0 || top > window.innerHeight - 40) cap.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(() => cap.classList.remove('flash'), 1800);
    };
    if (focus) box.querySelector('.starter-h').focus({ preventScroll: true });
    box.querySelectorAll('input[name="fr-q"]').forEach((r) =>
      r.addEventListener('change', () => {
        if (multi) {
          const v = r.value;
          if (r.checked && ans.goals.length >= 2) { r.checked = false; nudge(); return; }
          ans.goals = r.checked ? [...ans.goals, v] : ans.goals.filter((g) => g !== v);
        } else {
          ans[key] = r.value;
          if (key === 'setup') { // roles / goals that no longer fit are dropped
            if (!rolesFor().includes(ans.role)) ans.role = null;
            ans.goals = ans.goals.filter((g) => goalsFor().includes(g));
          }
        }
        box.querySelectorAll('.starter-opt').forEach((l) => {
          const inp = l.querySelector('input');
          inp.checked = sel(inp.value);
          const full = multi && !inp.checked && ans.goals.length >= 2;
          if (full) inp.setAttribute('aria-disabled', 'true'); else inp.removeAttribute('aria-disabled');
          l.classList.toggle('on', inp.checked);
          l.classList.toggle('off', full);
        });
        capLine();
        next.disabled = !done();
      }));
    next.addEventListener('click', () => (step === 2 ? renderResult() : renderQuestion(step + 1, true)));
    const back = box.querySelector('.fr-back');
    if (back) back.addEventListener('click', () => renderQuestion(step - 1, true));
    box.querySelector('.fr-skip').addEventListener('click', () => renderResult());
  }

  async function renderResult() {
    box.innerHTML = '<p class="muted">กำลังเลือกชุดที่เหมาะกับคุณ...</p>';
    let list;
    try {
      const qs = new URLSearchParams({ setup: ans.setup || '', role: ans.role || '', goals: ans.goals.join(',') });
      ({ options: list } = await api(`/api/admin/companies/${cid}/starter-options?${qs}`));
      window.__frList = list;
    } catch (err) {
      box.innerHTML = `<div class="error-msg">${esc(err.message)}<div><button type="button" class="btn ghost fr-retry">ลองอีกครั้ง</button></div></div>`;
      box.querySelector('.fr-retry').addEventListener('click', renderResult);
      return;
    }
    const answered = !!(ans.setup || ans.role || ans.goals.length);
    // Packs with nothing to show come last and never as a recommendation.
    const usable = list.filter((o) => o.ready.length);
    const shown = usable.slice(0, 3);
    const more = usable.slice(3);
    let pick = shown.length ? shown[0].key : null;
    // A card says what the customer will find out, not which widgets it holds.
    // The first (recommended) one is large: why it was chosen, three things you will see.
    // The others are short, so the choice is obvious.
    const said = [ans.setup && choices.setups[ans.setup], ans.role && choices.roles[ans.role], ...ans.goals.map((g) => choices.goals[g])].filter(Boolean);
    const sees = (o) => (o.highlights && o.highlights.length ? o.highlights : [o.description]);
    const card = (o, i) => {
      const hero = answered && i === 0;
      return `<label class="starter-opt${o.key === pick ? ' on' : ''}${hero ? ' top fr-hero' : ''}">
        <input type="radio" name="fr-pick" value="${esc(o.key)}"${o.key === pick ? ' checked' : ''}>
        <span class="starter-role">${hero ? 'แนะนำสำหรับคุณ' : esc(o.role || 'ทั่วไป')}</span>
        <b class="starter-title">${esc(o.title)}</b>
        ${hero && said.length ? `<span class="fr-why">เพราะคุณบอกว่า: ${esc(said.join(' · '))}</span>` : ''}
        ${hero
          ? `<span class="fr-sees-h">คุณจะเห็น</span><ul class="fr-sees">${sees(o).slice(0, 3).map((h) => `<li>${esc(h)}</li>`).join('')}</ul>`
          : `<span class="starter-desc">${esc(sees(o)[0])}</span>`}
        <span class="starter-count">${o.ready.length} widget พร้อมตัวเลข</span>
      </label>`;
    };
    box.innerHTML = `
      ${head(answered ? 'เลือกให้ตามคำตอบของคุณ' : 'เริ่มต้นใช้งาน', answered ? 'ชุดที่น่าจะตอบโจทย์คุณ' : `ยินดีต้อนรับ${name ? ` ${esc(name)}` : ''} — เลือกชุดเริ่มต้น`)}
      ${answered ? '' : `<p class="muted starter-lead">ยังไม่ได้ตอบคำถาม จึงแสดงชุดทั่วไปโดยไม่จัดอันดับ กด “ตอบคำถาม” ให้ระบบเลือกชุดที่ตรงกับคุณ</p>${sampleNote}`}
      <div class="starter-grid" role="radiogroup" aria-label="ชุดเริ่มต้น">${shown.map(card).join('')}</div>
      ${more.length ? `<button type="button" class="btn link fr-more">ดูชุดอื่นอีก ${more.length} ชุด</button><div class="starter-grid fr-morebox" hidden>${more.map((o, i) => card(o, i + 3)).join('')}</div>` : ''}
      <div class="starter-actions fr-actions">
        <button type="button" class="btn primary fr-go"${pick ? '' : ' disabled'}>สร้าง dashboard ของฉัน</button>
        <button type="button" class="btn ghost fr-redo">${answered ? 'แก้คำตอบ' : 'ตอบคำถาม'}</button>
      </div>
      <div class="fr-emptyrow"><button type="button" class="btn link fr-empty">เริ่มจาก dashboard ว่าง</button></div>
      <div class="starter-msg" role="status"></div>`;
    const sync = () => box.querySelectorAll('.starter-opt').forEach((l) => l.classList.toggle('on', l.querySelector('input').value === pick));
    box.querySelectorAll('input[name="fr-pick"]').forEach((r) => r.addEventListener('change', () => { pick = r.value; sync(); }));
    const moreBtn = box.querySelector('.fr-more');
    if (moreBtn) moreBtn.addEventListener('click', () => { box.querySelector('.fr-morebox').hidden = false; moreBtn.remove(); });
    box.querySelector('.fr-redo').addEventListener('click', () => renderQuestion(0, true));
    box.querySelector('.starter-h').focus({ preventScroll: true });
    const go = box.querySelector('.fr-go');
    go.addEventListener('click', () => create(go, { key: pick }, 'สร้าง dashboard ของฉัน'));
    const emp = box.querySelector('.fr-empty');
    emp.addEventListener('click', () => create(emp, { empty: true }, 'เริ่มจาก dashboard ว่าง'));
  }

  renderQuestion(0);
}

function renderTabs() {
  renderSideNav();
  const tabsEl = el('tabs');
  tabsEl.innerHTML = '';
  state.dashboards.forEach((d) => {
    const btn = document.createElement('button');
    btn.className = 'tab' + (d.id === state.activeDashboardId ? ' active' : '');
    btn.textContent = d.display_name;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', d.id === state.activeDashboardId ? 'true' : 'false');
    btn.addEventListener('click', () => selectDashboard(d.id));
    tabsEl.appendChild(btn);
  });
}

// ---------- dashboard view ----------
const activeCharts = [];
function destroyCharts() {
  activeCharts.splice(0).forEach((c) => c.destroy());
}

async function selectDashboard(id) {
  state.activeDashboardId = id;
  state.navCurrent = { kind: 'dashboard', id };
  if (id) dashPrefs.touch(id);
  renderTabs();
  const wrap = el('tab-panel-wrap');
  destroyCharts();
  wrap.innerHTML = '<p class="muted">กำลังโหลด...</p>';
  let payload;
  try {
    payload = await api(`/api/dashboards/${id}`);
  } catch (err) {
    wrap.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    return;
  }
  if (state.activeDashboardId !== id) return; // user already clicked another tab
  new DashboardView(wrap, payload).load();
  if (typeof aiAttach === 'function') aiAttach(payload.dashboard);
}

function keyMissingMessage() {
  if (isSuper()) return 'ยังไม่ได้ตั้งค่า FMH API Key ของบริษัทนี้ — ตั้งค่าได้ใน Admin Console';
  if (isCompanyAdmin()) return 'ยังไม่ได้ตั้งค่า FMH API Key — กดปุ่ม ตั้งค่า มุมขวาบนเพื่อใส่ Key';
  return 'ระบบยังไม่ได้เชื่อมข้อมูล FMH — กรุณาติดต่อผู้ดูแลระบบของบริษัท';
}

// Rows whose date is the start of a period bucket (FMH chart cards): keep a
// bucket if any day of it falls in the range. The bucket length is read from
// the data itself — the smallest gap between periods (1 day, 7 days, a month);
// a lone period on the 1st is taken as a month, any other lone one as a week.
function keepOverlappingBuckets(rows, field, start, end) {
  const day = (r) => (r[field] ? String(r[field]).slice(0, 10) : null);
  const starts = [...new Set(rows.map(day).filter(Boolean))].sort();
  const t = (iso) => new Date(iso + 'T00:00:00Z').getTime();
  let gapDays = null;
  for (let i = 1; i < starts.length; i++) {
    const g = Math.round((t(starts[i]) - t(starts[i - 1])) / 86400000);
    if (g > 0 && (gapDays === null || g < gapDays)) gapDays = g;
  }
  const monthly = gapDays === null ? starts.length === 1 && starts[0].endsWith('-01') : gapDays >= 28;
  const len = gapDays === null ? 7 : gapDays;
  const bucketEnd = (iso) => {
    if (monthly) {
      const d = new Date(iso + 'T00:00:00Z');
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    }
    return new Date(t(iso) + (len - 1) * 86400000).toISOString().slice(0, 10);
  };
  return rows.filter((r) => {
    const d = day(r);
    return d && (!end || d <= end) && (!start || bucketEnd(d) >= start);
  });
}

// Local calendar, not UTC: before 07:00 in Bangkok the UTC date is still yesterday.
// In saved-data mode "today" is the day that data was pulled, so "last 30 days"
// and every "within N days" rule still land on the saved rows.
let dataAnchor = null;
const nowRef = () => (dataAnchor ? new Date(dataAnchor) : new Date());
const todayIso = () => localIso(nowRef());
// Report sources that can take older months from FMH export files (fmh-file.js).
const FILE_SOURCES = ['sales-analysis', 'purchase-analysis'];
// YYYY-MM-DD shifted by n days (local calendar days).
const dayShift = (iso, n) => localIso(new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + n));
const dayLabel = (iso) => (iso ? new Date(String(iso).slice(0, 10) + 'T00:00:00').toLocaleDateString(I18N.locale(), { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const nextDay = (iso) => localIso(new Date(Date.parse(iso + 'T00:00:00') + 86400000));
const prevDay = (iso) => localIso(new Date(Date.parse(iso + 'T00:00:00') - 86400000));
const daysAgoIso = (n) => localIso(new Date(nowRef().getTime() - n * 86400000));

// "Use saved data" is a per-browser switch, so a demo stays on it while the
// presenter moves between dashboards.
const savedMode = {
  get() {
    try { return localStorage.getItem('kss_saved_mode') === '1'; } catch (e) { return false; }
  },
  set(on) {
    try { on ? localStorage.setItem('kss_saved_mode', '1') : localStorage.removeItem('kss_saved_mode'); } catch (e) { /* private window */ }
  },
};

const RECENT_ONLY = new Set(['Line Checks', 'Supplier Quality', 'Alerts']);

// users.home_branch: one name, or a JSON array of names (district manager).
function homeBranchList(raw) {
  if (!raw) return [];
  const s = String(raw).trim();
  if (s.startsWith('[')) { try { return JSON.parse(s).map(String).filter(Boolean); } catch (e) { return []; } }
  return s ? [s] : [];
}

class DashboardView {
  constructor(wrap, { dashboard, widgets, sources }) {
    this.wrap = wrap;
    this.dashboard = dashboard;
    this.widgets = widgets;
    this.sources = sources;
    // The Widget library previews one template on the company's own data
    // (routes/dashboards.js /preview): same renderers, no status bar.
    this.preview = !!dashboard.preview;
    if (!this.preview) state.currentView = this; // read by the AI chat (aichat.js)
    this.dataBase = this.preview
      ? `/api/dashboards/preview/${String(dashboard.id).replace('preview-', '')}`
      : `/api/dashboards/${dashboard.id}`;
    this.results = {}; // source -> { data, meta } | { error, code }
    this.hasDateSource = Object.values(sources).some((s) => s.date_field);
    // Which date column the range counts by, for Sales / Purchase Analysis (public/date-basis.js):
    // Order Date unless this user picked another, which the server remembers for them.
    this.hasBasis = Object.values(sources).some((s) => s.date_basis);
    this.dateBasis = DateBasis.normalize(dashboard.my_date_basis);
    // Reports whose older months can come from FMH export files: these pages
    // offer 6-month / 1-year ranges.
    this.fileCapable = Object.values(sources).some((s) => FILE_SOURCES.includes(s.source) && !s.grouping);
    this.useSaved = savedMode.get();
    this.rangePreset = RangePresets.DEFAULT; // the picked ready-made range; null after a custom date pick
    this.range = RangePresets.compute(this.rangePreset, todayIso());
    this.build();
  }

  build() {
    this.wrap.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'dash-header';
    header.innerHTML = `
      <div class="dash-head-left">
        ${
          this.preview
            ? `<h1 class="dash-title">${esc(this.dashboard.display_name)}</h1>`
            : `<div class="dash-switch-wrap">
                 <h1 class="dash-h1"><button type="button" class="dash-switch" aria-haspopup="dialog" aria-expanded="false" title="เปลี่ยน Dashboard">
                   <span class="dash-title">${esc(this.dashboard.display_name)}</span>
                   <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                 </button></h1>
                 <div class="dash-pop" role="dialog" aria-label="เลือก Dashboard" hidden></div>
               </div>`
        }
        ${this.dashboard.description ? `<p class="dash-desc">${esc(this.dashboard.description)}</p>` : ''}
      </div>
      <div class="dash-controls">
        ${!this.preview && !isSuper() && !isCompanyAdmin() && state.user && state.user.company_id ? '<div class="dash-actions"><button type="button" class="btn small ghost dash-wish" title="บอกทีม KSS ว่าอยากเห็นข้อมูลอะไรเพิ่ม">ขอข้อมูลเพิ่ม</button></div>' : ''}
        ${
          !this.preview && (isSuper() || isCompanyAdmin())
            ? `<div class="dash-actions">
                 ${isCompanyAdmin() ? '<button type="button" class="btn small ghost dash-wish" title="บอกทีม KSS ว่าอยากเห็นข้อมูลอะไรเพิ่ม">ขอข้อมูลเพิ่ม</button>' : ''}
                 <button type="button" class="btn small ghost dash-edit"><svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="18" height="7" rx="1.5"/></svg>จัดเรียง</button>
                 <button type="button" class="btn small primary dash-add">+ เพิ่ม Widget</button>
               </div>`
            : ''
        }
        ${
          this.hasDateSource
            ? `<div class="range-control" role="group" aria-label="ช่วงวันที่">
                 <select class="range-preset" aria-label="${esc(L('ช่วงเวลา', 'Period'))}">
                   ${RangePresets.available(this.fileCapable).map((p) => `<option value="${p.key}"${p.key === this.rangePreset ? ' selected' : ''}>${esc(RangePresets.label(p.key, I18N.lang))}</option>`).join('')}
                   <option value="custom" hidden>${esc(L('กำหนดเอง', 'Custom'))}</option>
                 </select>
                 <input type="date" class="range-start" value="${this.range.start}" aria-label="วันที่เริ่ม">
                 <span class="muted">–</span>
                 <input type="date" class="range-end" value="${this.range.end}" aria-label="วันที่สิ้นสุด">
               </div>
               ${this.hasBasis ? '<div class="basis-control" hidden></div>' : ''}`
            : ''
        }
      </div>`;
    this.wrap.appendChild(header);
    if (!this.preview) bindDashSwitcher(header.querySelector('.dash-switch-wrap'), this.dashboard.id);
    const wishBtn = header.querySelector('.dash-wish');
    if (wishBtn) wishBtn.addEventListener('click', () => openSupportForm({ kind: 'wish' }));
    const editBtn = header.querySelector('.dash-edit');
    if (editBtn) {
      editBtn.addEventListener('click', () => this.arrange());
      this.openPicker = () => {
        adminState.selected = { type: 'picker', id: this.dashboard.company_id, dashboardId: this.dashboard.id };
        if (!isSuper()) state.navCurrent = { kind: 'dashboard', id: this.dashboard.id };
        openAdminConsole();
      };
      header.querySelector('.dash-add').addEventListener('click', () => openLibrary({ dashboardId: this.dashboard.id }));
    }

    // Sample data is the first thing to know: its banner goes above the to-do
    // list; with real data the sync line stays below it as before.
    const statusFirst = this.dashboard.data_source === 'demo';
    if (statusFirst) {
      this.statusEl = document.createElement('div');
      this.wrap.appendChild(this.statusEl);
    }
    if (!this.preview) {
      this.insightEl = document.createElement('section');
      this.insightEl.className = 'insight-card';
      this.insightEl.setAttribute('aria-label', 'เราเจอให้คุณ');
      // a reserved space while the numbers load, so the page does not jump when the cards arrive
      this.insightEl.className = 'insight-card loading';
      this.insightEl.innerHTML = '<div class="ins-skel" aria-hidden="true"></div>';
      this.wrap.appendChild(this.insightEl);
      this.todayEl = document.createElement('section');
      this.todayEl.className = 'today-card';
      this.todayEl.hidden = true;
      this.wrap.appendChild(this.todayEl);
      this.renderToday();
    }
    if (!statusFirst) {
      this.statusEl = document.createElement('div');
      this.wrap.appendChild(this.statusEl);
    }
    // A page-wide filter (customer, for the CK sales widgets): any widget can
    // ask for it with config.page_filter, and it then applies to every widget
    // on the page whose rows carry that field.
    // page_filter is one field or a list; the page offers every field any of
    // its widgets asks for, in first-seen order.
    this.filterFields = [];
    this.filterUse = {}; // field -> titles of the widgets it narrows
    this.widgets.forEach((w) => {
      const pf = w.config && w.config.page_filter;
      (Array.isArray(pf) ? pf : pf ? [pf] : []).forEach((f) => {
        if (!this.filterFields.includes(f)) this.filterFields.push(f);
        (this.filterUse[f] = this.filterUse[f] || []).push(w.title);
      });
    });
    // A filter that narrows a single widget, on a page whose main filter narrows most of them, only adds
    // noise (a CK sales page showing "สาขา" and "ซัพพลายเออร์" for one widget each). Offer it only when
    // nothing else on the page is a real page-wide filter.
    if (this.filterFields.some((f) => (this.filterUse[f] || []).length >= 3)) {
      this.filterFields = this.filterFields.filter((f) => (this.filterUse[f] || []).length >= 2);
    }
    this.filters = {}; // field -> chosen value
    // A branch manager opens on their own branch (users.home_branch); they can still pick "ทุกสาขา".
    this.homeBranches = homeBranchList(state.user && state.user.home_branch);
    if (this.homeBranches.length && this.filterFields.includes('branch')) this.filters.branch = this.homeBranches[0];
    this.bucketPick = new Map();
    this.filterEl = document.createElement('div');
    this.filterEl.className = 'page-filter';
    this.wrap.appendChild(this.filterEl);
    this.coverageEl = document.createElement('div');
    this.wrap.appendChild(this.coverageEl);

    if (!this.widgets.length) {
      const box = document.createElement('div');
      box.className = 'dash-empty';
      this.wrap.appendChild(box);
      if (!this.preview && (isSuper() || isCompanyAdmin())) this.renderStarter(box);
      else box.innerHTML = '<p><b>Dashboard นี้ยังว่างอยู่</b></p><p class="muted">ผู้ดูแลของบริษัทยังไม่ได้ใส่ widget</p>';
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'widget-grid';
    this.cards = this.widgets.map((w) => {
      const card = document.createElement('section');
      card.className = `widget-card size-${w.config.size || 'half'} widget-${w.chart_type}${[2, 3].includes(Number(w.config.rows)) ? ` rows-${w.config.rows}` : ''}${w.config.lock_layout ? ' layout-locked' : ''}`;
      card.dataset.wid = w.id;
      card.innerHTML = `<div class="widget-head"><h3 class="widget-title">${esc(w.title)}</h3>${this.dashboard.data_source === 'demo' ? '<span class="demo-pill widget-sample">ตัวอย่าง</span>' : ''}${
        this.preview ? '' : '<button type="button" class="widget-explain" aria-expanded="false" title="กราฟนี้บอกอะไร"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/></svg>อธิบาย</button>'
      }</div><div class="explain-box" hidden></div><div class="widget-body">${SKELETON}</div>`;
      grid.appendChild(card);
      const box = card.querySelector('.explain-box');
      const eb = card.querySelector('.widget-explain');
      if (eb) {
        eb.addEventListener('click', () => {
          const open = box.hidden;
          box.hidden = !open;
          eb.setAttribute('aria-expanded', String(open));
          eb.classList.toggle('on', open);
          if (open) box.innerHTML = explainWidget(w, this.explainData.get(w.id));
        });
      }
      return { widget: w, body: card.querySelector('.widget-body'), box };
    });
    this.wrap.appendChild(grid);

    if (this.hasDateSource) this.bindRange(header);
  }

  // An empty dashboard asks "start with a basic dashboard?" and fills itself
  // in one click — only with widgets that have this company's data now
  // (lib/starter.js), so the first look is never a page of empty boxes.
  async renderStarter(box) {
    const cid = this.dashboard.company_id;
    box.classList.add('starter');
    box.innerHTML = '<p class="muted">กำลังเตรียมตัวเลือก...</p>';
    let options;
    try {
      ({ options } = await api(`/api/admin/companies/${cid}/starter-options`));
    } catch (err) {
      box.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
      return;
    }
    const usable = options.filter((o) => o.ready.length);
    let pick = (usable.find((o) => o.key === 'basic') || usable[0] || {}).key;
    const skippedLine = (o) => {
      if (!o.skipped.length) return '';
      const why = [...new Set(o.skipped.map((x) => x.reason))].join(' · ');
      return `<span class="starter-skip">ข้าม ${o.skipped.length} widget: ${esc(why)}</span>`;
    };
    box.innerHTML = `
      <h2 class="starter-h">เริ่มด้วย Dashboard พื้นฐานไหม?</h2>
      <p class="muted starter-lead">เลือกชุดแล้วกด “ใส่ให้เลย” ระบบใส่เฉพาะ widget ที่มีข้อมูลของบริษัทนี้แล้ว แก้ต่อทีหลังได้เสมอ</p>
      <div class="starter-grid" role="radiogroup" aria-label="ชุดเริ่มต้น">
        ${options
          .map(
            (o) => `<label class="starter-opt${o.ready.length ? '' : ' off'}${o.key === pick ? ' on' : ''}">
              <input type="radio" name="starter" value="${esc(o.key)}"${o.key === pick ? ' checked' : ''}${o.ready.length ? '' : ' disabled'}>
              ${o.role ? `<span class="starter-role">${esc(o.role)}</span>` : '<span class="starter-role">แนะนำ</span>'}
              <b class="starter-title">${esc(o.title)}</b>
              <span class="starter-desc">${esc(o.description)}</span>
              <span class="starter-count">${o.ready.length ? `พร้อมแสดง ${o.ready.length} widget` : 'ยังไม่มีข้อมูลสำหรับชุดนี้'}</span>
              ${skippedLine(o)}
            </label>`
          )
          .join('')}
      </div>
      <div class="starter-actions">
        <button type="button" class="btn primary starter-go"${pick ? '' : ' disabled'}>ใส่ให้เลย</button>
        <button type="button" class="btn ghost starter-lib">เลือกเองจากคลัง Widget</button>
      </div>
      <div class="starter-msg" role="status"></div>`;
    box.querySelectorAll('input[name="starter"]').forEach((r) =>
      r.addEventListener('change', () => {
        pick = r.value;
        box.querySelectorAll('.starter-opt').forEach((l) => l.classList.toggle('on', l.querySelector('input').value === pick));
      })
    );
    box.querySelector('.starter-lib').addEventListener('click', () => openLibrary({ dashboardId: this.dashboard.id }));
    const go = box.querySelector('.starter-go');
    go.addEventListener('click', async () => {
      go.disabled = true;
      go.textContent = 'กำลังใส่ widget...';
      try {
        await api(`/api/admin/companies/${cid}/dashboards/${this.dashboard.id}/starter`, { method: 'POST', body: JSON.stringify({ key: pick }) });
        selectDashboard(this.dashboard.id);
      } catch (err) {
        go.disabled = false;
        go.textContent = 'ใส่ให้เลย';
        box.querySelector('.starter-msg').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
      }
    });
  }

  // A custom range picked from code (the POS "show the file's days" button).
  setRange(startIso, endIso) {
    this.rangePreset = null;
    this.range = { start: startIso, end: endIso };
    this.syncPresetSelect();
    const s = this.wrap.querySelector('.range-start');
    const e = this.wrap.querySelector('.range-end');
    if (s) s.value = startIso;
    if (e) e.value = endIso;
    this.renderWidgets();
  }

  // The dropdown shows the ready-made range in use, or "กำหนดเอง" after a date was typed.
  syncPresetSelect() {
    const sel = this.wrap.querySelector('.range-preset');
    if (!sel) return;
    const custom = sel.querySelector('option[value="custom"]');
    if (this.rangePreset) {
      custom.hidden = true;
      sel.value = this.rangePreset;
    } else {
      // a custom pick that happens to equal a ready-made range shows as that range
      const m = RangePresets.match(this.range.start, this.range.end, todayIso());
      if (m && [...sel.options].some((o) => o.value === m)) sel.value = m;
      else { custom.hidden = false; sel.value = 'custom'; }
    }
  }

  bindRange(header) {
    const start = header.querySelector('.range-start');
    const end = header.querySelector('.range-end');
    const sel = header.querySelector('.range-preset');
    sel.addEventListener('change', () => {
      if (sel.value === 'custom') return;
      this.rangePreset = sel.value;
      this.range = RangePresets.compute(this.rangePreset, todayIso());
      start.value = this.range.start;
      end.value = this.range.end;
      this.syncPresetSelect();
      this.renderWidgets();
    });
    [start, end].forEach((input) =>
      input.addEventListener('change', () => {
        this.rangePreset = null;
        this.range = { start: start.value, end: end.value };
        this.syncPresetSelect();
        this.renderWidgets();
      })
    );
  }

  async load() {
    this.results = {};
    await Promise.all(
      Object.entries(this.sources).map(async ([key, info]) => {
        const params = new URLSearchParams();
        if (info.grouping) params.set('group', info.grouping);
        if (this.useSaved) params.set('saved', '1');
        if (this.preview && isSuper()) params.set('company_id', this.dashboard.company_id);
        const qs = params.toString() ? `?${params}` : '';
        try {
          this.results[key] = await api(`${this.dataBase}/data/${info.source || key}${qs}`);
        } catch (err) {
          this.results[key] = { error: err.message, code: err.code, health: err.data && err.data.health };
        }
      })
    );
    if (this.preview ? !this.wrap.isConnected : state.activeDashboardId !== this.dashboard.id) return;
    this.applyAnchor();
    this.renderStatus();
    this.renderPageFilter();
    this.renderWidgets();
  }

  renderPageFilter() {
    if (!this.filterFields.length) return;
    // When a page mixes CK sales (customer) with purchasing (branch/supplier), say which side each row is,
    // so "ลูกค้า" and "สาขา" are not read as the same thing.
    const mixed = this.filterFields.includes('customer') && this.filterFields.some((f) => f !== 'customer');
    const LABEL = {
      customer: [mixed ? 'ลูกค้าครัวกลาง' : 'ลูกค้า', 'ทุกราย'],
      branch: [mixed ? 'สาขาที่สั่งซื้อ' : 'สาขา', 'ทุกสาขา'],
      supplier: [mixed ? 'ซัพพลายเออร์ที่ซื้อ' : 'ซัพพลายเออร์', 'ทุกเจ้า'],
    };
    const useNote = (f) => {
      const names = [...new Set(this.filterUse[f] || [])];
      if (!names.length) return '';
      const total = this.widgets.length;
      return `<details class="pf-use"><summary>กรองได้ ${(this.filterUse[f] || []).length}${(this.filterUse[f] || []).length === total ? ' (ทั้งหมด)' : ` จาก ${total}`} รายการ</summary><span>${names.map(esc).join(' · ')}</span></details>`;
    };
    const show = (f, v) => (f === 'customer' ? partyShort(v) : String(v));
    const groups = this.filterFields.map((f) => {
      const totals = new Map();
      Object.values(this.results).forEach((r) => {
        if (!r || r.error || !Array.isArray(r.data)) return;
        r.data.forEach((row) => {
          if (!(f in row) || isBlank(row[f])) return;
          totals.set(String(row[f]), (totals.get(String(row[f])) || 0) + num(row.total ?? 1));
        });
      });
      let values = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
      // A manager with several branches picks among theirs (one branch alone needs no picker).
      if (f === 'branch' && this.homeBranches && this.homeBranches.length > 1) values = values.filter((v) => this.homeBranches.includes(v));
      return { f, values };
    }).filter((g) => g.values.length > 1);
    if (!groups.length) { this.filterEl.innerHTML = ''; return; }
    // A few values read best as chips; a long list (fifty suppliers) as a menu.
    this.filterEl.innerHTML = groups.map(({ f, values }) => {
      const [label, all] = LABEL[f] || [f, 'ทั้งหมด'];
      const cur = this.filters[f] ?? null;
      if (values.length <= 10) {
        const chip = (v, text) => `<button type="button" class="range-chip${cur === v ? ' active' : ''}" data-f="${esc(f)}" data-v="${v === null ? '' : esc(v)}" title="${esc(v ?? '')}">${esc(text)}</button>`;
        return `<div class="page-filter-group"><span class="page-filter-label">${esc(label)}</span>${useNote(f)}<div class="chip-row">${chip(null, all)}${values.map((v) => chip(v, show(f, v))).join('')}</div></div>`;
      }
      return `<div class="page-filter-group"><label class="page-filter-label" for="pf-${esc(f)}">${esc(label)}</label>${useNote(f)}<select id="pf-${esc(f)}" data-f="${esc(f)}"><option value="">${esc(all)}</option>${values
        .map((v) => `<option value="${esc(v)}"${cur === v ? ' selected' : ''}>${esc(show(f, v))}</option>`).join('')}</select></div>`;
    }).join('');
    const set = (f, v) => {
      this.filters[f] = this.filters[f] === v ? null : v;
      this.renderPageFilter();
      this.renderWidgets();
    };
    this.filterEl.querySelectorAll('button[data-f]').forEach((b) => b.addEventListener('click', () => set(b.dataset.f, b.dataset.v || null)));
    this.filterEl.querySelectorAll('select[data-f]').forEach((sel) => sel.addEventListener('change', () => { this.filters[sel.dataset.f] = null; set(sel.dataset.f, sel.value || null); }));
  }

  // Which active page filters a widget's rows cannot honour (they lack the
  // field — a server-grouped pull, another report), so it can say so.
  unfilteredBy(rows) {
    const active = Object.entries(this.filters).filter(([, v]) => v !== null && v !== undefined);
    if (!active.length || !rows || !rows.length) return [];
    return active.filter(([f]) => !(f in rows[0])).map(([f]) => f);
  }

  // "Today" is always the real today (Thai time), in saved mode too, so "this month"
  // means the current calendar month even when the last sync is older.
  applyAnchor() {
    dataAnchor = null;
    if (this.rangePreset) this.range = RangePresets.compute(this.rangePreset, todayIso());
    const s = this.wrap.querySelector('.range-start');
    const e = this.wrap.querySelector('.range-end');
    if (s) s.value = this.range.start;
    if (e) e.value = this.range.end;
  }

  async switchSaved(on) {
    savedMode.set(on);
    this.useSaved = on;
    (this.cards || []).forEach(({ body }) => (body.innerHTML = SKELETON));
    await this.load();
  }

  // Widgets address data by the same key the server cached it under.
  keyFor(widget) {
    return widget.grouping ? `${widget.report_source}|${widget.grouping}` : widget.report_source;
  }

  // The row column the range counts by for one pull: the user's chosen date for Sales / Purchase
  // Analysis (Order Date when the report has no such column), else the report's own.
  dateFieldOf(key) {
    const info = this.sources[key];
    if (!info) return null;
    if (!info.date_basis) return info.date_field;
    const r = this.results[key];
    return DateBasis.fieldFor(this.dateBasis, r && !r.error ? r.data : []).field;
  }

  // The "นับยอดตามวันที่" picker, a line on what the choice means, and what to watch for. Rebuilt
  // only when the choices change, so a keyboard user keeps their place after picking.
  renderBasis() {
    const box = this.wrap.querySelector('.basis-control');
    if (!box) return;
    const lang = I18N.lang;
    const keys = Object.keys(this.sources).filter((k) => this.sources[k].date_basis);
    const okKeys = keys.filter((k) => this.results[k] && !this.results[k].error);
    const sets = okKeys.map((k) => this.results[k].data);
    if (!sets.some((x) => x.length)) { box.hidden = true; return; }
    const opts = DateBasis.available(sets);
    if (!opts.includes(this.dateBasis)) opts.push(this.dateBasis);
    const sig = `${opts.join(',')}|${lang}`;
    if (box.dataset.sig !== sig) {
      box.dataset.sig = sig;
      box.innerHTML = `<div class="basis-label"><label for="basis-select">${esc(L('นับยอดตามวันที่', 'Count by date'))}</label>
        <select id="basis-select" class="basis-select" aria-describedby="basis-note">${opts.map((k) => `<option value="${k}">${esc(DateBasis.label(k, lang))}${k === DateBasis.DEFAULT ? esc(L(' — ตรงกับ FMH', ' — same as FMH')) : ''}</option>`).join('')}</select></div>
        <div id="basis-note" class="basis-note" aria-live="polite"></div>`;
      box.querySelector('select').addEventListener('change', (e) => {
        this.dateBasis = DateBasis.normalize(e.target.value);
        if (!this.preview) {
          api('/api/dashboards/me/date-basis', { method: 'PUT', body: JSON.stringify({ basis: this.dateBasis }) })
            .then(() => { this.basisSaveFailed = false; this.renderBasis(); })
            .catch(() => { this.basisSaveFailed = true; this.renderBasis(); });
        }
        this.renderWidgets();
      });
    }
    box.hidden = false;
    box.querySelector('select').value = this.dateBasis;
    const baht = (n) => `฿${Math.round(n).toLocaleString(lang === 'en' ? 'en-GB' : 'th-TH')}`;
    const num = (n) => n.toLocaleString(lang === 'en' ? 'en-GB' : 'th-TH');
    const lines = [];
    // what the chosen date means (and that it differs from FMH)
    if (this.dateBasis !== DateBasis.DEFAULT) {
      lines.push(`<strong>${esc(DateBasis.hint(this.dateBasis, lang))}</strong>`);
      lines.push(esc(L(`ต่างจาก FMH ที่นับตาม ${DateBasis.label(DateBasis.DEFAULT, lang)} ยอดรวมจึงอาจไม่ตรงกัน`, `FMH counts by ${DateBasis.label(DateBasis.DEFAULT, lang)}, so totals may not match.`)));
    }
    okKeys.forEach((k) => {
      const r = this.results[k];
      const name = this.sources[k].label;
      const f = DateBasis.fieldFor(this.dateBasis, r.data);
      if (f.fellBack) {
        lines.push(esc(L(`${name} ไม่มี ${DateBasis.label(this.dateBasis, lang)} จึงใช้ ${DateBasis.label(f.field, lang)} แทน`, `${name} has no ${DateBasis.label(this.dateBasis, lang)}, so ${DateBasis.label(f.field, lang)} is used instead.`)));
        return;
      }
      if (f.field === DateBasis.DEFAULT) return;
      // orders that have no value in this date leave the range: say how many and how much
      const inWindow = r.data.filter((row) => row.order_date && row.order_date.slice(0, 10) >= this.range.start && row.order_date.slice(0, 10) <= this.range.end);
      const n = new Set(inWindow.filter((row) => !row[f.field]).map((row) => row.so_number || row.po_number)).size;
      if (n) lines.push(esc(L(`${name}: ${num(n)} ใบ (${baht(DateBasis.money(inWindow, f.field))}) ที่สั่งในช่วงนี้ยังไม่มี ${DateBasis.label(f.field, lang)} จึงไม่ถูกนับ`, `${name}: ${num(n)} orders (${baht(DateBasis.money(inWindow, f.field))}) placed in this range have no ${DateBasis.label(f.field, lang)} yet and are not counted.`)));
      // data is pulled by order date: near its start, orders placed earlier but dated in the range are missing
      const from = this.coverageFrom(k);
      if (from && this.range.end >= from && this.range.start < dayShift(from, 30)) {
        lines.push(`<span class="basis-warn">${esc(L(`ข้อมูลเริ่มที่ใบสั่งวันที่ ${dayLabel(from)} ยอดช่วงต้น (ก่อน ${dayLabel(dayShift(from, 30))}) อาจต่ำกว่าจริง เพราะขาดใบที่สั่งก่อนหน้านั้น`, `Data starts with orders placed on ${dayLabel(from)}; figures before ${dayLabel(dayShift(from, 30))} may be too low because earlier orders are missing.`))}</span>`);
      }
    });
    // Orders still open after a week: their amount is the order total until they close, then it can change.
    const open = this.openOrders();
    if (open && open.count) {
      const list = open.top.map((o) => `<li>${esc(o.so)} · ${esc(dayLabel(o.date))} · ${esc(o.customer)} · ${esc(baht(o.total))}</li>`).join('');
      lines.push(`<details class="basis-open"><summary class="basis-warn">${esc(L(
        `มี ${num(open.count)} ใบสั่งขายที่สั่งเกิน 7 วันแล้วยังไม่ปิด (รวม ${baht(open.total)})`,
        `${num(open.count)} sales orders older than 7 days are still not closed (${baht(open.total)} in total)`
      ))}</summary><p>${esc(L(
        'ยอดของใบเหล่านี้เป็นยอดใบสั่ง และจะเปลี่ยนเมื่อปิด (ยอดสลับเป็นยอดใบแจ้งหนี้) ตัวเลขรวมจึงอาจต่างจาก FMH ที่เปิดดูทีหลัง ให้ตรวจและปิดใบที่ค้างใน FMH',
        'These amounts are order totals and change when the order closes (the total switches to the invoice). Totals may differ from FMH later. Check and close the open orders in FMH.'
      ))}</p><ul>${list}</ul>${open.count > open.top.length ? `<p>${esc(L(`และอีก ${num(open.count - open.top.length)} ใบ`, `and ${num(open.count - open.top.length)} more`))}</p>` : ''}</details>`);
    }
    if (this.basisSaveFailed) lines.push(`<span class="basis-warn">${esc(L('บันทึกตัวเลือกนี้ไม่สำเร็จ ครั้งหน้าอาจกลับเป็นวันที่สั่ง', 'Could not save this choice; next time it may go back to Order Date.'))}</span>`);
    box.querySelector('.basis-note').innerHTML = lines.map((x) => (x.startsWith('<details') ? x : `<p>${x}</p>`)).join('');
  }

  // Sales orders placed in the range that were placed more than 7 days ago and have no completed date.
  openOrders() {
    const key = Object.keys(this.sources).find((k) => this.sources[k].source === 'sales-analysis' && this.sources[k].date_basis);
    const r = key && this.results[key];
    if (!r || r.error || !(r.data || []).some((row) => row.completed_date)) return null; // no way to tell open from closed
    const cutoff = daysAgoIso(7);
    const bySo = new Map();
    r.data.forEach((row) => {
      const d = row.order_date && row.order_date.slice(0, 10);
      if (!d || d > cutoff || d < this.range.start || d > this.range.end || row.completed_date) return;
      const o = bySo.get(row.so_number) || { so: row.so_number, date: d, customer: partyShort(row.customer || ''), total: 0 };
      o.total += Number(row.total) || 0;
      bySo.set(row.so_number, o);
    });
    const all = [...bySo.values()].sort((a, b) => b.total - a.total);
    return { count: all.length, total: all.reduce((n, o) => n + o.total, 0), top: all.slice(0, 15) };
  }

  // First day a pull has data for: uploaded files first, then the API window,
  // else the oldest row. Null when the pull is undated.
  coverageFrom(key) {
    const r = this.results[key];
    const info = this.sources[key];
    if (!r || r.error || !info || !info.date_field) return null;
    const df = info.date_basis ? 'order_date' : info.date_field; // the pull is cut by order date
    const h = r.meta && r.meta.history;
    if (h && (h.archive_from || h.file_from || h.api_from)) return [h.archive_from, h.file_from, h.api_from].filter(Boolean).sort()[0];
    let min = null;
    (r.data || []).forEach((row) => {
      const d = row[df] ? String(row[df]).slice(0, 10) : null;
      if (d && (!min || d < min)) min = d;
    });
    return min;
  }

  // One line per report whose data starts after the picked range does, so a
  // 1-year chart with five months of data isn't read as seven quiet months.
  coverageLine(key) {
    const info = this.sources[key];
    if (!info || !info.date_field || !this.range.start) return null;
    const from = this.coverageFrom(key);
    if (!from || Date.parse(from) - Date.parse(this.range.start) < 3 * 86400000) return null;
    return `${info.label} มีข้อมูลตั้งแต่ ${dayLabel(from)}${FILE_SOURCES.includes(info.source) ? ' — อัปโหลดไฟล์จาก FMH เพื่อดูย้อนหลังกว่านี้' : ' (FMH API ย้อนหลังได้ราว 90 วัน)'}`;
  }

  // A report whose last sync is older than 2 days while the picked range runs past it:
  // the newest days are missing, which would otherwise look like quiet days.
  staleLine(key) {
    const info = this.sources[key];
    const r = this.results[key];
    const at = r && !r.error && r.meta && r.meta.synced_at;
    if (!info || !info.date_field || !at || !this.range.end) return null;
    const synced = localIso(new Date(at));
    if (this.range.end <= synced || Date.parse(todayIso()) - Date.parse(synced) <= 2 * 86400000) return null;
    return L(`${info.label}: ซิงก์ล่าสุด ${dayLabel(synced)} — ข้อมูลหลังวันนั้นยังไม่เข้า ยอดของช่วงที่เลือกอาจต่ำกว่าจริง`,
      `${info.label}: last synced ${dayLabel(synced)} — newer data has not arrived, so figures for this range may be too low.`);
  }

  // Page level: every report the page reads.
  renderCoverage() {
    if (!this.coverageEl) return;
    const lines = [...new Set(Object.keys(this.sources).flatMap((k) => [this.staleLine(k), this.coverageLine(k)]).filter(Boolean))];
    this.coverageEl.innerHTML = lines.length ? `<div class="warn-msg coverage-banner">${lines.map(esc).join('<br>')}</div>` : '';
  }

  // Widget level, only where it changes how to read that widget: two reports
  // that cover different spans side by side, or a server-side total that does
  // not follow the range at all.
  coverageNote(widget) {
    if (!this.hasDateSource || !this.range.start) return '';
    const keys = widget.pulls ? widget.pulls.map((p) => p.key) : [this.keyFor(widget)];
    const spanDays = (Date.parse(this.range.end) - Date.parse(this.range.start)) / 86400000;
    const notes = [];
    keys.forEach((key) => {
      const info = this.sources[key];
      if (!info) return;
      if (!info.date_field) {
        if (info.grouping && spanDays > 85) notes.push(`${info.label}: ยอดรวมจาก FMH ไม่เกิน 80 วันล่าสุด ไม่เปลี่ยนตามช่วงวันที่`);
        return;
      }
      if (keys.length > 1) {
        const line = this.coverageLine(key);
        if (line) notes.push(line);
      }
    });
    return notes.length ? `<p class="widget-foot coverage-note">${notes.map(esc).join('<br>')}</p>` : '';
  }

  // dateOverride: a widget that lines two reports up by date filters a pull on a
  // field the page does not use for that report (its other widgets want it whole).
  rowsFor(key, widget, dateOverride, minStart) {
    const r0 = this.results[key];
    if (!r0 || r0.error) return null;
    // Exception lists (unreceived lines, over-billing…) are about now: archived history keeps the last
    // status a line had in FMH's window, so it would list lines that were settled later.
    const r = widget && RECENT_ONLY.has(widget.category) && r0.data.some((x) => x._arch) ? { ...r0, data: r0.data.filter((x) => !x._arch) } : r0;
    const dateField = dateOverride || this.dateFieldOf(key);
    const active = Object.entries(this.filters).filter(([, v]) => v !== null && v !== undefined);
    const byFilter = (rows) => (active.length ? rows.filter((row) => active.every(([f, v]) => !(f in row) || String(row[f]) === v)) : rows);
    if (!dateField || !this.hasDateSource) return byFilter(r.data);
    const { end } = this.range;
    // minStart: a widget whose pulls reach back different lengths cuts them all to the shorter one
    const start = minStart && (!this.range.start || this.range.start < minStart) ? minStart : this.range.start;
    if (!dateOverride && this.sources[key].date_is_bucket) return byFilter(keepOverlappingBuckets(r.data, dateField, start, end));
    return byFilter(r.data).filter((row) => {
      const d = row[dateField] ? String(row[dateField]).slice(0, 10) : null;
      return d && (!start || d >= start) && (!end || d <= end);
    });
  }

  renderStatus() {
    if (this.preview) return;
    const ok = Object.values(this.results).filter((r) => r && !r.error);
    const errors = Object.values(this.results).filter((r) => r && r.error);
    const keyMissing = errors.some((r) => r.code === 'FMH_KEY_MISSING');
    const syncedTimes = ok.map((r) => r.meta && r.meta.synced_at).filter(Boolean).sort();
    const latest = ok
      .filter((r) => r.meta && r.meta.quota && r.meta.quota.monthly_row_limit !== undefined)
      .sort((a, b) => String(b.meta.synced_at).localeCompare(String(a.meta.synced_at)))[0];

    this.statusEl.innerHTML = '';
    const bar = document.createElement('div');
    bar.className = 'fmh-status-bar';
    const oldest = fmtDateTime(syncedTimes[0]);
    const all = Object.values(this.results).filter(Boolean);
    const healthOf = (r) => (r.meta && r.meta.health) || r.health || {};
    const savedAvailable = all.some((r) => healthOf(r).saved_synced_at);
    const failed = all.filter((r) => healthOf(r).last_error);
    const lastFail = failed.map((r) => healthOf(r).last_error_at).sort().pop();
    const emptyLive = ok.some((r) => Array.isArray(r.data) && !r.data.length);
    const trouble = failed.length || errors.some((r) => r.code !== 'FMH_KEY_MISSING') || emptyLive;
    const savedTimes = ok.filter((r) => r.meta && r.meta.from_saved).map((r) => r.meta.synced_at).sort();
    const savedAsOf = fmtDateTime(savedTimes[savedTimes.length - 1]);

    const toggle = this.useSaved
      ? '<button type="button" class="btn small ghost saved-toggle" data-on="0">กลับไปใช้ข้อมูลล่าสุด</button>'
      : savedAvailable
        ? `<button type="button" class="btn small ${trouble ? 'primary' : 'ghost'} saved-toggle" data-on="1">ใช้ข้อมูลที่เก็บไว้</button>`
        : '';
    bar.innerHTML = this.useSaved
      ? `<div class="fmh-sync-line saved-mode-line">
           <span><strong>กำลังใช้ข้อมูลที่เก็บไว้</strong>${savedAsOf ? ` · ดึงไว้เมื่อ ${esc(savedAsOf)}` : ''} · ช่วงวันที่นับจากวันนั้น ไม่ดึงข้อมูลใหม่จาก FMH</span>
           ${toggle}
         </div>`
      : `<div class="fmh-sync-line">
           <span>${
             this.dashboard.data_source === 'demo'
               ? `<span class="demo-pill">ข้อมูลตัวอย่าง</span> <span class="muted">${
                   isCompanyAdmin() && !this.preview
                     ? '<strong>ตัวเลขเป็นข้อมูลตัวอย่าง ไม่ใช่ของร้านคุณ</strong> <span class="hide-m">ลองจัด dashboard ให้ถูกใจได้เต็มที่ widget และการจัดวางจะอยู่ครบเมื่อสลับเป็นข้อมูลจริง</span>'
                     : 'ตัวเลขนี้เป็นข้อมูลตัวอย่าง ไม่ใช่ข้อมูลจริงของร้าน'
                 }</span>`
               : oldest ? (this.dashboard.auto_sync_mode === 'off' ? `ข้อมูลล่าสุด: ${esc(oldest)} · ปิดการดึงอัตโนมัติ กด “ดึงข้อมูลใหม่” เมื่อต้องการ` : this.dashboard.auto_sync_mode === 'light' ? `ข้อมูลล่าสุด: ${esc(oldest)} · อัปเดตอัตโนมัติทุกคืน รายงานใหญ่สัปดาห์ละครั้ง` : `ข้อมูลล่าสุด: ${esc(oldest)} · ระบบอัปเดตอัตโนมัติทุกวันตี 1`) : keyMissing ? '' : 'ยังไม่เคย sync ข้อมูล'
           }</span>
           <span class="sync-actions">${this.dashboard.data_source === 'demo' ? '' : toggle}${this.dashboard.data_source === 'demo' && isCompanyAdmin() && !this.preview ? '<button type="button" class="btn small primary use-real-btn">พร้อมใช้ข้อมูลจริงแล้ว</button>' : ''}${keyMissing || this.dashboard.data_source === 'demo' ? '' : '<button type="button" class="btn small ghost fmh-refresh-btn">ดึงข้อมูลใหม่</button>'}</span>
         </div>
         ${
           failed.length
             ? `<div class="warn-msg">อัปเดตข้อมูลจาก FMH ครั้งล่าสุดไม่สำเร็จ${lastFail ? ` (${esc(fmtDateTime(lastFail))})` : ''} — ตัวเลขที่เห็นเป็นชุดก่อนหน้า${savedAvailable ? ' หรือกด "ใช้ข้อมูลที่เก็บไว้"' : ''}</div>`
             : ''
         }`;

    if (latest && !this.useSaved) {
      const q = latest.meta.quota;
      const limit = Number(q.monthly_row_limit) || 0;
      const used = Number(q.rows_used) || 0;
      const remaining = q.rows_remaining ?? Math.max(0, limit - used);
      const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
      const low = limit ? remaining / limit < 0.1 : false;
      const resets = q.resets_at ? new Date(q.resets_at).toLocaleDateString(I18N.locale(), { day: 'numeric', month: 'short' }) : null;
      bar.insertAdjacentHTML(
        'beforeend',
        `<div class="fmh-quota">
           <span>FMH API quota เดือนนี้: ${used.toLocaleString('th-TH')} / ${limit.toLocaleString('th-TH')} แถว (เหลือ ${Number(remaining).toLocaleString('th-TH')})${resets ? ` · รีเซ็ต ${esc(resets)}` : ''}</span>
           <span class="fmh-quota-track" role="img" aria-label="ใช้ไป ${pct.toFixed(0)}%"><span class="fmh-quota-fill${low ? ' fmh-quota-fill-low' : ''}" style="width:${pct}%"></span></span>
         </div>`
      );
    }
    // Older months from uploaded FMH files: where they start, and any month
    // left between the last file and the API window.
    const hist = Object.entries(this.results)
      .filter(([, r]) => r && !r.error && r.meta && r.meta.history && r.meta.history.file_from)
      .map(([k, r]) => ({ label: (this.sources[k] || {}).label || k, ...r.meta.history }));
    if (hist.length && !this.useSaved) {
      const gaps = hist.filter((h) => h.api_from && Date.parse(h.api_from) - Date.parse(h.file_to) > 3 * 86400000);
      bar.insertAdjacentHTML(
        'beforeend',
        `<div class="fmh-sync-line history-line"><span>ข้อมูลย้อนหลังจากไฟล์ FMH: ${hist.map((h) => `${esc(h.label)} ตั้งแต่ ${esc(dayLabel(h.file_from))}`).join(' · ')}</span></div>` +
          gaps.map((h) => `<div class="warn-msg">${esc(h.label)}: ยังไม่มีข้อมูลช่วง ${esc(dayLabel(nextDay(h.file_to)))} – ${esc(dayLabel(prevDay(h.api_from)))} — อัปโหลดไฟล์ของช่วงนี้เพิ่ม</div>`).join('')
      );
    }
    // Days kept automatically after they leave the API window (lib/fmhArchive.js).
    const arch = Object.entries(this.results)
      .filter(([, r]) => r && !r.error && r.meta && r.meta.history && r.meta.history.archive_from)
      .map(([k, r]) => ({ label: (this.sources[k] || {}).label || k, from: r.meta.history.archive_from }));
    if (arch.length && !this.useSaved) {
      bar.insertAdjacentHTML('beforeend', `<div class="fmh-sync-line archive-line"><span>ข้อมูลย้อนหลังที่ระบบเก็บไว้ให้ ถึง ${esc(dayLabel(arch.map((h) => h.from).sort()[0]))} (เกินช่วงที่ FMH ส่งให้)</span></div>`);
    }
    if (this.fileCapable && (isCompanyAdmin() || isSuper()) && !this.useSaved && this.dashboard.data_source !== 'demo') {
      const line = bar.querySelector('.history-line') || bar.querySelector('.fmh-sync-line');
      const actions = line && (line.querySelector('.sync-actions') || line);
      if (actions) {
        actions.insertAdjacentHTML('beforeend', ' <button type="button" class="btn small ghost history-upload-btn">อัปโหลดไฟล์ย้อนหลัง</button>');
        actions.querySelector('.history-upload-btn').addEventListener('click', () => {
          adminState.selected = isSuper() ? { type: 'company', id: this.dashboard.company_id } : { type: 'my-dashboards', id: state.user.company_id };
          adminState.focus = 'fmh-files';
          openAdminConsole();
        });
      }
    }
    // A pull that hit the page cap holds only part of the period. Say which
    // ones, because every widget reading them is drawing an incomplete picture.
    const clipped = Object.entries(this.results)
      .filter(([, r]) => r && r.meta && r.meta.quota && r.meta.quota.truncated)
      .map(([k]) => k);
    if (clipped.length) {
      bar.insertAdjacentHTML(
        'beforeend',
        `<div class="error-msg" style="margin:4px 0 0;">ข้อมูลบางรายงานถูกตัดที่ ${Number(
          this.results[clipped[0]].meta.quota.row_cap || 0
        ).toLocaleString('th-TH')} แถว (${clipped.map(esc).join(', ')}) — ตัวเลขที่เห็นยังไม่ครบทั้งช่วง ควรแคบช่วงวันลง</div>`
      );
    }
    const tg = bar.querySelector('.saved-toggle');
    if (tg) tg.addEventListener('click', () => this.switchSaved(tg.dataset.on === '1'));
    if (keyMissing && !this.useSaved) bar.insertAdjacentHTML('beforeend', `<div class="error-msg" style="margin:4px 0 0;">${esc(keyMissingMessage())}</div>`);
    this.statusEl.appendChild(bar);
    if (state.realNoteUntil && Date.now() < state.realNoteUntil && this.dashboard.data_source !== 'demo') {
      const note = document.createElement('div');
      note.className = 'real-note';
      note.setAttribute('role', 'status');
      note.innerHTML = '<span><b>กำลังดึงข้อมูลจริงของร้านคุณ</b> ตัวเลขจะค่อยๆ ขึ้นภายในไม่กี่นาที เดือนปัจจุบันยังไม่จบและข้อมูลย้อนหลังอาจยังไม่ครบ ตัวเลขต้นทุนช่วงแรกจึงอาจต่ำหรือสูงกว่าจริง</span><button type="button" class="btn small ghost real-note-x">เข้าใจแล้ว</button>';
      note.querySelector('.real-note-x').addEventListener('click', () => { state.realNoteUntil = 0; note.remove(); });
      bar.after(note);
    }

    const real = bar.querySelector('.use-real-btn');
    if (real) real.addEventListener('click', () => showRealConfirm(bar, this.dashboard.id));
    const btn = bar.querySelector('.fmh-refresh-btn');
    if (btn) {
      const failNote = (err) => {
        btn.disabled = false;
        btn.textContent = 'ดึงข้อมูลใหม่';
        const note = document.createElement('div');
        note.className = 'inline-note';
        note.textContent = err.message;
        bar.appendChild(note);
        setTimeout(() => note.remove(), 6000);
      };
      const doRefresh = async () => {
        btn.disabled = true;
        btn.textContent = 'กำลัง refresh...';
        try {
          await api(`/api/dashboards/${this.dashboard.id}/refresh`, { method: 'POST' });
          await this.load();
        } catch (err) {
          failNote(err);
        }
      };
      btn.addEventListener('click', async () => {
        // Say what it will cost first when it is more than a few rows: every row counts against the month's FMH quota.
        btn.disabled = true;
        let est = null;
        try { est = await api(`/api/dashboards/${this.dashboard.id}/refresh-estimate`); } catch (e) { /* no estimate: just pull */ }
        btn.disabled = false;
        if (!est || est.demo || !est.will_pull || (est.total < REFRESH_WARN_ROWS && !est.unknown && !refreshNearQuota(est))) return doRefresh();
        showRefreshConfirm(bar, est, doRefresh);
      });
    }
  }

  // ---- "เช้านี้ต้องทำ": the most urgent open alerts across the company, with รับทราบ / มอบหมาย ----
  async renderToday() {
    const box = this.todayEl;
    let data;
    try { data = await api(`/api/dashboards/${this.dashboard.id}/today`); } catch (e) { box.hidden = true; return; }
    // A branch manager sees their branch's items plus company-wide ones.
    const open = data.items.filter((i) => !i.ack_status);
    const taken = data.items.filter((i) => i.ack_status);
    if (!data.items.length) { box.hidden = true; return; }
    box.hidden = false;
    // A slim warning line by default: the page leads with what the numbers found, and the
    // to-do list opens when someone wants it (remembered for the day).
    const fold = `kss_today_open_${this.dashboard.id}_${data.day}`;
    const phone = matchMedia('(max-width: 700px)').matches;
    let folded = true;
    try { folded = localStorage.getItem(fold) !== '1'; } catch (e) { /* private window */ }
    // Deep link from the LINE digest button (/?alerts=1): open the card and bring it into view once.
    let deepLink = false;
    try { deepLink = !this.deepLinked && new URLSearchParams(location.search).get('alerts') === '1'; } catch (e) { /* no URL */ }
    if (deepLink) { folded = false; this.deepLinked = true; setTimeout(() => box.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300); }
    const SHOW = phone ? 3 : 5;
    const crit = data.items.filter((i) => !i.ack_status && i.severity === 'วิกฤต').length;
    const sumOpen = data.items.filter((i) => !i.ack_status).reduce((a, i) => a + (Number(i.impact) || 0), 0);
    const sevCls = { 'วิกฤต': 'crit', 'สูง': 'high', 'กลาง': 'mid' };
    const money = (v) => (v ? '฿' + Math.round(v).toLocaleString('th-TH') : '');
    const people = data.people || [];
    const sampleMode = this.dashboard.data_source === 'demo';
    const item = (it, i) => `<li class="today-item" data-i="${i}">
        <span class="sev-pill sev-${sevCls[it.severity] || 'mid'}">${esc(it.severity)}</span>
        <div class="today-main"><b>${esc(it.subject || it.detail)}</b>${it.owner ? `<span class="today-owner">งาน${esc(it.owner)}</span>` : ''}<span>${esc(it.subject ? it.detail : '')}</span>
          <span class="today-meta">${[it.branch, it.age_days != null ? `ค้าง ${it.age_days} วัน` : '', money(it.impact)].filter(Boolean).map(esc).join(' · ')}${it.handled ? ` · <em>${esc(it.handled)}</em>` : ''}</span></div>
        <div class="today-acts">${
          sampleMode
            ? ''
            : it.ack_status
              ? '<button type="button" class="btn small ghost t-clear">ยกเลิก</button>'
              : '<button type="button" class="btn small ghost t-ack">รับทราบ</button><button type="button" class="btn small ghost t-assign">มอบหมาย</button>'
        }${it.source && this.widgets.some((w) => w.report_source === it.source) ? '<button type="button" class="btn small ghost t-go">ดูในรายการ</button>' : ''}</div>
        <form class="today-assign" hidden><label class="sr-only" for="ta-${i}">มอบหมายให้</label><input id="ta-${i}" list="today-people-${this.dashboard.id}" placeholder="ชื่อผู้รับผิดชอบ" maxlength="80" required><button type="submit" class="btn small primary">มอบหมาย</button></form>
      </li>`;
    const all = [...open, ...taken];
    box.classList.toggle('folded', folded);
    box.classList.toggle('has-crit', crit > 0);
    const summary = open.length ? `${open.length} เรื่องยังไม่มีคนรับ${crit ? ` · วิกฤต ${crit}` : ''}${sumOpen ? ` · ยอดค้าง ฿${Math.round(sumOpen).toLocaleString('th-TH')}` : ''}` : 'ทุกเรื่องมีคนรับแล้ว';
    box.innerHTML = `<button type="button" class="today-bar today-fold" aria-expanded="${!folded}" aria-controls="today-body-${this.dashboard.id}">
        <span class="today-ico" aria-hidden="true">!</span>
        <b>เช้านี้ต้องทำ</b>${sampleMode ? ' <span class="demo-pill">ตัวอย่าง</span>' : ''}
        <span class="today-sum">${summary}${taken.length ? ` · รับแล้ว ${taken.length}` : ''}</span>
        <span class="today-toggle">${folded ? 'ดูรายการ' : 'ย่อ'}</span>
      </button>
      <div class="today-body" id="today-body-${this.dashboard.id}"${folded ? ' hidden' : ''}>
        ${sampleMode ? '<p class="muted today-note">รายการนี้สร้างจากข้อมูลตัวอย่าง ไม่ใช่งานค้างจริงของร้านคุณ ปุ่มรับทราบ/มอบหมายจะใช้ได้เมื่อเป็นข้อมูลจริง</p>' : ''}
        <ul class="today-list">${open.slice(0, SHOW).map((it) => item(it, all.indexOf(it))).join('') || '<li class="today-empty">ไม่มีเรื่องค้างที่ยังไม่มีคนรับ</li>'}</ul>
        ${open.length > SHOW ? `<p class="today-more">และอีก ${open.length - SHOW} เรื่อง${this.widgets.some((w) => /^watch_/.test(w.template_key || '')) ? 'ในตารางตัวเตือนด้านล่าง' : ''}</p>` : ''}
        ${taken.length ? `<details class="today-taken"><summary>รับแล้ว ${taken.length} เรื่อง</summary><ul class="today-list">${taken.map((it) => item(it, all.indexOf(it))).join('')}</ul></details>` : ''}
        <datalist id="today-people-${this.dashboard.id}">${people.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
        <p class="today-msg" role="status"></p>
      </div>`;
    box.querySelector('.today-fold').addEventListener('click', () => {
      try { localStorage.setItem(fold, folded ? '1' : '0'); } catch (e) { /* private window */ }
      this.renderToday().then(() => { const b = box.querySelector('.today-fold'); if (b) b.focus({ preventScroll: true }); });
    });
    const send = async (it, body) => {
      try {
        await api(`/api/dashboards/${this.dashboard.id}/today/ack`, { method: 'POST', body: JSON.stringify({ watcher: it.watcher, finding_key: it.finding_key, ...body }) });
        await this.renderToday();
        const m = box.querySelector('.today-msg');
        if (m && body.action !== 'clear') {
          m.className = 'today-msg ok';
          m.innerHTML = `${body.action === 'assign' ? 'มอบหมายแล้ว' : 'รับทราบแล้ว'}: ${esc(it.subject || '')} <button type="button" class="link-btn t-undo">เลิกทำ</button>`;
          m.querySelector('.t-undo').addEventListener('click', () => send(it, { action: 'clear' }));
        }
      } catch (err) { const m = box.querySelector('.today-msg'); if (m) m.textContent = err.message; }
    };
    box.querySelectorAll('.today-item').forEach((li) => {
      const it = all[Number(li.dataset.i)];
      const q = (sel) => li.querySelector(sel);
      if (q('.t-ack')) q('.t-ack').addEventListener('click', () => send(it, { action: 'ack' }));
      if (q('.t-clear')) q('.t-clear').addEventListener('click', () => send(it, { action: 'clear' }));
      if (q('.t-assign')) q('.t-assign').addEventListener('click', () => { const f = q('.today-assign'); f.hidden = !f.hidden; if (!f.hidden) f.querySelector('input').focus(); });
      q('.today-assign').addEventListener('submit', (e) => { e.preventDefault(); send(it, { action: 'assign', to: q('.today-assign input').value.trim() }); });
      if (q('.t-go')) q('.t-go').addEventListener('click', () => {
        const w = this.widgets.find((x) => x.report_source === it.source);
        const el = w && this.wrap.querySelector(`.widget-card[data-wid="${w.id}"]`);
        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
      });
    });
  }

  // ---- Arrange mode: drag cards on a 6-column grid, snap width to ⅓ / ½ / full and height to 1-3 rows ----
  arrange() {
    const grid = this.wrap.querySelector('.widget-grid');
    if (!grid || this.arranging) return;
    this.arranging = true;
    const SIZES = [['third', 2, '⅓'], ['half', 3, '½'], ['full', 6, 'เต็มแถว']];
    const sizeOf = (c) => (c.classList.contains('size-full') ? 'full' : c.classList.contains('size-third') ? 'third' : 'half');
    const rowsOf = (c) => (c.classList.contains('rows-3') ? 3 : c.classList.contains('rows-2') ? 2 : 1);
    const cards = () => [...grid.querySelectorAll('.widget-card')];
    const before = cards().map((c) => ({ el: c, size: sizeOf(c), rows: rowsOf(c) }));
    let dirty = false;

    const bar = document.createElement('div');
    bar.className = 'arrange-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'โหมดจัดเรียง');
    bar.innerHTML = `<div class="arrange-text"><b>โหมดจัดเรียง</b><span>ลากที่ <span class="arr-grip-ico" aria-hidden="true">⠿</span> เพื่อย้าย · เลือกความกว้าง ⅓ / ½ / เต็มแถว · ลากมุมขวาล่างเพื่อปรับขนาด</span></div>
      <div class="arrange-actions"><button type="button" class="btn small ghost arr-picker">เพิ่ม / เอาออก Widget</button><button type="button" class="btn small ghost arr-cancel">ยกเลิก</button><button type="button" class="btn small primary arr-save" disabled>บันทึกการจัดเรียง</button></div>
      <p class="arrange-msg" role="status"></p>`;
    grid.before(bar);
    grid.classList.add('arranging');
    document.body.classList.add('arranging-on');
    const hidden = [this.todayEl, this.filterEl, this.statusEl].filter(Boolean);
    hidden.forEach((n) => n.classList.add('arr-hide'));
    const markDirty = () => { dirty = true; bar.querySelector('.arr-save').disabled = false; };

    const setSize = (c, size) => {
      c.classList.remove('size-third', 'size-half', 'size-full');
      c.classList.add(`size-${size}`);
      c.querySelectorAll('.arr-size button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.size === size ? 'true' : 'false'));
      // A table squeezed into ⅓ cuts its text: say so rather than refuse.
      const tools = c.querySelector('.arr-tools');
      const old = c.querySelector('.arr-warn');
      if (old) old.remove();
      if (size === 'third' && c.classList.contains('widget-table') && tools) tools.insertAdjacentHTML('afterend', '<p class="arr-warn">ตารางแคบเกินไปที่ ⅓ แถว แนะนำ ½ หรือเต็มแถว</p>');
    };
    const setRows = (c, n) => { c.classList.remove('rows-2', 'rows-3'); if (n > 1) c.classList.add(`rows-${n}`); };

    cards().forEach((c) => {
      const locked = c.classList.contains('layout-locked');
      const t = (c.querySelector('.widget-title') || {}).textContent || 'widget';
      const tools = document.createElement('div');
      tools.className = 'arr-tools';
      tools.innerHTML = `<button type="button" class="arr-grip" aria-label="ย้าย ${esc(t)} (ใช้ลูกศรซ้าย/ขวาก็ได้)" title="ลากเพื่อย้าย"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg><span>ลากเพื่อย้าย</span></button>
        ${locked ? '<span class="arr-locked">ขนาดล็อกไว้ (เต็มแถว สูง 3 แถว)</span>' : `<span class="arr-size" role="group" aria-label="ความกว้าง">${SIZES.map(([k, , l]) => `<button type="button" data-size="${k}" aria-pressed="${sizeOf(c) === k}">${l}</button>`).join('')}</span>`}`;
      c.prepend(tools);
      const rz = document.createElement('button');
      rz.type = 'button';
      rz.className = 'arr-resize';
      rz.setAttribute('aria-label', `ปรับขนาด ${t}`);
      rz.title = 'ลากเพื่อปรับขนาด';
      if (!locked) c.appendChild(rz);
      tools.querySelectorAll('.arr-size button').forEach((b) => b.addEventListener('click', () => { setSize(c, b.dataset.size); markDirty(); }));
      setSize(c, sizeOf(c));
      const grip = tools.querySelector('.arr-grip');

      // Move: the card follows the pointer through the grid; others reflow around it.
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        grip.setPointerCapture(e.pointerId);
        c.classList.add('arr-dragging');
        const move = (ev) => {
          const under = document.elementsFromPoint(ev.clientX, ev.clientY).find((n) => n.classList && n.classList.contains('widget-card') && n !== c);
          if (!under) return;
          const r = under.getBoundingClientRect();
          const after = ev.clientY > r.bottom - r.height / 3 || (ev.clientX > r.left + r.width / 2 && ev.clientY > r.top + r.height / 3);
          const ref = after ? under.nextSibling : under;
          if (ref !== c && ref !== c.nextSibling) { grid.insertBefore(c, ref); markDirty(); }
          if (ev.clientY < 80) window.scrollBy(0, -18); else if (ev.clientY > innerHeight - 80) window.scrollBy(0, 18);
        };
        const up = () => {
          c.classList.remove('arr-dragging');
          grip.removeEventListener('pointermove', move);
          grip.removeEventListener('pointerup', up);
          grip.removeEventListener('pointercancel', up);
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
        grip.addEventListener('pointercancel', up);
      });
      grip.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); if (c.previousElementSibling) { grid.insertBefore(c, c.previousElementSibling); markDirty(); grip.focus(); } }
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); if (c.nextElementSibling) { grid.insertBefore(c.nextElementSibling, c); markDirty(); grip.focus(); } }
      });

      // Resize: drag the corner; width snaps to 2 / 3 / 6 of 6 columns, height to 1-3 rows.
      rz.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        rz.setPointerCapture(e.pointerId);
        c.classList.add('arr-resizing');
        const g = grid.getBoundingClientRect();
        const col = (g.width - 5 * 16) / 6 + 16;
        const top = c.getBoundingClientRect().top;
        const move = (ev) => {
          const span = (ev.clientX - c.getBoundingClientRect().left) / col;
          const size = span < 2.5 ? 'third' : span < 4.5 ? 'half' : 'full';
          const h = ev.clientY - top;
          const rows = h < 450 ? 1 : h < 660 ? 2 : 3;
          if (size !== sizeOf(c)) { setSize(c, size); markDirty(); }
          if (rows !== rowsOf(c)) { setRows(c, rows); markDirty(); }
        };
        const up = () => { c.classList.remove('arr-resizing'); rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', up); rz.removeEventListener('pointercancel', up); };
        rz.addEventListener('pointermove', move);
        rz.addEventListener('pointerup', up);
        rz.addEventListener('pointercancel', up);
      });
      rz.addEventListener('keydown', (e) => {
        const order = ['third', 'half', 'full'];
        const i = order.indexOf(sizeOf(c));
        if (e.key === 'ArrowRight' && i < 2) { setSize(c, order[i + 1]); markDirty(); }
        else if (e.key === 'ArrowLeft' && i > 0) { setSize(c, order[i - 1]); markDirty(); }
        else if (e.key === 'ArrowDown' && rowsOf(c) < 3) { setRows(c, rowsOf(c) + 1); markDirty(); }
        else if (e.key === 'ArrowUp' && rowsOf(c) > 1) { setRows(c, rowsOf(c) - 1); markDirty(); }
        else return;
        e.preventDefault();
      });
    });

    const exit = () => {
      this.arranging = false;
      bar.remove();
      grid.classList.remove('arranging');
      grid.querySelectorAll('.arr-tools, .arr-resize, .arr-warn').forEach((n) => n.remove());
      document.body.classList.remove('arranging-on');
      hidden.forEach((n) => n.classList.remove('arr-hide'));
    };
    bar.querySelector('.arr-cancel').addEventListener('click', () => {
      before.forEach(({ el, size, rows }) => { grid.appendChild(el); setSize(el, size); setRows(el, rows); });
      exit();
    });
    bar.querySelector('.arr-picker').addEventListener('click', () => {
      if (dirty) { bar.querySelector('.arrange-msg').textContent = 'บันทึกหรือยกเลิกการจัดเรียงก่อน แล้วค่อยเพิ่ม / เอาออก widget'; return; }
      exit();
      this.openPicker();
    });
    bar.querySelector('.arr-save').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'กำลังบันทึก...';
      const items = cards().map((c) => ({ id: Number(c.dataset.wid), size: sizeOf(c), rows: rowsOf(c) }));
      try {
        await api(`/api/admin/dashboards/${this.dashboard.id}/arrange`, { method: 'PUT', body: JSON.stringify({ items }) });
        const byId = new Map(this.widgets.map((w) => [w.id, w]));
        this.widgets = items.map((it) => {
          const w = byId.get(it.id);
          w.config = { ...w.config, size: it.size };
          if (it.rows > 1) w.config.rows = it.rows; else delete w.config.rows;
          return w;
        });
        exit();
        this.renderWidgets();
      } catch (err) {
        bar.querySelector('.arrange-msg').textContent = err.message;
        btn.disabled = false;
        btn.textContent = 'บันทึกการจัดเรียง';
      }
    });
    const first = grid.querySelector('.arr-grip');
    if (first) first.focus({ preventScroll: true });
    bar.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  renderWidgets() {
    destroyCharts();
    this.renderBasis();
    this.renderCoverage();
    // What each widget drew, for its "อธิบาย" button (public/explain.js).
    this.explainData = new Map();
    (this.cards || []).forEach(({ widget, body }) => {
      body.innerHTML = '';
      const key = this.keyFor(widget);
      const res = this.results[key];
      if (!res) return;
      if (res.error) {
        body.innerHTML = `<p class="muted">${esc(res.code === 'FMH_KEY_MISSING' ? 'ยังไม่มีข้อมูล' : res.error)}</p>`;
        if (res.code === 'POS_NO_UPLOAD' && isCompanyAdmin()) {
          body.insertAdjacentHTML('beforeend', '<button type="button" class="btn small primary">อัปโหลดไฟล์ยอดขาย POS</button>');
          body.querySelector('button').addEventListener('click', () => {
            adminState.selected = { type: 'my-dashboards', id: state.user.company_id };
            adminState.focus = 'pos';
            openAdminConsole();
          });
        }
        return;
      }
      const cfg = DateBasis.applyToConfig(themedCfg(widget.config || {}), widget.report_source, widget.pulls ? null : this.dateFieldOf(key), I18N.lang);
      // A composite widget draws several small charts, each from its own pull.
      if (widget.pulls && cfg.panels) {
        const byAlias = {};
        widget.pulls.forEach((p) => {
          const r = this.results[p.key];
          byAlias[p.as] = r && !r.error ? this.rowsFor(p.key, widget, p.date_field) || [] : null;
        });
        this.explainData.set(widget.id, { panels: true });
        try {
          renderPanels(body, byAlias, cfg);
        } catch (err) {
          console.error('Widget render failed', widget, err);
          body.innerHTML = `<p class="muted">แสดงผล widget นี้ไม่สำเร็จ (${esc(err.message)})</p>`;
        }
        return;
      }
      // A pivot widget's rows are computed here from several pulls; everything
      // after this line treats them like any other rows.
      let raw;
      if (widget.pulls && cfg.pivot) {
        const missing = widget.pulls.filter((p) => {
          const r = this.results[p.key];
          return !r || r.error;
        });
        if (missing.length) {
          const first = this.results[missing[0].key];
          body.innerHTML = `<p class="muted">${esc(
            (first && first.error) || 'ยังไม่มีข้อมูลของรายงานที่ widget นี้ต้องใช้'
          )}</p>`;
          return;
        }
        const byAlias = {};
        const minStart = cfg.max_range_days ? daysAgoIso(cfg.max_range_days - 1) : null;
        widget.pulls.forEach((p) => {
          let rows = this.rowsFor(p.key, widget, p.date_field, minStart) || [];
          // a source narrowed to some rows (only the kitchen's purchases); with fallback, all rows
          // when none match, and the widget says so
          if (p.where) {
            const kept = rows.filter((r) => rowMatches(p.where, r));
            if (kept.length || !p.where_fallback) rows = kept;
            else (this.whereFell ||= new Set()).add(widget.id);
          }
          byAlias[p.as] = rows;
        });
        raw = pivotRows(byAlias, cfg) || [];
      } else {
        raw = this.rowsFor(key, widget, cfg.row_date_field);
      }
      const rows = applyRowLayer(raw, cfg);
      if (!rows.length) {
        // Three different situations used to share one sentence, and it named
        // the date range even for sources that carry no date — which sent me
        // looking at the range picker when the pull itself was empty.
        const filtered = raw.length && !rows.length;
        const dated = !widget.pulls && !!(this.sources[key] && this.sources[key].date_field) && this.hasDateSource;
        // An alert widget with nothing found is good news, or says why it can't look.
        const watch = res && res.meta && res.meta.quota && res.meta.quota.watch;
        this.explainData.set(widget.id, { empty: watch && !raw.length ? watch.note || cfg.empty_message || 'ไม่มีเรื่องผิดปกติในวันนี้' : cfg.empty_message || 'ไม่พบข้อมูลในช่วงวันที่และตัวกรองที่เลือก' });
        body.innerHTML = `<p class="muted">${esc(
          watch && !raw.length
            ? watch.note || cfg.empty_message || 'ไม่มีเรื่องผิดปกติ'
            : filtered
            ? cfg.empty_message || 'ไม่พบรายการที่เข้าเงื่อนไขของ widget นี้'
            : dated
              ? 'ไม่พบข้อมูลในช่วงวันที่เลือก'
              : 'รายงานนี้ไม่มีข้อมูลสำหรับบริษัทนี้'
        )}</p>`;
        // An uploaded POS file covers the days it covers, which are often not
        // "the last 30 days": say which days it has and offer to jump there.
        const pos = res.meta && res.meta.quota && res.meta.quota.pos;
        if (dated && pos && pos.date_to && !raw.length) {
          body.insertAdjacentHTML(
            'beforeend',
            `<p class="muted">ไฟล์ยอดขาย POS มีข้อมูลวันที่ ${esc(pos.date_from)} ถึง ${esc(pos.date_to)}</p><button type="button" class="btn small ghost">ดูช่วงวันที่ของไฟล์</button>`
          );
          body.querySelector('button').addEventListener('click', () => this.setRange(pos.date_from, pos.date_to));
        }
        if (dated) body.insertAdjacentHTML('beforeend', this.coverageNote(widget));
        return;
      }
      // A widget that only makes sense on a big screen says so instead of squeezing itself onto a phone.
      if (cfg.desktop_only && window.matchMedia && window.matchMedia('(max-width: 700px)').matches) {
        this.explainData.set(widget.id, { empty: 'widget นี้ใช้งานบนมือถือไม่ได้' });
        body.innerHTML = '<div class="desktop-only" role="note"><b>widget นี้ใช้งานบนมือถือไม่ได้</b><p>ตารางนี้กว้างและมีตัวเลขเยอะ กรุณาเปิดบนคอมพิวเตอร์หรือแท็บเล็ต</p></div>';
        window.matchMedia('(max-width: 700px)').addEventListener('change', () => this.renderWidgets(), { once: true });
        return;
      }
      const renderer = RENDERERS[widget.chart_type];
      if (!renderer) {
        body.innerHTML = `<p class="muted">ไม่รู้จักประเภท widget: ${esc(widget.chart_type)}</p>`;
        return;
      }
      // Day / week / month switch on the widget itself.
      let useCfg = cfg;
      if (cfg.bucket_toggle) {
        let saved = null;
        try { saved = localStorage.getItem(`kss_bucket_${widget.id}`); } catch (e) { /* private window */ }
        // Over months, a day per bar is unreadable: long ranges open by month
        // (or week, if that was the saved choice) until the user picks again.
        const longRange = this.range.start && Date.parse(this.range.end) - Date.parse(this.range.start) > 120 * 86400000;
        const pickB = this.bucketPick.get(widget.id) || (longRange ? (saved === 'week' ? 'week' : 'month') : saved || cfg.bucket || 'day');
        useCfg = { ...cfg, bucket: pickB };
        const seg = document.createElement('div');
        seg.className = 'bucket-toggle';
        seg.innerHTML = [['day', 'วัน'], ['week', 'สัปดาห์'], ['month', 'เดือน']]
          .map(([b, l]) => `<button type="button" class="range-chip${b === pickB ? ' active' : ''}" data-b="${b}">${l}</button>`).join('');
        seg.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => {
          this.bucketPick.set(widget.id, btn.dataset.b);
          try { localStorage.setItem(`kss_bucket_${widget.id}`, btn.dataset.b); } catch (e) { /* private window */ }
          this.renderWidgets();
        }));
        body.appendChild(seg);
      }
      // One colour per series for good: ranked on the whole pull, not on what
      // the filters left, so a customer keeps its colour when you narrow the page.
      if (cfg.series_by && !widget.pulls && res.data) {
        const all = applyRowLayer(res.data, { derived: cfg.derived });
        const totals = new Map();
        all.forEach((r) => { const k = String(pick(r, cfg.series_by) ?? 'ไม่ระบุ'); totals.set(k, (totals.get(k) || 0) + evalMetric(cfg.value, [r])); });
        useCfg = { ...useCfg, series_order: [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k) };
      }
      const base = widget.pulls ? this.results[widget.pulls[0].key] : res;
      const skipped = this.unfilteredBy(base && base.data);
      try {
        renderer(body, rows, useCfg, { widget, dashboardId: this.dashboard.id, persist: !this.preview, syncedAt: res && res.meta ? res.meta.synced_at : null, range: this.range, quota: res && res.meta ? res.meta.quota : null });
        this.explainData.set(widget.id, { rows, cfg: useCfg, range: this.range });
        if (skipped.length) body.insertAdjacentHTML('beforeend', `<p class="widget-foot">widget นี้ไม่มีข้อมูล${esc(skipped.map((f) => ({ customer: 'ลูกค้า', branch: 'สาขา', supplier: 'ซัพพลายเออร์' })[f] || f).join(', '))} จึงแสดงทั้งหมด ไม่ได้กรองตามตัวเลือกด้านบน</p>`);
        // A note on how to read the widget. Renderers that place it themselves
        // (range) are left alone.
        // A widget that needs a long span to mean anything says so when the range is shorter.
        const span = this.range.start && this.range.end ? (Date.parse(this.range.end) - Date.parse(this.range.start)) / 86400000 + 1 : null;
        const cut = cfg.max_range_days ? daysAgoIso(cfg.max_range_days - 1) : null;
        if (cut && this.range.start && this.range.start < cut) body.insertAdjacentHTML('beforeend', `<p class="widget-foot warn-msg">ข้อมูลของเสียจาก FMH ย้อนหลังได้ ${cfg.max_range_days} วัน widget นี้จึงนับทั้งสองฝั่งตั้งแต่ ${esc(dayLabel(cut))}</p>`);
        if (cfg.min_range_days && span && span < cfg.min_range_days) body.insertAdjacentHTML('beforeend', `<p class="widget-foot warn-msg">ช่วงที่เลือกสั้นกว่า ${cfg.min_range_days} วัน ตัวเลขอาจแกว่งมาก ลองเลือก ${cfg.min_range_days} วันขึ้นไป</p>`);
        if (cfg.foot && widget.chart_type !== 'range') body.insertAdjacentHTML('beforeend', `<p class="widget-foot widget-note">${esc(cfg.foot).replace(/\n/g, '<br>')}</p>`);
        body.insertAdjacentHTML('beforeend', this.coverageNote(widget));
        const clippedPull = (widget.pulls ? widget.pulls.map((p) => p.key) : [key]).some((k) => { const r = this.results[k]; return r && r.meta && r.meta.quota && r.meta.quota.truncated; });
        if (this.whereFell && this.whereFell.has(widget.id) && cfg.where_fallback_note) body.insertAdjacentHTML('beforeend', `<p class="widget-foot warn-msg">${esc(cfg.where_fallback_note)}</p>`);
        if (clippedPull) body.insertAdjacentHTML('beforeend', '<p class="widget-foot warn-msg">ข้อมูลของ widget นี้ถูกตัดเพราะยาวเกินที่ดึงได้ ตัวเลขยังไม่ครบทั้งช่วง ลองเลือกช่วงวันให้สั้นลง</p>');
      } catch (err) {
        console.error('Widget render failed', widget, err);
        body.innerHTML = `<p class="muted">แสดงผล widget นี้ไม่สำเร็จ (${esc(err.message)})</p>`;
      }
    });
    // An open explanation follows the new range / filters.
    (this.cards || []).forEach(({ widget, box }) => {
      if (box && !box.hidden) box.innerHTML = explainWidget(widget, this.explainData.get(widget.id));
    });
    this.renderInsights();
  }

  // ---- "เราเจอให้คุณ": the page opens with what the numbers found, in baht ----
  // Built from the pulls the page already loaded (no extra FMH rows), for the
  // range on screen. The first-run goals decide which findings lead.
  renderInsights() {
    const el = this.insightEl;
    if (!el) return;
    el.classList.remove('loading');
    const get = (key, dateField) => {
      const r = this.results[key];
      return r && !r.error ? this.rowsFor(key, null, dateField) || [] : null;
    };
    const onPage = (keys) => {
      for (const k of keys) { const w = this.widgets.find((x) => x.template_key === k); if (w) return w; }
      return null;
    };
    const profile = this.dashboard.profile || {};
    const found = findInsights(get, onPage, profile.goals || [], { start: this.range.start, end: this.range.end, today: todayIso() });
    // the finding behind a widget also heads that widget, so % tables say what they mean in baht
    this.wrap.querySelectorAll('.widget-headline').forEach((x) => x.remove());
    found.all.forEach((f) => {
      if (!f.widget || !f.headline) return;
      const card = this.wrap.querySelector(`.widget-card[data-wid="${f.widget.id}"] .widget-body`);
      if (card) card.insertAdjacentHTML('afterbegin', `<p class="widget-headline">${esc(f.headline)}</p>`);
    });
    // a ranking whose values barely differ says so, so equal outlets are not read as a problem
    (this.cards || []).forEach(({ widget }) => {
      const c = widget.config || {};
      const d = this.explainData && this.explainData.get(widget.id);
      if (!c.flat_within || !d || !d.rows || !d.rows.length) return;
      const keyF = [].concat(c.group_by_field || [])[0];
      if (!keyF) return;
      const groups = new Map();
      d.rows.forEach((r) => { const k = pick(r, keyF); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
      if (groups.size < 2) return;
      const vals = [...groups.values()].map((rs) => evalMetric(c.value, rs));
      const gap = Math.max(...vals) - Math.min(...vals);
      if (gap >= c.flat_within) return;
      const body = this.wrap.querySelector(`.widget-card[data-wid="${widget.id}"] .widget-body`);
      if (body) body.insertAdjacentHTML('afterbegin', `<p class="widget-headline">ทุกสาขาใกล้เคียงกัน ต่างกันไม่ถึง ${c.flat_within} จุด ยังไม่มีสาขาไหนผิดปกติ</p>`);
    });
    let welcome = null;
    try { welcome = JSON.parse(sessionStorage.getItem(`kss_welcome_${this.dashboard.id}`) || 'null'); } catch (e) { /* none */ }
    const top = found.top;
    const lead = found.lead || top[0];
    // findings past the three cards stay reachable: one line, each to its widget
    const rest = found.all.filter((f) => !top.includes(f)).sort((a, b) => b.baht - a.baht);
    if (!top.length && !welcome) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const sample = this.dashboard.data_source === 'demo';
    const money = (v) => fmtValue(v, 'currency');
    // announced once, not on every range or filter change
    const announce = welcome && !this.welcomeAnnounced;
    if (welcome) this.welcomeAnnounced = true;
    const hid = `ins-h-${this.dashboard.id}`;
    const bid = `ins-body-${this.dashboard.id}`;
    // A slim line like "เช้านี้ต้องทำ": the biggest finding shows folded, the cards open on demand.
    // Opens by itself on the first visit after setup (the welcome strip), remembered for the day.
    const foldKey = `kss_ins_open_${this.dashboard.id}_${todayIso()}`;
    let folded = !welcome;
    try {
      const v = localStorage.getItem(foldKey);
      if (v !== null) folded = v !== '1';
      else if (welcome && top.length) localStorage.setItem(foldKey, '1'); // stays open after the welcome is closed
    } catch (e) { /* private window */ }
    el.setAttribute('aria-labelledby', hid);
    el.removeAttribute('aria-label');
    el.innerHTML = `
      ${welcome ? `<div class="ins-welcome"${announce ? ' role="status"' : ''}>
        <div><b>Dashboard ของคุณพร้อมแล้ว</b>${welcome.said && welcome.said.length ? `<span class="ins-said">จัดให้ตามที่คุณบอก: ${esc(welcome.said.join(' · '))}</span>` : ''}</div>
        <button type="button" class="btn small ghost ins-close" aria-label="ปิดข้อความต้อนรับ">ปิด</button>
      </div>` : ''}
      ${top.length ? `<div class="ins-fold-card${folded ? ' folded' : ''}">
      <h2 class="ins-h"><button type="button" class="ins-bar" aria-expanded="${!folded}" aria-controls="${bid}">
        <span class="ins-ico" aria-hidden="true">฿</span>
        <b class="ins-title" id="${hid}">เราเจอให้คุณ</b>${sample ? '<span class="demo-pill">ตัวอย่าง</span>' : ''}
        <span class="ins-count">พบ ${found.all.length} เรื่อง</span>
        ${folded ? `<span class="ins-top tone-${lead.tone || 'warn'}">${lead.kind ? `<span class="ins-kind">${esc(lead.kind)}</span>` : ''}<span class="ins-top-baht">${money(lead.baht)}</span> <span>${esc(lead.text)}</span>${lead.caveat ? `<span class="ins-caveat">${esc(lead.caveat)}</span>` : ''}</span>` : ''}
        <span class="ins-toggle">${folded ? (found.all.length > top.length ? `ดู ${top.length} เรื่องสำคัญ` : `ดูทั้ง ${top.length} เรื่อง`) : 'ย่อ'}</span>
      </button></h2>
      <div class="ins-body" id="${bid}"${folded ? ' hidden' : ''}>
      <div class="ins-grid">${top.map((f, i) => `<article class="ins-card tone-${f.tone || 'warn'}">
          <span class="ins-tag">${esc(f.tag || { warn: 'เงินที่เสียหรือควรทวง', good: 'โอกาสประหยัด', info: 'รอดำเนินการ' }[f.tone || 'warn'])}</span>
          <span class="ins-baht">${money(f.baht)}</span>
          <b class="ins-text">${esc(f.text)}</b>
          ${f.sub ? `<span class="ins-sub">${esc(f.sub)}</span>` : ''}
          ${f.note ? `<span class="ins-note">${esc(f.note)}</span>` : ''}
          ${f.widget
            ? `<button type="button" class="btn small ghost ins-go" data-i="${i}">ดูรายละเอียด</button>`
            : f.how ? `<details class="ins-how"><summary>ตัวเลขนี้คิดอย่างไร</summary><p>${esc(f.how)}</p></details>` : ''}
        </article>`).join('')}</div>
      ${rest.length ? `<p class="ins-more">อีก ${rest.length} เรื่อง: ${rest.map((f, j) => {
        const label = `<span>${esc(f.kind || f.text)}</span> <span>${money(f.baht)}</span>`;
        return f.widget ? `<button type="button" class="link-btn ins-more-go" data-j="${j}">${label}</button>` : `<span>${label}</span>`;
      }).join(' · ')}</p>` : ''}
      ${!isSuper() && state.user && state.user.company_id ? '<p class="ins-ask">อยากเห็นข้อมูลอื่นที่ยังไม่มีในหน้านี้? <button type="button" class="link-btn ins-wish">บอกเรา</button></p>' : ''}
      </div></div>` : ''}`;
    const bar = el.querySelector('.ins-bar');
    if (bar) bar.addEventListener('click', () => {
      try { localStorage.setItem(foldKey, folded ? '1' : '0'); } catch (e) { /* private window */ }
      this.renderInsights();
      const b = el.querySelector('.ins-bar');
      if (b) b.focus({ preventScroll: true });
    });
    const wishLink = el.querySelector('.ins-wish');
    if (wishLink) wishLink.addEventListener('click', () => openSupportForm({ kind: 'wish' }));
    const close = el.querySelector('.ins-close');
    if (close) close.addEventListener('click', () => {
      try { sessionStorage.removeItem(`kss_welcome_${this.dashboard.id}`); } catch (e) { /* none */ }
      this.renderInsights();
      const b = el.querySelector('.ins-bar');
      if (b) b.focus({ preventScroll: true });
    });
    const goTo = (f) => {
      const card = this.wrap.querySelector(`.widget-card[data-wid="${f.widget.id}"]`);
      if (!card) return;
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      card.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
      // keyboard and screen-reader users land on the widget, not back on the card
      if (!card.hasAttribute('tabindex')) card.tabIndex = -1;
      setTimeout(() => card.focus({ preventScroll: true }), still ? 0 : 350);
      card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1600);
    };
    el.querySelectorAll('.ins-go').forEach((b) => b.addEventListener('click', () => goTo(top[Number(b.dataset.i)])));
    el.querySelectorAll('.ins-more-go').forEach((b) => b.addEventListener('click', () => goTo(rest[Number(b.dataset.j)])));
  }
}

// ---------- findings ----------
// Each finder reads rows the page already has and returns a money finding or
// null. get(key, dateField) -> rows on the page's range (null = not loaded);
// onPage(templateKeys) -> the first of those widgets on the page.
// Every number here is the same number the widget it points to shows.
const CK_NAME = /ครัวกลาง|central\s*kitchen|commissary|\bck\b/i;
// ISO week key, so prices are only compared within the same week
const weekKey = (d) => { const t = new Date(String(d).slice(0, 10) + 'T00:00:00Z'); if (isNaN(t)) return ''; const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day); return t.toISOString().slice(0, 10); };
function findInsights(get, onPage, goals, span = {}) {
  const out = [];
  const add = (f) => { if (f && f.baht >= 100) out.push(f); };
  const baht = (v) => fmtValue(v, 'currency');
  const pa = get('purchase-analysis');
  const keyOfLine = (r) => `${r.product_code || r.product_name}|${r.uom || ''}`;

  if (pa && pa.length) {
    // 1. price moves: paid above / below the window's first price (the pc_movers definition),
    //    rises and falls both shown, so the headline agrees with the by-category chart
    const byP = new Map();
    pa.forEach((r) => { if (!isBlank(r.price) && num(r.qty)) { const k = keyOfLine(r); if (!byP.has(k)) byP.set(k, []); byP.get(k).push(r); } });
    let up = 0; let down = 0; let worst = null;
    byP.forEach((rs) => {
      if (rs.length < 2) return;
      rs.sort((a, b) => String(a.order_date).localeCompare(String(b.order_date)));
      const first = num(rs[0].price);
      const extra = rs.reduce((s, r) => s + (num(r.price) - first) * num(r.qty), 0);
      if (extra < 0) { down += -extra; return; }
      if (extra === 0) return;
      up += extra;
      // the average paid against the first price: the move that cost the money
      const q = rs.reduce((x, r) => x + num(r.qty), 0);
      const avg = q ? rs.reduce((x, r) => x + num(r.price) * num(r.qty), 0) / q : first;
      if (!worst || extra > worst.extra) worst = { extra, name: rs[0].product_name, pct: first ? ((avg - first) / first) * 100 : 0 };
    });
    const wPrice = onPage(['pc_movers', 'pc_extra_by_product', 'pc_extra_by_category', 'watch_price']);
    const moves = `ขึ้น ${baht(up)} · ลง ${baht(down)} · สุทธิ ${baht(up - down)}`;
    const how = 'เทียบราคาที่จ่ายแต่ละครั้งกับราคาครั้งแรกในช่วงที่เลือก คูณจำนวนที่ซื้อ แยกตามสินค้าและหน่วย';
    // net up: what the rises cost. Net down: prices fell overall, which is news too, not a loss.
    if (worst && up > down) add({
      id: 'price_up', goals: ['price', 'profit'], baht: up - down, text: 'จ่ายเพิ่มสุทธิเพราะราคาวัตถุดิบขึ้น',
      sub: `${moves} · มากสุด ${worst.name} ${baht(worst.extra)} (ราคาเฉลี่ยสูงกว่าครั้งแรก ${fmtValue(worst.pct, 'pct_signed')})`,
      widget: wPrice, headline: `ราคาขึ้นทำให้จ่ายเพิ่ม ${baht(up)} · ราคาลงประหยัด ${baht(down)} · สุทธิ ${baht(up - down)}`, how,
    });
    else if (down > up && down - up >= 100) add({
      id: 'price_down', goals: ['price'], tone: 'good', tag: 'ข่าวดี', baht: down - up, text: 'ราคาวัตถุดิบโดยรวมลดลง',
      sub: `${moves}${worst ? ` · แต่ ${worst.name} ยังทำให้จ่ายเพิ่ม ${baht(worst.extra)}` : ''}`,
      widget: wPrice, headline: `ราคาขึ้นทำให้จ่ายเพิ่ม ${baht(up)} · ราคาลงประหยัด ${baht(down)} · สุทธิ ${baht(up - down)}`, how,
    });

    // 2. the same item cheaper from another supplier the same week. A supplier that often
    //    delivers short (more than 15% of its invoiced lines) is never the "cheaper" one.
    const shortRate = new Map();
    pa.forEach((r) => {
      if (isBlank(r.invoice_quantity) || !num(r.po_qty)) return;
      const o = shortRate.get(r.supplier) || { n: 0, s: 0 };
      o.n++; if (num(r.invoice_quantity) < num(r.po_qty) * 0.98) o.s++;
      shortRate.set(r.supplier, o);
    });
    const reliable = (sup) => { const o = shortRate.get(sup); return !o || o.n < 5 || o.s / o.n <= 0.15; };
    let save = 0; let best = null;
    byP.forEach((rs) => {
      const byWeek = new Map();
      rs.forEach((r) => { const w = weekKey(r.order_date); if (!byWeek.has(w)) byWeek.set(w, []); byWeek.get(w).push(r); });
      byWeek.forEach((ws) => {
        const bySup = new Map();
        ws.forEach((r) => { const o = bySup.get(r.supplier) || { v: 0, q: 0 }; o.v += num(r.price) * num(r.qty); o.q += num(r.qty); bySup.set(r.supplier, o); });
        if (bySup.size < 2) return;
        const avgs = [...bySup.entries()].filter(([, o]) => o.q > 0).map(([sup, o]) => ({ sup, avg: o.v / o.q }));
        const cheap = avgs.filter((a) => reliable(a.sup));
        if (avgs.length < 2 || !cheap.length) return;
        const min = cheap.reduce((a, b) => (b.avg < a.avg ? b : a));
        ws.forEach((r) => {
          const over = Math.max(0, num(r.price) - min.avg) * num(r.qty);
          if (over <= 0 || r.supplier === min.sup) return;
          save += over;
          if (!best || over > best.over) best = { over, name: r.product_name, cheap: min.sup, dear: r.supplier, pct: ((num(r.price) - min.avg) / min.avg) * 100 };
        });
      });
    });
    if (best) add({
      id: 'cheaper', goals: ['price', 'supplier', 'profit'], tone: 'good', baht: save,
      text: 'ส่วนต่างราคาระหว่างเจ้า (ประหยัดได้สูงสุด)',
      sub: `${best.name}: ${partyShort(best.cheap)} ถูกกว่า ${partyShort(best.dear)} ${best.pct.toFixed(0)}% ในสัปดาห์เดียวกัน`,
      note: 'ไม่นับเจ้าที่ส่งขาดบ่อย ควรดูว่าเจ้าที่ถูกกว่ารับปริมาณได้พอด้วย',
      widget: onPage(['price_compare_suppliers', 'price_variance_top']),
      headline: `ถ้าซื้อจากเจ้าที่ถูกกว่าในสัปดาห์เดียวกัน จะประหยัดได้สูงสุด ${baht(save)} · มากสุด ${best.name}`,
      how: 'สินค้าและหน่วยเดียวกันที่ซื้อจากหลายเจ้าในสัปดาห์เดียวกัน: ส่วนที่จ่ายเกินราคาเฉลี่ยของเจ้าที่ถูกที่สุดในสัปดาห์นั้น คูณจำนวน ไม่นับเจ้าที่ส่งขาดเกิน 15% ของบรรทัดที่วางบิล',
    });

    // 3. billed above what was received, less credit notes already issued
    //    (the sq_overbill_credit definition: invoice + product, quantity over × invoice price)
    const lines = new Map();
    pa.forEach((r) => {
      if (isBlank(r.invoice_number) || !(num(r.invoice_quantity) > num(r.grn_quantity))) return;
      const k = `${r.invoice_number}|${r.product_code}`;
      const o = lines.get(k) || { sup: r.supplier, over: 0, cn: 0 };
      o.over += (num(r.invoice_quantity) - num(r.grn_quantity)) * num(r.invoice_price);
      lines.set(k, o);
    });
    if (lines.size) {
      const cn = get('credit-notes');
      if (cn) cn.forEach((c) => { const o = lines.get(`${c.invoice_number}|${c.product_code}`); if (o) o.cn += num(c.total !== undefined ? c.total : c.credit_note_amount); });
      const bySup = new Map();
      lines.forEach((o) => { const left = Math.max(0, o.over - o.cn); if (left > 0) bySup.set(o.sup, (bySup.get(o.sup) || 0) + left); });
      const owed = [...bySup.values()].reduce((a, b) => a + b, 0);
      const topS = [...bySup.entries()].sort((a, b) => b[1] - a[1])[0];
      if (topS) add({
        id: 'overbilled', goals: ['bills', 'supplier'], baht: owed,
        text: cn ? `บิลเกินที่ยังไม่ได้ใบลดหนี้คืน ${bySup.size} เจ้า` : `ซัพพลายเออร์ ${bySup.size} เจ้าวางบิลเกินของที่รับจริง`,
        sub: `มากสุด ${partyShort(topS[0])} ${baht(topS[1])} ควรทวงใบลดหนี้`,
        note: cn ? '' : 'ยังไม่ได้หักใบลดหนี้ เพิ่ม widget "บิลเกินของที่รับ ได้ใบลดหนี้คืนแล้วหรือยัง" เพื่อดูยอดที่ค้างจริง',
        widget: onPage(cn ? ['sq_overbill_credit', 'ita_overbilled'] : ['ita_overbilled', 'sq_overbill_credit', 'pa_kpis']),
        how: '(จำนวนในบิล − จำนวนที่รับจริง) × ราคาในบิล ต่อเลขบิลและสินค้า หักใบลดหนี้ของบิลและสินค้าเดียวกัน',
      });
    }

    // 4. received, no invoice yet (the ita_grn_not_invoiced definition) — a bill to come, aged by GRN date
    const wait = pa.filter((r) => !isBlank(r.grn_number) && isBlank(r.invoice_number));
    if (wait.length) {
      const v = wait.reduce((s, r) => s + num(r.grn_total), 0);
      const ref = span.today || todayIso();
      const age = (r) => (Date.parse(ref) - Date.parse(String(r.grn_date || r.order_date).slice(0, 10))) / 86400000;
      const old = wait.filter((r) => age(r) > 15).reduce((s, r) => s + num(r.grn_total), 0);
      const older = wait.filter((r) => age(r) > 30).reduce((s, r) => s + num(r.grn_total), 0);
      add({
        id: 'waiting', goals: ['bills', 'supplier'], tone: 'info', baht: v, text: 'รับของแล้ว ยังรอใบแจ้งหนี้',
        sub: [old ? `รอเกิน 15 วัน ${baht(old)}` : '', older ? `เกิน 30 วัน ${baht(older)}` : '', `${new Set(wait.map((r) => r.supplier)).size} ซัพพลายเออร์`].filter(Boolean).join(' · '),
        widget: onPage(['ita_grn_not_invoiced', 'pa_kpis']),
        how: 'มูลค่ารับของของบรรทัดที่มีใบรับของแล้วแต่ยังไม่มีเลขใบแจ้งหนี้ อายุนับจากวันที่รับของ',
      });
    }
  }

  // 5. counted short. FMH groups stock counts by product over the whole synced window
  //    (about 80 days), so this does not follow the range picker and says so.
  const sc = get('stock-count|product');
  if (sc && sc.length) {
    const neg = sc.filter((r) => num(r.variance_value) < 0);
    if (neg.length) {
      const short = -neg.reduce((s, r) => s + num(r.variance_value), 0);
      const extra = sc.filter((r) => num(r.variance_value) > 0).reduce((s, r) => s + num(r.variance_value), 0);
      const w = neg.reduce((a, b) => (num(b.variance_value) < num(a.variance_value) ? b : a));
      add({
        id: 'count_short', goals: ['waste', 'branch', 'profit'], baht: short, text: 'นับสต็อกขาด',
        sub: `${w.product} ตัวเดียว ${baht(-num(w.variance_value))} · นับเกิน ${baht(extra)} · สุทธิขาด ${baht(short - extra)}`,
        note: '80 วันล่าสุดที่ดึงจาก FMH ไม่ตามช่วงที่เลือก',
        widget: onPage(['stock_count_variance']),
        how: 'ผลรวมมูลค่าที่นับได้ต่ำกว่าในระบบ ต่อสินค้า จากการนับสต็อกใน FMH',
      });
    }
  }

  // 6. waste, against what each outlet bought when both are on the page
  const wl = get('wastage-lines', 'wastage_date');
  const wb = wl || get('wastage-top-branches');
  if (wb && wb.length) {
    const val = (r) => num(r.wastage_value !== undefined ? r.wastage_value : r.total_wastage_value);
    const v = wb.reduce((s, r) => s + val(r), 0);
    let sub = '';
    if (wl && pa && pa.length) {
      const by = new Map();
      const k = (n) => partyShort(n || '').toLowerCase();
      pa.forEach((r) => { if (CK_NAME.test(r.branch || '')) return; const o = by.get(k(r.branch)) || { n: partyShort(r.branch), p: 0, w: 0 }; o.p += num(r.total); by.set(k(r.branch), o); });
      wl.forEach((r) => { const o = by.get(k(r.branch)); if (o) o.w += val(r); });
      const rates = [...by.values()].filter((o) => o.p > 0 && o.w > 0).map((o) => ({ ...o, pct: (o.w / o.p) * 100 })).sort((a, b) => b.pct - a.pct);
      if (rates.length >= 2) sub = `${rates[0].n} ทิ้ง ${rates[0].pct.toFixed(1)}% ของยอดซื้อ · ${rates[rates.length - 1].n} ${rates[rates.length - 1].pct.toFixed(1)}%`;
    }
    if (!sub) {
      const byB = new Map();
      wb.forEach((r) => byB.set(r.branch || r.product || '', (byB.get(r.branch || r.product || '') || 0) + val(r)));
      const t = [...byB.entries()].sort((a, b) => b[1] - a[1])[0];
      if (t && t[0]) sub = `มากสุด ${partyShort(t[0])} ${baht(t[1])}`;
    }
    add({
      id: 'waste', goals: ['waste', 'branch'], baht: v, text: 'ของเสียที่บันทึกไว้', sub,
      note: wl ? '' : '80 วันล่าสุดที่ดึงจาก FMH ไม่ตามช่วงที่เลือก',
      widget: onPage(['wastage_pct_by_branch', 'wastage_top_branches', 'wastage_top_products', 'wastage_by_category', 'wastage_trend']),
      how: 'มูลค่าของเสียที่สาขาบันทึกใน FMH',
    });
  }

  // 7. the central kitchen paid more than its recipes say its sales used. Only the kitchen's
  //    own purchases count (an outlet buying direct is not kitchen cost), over the same
  //    months as the sales buckets.
  const ck = get('cogs-trend');
  const wCk = onPage(['ck_margin_kpi', 'ck_margin_table', 'ck_margin_trend']);
  if (ck && ck.length && pa && pa.length && wCk) {
    const own = pa.filter((r) => CK_NAME.test(r.branch || ''));
    const from = ck.map((r) => String(r.period || '').slice(0, 10)).filter(Boolean).sort()[0];
    const bought = own.filter((r) => !from || String(r.order_date).slice(0, 10) >= from).reduce((s, r) => s + num(r.total), 0);
    const sales = ck.reduce((s, r) => s + num(r.sales), 0);
    const recipe = ck.reduce((s, r) => s + num(r.cogs), 0);
    const open = span.today && ck.some((r) => String(r.period || '').slice(0, 7) === String(span.today).slice(0, 7));
    if (own.length && sales > 0 && bought > recipe) {
      add({
        id: 'ck_gap', goals: ['profit'], baht: bought - recipe, text: 'ครัวกลางจ่ายซื้อเกินต้นทุนตามสูตร',
        sub: `กำไรขั้นต้นจากที่จ่ายจริง ${(((sales - bought) / sales) * 100).toFixed(1)}% เทียบตามสูตร ${(((sales - recipe) / sales) * 100).toFixed(1)}%`,
        note: `ยอดซื้อไม่เท่ากับของที่ใช้ ของที่ยังอยู่ในสต็อกก็นับรวม${open ? ' · เดือนนี้ยังไม่จบ ตัวเลขยังแกว่ง' : ''}`,
        unsure: !!open, widget: wCk,
        how: 'ยอดซื้อของสาขาครัวกลางในเดือนเดียวกับยอดขาย ลบต้นทุนตามสูตรของสิ่งที่ครัวกลางขาย',
      });
    }
  }

  return finishInsights(out, goals);
}

// Ranks the findings, names their kind and caveat, and picks the one the folded bar leads with.
function finishInsights(out, goals) {
  // Order: what the customer said they care about, then the rest; within each, money to act
  // on before money that is waiting or unsure (an unfinished month), then by size.
  const wanted = new Set(goals || []);
  const rank = (f) => (wanted.size && f.goals.some((g) => wanted.has(g)) ? 0 : 2) + (f.tone === 'info' || f.unsure ? 1 : 0);
  let top = [...out].sort((a, b) => rank(a) - rank(b) || b.baht - a.baht).slice(0, 3);
  // A word for what kind of money it is (the folded bar has no room for the card's tag),
  // and the caveat that must travel with the number.
  const KIND = { overbilled: 'ควรทวง', price_up: 'จ่ายเพิ่มไปแล้ว', count_short: 'ของขาด', waste: 'ของเสีย', ck_gap: 'ต้นทุนเกิน', price_down: 'ข่าวดี', cheaper: 'ประหยัดได้', waiting: 'รอบิล' };
  out.forEach((f) => {
    f.kind = KIND[f.id] || '';
    f.caveat = f.unsure ? 'เดือนนี้ยังไม่จบ'
      : /80 วันล่าสุด/.test(f.note || '') ? '80 วันล่าสุด ไม่ตามช่วงที่เลือก'
      : f.id === 'cheaper' ? 'ตัวเลขสูงสุด'
      : f.id === 'ck_gap' ? 'รวมของที่ยังอยู่ในสต็อก'
      : f.id === 'overbilled' && f.note ? 'ยอดก่อนหักใบลดหนี้' : '';
  });
  // The folded bar leads with money to act on: money to claim back first, then money lost,
  // and good news or bills still to come only when nothing is being lost.
  const lead = [...out].sort((a, b) => {
    const w = (f) => (f.tone === 'good' || f.tone === 'info' ? 4 : f.unsure ? 2 : f.id === 'overbilled' ? 0 : 1);
    return w(a) - w(b) || b.baht - a.baht;
  })[0];
  if (lead) top = [lead, ...top.filter((f) => f !== lead)].slice(0, 3);
  return { top, all: out, lead };
}

// ---------- widget renderers ----------
// Every renderer: (bodyElement, rows, config) — rows are already date-filtered.

function renderKpi(body, rows, cfg) {
  const row = document.createElement('div');
  row.className = 'kpi-row';
  (cfg.metrics || []).forEach((m) => {
    const card = document.createElement('div');
    card.className = 'kpi-card';
    card.innerHTML = `<div class="kpi-label">${esc(m.label)}</div><div class="kpi-value">${esc(fmtValue(evalMetric(m.value, rows), m.format))}</div>`;
    row.appendChild(card);
  });
  body.appendChild(row);
}

// Signed values: diverging blue (+) / chili (-). Margin: status colors, always
// shown next to the printed value, so color is never the only signal.
function barColor(value, cfg) {
  if (cfg.color_mode === 'signed') return value < 0 ? 'var(--danger)' : 'var(--series-blue)';
  // Money out: paying more is the bad direction, so it is the red one.
  if (cfg.color_mode === 'signed_cost') return value > 0 ? 'var(--danger)' : 'var(--series-blue)';
  if (cfg.color_mode === 'margin') return value < 0 ? 'var(--danger)' : value < 20 ? 'var(--amber)' : 'var(--status-good)';
  // A target makes "good" directional: food cost is better low, margin better
  // high, so the widget says which way it reads rather than the renderer
  // guessing from the number's sign.
  if (cfg.threshold != null) {
    const lowerIsBetter = cfg.lower_is_better !== false;
    const miss = lowerIsBetter ? value > cfg.threshold : value < cfg.threshold;
    if (!miss) return 'var(--status-good)';
    const far = lowerIsBetter ? value > cfg.threshold * 1.15 : value < cfg.threshold * 0.85;
    return far ? 'var(--danger)' : 'var(--amber)';
  }
  return cfg.color || 'var(--series-blue)';
}

// Ranked horizontal bars as HTML rows (name · bar · value): every value is
// printed, long names truncate with a tooltip, and it stays readable on phones.
function renderBar(body, rows, cfg) {
  const groups = groupRows(rows, rowFields(cfg));
  let items = [...groups].map(([name, rs]) => ({
    name: String(name),
    value: evalMetric(cfg.value, rs),
    rank: cfg.rank_by ? evalMetric(cfg.rank_by, rs) : null,
    extra: cfg.label_extra ? evalMetric(cfg.label_extra.value, rs) : null,
  }));
  const key = (i) => (cfg.rank_by ? i.rank : i.value);
  const sorters = {
    asc: (a, b) => key(a) - key(b),
    abs_desc: (a, b) => Math.abs(key(b)) - Math.abs(key(a)),
    desc: (a, b) => key(b) - key(a),
    // In label order: weekdays, sizes — anything whose order is the point.
    key: (a, b) => a.name.localeCompare(b.name, 'th'),
  };
  items.sort(sorters[cfg.sort] || sorters.desc);
  items = items.slice(0, cfg.top_n || 10);

  const maxAbs = Math.max(...items.map((i) => Math.abs(i.value)), 1e-9);
  const list = document.createElement('div');
  list.className = 'bar-list';
  items.forEach((item) => {
    const label = item.extra !== null ? `${item.name} (${fmtValue(item.extra)}${cfg.label_extra.suffix || ''})` : item.name;
    const width = Math.max(2, (Math.abs(item.value) / maxAbs) * 100);
    const valueText = fmtValue(item.value, cfg.format);
    const row = document.createElement('div');
    row.className = 'bar-row';
    let mark = '';
    let targetLine = '';
    if (cfg.threshold != null) {
      const lowerIsBetter = cfg.lower_is_better !== false;
      const miss = lowerIsBetter ? item.value > cfg.threshold : item.value < cfg.threshold;
      // Colour alone should never carry the verdict.
      mark = miss ? ' ▼' : ' ✓';
      const tPct = Math.min(100, (Math.abs(cfg.threshold) / maxAbs) * 100);
      targetLine = `<span class="bar-target" style="left:${tPct}%" title="เป้า ${esc(fmtValue(cfg.threshold, cfg.format))}"></span>`;
    }
    row.title = `${label}: ${valueText}${cfg.threshold != null ? ` · เป้า ${fmtValue(cfg.threshold, cfg.format)}` : ''}`;
    row.innerHTML = `
      <span class="bar-name">${esc(label)}</span>
      <span class="bar-track">${targetLine}<span class="bar-fill" style="width:${width}%;background:${barColor(item.value, cfg)}"></span></span>
      <span class="bar-value">${esc(valueText + mark)}</span>`;
    list.appendChild(row);
  });
  body.appendChild(list);
  if (groups.size > items.length) {
    body.insertAdjacentHTML('beforeend', `<p class="widget-foot">แสดง ${items.length} จาก ${groups.size} รายการ</p>`);
  }
}

// YYYY-MM-DD in the viewer's own calendar. toISOString() is UTC, so in
// Bangkok (UTC+7) a local midnight came back as the previous day and every
// monthly chart was labelled one month early.
function localIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function bucketKey(dateStr, bucket) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
  if (isNaN(d)) return null;
  if (bucket === 'day') return localIso(d);
  if (bucket === 'month') return localIso(d).slice(0, 7) + '-01';
  // Week of the month: 1-7, 8-14, 15-21, 22-end. Every bucket stays inside one
  // month, so a month's buckets always add up to that month.
  if (bucket === 'wom') {
    const start = d.getDate() <= 7 ? 1 : d.getDate() <= 14 ? 8 : d.getDate() <= 21 ? 15 : 22;
    return localIso(d).slice(0, 8) + String(start).padStart(2, '0');
  }
  const day = d.getDay(); // week: Monday of that week
  d.setDate(d.getDate() + ((day === 0 ? -6 : 1) - day));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Every bucket from the first key to the last, so empty periods show as gaps.
function continuousBuckets(keys, bucket) {
  if (keys.length < 2 || !['day', 'week', 'month'].includes(bucket)) return keys;
  const out = [];
  const end = keys[keys.length - 1];
  let d = new Date(keys[0] + 'T00:00:00');
  while (out.length < 800) {
    const k = localIso(d);
    if (k > end) break;
    out.push(k);
    if (bucket === 'day') d.setDate(d.getDate() + 1);
    else if (bucket === 'week') d.setDate(d.getDate() + 7);
    else d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }
  return out.length >= keys.length ? out : keys;
}

function bucketLabel(k, bucket) {
  const d = new Date(k + 'T00:00:00');
  if (bucket === 'month') return d.toLocaleDateString(I18N.locale(), { month: 'short', year: '2-digit' });
  if (bucket === 'wom') {
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const end = d.getDate() === 22 ? last : d.getDate() + 6;
    return `${d.getDate()}-${end} ${d.toLocaleDateString(I18N.locale(), { month: 'short' })}`;
  }
  return d.toLocaleDateString(I18N.locale(), { day: 'numeric', month: 'short' });
}

function renderLine(body, rows, cfg) {
  const buckets = new Map();
  rows.forEach((r) => {
    const raw = pick(r, cfg.date_fields || []);
    const k = raw ? bucketKey(raw, cfg.bucket || 'week') : null;
    if (!k) return;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  });
  let keys = [...buckets.keys()].sort();
  if (!keys.length || !window.Chart) {
    body.innerHTML = `<p class="muted">${window.Chart ? 'ไม่มีวันที่ในข้อมูลสำหรับสร้างกราฟ' : 'โหลดไลบรารีกราฟไม่สำเร็จ'}</p>`;
    return;
  }
  // Periods with no rows stay on the axis as gaps. Skipping them drew June
  // straight into September when a month of history was missing.
  keys = continuousBuckets(keys, cfg.bucket || 'week');
  // The current week / month is still filling up: its point would read as a drop.
  const bk = cfg.bucket || 'week';
  const partialLast = (bk === 'week' || bk === 'month') && keys.length > 1 && keys[keys.length - 1] === bucketKey(localIso(new Date()), bk);
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  wrap.innerHTML = '<canvas></canvas>';
  body.appendChild(wrap);
  if (partialLast) body.insertAdjacentHTML('beforeend', `<p class="chart-note">ช่วงสุดท้าย (เส้นประ) ยังไม่ครบ${bk === 'week' ? 'สัปดาห์' : 'เดือน'} ตัวเลขยังขึ้นได้อีก</p>`);
  // `series_by` makes one series per value of a field (a line per category),
  // the largest first; the rest fold into one, so the legend stays readable.
  let series = cfg.series || [];
  // A line is a series, not an alarm: keep red for abnormal values and give red-coloured lines a distinct hue.
  series = series.map((x) => (x.color && x.color === cssv('--danger') ? { ...x, color: cssv('--s4') } : x));
  if (cfg.series_by) {
    const totals = new Map();
    rows.forEach((r) => {
      const k = String(pick(r, cfg.series_by) ?? 'ไม่ระบุ');
      totals.set(k, (totals.get(k) || 0) + evalMetric(cfg.value, [r]));
    });
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const top = ranked.slice(0, cfg.top_n || 6);
    const inTop = new Set(top);
    const colorOf = (k, i) => {
      const at = cfg.series_order ? cfg.series_order.indexOf(k) : i;
      return at >= 0 && at < CAT_COLORS.length ? CAT_COLORS[at] : cssv('--s-other');
    };
    series = top.map((k, i) => ({
      label: k,
      color: colorOf(k, i),
      value: { op: 'sum_where', field: cfg.value.field, where: { op: 'in', field: cfg.series_by, values: [k] } },
    }));
    if (ranked.length > top.length) {
      series.push({
        label: `อื่น ๆ (${ranked.length - top.length})`,
        color: cssv('--s-other'),
        value: { op: 'sum_where', field: cfg.value.field, where: { op: 'not', rule: { op: 'in', field: cfg.series_by, values: [...inTop] } } },
      });
    }
  }
  // `mark: 'bar'` draws the same buckets as grouped bars: the honest form when
  // the series are amounts to compare side by side (sales vs purchases), not a
  // level to follow. A series may still set its own `mark` to ride as a line.
  const asBar = cfg.mark === 'bar';
  I18N.hookCharts();
  const chart = new Chart(wrap.querySelector('canvas'), {
    type: asBar ? 'bar' : 'line',
    data: {
      labels: keys.map((k) => bucketLabel(k, cfg.bucket)),
      datasets: series.map((s, si) => {
        const data = keys.map((k) => (buckets.has(k) ? evalMetric(s.value, buckets.get(k)) : null));
        if ((s.mark || cfg.mark) === 'bar') {
          return { type: 'bar', label: s.label, data, backgroundColor: s.color, borderRadius: 4, maxBarThickness: 36, categoryPercentage: 0.7, barPercentage: 0.9 };
        }
        return {
          type: 'line',
          label: s.label,
          data,
          borderColor: s.color,
          backgroundColor: s.color,
          borderWidth: 2,
          // Shape + dash as well as colour, so lines stay apart for colour-blind readers.
          pointStyle: ['circle', 'rect', 'triangle', 'rectRot', 'crossRot', 'star'][si % 6],
          borderDash: si >= 2 ? [6, 4] : undefined,
          pointRadius: si ? 4 : 3,
          segment: partialLast ? {
            borderDash: (c) => (c.p1DataIndex === keys.length - 1 ? [2, 4] : si >= 2 ? [6, 4] : undefined),
            borderColor: (c) => (c.p1DataIndex === keys.length - 1 ? withAlpha(s.color, 0.45) : undefined),
          } : undefined,
          pointHoverRadius: 6,
          pointBorderColor: cssv('--surface'),
          pointBorderWidth: 1.5,
          tension: 0.25,
        };
      }),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: cfg.legend !== false, position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8, color: cssv('--ink') } },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${fmtValue(ctx.parsed.y, cfg.format)}`,
            footer: (its) => (cfg.stacked && its.length > 1 ? `รวม ${fmtValue(its.reduce((a, i) => a + i.parsed.y, 0), cfg.format)}` : ''),
          },
        },
      },
      scales: {
        x: { stacked: !!cfg.stacked, grid: { display: false }, ticks: { color: cssv('--muted') } },
        y: { stacked: !!cfg.stacked, beginAtZero: asBar || cfg.zero === true, grid: { color: cssv('--chart-grid') }, border: { display: false }, ticks: { color: cssv('--muted'), callback: (v) => fmtAxis(v, cfg.format) } },
      },
    },
  });
  activeCharts.push(chart);
}

function renderTable(body, rows, cfg, ctx) {
  if (cfg.customize) return renderCustomTable(body, rows, cfg, ctx);
  // A column empty on every row (e.g. LINE before anyone is notified) is noise: leave it out.
  const columns = (cfg.columns && cfg.columns.length ? cfg.columns : Object.keys(rows[0]).map((field) => ({ field })))
    .filter((c) => c.share_of || rows.some((r) => r[c.field] != null && r[c.field] !== ''));
  // A column that is another column's share of its total (each customer's
  // percent of sales) — a total the row layer, which sees one row, cannot know.
  columns.filter((c) => c.share_of).forEach((c) => {
    const tot = rows.reduce((a, r) => a + num(r[c.share_of]), 0);
    rows = rows.map((r) => ({ ...r, [c.field]: tot ? (num(r[c.share_of]) / tot) * 100 : 0 }));
  });
  let sort = cfg.sort_by ? { ...cfg.sort_by } : null; // { field, dir }
  const limit = cfg.top_n || 200;
  // Severity columns (สูง / กลาง / ต่ำ) read as coloured pills, so the eye finds what needs action first.
  const SEV = { 'วิกฤต': 'crit', critical: 'crit', 'สูง': 'high', 'กลาง': 'mid', 'ต่ำ': 'low', high: 'high', medium: 'mid', low: 'low', 'ใหม่': 'new' };
  const pillCols = new Set(columns.filter((c) => {
    const vals = rows.map((r) => r[c.field]).filter((v) => v != null && v !== '');
    if (!vals.length || !vals.every((v) => typeof v === 'string' && SEV[v.trim().toLowerCase()] || SEV[v])) return false;
    // Severity always shows as a pill; a status that is the same on every row ("ใหม่") is noise.
    return vals.some((v) => SEV[String(v).trim().toLowerCase()] !== 'new') || new Set(vals).size > 1;
  }).map((c) => c.field));
  // Long lists open short: the first rows are what to act on today; the rest is one click away.
  const PREVIEW = cfg.preview_rows || 8;
  let expanded = rows.length <= PREVIEW + 2;

  const tools = document.createElement('div');
  tools.className = 'table-tools';
  tools.innerHTML = `<span class="widget-foot"></span><button type="button" class="btn small ghost">Export CSV</button>`;
  tools.querySelector('button').addEventListener('click', () => exportCsv(rows, columns));
  const scroller = document.createElement('div');
  scroller.className = 'table-scroll';
  body.appendChild(tools);
  body.appendChild(scroller);

  const numCount = columns.filter((c) => rows.length && typeof rows[0][c.field] === 'number').length;

  function draw() {
    let data = [...rows];
    if (sort) {
      data.sort((a, b) => {
        const x = a[sort.field];
        const y = b[sort.field];
        const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), 'th');
        return sort.dir === 'asc' ? cmp : -cmp;
      });
    }
    const shown = data.slice(0, expanded ? limit : PREVIEW);
    tools.querySelector('.widget-foot').textContent =
      data.length > limit ? `แสดง ${limit.toLocaleString('th-TH')} จาก ${data.length.toLocaleString('th-TH')} แถว (Export ได้ครบ)` : `${data.length.toLocaleString('th-TH')} แถว`;
    const head = columns
      .map((c) => {
        const arrow = sort && sort.field === c.field ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
        return `<th tabindex="0" data-field="${esc(c.field)}">${esc(c.label || c.field.replace(/_/g, ' '))}${arrow}</th>`;
      })
      .join('');
    const bodyHtml = shown
      .map(
        (r) =>
          `<tr>${columns
            .map((c) => {
              const v = r[c.field];
              return typeof v === 'number'
                ? `<td class="num" data-label="${esc(c.label || c.field.replace(/_/g, ' '))}">${esc(c.format ? fmtValue(v, c.format) : v.toLocaleString('th-TH', { maximumFractionDigits: 2 }))}</td>`
                : pillCols.has(c.field) && v != null && v !== ''
                  ? `<td><span class="sev-pill sev-${SEV[String(v).trim().toLowerCase()] || SEV[v]}">${esc(v)}</span></td>`
                  : `<td>${esc(v)}</td>`;
            })
            .join('')}</tr>`
      )
      .join('');
    const more = Math.min(data.length, limit) - PREVIEW;
    scroller.innerHTML = `<table class="report-table${numCount >= 3 ? ' nums-many' : ''}"><thead><tr>${head}</tr></thead><tbody>${bodyHtml}</tbody></table>${
      more > 2 ? `<button type="button" class="table-more">${expanded ? 'ย่อเหลือ ' + PREVIEW + ' แถวแรก' : 'แสดงอีก ' + more.toLocaleString('th-TH') + ' แถว'}</button>` : ''}`;
    const mb = scroller.querySelector('.table-more');
    if (mb) mb.addEventListener('click', () => { expanded = !expanded; draw(); if (!expanded) scroller.scrollIntoView({ block: 'nearest' }); });
    scroller.querySelectorAll('th').forEach((th) => {
      const toggle = () => {
        const f = th.dataset.field;
        sort = !sort || sort.field !== f ? { field: f, dir: 'desc' } : sort.dir === 'desc' ? { field: f, dir: 'asc' } : null;
        draw();
      };
      th.addEventListener('click', toggle);
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
    });
  }
  draw();
}

// ---------- a table each viewer arranges for themselves ----------
// cfg.customize: { pin_key: [fields], pin_label, category, search: [fields], default_hidden }
// Prefs { order, hidden, pins, pin_cats, pinned_only } live on widget.my_prefs and are
// saved per user (PUT …/widgets/:wid/prefs); in the library preview they stay in memory.
const CT_OPEN = new Map(); // widget id -> settings panel open, kept across re-renders
const PIN_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M14.5 3.5l6 6-2.2.6-3.6 3.6.3 4.3-1.5 1.5-4.2-4.2L4.5 20.1l-.6-.6 4.8-4.8-4.2-4.2L6 9l4.3.3 3.6-3.6z" fill="currentColor"/></svg>';
function renderCustomTable(body, rows, cfg, ctx = {}) {
  const cu = cfg.customize || {};
  const wid = ctx.widget ? ctx.widget.id : 'x';
  const all = cfg.columns && cfg.columns.length ? cfg.columns : Object.keys(rows[0] || {}).map((field) => ({ field }));
  const label = (c) => c.label || c.field.replace(/_/g, ' ');
  const byField = new Map(all.map((c) => [c.field, c]));
  const blank = () => ({ order: all.map((c) => c.field), hidden: [...(cu.default_hidden || [])], pins: [], pin_order: [], pin_cats: [], pinned_only: false, branch: '' });
  const load = () => {
    const p = (ctx.widget && ctx.widget.my_prefs) || null;
    const b = blank();
    if (!p) return b;
    // columns added to the widget later show up at the end, visible
    const order = (p.order || []).filter((f) => byField.has(f));
    all.forEach((c) => { if (!order.includes(c.field)) order.push(c.field); });
    return { order, hidden: (p.hidden || []).filter((f) => byField.has(f)), pins: p.pins || [], pin_order: p.pin_order || [], pin_cats: p.pin_cats || [], pinned_only: !!p.pinned_only, branch: p.branch || '' };
  };
  let prefs = load();
  let saveTimer = null;
  const save = () => {
    if (ctx.widget) ctx.widget.my_prefs = { ...prefs };
    if (!ctx.persist) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api(`/api/dashboards/${ctx.dashboardId}/widgets/${wid}/prefs`, { method: 'PUT', body: JSON.stringify({ prefs }) })
        .catch(() => { msg.textContent = 'บันทึกการตั้งค่าตารางไม่สำเร็จ ลองอีกครั้ง'; });
    }, 400);
  };
  const keyOf = (r) => { for (const f of [].concat(cu.pin_key || [])) { const v = r[f]; if (v != null && v !== '') return String(v); } return ''; };
  const catOf = (r) => (cu.category ? String(r[cu.category] ?? '') : '');
  const nameOf = (r) => String((cu.pin_label && r[cu.pin_label]) || keyOf(r));
  const pinned = (r) => prefs.pins.includes(keyOf(r)) || (catOf(r) && prefs.pin_cats.includes(catOf(r)));
  // the widget's own branch choice (remembered per person), on top of the page's branch filter
  const BF = cu.branch_field || null;
  const branches = BF ? [...new Set(rows.map((r) => String(r[BF] ?? '')).filter(Boolean))].sort((a, b) => (CK_NAME.test(b) - CK_NAME.test(a)) || a.localeCompare(b, 'th')) : [];
  if (prefs.branch && !branches.includes(prefs.branch)) prefs.branch = '';
  const cats = cu.category ? [...new Set(rows.map(catOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'th')) : [];
  let sort = cfg.sort_by ? { ...cfg.sort_by } : null;
  let query = '';
  let undoPin = null; // the order just cleared, so it can be put back
  let expanded = false;
  const PREVIEW = cfg.preview_rows || 10;
  const limit = cfg.top_n || 500;
  const pid = `ct-panel-${wid}`;

  body.insertAdjacentHTML('beforeend', `
    <div class="ct-tools">
      ${branches.length > 1 ? `<label class="ct-branch"><span class="sr-only">สาขา</span><select>${['', ...branches].map((b) => `<option value="${esc(b)}"${b === prefs.branch ? ' selected' : ''}>${b ? esc(b) : 'ทุกสาขา'}</option>`).join('')}</select></label>` : ''}
      ${cu.search ? `<label class="ct-search"><span class="sr-only">ค้นหาสินค้า</span><input type="search" placeholder="ค้นหาชื่อหรือรหัสสินค้า" autocomplete="off"></label>` : ''}
      <button type="button" class="btn small ghost ct-only" aria-pressed="false"></button>
      <button type="button" class="btn small ghost ct-open" aria-expanded="false" aria-controls="${pid}">ปรับตาราง</button>
      <button type="button" class="btn small ghost ct-csv">Export CSV</button>
    </div>
    <div class="ct-panel" id="${pid}" hidden></div>
    <p class="ct-msg" role="status"></p>
    <p class="widget-foot ct-count"></p>
    ${ctx.syncedAt ? `<p class="ct-asof">ยอดคงเหลือ ณ ${esc(fmtDateTime(ctx.syncedAt))}</p>` : ''}
    <div class="table-scroll"></div>`);
  const $ = (s) => body.querySelector(s);
  const panel = $('.ct-panel');
  const scroller = $('.table-scroll');
  const msg = $('.ct-msg');
  const visible = () => prefs.order.filter((f) => !prefs.hidden.includes(f)).map((f) => byField.get(f));

  function sortRows(data) {
    const out = [...data];
    if (sort) {
      out.sort((a, b) => {
        const x = a[sort.field]; const y = b[sort.field];
        const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), 'th');
        return sort.dir === 'asc' ? cmp : -cmp;
      });
    }
    return out;
  }
  // The pinned rows of an already-sorted list, in the order the table shows them: the
  // person's own order first, then the table's sort; each product's places together, kitchen first.
  function orderPins(sorted) {
    const pins = sorted.filter(pinned);
    const rank = new Map();
    pins.forEach((r) => { const k = keyOf(r) || nameOf(r); if (!rank.has(k)) rank.set(k, rank.size); });
    const mine = (r) => { const i = prefs.pin_order.indexOf(keyOf(r) || nameOf(r)); return i < 0 ? 1e6 : i; };
    const placeOf = (r) => String(r.branch ?? '');
    return pins.sort((a, b) => mine(a) - mine(b) || rank.get(keyOf(a) || nameOf(a)) - rank.get(keyOf(b) || nameOf(b))
      || (CK_NAME.test(placeOf(b)) - CK_NAME.test(placeOf(a))) || placeOf(a).localeCompare(placeOf(b), 'th'));
  }

  function dataNow() {
    let data = rows;
    if (BF && prefs.branch) data = data.filter((r) => String(r[BF] ?? '') === prefs.branch);
    if (query) {
      const q = query.toLowerCase();
      data = data.filter((r) => [].concat(cu.search || []).some((f) => String(r[f] ?? '').toLowerCase().includes(q)));
    }
    if (prefs.pinned_only) data = data.filter(pinned);
    data = [...data];
    data = sortRows(data);
    const pins = orderPins(data);
    return [...pins, ...data.filter((r) => !pinned(r))];
  }

  function drawTools() {
    const n = rows.filter((r) => pinned(r) && (!BF || !prefs.branch || String(r[BF] ?? '') === prefs.branch)).length;
    const only = $('.ct-only');
    only.setAttribute('aria-pressed', String(prefs.pinned_only));
    only.textContent = `เฉพาะที่ปักหมุด (${n})`;
    only.disabled = !n && !prefs.pinned_only;
    const open = !!CT_OPEN.get(wid);
    $('.ct-open').setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
  }

  function drawTable() {
    const cols = visible();
    const data = dataNow();
    const shown = data.slice(0, expanded ? limit : PREVIEW);
    const pinCount = data.filter(pinned).length;
    $('.ct-count').textContent = `${data.length.toLocaleString('th-TH')} แถว${pinCount ? ` · ปักไว้ ${pinCount.toLocaleString('th-TH')} รายการ` : ''}${data.length > limit ? ` · แสดง ${limit.toLocaleString('th-TH')} แถวแรก (Export ได้ครบ)` : ''}`;
    const nums = cols.filter((c) => rows.length && typeof rows[0][c.field] === 'number').length;
    const head = `<th class="ct-pin-h"><span class="sr-only">ปักหมุด</span></th>` + cols.map((c) => {
      const on = sort && sort.field === c.field;
      const isNum = rows.length && typeof rows[0][c.field] === 'number';
      return `<th tabindex="0" data-field="${esc(c.field)}"${isNum ? ' class="num"' : ''} aria-sort="${on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">${esc(label(c))}${on ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`;
    }).join('');
    const plist = pinList(); const plKeys = plist.map((x) => x.k);
    const seenGroup = new Set();
    const rowsHtml = shown.map((r, i) => {
      const k = keyOf(r);
      const own = prefs.pins.includes(k);
      const viaCat = !own && catOf(r) && prefs.pin_cats.includes(catOf(r));
      const pin = viaCat
        ? `<button type="button" class="ct-pin on via-cat" aria-pressed="true" disabled title="ปักไว้ทั้งหมวด ${esc(catOf(r))} เลิกปักได้ที่ ปรับตาราง" aria-label="ปักไว้ทั้งหมวด ${esc(catOf(r))}">${PIN_SVG}</button>`
        : `<button type="button" class="ct-pin${own ? ' on' : ''}" data-i="${i}" aria-pressed="${own}" aria-label="${own ? 'เลิกปักหมุด' : 'ปักหมุด'} ${esc(nameOf(r))}" title="${own ? 'เลิกปักหมุด' : 'ปักหมุดไว้บนสุด'}">${PIN_SVG}</button>`;
      const cells = cols.map((c) => {
        const v = r[c.field];
        // stock that ran out or went below zero (issued before it was received) says so
        const flag = cu.qty_field === c.field && typeof v === 'number' && v <= 0
          ? ` <span class="ct-flag ${v < 0 ? 'neg' : 'zero'}">${v < 0 ? 'ติดลบ' : 'หมด'}</span>` : '';
        return typeof v === 'number'
          ? `<td class="num" data-label="${esc(label(c))}">${esc(c.format ? fmtValue(v, c.format) : v.toLocaleString('th-TH', { maximumFractionDigits: 2 }))}${flag}</td>`
          : `<td class="ct-txt" data-label="${esc(label(c))}">${esc(v == null || v === '' ? '-' : v)}</td>`;
      }).join('');
      // pinned products carry their own up/down arrows (once per product, on its first row)
      const gk = keyOf(r) || nameOf(r); let mv = '';
      if (pinned(r) && plKeys.length > 1 && !seenGroup.has(gk)) {
        seenGroup.add(gk); const pi = plKeys.indexOf(gk);
        mv = `<span class="ct-rowmove"><button type="button" class="ct-rup" data-k="${esc(gk)}" aria-label="เลื่อน ${esc(nameOf(r))} ขึ้นในลำดับที่ปักหมุด"${pi === 0 ? ' disabled' : ''}>▲</button><button type="button" class="ct-rdown" data-k="${esc(gk)}" aria-label="เลื่อน ${esc(nameOf(r))} ลงในลำดับที่ปักหมุด"${pi === plKeys.length - 1 ? ' disabled' : ''}>▼</button></span>`;
      }
      return `<tr${pinned(r) ? ' class="ct-pinned"' : ''}><td class="ct-pin-cell">${pin}${mv}</td>${cells}</tr>`;
    }).join('');
    const more = Math.min(data.length, limit) - PREVIEW;
    scroller.innerHTML = data.length
      ? `<table class="report-table ct-table${nums >= 3 ? ' nums-many' : ''}"><thead><tr>${head}</tr></thead><tbody>${rowsHtml}</tbody></table>${more > 0 ? `<button type="button" class="table-more">${expanded ? 'ย่อเหลือ ' + PREVIEW + ' แถวแรก' : 'แสดงอีก ' + more.toLocaleString('th-TH') + ' แถว'}</button>` : ''}`
      : `<p class="muted ct-empty">${prefs.pinned_only ? 'ยังไม่มีสินค้าที่ปักหมุดตรงกับตัวกรองนี้' : query ? 'ไม่พบสินค้าที่ค้นหา' : 'ไม่มีข้อมูล'}</p>`;
    const mb = scroller.querySelector('.table-more');
    if (mb) mb.addEventListener('click', () => { expanded = !expanded; drawTable(); scroller.querySelector('.table-more').focus(); });
    scroller.querySelectorAll('th[data-field]').forEach((th) => {
      const toggle = () => {
        const f = th.dataset.field;
        sort = !sort || sort.field !== f ? { field: f, dir: 'desc' } : sort.dir === 'desc' ? { field: f, dir: 'asc' } : null;
        drawTable();
        const again = scroller.querySelector(`th[data-field="${CSS.escape(f)}"]`); if (again) again.focus();
      };
      th.addEventListener('click', toggle);
      th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    });
    scroller.querySelectorAll('.ct-rup').forEach((b) => b.addEventListener('click', () => pmove(b.dataset.k, -1, 'row')));
    scroller.querySelectorAll('.ct-rdown').forEach((b) => b.addEventListener('click', () => pmove(b.dataset.k, 1, 'row')));
    scroller.querySelectorAll('.ct-pin[data-i]').forEach((b) => b.addEventListener('click', () => {
      const r = shown[Number(b.dataset.i)];
      const k = keyOf(r);
      if (!k) return;
      const was = prefs.pins.includes(k);
      prefs.pins = was ? prefs.pins.filter((x) => x !== k) : [...prefs.pins, k];
      if (was) prefs.pin_order = prefs.pin_order.filter((x) => x !== k);
      else if (prefs.pin_order.length && !prefs.pin_order.includes(k)) prefs.pin_order = [...prefs.pin_order, k];
      msg.textContent = was ? `เลิกปักหมุด ${nameOf(r)}` : `ปักหมุด ${nameOf(r)} ไว้บนสุดแล้ว`;
      save(); drawPanel(); drawTools(); drawTable();
      // keep the keyboard on the same product's pin, wherever it moved
      const idx = shown.length && [...scroller.querySelectorAll('.ct-pin[data-i]')].find((x) => keyOf(shownNow()[Number(x.dataset.i)]) === k);
      if (idx) idx.focus();
    }));
  }
  const shownNow = () => dataNow().slice(0, expanded ? limit : PREVIEW);

  // every pinned product (one entry each, whatever branch or search is on), in the order shown
  const pinList = () => {
    const out = []; const seen = new Set();
    orderPins(sortRows(rows)).forEach((r) => { const k = keyOf(r) || nameOf(r); if (!seen.has(k)) { seen.add(k); out.push({ k, name: nameOf(r) }); } });
    return out;
  };

  // order of the pinned products: the first change writes the whole list down
  const setPinOrder = (keys, say, focus) => {
    if (keys.length) undoPin = null;
    prefs.pin_order = keys; msg.textContent = say;
    save(); drawPanel(focus); drawTable();
  };
  // d = -1 up, +1 down; from = which button to keep the keyboard on afterwards
  const pmove = (k, d, from) => {
    const pl = pinList(); const keys = pl.map((x) => x.k); const i = keys.indexOf(k); const j = i + d;
    if (i < 0 || j < 0 || j >= keys.length) return;
    [keys[i], keys[j]] = [keys[j], keys[i]];
    setPinOrder(keys, `ย้าย ${pl[i].name} ไปลำดับที่ ${j + 1} จาก ${keys.length}`, from === 'row' ? null : `.${d < 0 ? 'ct-pup' : 'ct-pdown'}[data-k="${CSS.escape(k)}"]`);
    if (from === 'row') {
      const sel = (c) => scroller.querySelector(`.${c}[data-k="${CSS.escape(k)}"]`);
      let el = sel(d < 0 ? 'ct-rup' : 'ct-rdown');
      if (!el || el.disabled) el = sel(d < 0 ? 'ct-rdown' : 'ct-rup');
      if (el) el.focus();
    }
  };

  function drawPanel(focusSel) {
    const plist = pinList();
    const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const cols = prefs.order.map((f) => byField.get(f));
    panel.innerHTML = `
      <fieldset class="ct-cols"><legend>คอลัมน์ที่แสดง และลำดับ</legend>
        <p class="muted ct-hint">ติ๊กเพื่อแสดง ใช้ปุ่มขึ้นลงหรือลากเพื่อเรียงลำดับ</p>
        <ol>${cols.map((c, i) => `<li draggable="true" data-f="${esc(c.field)}">
          <span class="ct-grip" aria-hidden="true">⋮⋮</span>
          <label><input type="checkbox" data-f="${esc(c.field)}"${prefs.hidden.includes(c.field) ? '' : ' checked'}> ${esc(label(c))}</label>
          <span class="ct-move">
            <button type="button" class="ct-up" data-f="${esc(c.field)}" aria-label="เลื่อน ${esc(label(c))} ขึ้น"${i === 0 ? ' disabled' : ''}>▲</button>
            <button type="button" class="ct-down" data-f="${esc(c.field)}" aria-label="เลื่อน ${esc(label(c))} ลง"${i === cols.length - 1 ? ' disabled' : ''}>▼</button>
          </span></li>`).join('')}</ol>
      </fieldset>
      ${plist.length > 1 ? `<fieldset class="ct-cols ct-pinorder"><legend>ลำดับสินค้าที่ปักหมุด</legend>
        <p class="muted ct-hint">${touch ? 'เรียงสินค้าที่ปักหมุดตามที่ต้องการ ใช้ปุ่มขึ้นลง ตารางจะเรียงตามนี้เสมอ' : 'เรียงสินค้าที่ปักหมุดตามที่ต้องการ ใช้ปุ่มขึ้นลงหรือลาก ตารางจะเรียงตามนี้เสมอ'}</p>
        <ol>${plist.map((x, i) => `<li${touch ? '' : ' draggable="true"'} data-k="${esc(x.k)}">
          <span class="ct-grip" aria-hidden="true">⋮⋮</span>
          <span class="ct-pname">${esc(x.name)}</span>
          <span class="ct-move">
            <button type="button" class="ct-pup" data-k="${esc(x.k)}" aria-label="เลื่อน ${esc(x.name)} ขึ้น"${i === 0 ? ' disabled' : ''}>▲</button>
            <button type="button" class="ct-pdown" data-k="${esc(x.k)}" aria-label="เลื่อน ${esc(x.name)} ลง"${i === plist.length - 1 ? ' disabled' : ''}>▼</button>
          </span></li>`).join('')}</ol>
        ${prefs.pin_order.length ? '<button type="button" class="link-btn ct-pauto">ล้างลำดับที่จัดเอง (กลับไปเรียงตามตาราง)</button>' : undoPin ? '<button type="button" class="link-btn ct-pundo">ย้อนกลับลำดับที่จัดไว้</button>' : ''}
      </fieldset>` : ''}
      ${cats.length ? `<fieldset class="ct-cats"><legend>ปักหมุดทั้งหมวด</legend>
        <p class="muted ct-hint">สินค้าทุกตัวในหมวดที่เลือกจะขึ้นไปอยู่บนสุด</p>
        <div class="ct-chips">${cats.map((c) => { const on = prefs.pin_cats.includes(c); const n = rows.filter((r) => catOf(r) === c).length; return `<button type="button" class="ct-cat${on ? ' on' : ''}" data-c="${esc(c)}" aria-pressed="${on}">${on ? PIN_SVG + ' ' : ''}${esc(c)} <span class="muted">${n}</span></button>`; }).join('')}</div>
      </fieldset>` : ''}
      <div class="ct-panel-foot">
        <button type="button" class="btn small ct-done">เสร็จ</button>
        <button type="button" class="link-btn ct-reset">คืนค่าเริ่มต้น</button>
      </div>`;
    const move = (f, d) => {
      const i = prefs.order.indexOf(f); const j = i + d;
      if (i < 0 || j < 0 || j >= prefs.order.length) return;
      const o = [...prefs.order]; [o[i], o[j]] = [o[j], o[i]]; prefs.order = o;
      msg.textContent = `ย้าย ${label(byField.get(f))} ไปลำดับที่ ${j + 1}`;
      save(); drawPanel(`.${d < 0 ? 'ct-up' : 'ct-down'}[data-f="${CSS.escape(f)}"]`); drawTable();
    };
    panel.querySelectorAll('input[type=checkbox]').forEach((cb) => cb.addEventListener('change', () => {
      const f = cb.dataset.f;
      if (!cb.checked && visible().length <= 1) { cb.checked = true; msg.textContent = 'ต้องแสดงอย่างน้อย 1 คอลัมน์'; return; }
      prefs.hidden = cb.checked ? prefs.hidden.filter((x) => x !== f) : [...prefs.hidden, f];
      save(); drawTable();
    }));
    panel.querySelectorAll('.ct-up').forEach((b) => b.addEventListener('click', () => move(b.dataset.f, -1)));
    panel.querySelectorAll('.ct-down').forEach((b) => b.addEventListener('click', () => move(b.dataset.f, 1)));
    // drag to reorder (mouse); the buttons do the same for keyboard and touch
    let dragF = null;
    panel.querySelectorAll('li[draggable]').forEach((li) => {
      li.addEventListener('dragstart', (e) => { dragF = li.dataset.f; li.classList.add('dragging'); try { e.dataTransfer.setData('text/plain', dragF); e.dataTransfer.effectAllowed = 'move'; } catch (er) { /* old browser */ } });
      li.addEventListener('dragend', () => { li.classList.remove('dragging'); dragF = null; });
      li.addEventListener('dragover', (e) => { if (dragF && dragF !== li.dataset.f) { e.preventDefault(); li.classList.add('drop'); } });
      li.addEventListener('dragleave', () => li.classList.remove('drop'));
      li.addEventListener('drop', (e) => {
        e.preventDefault(); li.classList.remove('drop');
        if (!dragF || dragF === li.dataset.f) return;
        const o = prefs.order.filter((f) => f !== dragF);
        o.splice(o.indexOf(li.dataset.f) + (prefs.order.indexOf(dragF) < prefs.order.indexOf(li.dataset.f) ? 1 : 0), 0, dragF);
        prefs.order = o; save(); drawPanel(); drawTable();
      });
    });
    panel.querySelectorAll('.ct-pup').forEach((b) => b.addEventListener('click', () => pmove(b.dataset.k, -1)));
    panel.querySelectorAll('.ct-pdown').forEach((b) => b.addEventListener('click', () => pmove(b.dataset.k, 1)));
    let dragK = null;
    panel.querySelectorAll('li[data-k]').forEach((li) => {
      li.addEventListener('dragstart', (e) => { dragK = li.dataset.k; li.classList.add('dragging'); try { e.dataTransfer.setData('text/plain', dragK); e.dataTransfer.effectAllowed = 'move'; } catch (er) { /* old browser */ } });
      li.addEventListener('dragend', () => { li.classList.remove('dragging'); dragK = null; });
      li.addEventListener('dragover', (e) => { if (dragK && dragK !== li.dataset.k) { e.preventDefault(); li.classList.add('drop'); } });
      li.addEventListener('dragleave', () => li.classList.remove('drop'));
      li.addEventListener('drop', (e) => {
        e.preventDefault(); li.classList.remove('drop');
        if (!dragK || dragK === li.dataset.k) return;
        const keys = plist.map((x) => x.k); const from = keys.indexOf(dragK); const to = keys.indexOf(li.dataset.k);
        keys.splice(from, 1); keys.splice(to, 0, dragK);
        setPinOrder(keys, `ย้าย ${plist[from].name} ไปลำดับที่ ${to + 1} จาก ${keys.length}`);
      });
    });
    const pauto = panel.querySelector('.ct-pauto');
    if (pauto) pauto.addEventListener('click', () => { const was = prefs.pin_order; setPinOrder([], 'ล้างลำดับที่จัดเองแล้ว สินค้าที่ปักหมุดเรียงตามตาราง', '.ct-pundo'); undoPin = was; drawPanel('.ct-pundo'); });
    const pundo = panel.querySelector('.ct-pundo');
    if (pundo) pundo.addEventListener('click', () => { const was = undoPin; setPinOrder(was, 'คืนลำดับที่จัดไว้แล้ว', '.ct-pauto'); });
    panel.querySelectorAll('.ct-cat').forEach((b) => b.addEventListener('click', () => {
      const c = b.dataset.c; const was = prefs.pin_cats.includes(c);
      prefs.pin_cats = was ? prefs.pin_cats.filter((x) => x !== c) : [...prefs.pin_cats, c];
      msg.textContent = was ? `เลิกปักหมวด ${c}` : `ปักหมุดทั้งหมวด ${c} แล้ว`;
      save(); drawPanel(`.ct-cat[data-c="${CSS.escape(c)}"]`); drawTools(); drawTable();
    }));
    panel.querySelector('.ct-reset').addEventListener('click', () => {
      prefs = blank(); msg.textContent = 'คืนค่าคอลัมน์ ลำดับ และปักหมุดเป็นค่าเริ่มต้นแล้ว';
      save(); drawPanel('.ct-reset'); drawTools(); drawTable();
    });
    panel.querySelector('.ct-done').addEventListener('click', () => { CT_OPEN.set(wid, false); drawTools(); $('.ct-open').focus(); });
    if (focusSel) {
      // a button that just became disabled (top or bottom of the list) hands focus to its partner
      const opp = { 'ct-up': 'ct-down', 'ct-down': 'ct-up', 'ct-pup': 'ct-pdown', 'ct-pdown': 'ct-pup' };
      let el = panel.querySelector(focusSel);
      if (el && el.disabled) el = panel.querySelector(focusSel.replace(/ct-(up|down|pup|pdown)/, (m, c) => opp['ct-' + c].slice(0))) || el;
      if (el && !el.disabled) el.focus();
    }
  }

  $('.ct-open').addEventListener('click', () => {
    const open = !CT_OPEN.get(wid); CT_OPEN.set(wid, open);
    drawTools();
    if (open) { const f = panel.querySelector('input,button'); if (f) f.focus(); }
  });
  $('.ct-only').addEventListener('click', () => { prefs.pinned_only = !prefs.pinned_only; expanded = false; save(); drawTools(); drawTable(); $('.ct-only').focus(); });
  $('.ct-csv').addEventListener('click', () => exportCsv(dataNow(), visible()));
  const bsel = body.querySelector('.ct-branch select');
  if (bsel) bsel.addEventListener('change', () => { prefs.branch = bsel.value; expanded = false; msg.textContent = prefs.branch ? `แสดงเฉพาะ ${prefs.branch}` : 'แสดงทุกสาขา'; save(); drawTools(); drawTable(); });
  const search = body.querySelector('.ct-search input');
  if (search) search.addEventListener('input', () => { query = search.value.trim(); expanded = false; drawTable(); });
  drawPanel(); drawTools(); drawTable();
}

function exportCsv(rows, columns) {
  if (!rows.length) return;
  const fields = columns.map((c) => c.field);
  const csv = [fields.join(',')]
    .concat(rows.map((r) => fields.map((f) => `"${String(r[f] ?? '').replace(/"/g, '""')}"`).join(',')))
    .join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }));
  link.download = 'kss-report.csv';
  link.click();
}

// Recipe cost structure shared by the two menu-costing simulators.
function menuCostModel(rows) {
  const MENU = ['menu_name', 'menu_code'];
  const ING = ['ingredient_name', 'ingredient_code'];
  const menus = {};
  rows.forEach((r) => {
    const m = pick(r, MENU) ?? 'ไม่ระบุเมนู';
    const i = pick(r, ING) ?? 'ไม่ระบุวัตถุดิบ';
    const cost = num(r.total_cost);
    if (!menus[m]) menus[m] = { total: 0, ingredients: {} };
    menus[m].total += cost;
    menus[m].ingredients[i] = (menus[m].ingredients[i] || 0) + cost;
  });
  return menus;
}

function sensitivityRows(list, x, shareKey, labelFn) {
  const maxShare = Math.max(...list.map((i) => i[shareKey]), 1e-9);
  return list
    .map((item) => {
      const y = (item[shareKey] / 100) * x;
      return `<div class="bar-row" title="${esc(labelFn(item))}: ${fmtValue(y, 'pct_signed')}">
        <span class="bar-name">${esc(labelFn(item))}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, (item[shareKey] / maxShare) * 100)}%;background:var(--amber)"></span></span>
        <span class="bar-value">${esc(fmtValue(y, 'pct_signed'))}</span>
      </div>`;
    })
    .join('');
}

// Ingredient price sensitivity: if an ingredient's price moves X%, the menus
// using it move by (its average share of those menus' cost) × X.
function renderSensitivity(body, rows, cfg) {
  const menus = menuCostModel(rows);
  const byIng = {};
  Object.values(menus).forEach((m) => {
    Object.entries(m.ingredients).forEach(([name, cost]) => {
      if (!byIng[name]) byIng[name] = { name, shares: [], menuCount: 0 };
      byIng[name].menuCount++;
      if (m.total) byIng[name].shares.push(cost / m.total);
    });
  });
  const list = Object.values(byIng)
    .map((i) => ({ ...i, avgSharePct: i.shares.length ? (i.shares.reduce((s, v) => s + v, 0) / i.shares.length) * 100 : 0 }))
    .sort((a, b) => b.avgSharePct - a.avgSharePct)
    .slice(0, cfg.top_n || 10);

  body.innerHTML = `
    <p class="widget-help">ถ้าราคาวัตถุดิบขยับ X% ต้นทุนเมนูที่ใช้วัตถุดิบนั้นจะขยับตามสัดส่วนที่วัตถุดิบคิดเป็นของต้นทุนเมนู</p>
    <label class="inline-field">ราคาวัตถุดิบเปลี่ยน (X%) <input type="number" class="sens-x" value="${Number(cfg.default_pct) || 10}" step="1"></label>
    <div class="bar-list sens-list"></div>`;
  const input = body.querySelector('.sens-x');
  const draw = () => {
    body.querySelector('.sens-list').innerHTML = sensitivityRows(list, Number(input.value) || 0, 'avgSharePct', (i) => `${i.name} (${i.menuCount} เมนู)`);
  };
  input.addEventListener('input', draw);
  draw();
}

function renderMenuBreakdown(body, rows, cfg) {
  const menus = menuCostModel(rows);
  const list = Object.entries(menus)
    .map(([name, m]) => ({ name, ...m }))
    .sort((a, b) => b.total - a.total);
  body.innerHTML = `
    <p class="widget-help">เลือกเมนู เพื่อดูว่าวัตถุดิบไหนเป็นสัดส่วนต้นทุนมากที่สุด และถ้าราคาวัตถุดิบนั้นขยับ X% ต้นทุนเมนูนี้ขยับเท่าไหร่</p>
    <div class="inline-fields">
      <label class="inline-field">เมนู <select class="mb-menu">${list
        .map((m) => `<option value="${esc(m.name)}">${esc(m.name)} — ${esc(fmtValue(m.total, 'currency'))}</option>`)
        .join('')}</select></label>
      <label class="inline-field">วัตถุดิบเปลี่ยนราคา (X%) <input type="number" class="mb-x" value="${Number(cfg.default_pct) || 10}" step="1"></label>
    </div>
    <p class="widget-foot mb-summary"></p>
    <div class="bar-list mb-list"></div>`;
  const select = body.querySelector('.mb-menu');
  const input = body.querySelector('.mb-x');
  const draw = () => {
    const menu = list.find((m) => m.name === select.value) || list[0];
    if (!menu) return;
    const ings = Object.entries(menu.ingredients)
      .map(([name, cost]) => ({ name, cost, sharePct: menu.total ? (cost / menu.total) * 100 : 0 }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, cfg.top_n || 10);
    body.querySelector('.mb-summary').textContent = `ต้นทุนรวมเมนูนี้ ${fmtValue(menu.total, 'currency')} · ใช้วัตถุดิบ ${Object.keys(menu.ingredients).length} รายการ`;
    body.querySelector('.mb-list').innerHTML = sensitivityRows(ings, Number(input.value) || 0, 'sharePct', (i) => `${i.name} (${i.sharePct.toFixed(1)}% ของต้นทุน)`);
  };
  select.addEventListener('change', draw);
  input.addEventListener('input', draw);
  draw();
}

// A single-hue sequential ramp, light to dark. Used wherever slices or tiles
// encode magnitude rather than identity, so the reader sees "more" as "darker"
// instead of having to decode a rainbow.
const SEQ_RAMP = tokenList(['--q1', '--q2', '--q3', '--q4', '--q5']);
// Distinct in hue AND lightness, so neighbouring slices separate in greyscale too.
// No chili: in this app red means "needs action" (overdue, awaiting invoice).
const CAT_COLORS = tokenList(['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7']);
const seqColor = (i, n) => SEQ_RAMP[Math.min(SEQ_RAMP.length - 1, Math.floor((i / Math.max(1, n - 1)) * (SEQ_RAMP.length - 1)))];

// Shared shaping for the renderers that rank grouped rows.
function rankedItems(rows, cfg, fallbackTop) {
  const groups = groupRows(rows, rowFields(cfg));
  let items = [...groups].map(([name, rs]) => ({ name: String(name), value: evalMetric(cfg.value, rs), rows: rs }));
  items = items.filter((i) => Number.isFinite(i.value));
  items.sort(cfg.sort === 'asc' ? (a, b) => a.value - b.value : (a, b) => b.value - a.value);
  return { items: items.slice(0, cfg.top_n || fallbackTop), total: groups.size };
}

// ---- donut: part-to-whole for a small set of named states ----
// Only used where the parts genuinely sum to a meaningful whole (order status,
// stock value by category); a ranked bar is better for anything else.
function renderDonut(body, rows, cfg) {
  const top = cfg.top_n || 6;
  const all = rankedItems(rows, { ...cfg, top_n: 1e9 }, top).items;
  if (!all.length) return;
  // Part-to-whole only reads true if the parts are the whole: fold everything
  // past the top slices into one, instead of dropping it from the total.
  const items = all.slice(0, top);
  if (all.length > top) {
    items.push({ other: true, name: `อื่น ๆ (${all.length - top})`, value: all.slice(top).reduce((a, i) => a + i.value, 0) });
  }
  const sum = items.reduce((a, i) => a + i.value, 0);
  // Ring on the left, a legend that carries the amounts on the right: the
  // numbers are the point, so they should not hide behind a hover.
  const box = document.createElement('div');
  box.className = 'donut-box';
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap donut-ring';
  wrap.innerHTML = '<canvas></canvas>';
  box.appendChild(wrap);
  const legend = document.createElement('ul');
  legend.className = 'donut-legend';
  box.appendChild(legend);
  body.appendChild(box);
  // Slices are categories, not steps on a scale: a shaded ramp ran out of
  // distinct shades past five and painted neighbours the same blue. The tail
  // slice is always neutral so it never reads as a category of its own.
  const colors = items.map((it, i) =>
    (cfg.colors && cfg.colors[it.name]) || (it.other ? cssv('--s-other') : CAT_COLORS[i % CAT_COLORS.length])
  );
  I18N.hookCharts();
  const chart = new Chart(wrap.querySelector('canvas'), {
    type: 'doughnut',
    data: { labels: items.map((i) => i.name), datasets: [{ data: items.map((i) => i.value), backgroundColor: colors, borderColor: '#fff', borderWidth: 2 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '58%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.label}: ${fmtValue(ctx.parsed, cfg.format)} (${sum ? ((ctx.parsed / sum) * 100).toFixed(0) : 0}%)`,
          },
        },
      },
    },
  });
  activeCharts.push(chart);
  legend.innerHTML = items
    .map((it, i) => {
      const share = sum ? Math.round((it.value / sum) * 100) : 0;
      return `<li><span class="dot" style="background:${colors[i]}"></span><span class="nm" title="${esc(it.name)}">${esc(it.name)}</span><span class="vl">${esc(fmtValue(it.value, cfg.format))}</span><span class="sh">${share}%</span></li>`;
    })
    .join('');
}

// ---- tabs_bar: a ranked bar list with period tabs above it ----
// Each tab shows the average per group for its period (average per branch),
// so a chain owner reads "a branch buys ฿X a week" before the ranking.
// Tabs filter inside the rows the range picker already gave this widget.
function renderTabsBar(body, rows, cfg) {
  const tabs = cfg.tabs || [{ label: 'ช่วงที่เลือก' }];
  const fieldOf = (cfg.date_fields || [])[0];
  const slice = (t) => (t.days && fieldOf ? rows.filter((r) => rowMatches({ op: 'within_days', field: fieldOf, days: t.days }, r)) : rows);
  const avgPer = (rs) => {
    const groups = groupRows(rs, rowFields(cfg));
    return groups.size ? evalMetric(cfg.value, rs) / groups.size : 0;
  };
  const head = document.createElement('div');
  head.className = 'tabs-bar-head';
  head.innerHTML = `<p class="tabs-bar-caption">${esc(cfg.caption || 'เฉลี่ยต่อรายการ')}</p><div class="tabs-bar-tabs" role="tablist"></div>`;
  const tabRow = head.querySelector('.tabs-bar-tabs');
  const list = document.createElement('div');
  body.appendChild(head);
  body.appendChild(list);
  let active = Math.min(cfg.default_tab ?? tabs.length - 1, tabs.length - 1);
  const draw = () => {
    tabRow.innerHTML = '';
    tabs.forEach((t, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `tabs-bar-tab${i === active ? ' active' : ''}`;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(i === active));
      b.innerHTML = `<span>${esc(t.label)}</span><b>${esc(fmtValue(avgPer(slice(t)), cfg.format))}</b>`;
      b.addEventListener('click', () => { active = i; draw(); });
      tabRow.appendChild(b);
    });
    list.innerHTML = '';
    const rs = slice(tabs[active]);
    if (!rs.length) {
      list.innerHTML = '<p class="muted">ไม่มีรายการในช่วงนี้</p>';
      return;
    }
    renderBar(list, rs, cfg);
  };
  draw();
}

// ---- stack: one horizontal bar per group, split into parts of its whole ----
// cfg.segments = [{label, color, value}]; the segments must sum to the bar's
// whole (use floor0/diff for "the rest"), or the stack would misstate it.
function renderStack(body, rows, cfg) {
  const groups = groupRows(rows, rowFields(cfg));
  const segs = cfg.segments || [];
  let items = [...groups].map(([name, rs]) => {
    const parts = segs.map((sg) => evalMetric(sg.value, rs));
    return { name: String(name), parts, total: parts.reduce((a, b) => a + b, 0) };
  });
  items = items.filter((i) => i.total > 0).sort((a, b) => b.total - a.total);
  const shown = items.slice(0, cfg.top_n || 8);
  if (!shown.length) {
    body.insertAdjacentHTML('beforeend', `<p class="muted">${esc(cfg.empty_message || 'ไม่มีรายการ')}</p>`);
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  wrap.style.height = `${Math.max(160, shown.length * 34 + 60)}px`;
  wrap.innerHTML = '<canvas></canvas>';
  body.appendChild(wrap);
  I18N.hookCharts();
  const chart = new Chart(wrap.querySelector('canvas'), {
    type: 'bar',
    data: {
      labels: shown.map((i) => i.name),
      datasets: segs.map((sg, k) => ({
        label: sg.label,
        data: shown.map((i) => i.parts[k]),
        backgroundColor: sg.color,
        borderColor: '#fff',
        borderWidth: { right: 1 },
        borderSkipped: false,
        maxBarThickness: 22,
      })),
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8, color: cssv('--ink') } },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${fmtValue(ctx.parsed.x, cfg.format)}`,
            footer: (its) => (its.length ? `รวม ${fmtValue(shown[its[0].dataIndex].total, cfg.format)}` : ''),
          },
        },
      },
      scales: {
        x: { stacked: true, beginAtZero: true, grid: { color: cssv('--chart-grid') }, border: { display: false }, ticks: { color: cssv('--muted'), callback: (v) => fmtAxis(v, cfg.format) } },
        y: { stacked: true, grid: { display: false }, ticks: { color: cssv('--ink') } },
      },
    },
  });
  activeCharts.push(chart);
  if (items.length > shown.length) {
    body.insertAdjacentHTML('beforeend', `<p class="widget-foot">แสดง ${shown.length} จาก ${items.length} กลุ่ม</p>`);
  }
}

// ---- panels: one widget, several small charts, each on its own pull ----
// cfg.panels = [{ title, note?, from: <alias>, chart: 'donut'|'stack'|..., wide?, ...that chart's config }]
function renderPanels(body, byAlias, cfg) {
  const grid = document.createElement('div');
  grid.className = 'panel-grid';
  body.appendChild(grid);
  (cfg.panels || []).forEach((panel) => {
    const cell = document.createElement('section');
    cell.className = `panel${panel.wide ? ' panel-wide' : ''}`;
    cell.innerHTML = `<h4 class="panel-title">${esc(panel.title || '')}</h4>${panel.note ? `<p class="widget-foot">${esc(panel.note)}</p>` : ''}`;
    grid.appendChild(cell);
    const src = byAlias[panel.from];
    const inner = document.createElement('div');
    if (src === null || src === undefined) {
      cell.appendChild(inner);
      inner.innerHTML = '<p class="muted">ยังไม่มีข้อมูลของรายงานนี้</p>';
      return;
    }
    const rows = applyRowLayer(src, panel);
    // The totals the chart is made of, said once above it in words.
    if (panel.headline && rows.length) {
      const h = document.createElement('p');
      h.className = 'panel-headline';
      h.innerHTML = panel.headline
        .map((m) => `<span><span class="dot" style="background:${m.color || cssv('--muted')}"></span>${esc(m.label)}: <b style="color:${m.color || cssv('--ink')}">${esc(fmtValue(evalMetric(m.value, rows), m.format || panel.format))}</b></span>`)
        .join('');
      cell.appendChild(h);
    }
    cell.appendChild(inner);
    const renderer = RENDERERS[panel.chart];
    if (!rows.length || !renderer) {
      inner.innerHTML = `<p class="muted">${esc(renderer ? panel.empty_message || 'ไม่พบข้อมูลในช่วงนี้' : 'ไม่รู้จักประเภทกราฟ')}</p>`;
      return;
    }
    renderer(inner, rows, panel);
  });
  if (cfg.foot) body.insertAdjacentHTML('beforeend', `<p class="widget-foot">${esc(cfg.foot).replace(/\n/g, '<br>')}</p>`);
}

// ---- pareto: ranked bars plus a cumulative share line ----
// The one place a second y-axis is justified: the line is a percentage of the
// same total the bars sum to, so the two scales describe one quantity.
function renderPareto(body, rows, cfg) {
  const { items } = rankedItems(rows, cfg, 12);
  if (!items.length) return;
  const total = items.reduce((a, i) => a + i.value, 0) || 1;
  let run = 0;
  const cum = items.map((i) => { run += i.value; return (run / total) * 100; });
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  wrap.innerHTML = '<canvas></canvas>';
  body.appendChild(wrap);
  I18N.hookCharts();
  const chart = new Chart(wrap.querySelector('canvas'), {
    data: {
      labels: items.map((i) => i.name),
      datasets: [
        { type: 'bar', label: cfg.bar_label || 'มูลค่า', data: items.map((i) => i.value), backgroundColor: cssv('--s1'), borderRadius: 3, order: 2 },
        { type: 'line', label: 'สะสม %', data: cum, yAxisID: 'y2', borderColor: cssv('--s2'), backgroundColor: cssv('--s2'), borderWidth: 2, pointRadius: 3, tension: 0.2, order: 1 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8, color: cssv('--ink') } },
        tooltip: {
          callbacks: {
            label: (ctx) => (ctx.dataset.yAxisID === 'y2' ? ` ${t(`สะสม ${ctx.parsed.y.toFixed(0)}%`)}` : ` ${fmtValue(ctx.parsed.y, cfg.format)}`),
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: cssv('--muted'), maxRotation: 50, minRotation: 0, autoSkip: false } },
        y: { beginAtZero: true, grid: { color: cssv('--chart-grid') }, border: { display: false }, ticks: { color: cssv('--muted'), callback: (v) => fmtAxis(v, cfg.format) } },
        y2: { position: 'right', min: 0, max: 100, grid: { display: false }, border: { display: false }, ticks: { color: cssv('--s2'), callback: (v) => v + '%' } },
      },
    },
  });
  activeCharts.push(chart);
}

// ---- scatter with quadrant lines ----
// The cut-offs are computed from the data on screen, never hard-coded: the
// menu-engineering rule is (100 / item count) x 0.70, which changes the moment
// the reader filters the list.
const quadrantLines = {
  id: 'quadrantLines',
  afterDatasetsDraw(chart, args, opts) {
    const { ctx, chartArea, scales } = chart;
    if (!opts || opts.x == null) return;
    ctx.save();
    ctx.strokeStyle = cssv('--line-strong');
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    const px = scales.x.getPixelForValue(opts.x);
    const py = scales.y.getPixelForValue(opts.y);
    ctx.beginPath(); ctx.moveTo(px, chartArea.top); ctx.lineTo(px, chartArea.bottom); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(chartArea.left, py); ctx.lineTo(chartArea.right, py); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = cssv('--muted');
    ctx.font = '600 10px system-ui, sans-serif';
    (opts.labels || []).forEach((t, i) => {
      const lx = [px + 5, chartArea.left + 5, px + 5, chartArea.left + 5][i];
      const ly = [chartArea.top + 12, chartArea.top + 12, chartArea.bottom - 5, chartArea.bottom - 5][i];
      ctx.fillText(t, lx, ly);
    });
    ctx.restore();
  },
};

function renderScatter(body, rows, cfg) {
  const groups = groupRows(rows, rowFields(cfg));
  let pts = [...groups]
    .map(([name, rs]) => ({ name: String(name), x: evalMetric(cfg.x, rs), y: evalMetric(cfg.y, rs) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pts.length) return;

  // A "share of the menu" axis is a share of what is actually plotted, so it is
  // computed here rather than per group — and it moves when the reader filters.
  ['x', 'y'].forEach((axis) => {
    if (!cfg[axis + '_share']) return;
    const tot = pts.reduce((a, p) => a + p[axis], 0);
    if (tot) pts = pts.map((p) => ({ ...p, [axis]: (p[axis] / tot) * 100 }));
  });

  // "share" cut-offs are a share of the plotted set, so they must be computed here.
  const cut = (spec, axis) => {
    if (spec == null) return null;
    if (typeof spec === 'number') return spec;
    if (spec.op === 'mean') return pts.reduce((a, p) => a + p[axis], 0) / pts.length;
    if (spec.op === 'share_rule') return (100 / pts.length) * (spec.factor || 0.7);
    return null;
  };
  const qx = cut(cfg.qx, 'x');
  const qy = cut(cfg.qy, 'y');

  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  wrap.innerHTML = '<canvas></canvas>';
  body.appendChild(wrap);
  const colorFor = (p) =>
    qx == null ? cssv('--s1') : p.x >= qx && p.y >= qy ? cssv('--good') : p.x < qx && p.y < qy ? cssv('--danger') : cssv('--s1');
  I18N.hookCharts();
  const chart = new Chart(wrap.querySelector('canvas'), {
    type: 'scatter',
    data: { datasets: [{ data: pts, backgroundColor: pts.map(colorFor), pointRadius: 6, pointHoverRadius: 9, borderColor: '#fff', borderWidth: 1.5 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        quadrantLines: { x: qx, y: qy, labels: cfg.quadrant_labels },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const p = ctx.raw;
              return ` ${p.name} · ${cfg.x_label || 'x'} ${fmtValue(p.x, cfg.x_format)} · ${cfg.y_label || 'y'} ${fmtValue(p.y, cfg.y_format)}`;
            },
          },
        },
      },
      scales: {
        x: { title: { display: !!cfg.x_label, text: cfg.x_label, color: cssv('--muted') }, grid: { color: cssv('--chart-grid') }, ticks: { color: cssv('--muted'), callback: (v) => fmtAxis(v, cfg.x_format) } },
        y: { title: { display: !!cfg.y_label, text: cfg.y_label, color: cssv('--muted') }, grid: { color: cssv('--chart-grid') }, border: { display: false }, ticks: { color: cssv('--muted'), callback: (v) => fmtAxis(v, cfg.y_format) } },
      },
    },
    plugins: [quadrantLines],
  });
  activeCharts.push(chart);
}

// ---- treemap: area as share of a whole, for many small categories ----
// Built as nested flex rows rather than pulled in as a charting plugin; the
// layout is a simple slice-and-dice, which is honest about area and keeps the
// labels selectable.
function renderTreemap(body, rows, cfg) {
  const { items } = rankedItems(rows, cfg, 10);
  if (!items.length) return;
  const total = items.reduce((a, i) => a + i.value, 0) || 1;
  const wrap = document.createElement('div');
  wrap.className = 'treemap';
  // One tall tile for the largest, the rest stacked beside it: the common
  // shape for "one or two things dominate", which is what this chart is for.
  const [first, ...rest] = items;
  const restTotal = rest.reduce((a, i) => a + i.value, 0) || 1;
  const tile = (it, i, pctOfParent, vertical) => {
    const share = (it.value / total) * 100;
    const el = document.createElement('div');
    el.className = 'treemap-tile';
    el.style[vertical ? 'height' : 'width'] = `${pctOfParent}%`;
    el.style.background = seqColor(i, items.length);
    el.style.color = onColor(el.style.background);
    el.title = `${it.name}: ${fmtValue(it.value, cfg.format)} (${share.toFixed(1)}%)`;
    el.innerHTML = `<span class="treemap-name">${esc(it.name)}</span><span class="treemap-val">${esc(fmtValue(it.value, cfg.format))} · ${share.toFixed(0)}%</span>`;
    return el;
  };
  wrap.appendChild(tile(first, 0, (first.value / total) * 100, false));
  if (rest.length) {
    const col = document.createElement('div');
    col.className = 'treemap-col';
    col.style.width = `${100 - (first.value / total) * 100}%`;
    rest.forEach((it, i) => col.appendChild(tile(it, i + 1, (it.value / restTotal) * 100, true)));
    wrap.appendChild(col);
  }
  body.appendChild(wrap);
}

// ---- range plot: where the latest value sits inside its own min–max ----
// Each row is scaled to its own range, because the question is "is this price
// near the cheap end or the dear end for THIS item", not how items compare.
function renderRange(body, rows, cfg) {
  const groups = groupRows(rows, rowFields(cfg));
  let items = [...groups]
    .map(([name, rs]) => ({
      name: String(name),
      min: evalMetric(cfg.min, rs),
      max: evalMetric(cfg.max, rs),
      last: evalMetric(cfg.last, rs),
    }))
    .filter((i) => Number.isFinite(i.min) && Number.isFinite(i.max));
  items.sort((a, b) => (b.max - b.min) - (a.max - a.min));
  items = items.slice(0, cfg.top_n || 10);
  if (!items.length) return;

  const list = document.createElement('div');
  list.className = 'range-list';
  items.forEach((it) => {
    const span = it.max - it.min;
    const t = span > 0 && Number.isFinite(it.last) ? (it.last - it.min) / span : 0;
    const pct = Math.max(0, Math.min(100, t * 100));
    const high = t > 0.5;
    const hasNow = Number.isFinite(it.last);
    const row = document.createElement('div');
    row.className = 'range-row';
    row.title = `${it.name}: ต่ำสุด ${fmtValue(it.min, cfg.format)} · สูงสุด ${fmtValue(it.max, cfg.format)}` +
      (hasNow ? ` · ${cfg.marker_label || 'ล่าสุด'} ${fmtValue(it.last, cfg.format)}` : '');
    row.innerHTML = `
      <span class="bar-name">${esc(it.name)}</span>
      <span class="range-track">
        <span class="range-dot range-end" style="left:0"></span>
        <span class="range-dot range-end" style="left:100%"></span>
        ${hasNow ? `<span class="range-dot range-now ${high ? 'high' : 'low'}" style="left:${pct}%"></span>` : ''}
      </span>
      <span class="bar-value">${esc(fmtValue(hasNow ? it.last : it.max, cfg.format))}</span>`;
    list.appendChild(row);
  });
  body.appendChild(list);
  body.insertAdjacentHTML(
    'beforeend',
    `<p class="widget-foot">${esc(cfg.foot || 'แถบคือช่วงราคาที่เคยซื้อของรายการนั้นเอง จุดเข้มคือราคาล่าสุด')}</p>`
  );
}

// ---- heatmap: rows × columns, every cell printed, darker = larger ----
// "Which customer bought how much on which day" and "which product sells where"
// are both a grid the eye scans for gaps and dark spots. Columns are either a
// date bucketed by day / week / month, or a second field.
//   row_field, col_field | col_date + bucket, value (metric), top_rows,
//   row_rank (metric that picks and orders the rows; default: value),
//   col_sort: 'key' (label order, e.g. weekdays) | default by size,
//   scale: 'global' (default) | 'row' (shade within each row) |
//          'diverging_row' (below / above the row's own average),
//   palette: 'blue' (default) | 'red' (for amounts that are bad news),
//   format, row_label
// A cell with no rows prints "–"; a cell with rows prints its value, zero too,
// because 0% short is a result and a week with no deliveries is not.
const HEAT_PALETTES = {
  blue: ['#EAF1FA', '#C9DCF2', '#9EC2E8', '#6FA3DB', '#3F80C8', '#2A64A6', '#1D4A7E'],
  red: ['#FBEDE9', '#F5D3CA', '#ECB09F', '#E08770', '#CF5E44', '#B4442C', '#8C321F'],
};
function renderHeatmap(body, rows, cfg) {
  const rowKey = (r) => String(pick(r, cfg.row_field) ?? 'ไม่ระบุ');
  const colKey = cfg.col_date
    ? (r) => { const raw = pick(r, cfg.col_date); return raw ? bucketKey(raw, cfg.bucket || 'day') : null; }
    : (r) => String(pick(r, cfg.col_field) ?? 'ไม่ระบุ');
  const cells = new Map();
  const rowsBy = new Map();
  const colsBy = new Map();
  rows.forEach((r) => {
    const rk = rowKey(r), ck = colKey(r);
    if (ck === null) return;
    const k = rk + '\u0001' + ck;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(r);
    if (!rowsBy.has(rk)) rowsBy.set(rk, []);
    rowsBy.get(rk).push(r);
    if (!colsBy.has(ck)) colsBy.set(ck, []);
    colsBy.get(ck).push(r);
  });
  const rank = cfg.row_rank || cfg.value;
  let rowKeys = [...rowsBy.keys()].map((k) => [k, evalMetric(rank, rowsBy.get(k)), evalMetric(cfg.value, rowsBy.get(k))]).sort((a, b) => b[1] - a[1]);
  const totalRows = rowKeys.length;
  rowKeys = rowKeys.slice(0, cfg.top_rows || 30);
  const colKeys = cfg.col_date || cfg.col_sort === 'key'
    ? [...colsBy.keys()].sort((a, b) => a.localeCompare(b, 'th'))
    : [...colsBy.keys()].map((k) => [k, evalMetric(cfg.value, colsBy.get(k))]).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const val = new Map();
  rowKeys.forEach(([rk]) => colKeys.forEach((ck) => {
    const rs = cells.get(rk + '\u0001' + ck);
    if (rs) val.set(rk + '\u0001' + ck, evalMetric(cfg.value, rs));
  }));
  const pal = HEAT_PALETTES[cfg.palette] || HEAT_PALETTES.blue;
  const scale = cfg.scale || (cfg.row_norm ? 'row' : 'global');
  const all = [...val.values()];
  const gMin = Math.min(0, ...all), gMax = Math.max(1e-9, ...all);
  const colLabel = (ck) => (cfg.col_date ? bucketLabel(ck, cfg.bucket || 'day') : ck);
  const short = (v) => fmtCompact(v, cfg.format);
  const shade = (step, list) => `background:${list[step]};color:${onColor(list[step])}`;
  // threshold_col: each cell against its column's median (a month across
  // branches); below `threshold` × median is flagged, far below is darker.
  const thr = Number(cfg.threshold) || 0.85;
  const colMed = new Map();
  if (scale === 'threshold_col') {
    colKeys.forEach((ck) => {
      const v = rowKeys.map(([rk]) => val.get(rk + '\u0001' + ck)).filter((x) => x !== undefined).sort((a, b) => a - b);
      if (v.length >= 3) colMed.set(ck, v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2);
    });
  }
  const lastCol = colKeys[colKeys.length - 1];
  let html = `<table class="heat-table"><thead><tr><th class="heat-row">${esc(cfg.row_label || '')}</th>${colKeys.map((ck) => `<th>${esc(colLabel(ck))}</th>`).join('')}<th>${scale === 'diverging_row' ? 'เฉลี่ย' : scale === 'threshold_col' ? 'ล่าสุด เทียบค่ากลาง' : 'รวม'}</th></tr></thead><tbody>`;
  rowKeys.forEach(([rk, , rowValue]) => {
    const vals = colKeys.map((ck) => val.get(rk + '\u0001' + ck));
    const present = vals.filter((v) => v !== undefined);
    const rMax = Math.max(1e-9, ...present), rMin = Math.min(0, ...present);
    const avg = present.length ? present.reduce((a, b) => a + b, 0) / present.length : 0;
    const dev = Math.max(1e-9, ...present.map((v) => Math.abs(v - avg)));
    html += `<tr><th class="heat-row" title="${esc(rk)}">${esc(rk)}</th>${vals.map((v, i) => {
      const tip = `${rk} · ${colLabel(colKeys[i])}: ${v === undefined ? 'ไม่มีข้อมูล' : fmtValue(v, cfg.format)}${scale === 'diverging_row' && v !== undefined ? ` (${v >= avg ? '+' : ''}${fmtValue(v - avg, cfg.format)} จากค่าเฉลี่ยของแถว)` : ''}`;
      if (v === undefined) return `<td class="heat-empty" title="${esc(tip)}">–</td>`;
      let style;
      if (scale === 'threshold_col') {
        const med = colMed.get(colKeys[i]);
        const r = med ? v / med : 1;
        style = r < thr - 0.1 ? shade(5, HEAT_PALETTES.red) : r < thr ? shade(2, HEAT_PALETTES.red) : 'background:var(--cream);color:var(--ink)';
        const tip2 = med ? `${tip} · ค่ากลาง ${fmtValue(med, cfg.format)} (${Math.round(r * 100)}%)` : tip;
        return `<td style="${style}" title="${esc(tip2)}">${esc(short(v))}</td>`;
      }
      if (scale === 'diverging_row') {
        // diverge_rel: shade by % away from the row average (0.3 = full) with
        // a dead zone, so a 10-vs-11 row doesn't look like an alarm.
        const rel = cfg.diverge_rel ? Math.abs(v - avg) / Math.max(1e-9, Math.abs(avg)) : null;
        const t = rel === null ? Math.min(1, Math.abs(v - avg) / dev) : rel < cfg.diverge_rel / 3 ? 0 : Math.min(1, rel / cfg.diverge_rel);
        const step = Math.min(6, Math.round(t * 5));
        style = step === 0 ? 'background:var(--cream);color:var(--ink)' : shade(step, v < avg ? HEAT_PALETTES.red : HEAT_PALETTES.blue);
      } else {
        const lo = scale === 'row' ? rMin : gMin, hi = scale === 'row' ? rMax : gMax;
        const step = Math.max(0, Math.min(pal.length - 1, Math.floor(((v - lo) / Math.max(1e-9, hi - lo)) * pal.length)));
        style = shade(step, pal);
      }
      return `<td style="${style}" title="${esc(tip)}">${esc(short(v))}</td>`;
    }).join('')}<td class="heat-total">${esc(scale === 'threshold_col' ? (() => { const v = val.get(rk + '\u0001' + lastCol); const m = colMed.get(lastCol); return v !== undefined && m ? Math.round((v / m) * 100) + '%' : '–'; })() : short(scale === 'diverging_row' ? avg : rowValue))}</td></tr>`;
  });
  if (scale === 'threshold_col') {
    html += `<tr class="heat-sum"><th class="heat-row">ค่ากลาง</th>${colKeys.map((ck) => `<td>${colMed.has(ck) ? esc(short(colMed.get(ck))) : '–'}</td>`).join('')}<td></td></tr>`;
  }
  if (cfg.col_totals !== false && scale !== 'diverging_row' && scale !== 'threshold_col' && !/pct/.test(cfg.format || '')) {
    const colTotals = colKeys.map((ck) => rowKeys.reduce((a, [rk]) => a + (val.get(rk + '\u0001' + ck) || 0), 0));
    html += `<tr class="heat-sum"><th class="heat-row">รวม</th>${colTotals.map((v) => `<td>${esc(short(v))}</td>`).join('')}<td>${esc(short(colTotals.reduce((a, b) => a + b, 0)))}</td></tr>`;
  }
  html += '</tbody></table>';
  const wrap = document.createElement('div');
  wrap.className = 'heat-scroll';
  wrap.innerHTML = html;
  body.appendChild(wrap);
  // The key: what light and dark mean, with the values at either end.
  const swatches = (list) => list.map((c) => `<i style="background:${c}"></i>`).join('');
  const legend = scale === 'threshold_col'
    ? `<span class="heat-ramp"><i style="background:${HEAT_PALETTES.red[5]}"></i></span><span>ต่ำกว่า ${Math.round((thr - 0.1) * 100)}% ของค่ากลางเดือนนั้น</span><span class="heat-ramp"><i style="background:${HEAT_PALETTES.red[2]}"></i></span><span>ต่ำกว่า ${Math.round(thr * 100)}%</span><span class="heat-ramp"><i style="background:var(--cream)"></i></span><span>ปกติ</span><span class="muted">· ช่อง – คือไม่มีข้อมูล</span>`
    : scale === 'diverging_row'
    ? `<span>ต่ำกว่าค่าเฉลี่ยของแถว</span><span class="heat-ramp">${swatches([...HEAT_PALETTES.red.slice(1, 6)].reverse())}<i style="background:var(--cream)"></i>${swatches(HEAT_PALETTES.blue.slice(1, 6))}</span><span>สูงกว่า</span>`
    : `<span>${esc(scale === 'row' ? 'น้อยสุดในแถว' : short(gMin))}</span><span class="heat-ramp">${swatches(pal)}</span><span>${esc(scale === 'row' ? 'มากสุดในแถว' : short(gMax))}</span><span class="muted">· ช่อง – คือไม่มีข้อมูล</span>`;
  body.insertAdjacentHTML('beforeend', `<div class="heat-legend">${legend}</div>`);
  if (totalRows > rowKeys.length) body.insertAdjacentHTML('beforeend', `<p class="widget-foot">แสดง ${rowKeys.length} จาก ${totalRows} รายการ</p>`);
}
// ฿12.3k-style numbers for cells too small for a full figure.
function fmtCompact(v, format) {
  if (format !== 'currency' && format !== 'number') return fmtValue(v, format);
  const a = Math.abs(v);
  const pre = format === 'currency' ? '฿' : '';
  if (a >= 1e6) return pre + (v / 1e6).toLocaleString('th-TH', { maximumFractionDigits: 1 }) + 'M';
  if (a >= 1e3) return pre + (v / 1e3).toLocaleString('th-TH', { maximumFractionDigits: 1 }) + 'k';
  return pre + Math.round(v).toLocaleString('th-TH');
}

const RENDERERS = {
  kpi: renderKpi,
  bar: renderBar,
  line: renderLine,
  table: renderTable,
  sensitivity: renderSensitivity,
  menu_breakdown: renderMenuBreakdown,
  donut: renderDonut,
  pareto: renderPareto,
  scatter: renderScatter,
  treemap: renderTreemap,
  range: renderRange,
  stack: renderStack,
  tabs_bar: renderTabsBar,
  heatmap: renderHeatmap,
  date_grid: renderDateGrid,
  par_table: renderParTable,
};

// ---------- par_table: Auto PAR Level (Min / Max PAR from POS sales × recipes) ----------
// The server sends average daily usage per ingredient × branch (lib/parLevel.js).
// The PAR itself is worked out here from the company's per-category settings, so a
// changed setting shows at once:
//   Min PAR (reorder point) = avg daily usage × (lead time + safety days)
//   Max PAR (order-up-to)   = avg daily usage × (order every N days + lead time + safety days)
// FMH tells the buyer to refill to Max when stock falls below Min. PAR is shown in the
// unit the ingredient is ordered in (recipes are written in g / ml / pieces: the ratio
// comes from the purchase data or from a person).
const PAR_DEFAULTS = { lead_days: 2, safety_days: 1, order_days: 3 };
const PAR_WEEKDAYS = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสฯ', 'ศุกร์', 'เสาร์', 'อาทิตย์'];
const parUp = (x) => (x >= 10 ? Math.ceil(x - 1e-9) : Math.ceil(x * 10 - 1e-9) / 10); // round up: a short PAR is a stock-out
// PAR in the unit the ingredient is ORDERED in when that is known (u = { uom, ratio }: base units
// per order unit), else in the recipe's own unit. Max is never left at Min: at least one more order unit.
function parCalc(r, s, u) {
  const d = num(r.avg_daily);
  const minB = d * (s.lead_days + s.safety_days);
  const maxB = d * (s.order_days + s.lead_days + s.safety_days);
  if (u && u.ratio > 0) {
    const min = d > 0 ? Math.max(1, Math.ceil(minB / u.ratio - 1e-9)) : 0;
    let max = Math.ceil(maxB / u.ratio - 1e-9);
    const bumped = max <= min;
    if (bumped) max = min + 1;
    return { unit: u.uom, known: true, min, max, minB, maxB, bumped, ratio: u.ratio };
  }
  return { unit: r.uom, known: false, min: parUp(minB), max: parUp(maxB), minB, maxB, bumped: false, ratio: null };
}

function renderParTable(body, rows, cfg, ctx) {
  const wid = (ctx.widget && ctx.widget.id) || 0;
  const quota = (ctx.quota && ctx.quota.par) || null;
  const minDays = (quota && quota.min_days) || 7;
  let settings = { defaults: { ...PAR_DEFAULTS }, categories: {}, uoms: {}, can_edit: false };
  let branch = '', query = '', catSel = '';
  let sort = { field: 'category', dir: 'asc' };
  let openPanel = ''; // '' | 'cat' | 'uom'
  const cats = [...new Set(rows.map((r) => r.category))].sort((a, b) => a.localeCompare(b, 'th'));
  const branches = [...new Set(rows.map((r) => r.branch))].sort((a, b) => a.localeCompare(b, 'th'));
  const setFor = (c) => settings.categories[c] || settings.defaults;
  const isOwn = (c) => !!settings.categories[c];
  const fmt = (v) => v.toLocaleString('th-TH', { maximumFractionDigits: 1 });
  // one order unit per ingredient: a person's choice first, else what the purchase data says
  const unitOf = (r) => {
    const m = settings.uoms[r.ingredient_code];
    if (m && m.ratio > 0) return { uom: m.order_uom, ratio: m.ratio, via: 'manual' };
    if (r.order_ratio > 0 && r.order_uom) return { uom: r.order_uom, ratio: r.order_ratio, via: 'auto' };
    return null;
  };
  const ingredients = [...new Map(rows.map((r) => [r.ingredient_code, r])).values()].sort((a, b) => a.ingredient_name.localeCompare(b.ingredient_name, 'th'));
  const unknownCount = () => ingredients.filter((r) => !unitOf(r)).length;

  body.insertAdjacentHTML('beforeend', `
    <div class="ct-tools">
      ${branches.length > 1 ? `<label class="ct-branch"><span class="sr-only">สาขา</span><select class="par-branch">${['', ...branches].map((b) => `<option value="${esc(b)}">${b ? esc(b) : 'ทุกสาขา'}</option>`).join('')}</select></label>` : ''}
      ${cats.length > 1 ? `<label class="ct-branch"><span class="sr-only">หมวด</span><select class="par-cat">${['', ...cats].map((c) => `<option value="${esc(c)}">${c ? esc(c) : 'ทุกหมวด'}</option>`).join('')}</select></label>` : ''}
      <label class="ct-search"><span class="sr-only">ค้นหาวัตถุดิบ</span><input type="search" placeholder="ค้นหาชื่อหรือรหัสวัตถุดิบ" autocomplete="off"></label>
      <button type="button" class="btn small ghost par-open" data-p="cat" aria-expanded="false" aria-controls="par-set-${wid}">ตั้งค่าตามหมวด</button>
      <button type="button" class="btn small ghost par-open" data-p="uom" aria-expanded="false" aria-controls="par-set-${wid}">หน่วยสั่ง</button>
      <button type="button" class="btn small ghost par-csv">Export CSV</button>
    </div>
    <div class="par-settings" id="par-set-${wid}" hidden></div>
    <p class="ct-msg" role="status"></p>
    <div class="par-notes"></div>
    <div class="table-scroll" tabindex="0" role="region" aria-label="ตาราง Min PAR และ Max PAR ของแต่ละวัตถุดิบ"></div>
    <p class="widget-foot par-count"></p>
    <p class="widget-foot par-formula"><b>Min PAR</b> = ใช้เฉลี่ยต่อวัน × (Lead time + วันสำรอง) · <b>Max PAR</b> = ใช้เฉลี่ยต่อวัน × (รอบสั่ง + Lead time + วันสำรอง) ปัดขึ้นเสมอ ใน FMH: สต็อกต่ำกว่า Min แจ้งให้เติม และเติมถึง Max</p>
    <p class="widget-foot par-caveat">ยอดใช้นับตามสูตรเท่านั้น ไม่รวมน้ำแข็ง ภาชนะ น้ำมันทอด ของที่ใช้เกินสูตร หรือของเสียจริง ใช้เป็นค่าตั้งต้นแล้วปรับตามหน้างาน · ของสดอายุเก็บสั้น (เช่น เนื้อบด อาหารทะเล 1–2 วัน) ควรตรวจว่า Max ไม่เกินอายุเก็บ · "รอบสั่ง" คือจำนวนวันระหว่างรอบสั่ง หรือระยะห่างที่ยาวที่สุดระหว่างวันที่ส่งของได้</p>`);
  const $ = (s) => body.querySelector(s);
  const msg = $('.ct-msg');
  const panel = $('.par-settings');
  const scroller = $('.table-scroll');

  const viewRows = () => {
    const q = query.toLowerCase();
    let out = rows.filter((r) => (!branch || r.branch === branch) && (!catSel || r.category === catSel)
      && (!q || `${r.ingredient_name} ${r.ingredient_code}`.toLowerCase().includes(q)));
    out = out.map((r) => ({ ...r, ...parCalc(r, setFor(r.category), unitOf(r)), unitVia: (unitOf(r) || {}).via || '' }));
    const f = sort.field;
    out.sort((a, b) => {
      const x = a[f], y = b[f];
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), 'th');
      return (sort.dir === 'asc' ? c : -c) || String(a.ingredient_name).localeCompare(String(b.ingredient_name), 'th') || String(a.branch).localeCompare(String(b.branch), 'th');
    });
    return out;
  };
  const gappy = (r) => r.missing_days >= Math.max(3, Math.round(r.days * 0.15));

  function drawNotes(data) {
    const li = [];
    if (quota) li.push(`คำนวณจากยอดขาย POS ${quota.from} ถึง ${quota.to} (${quota.window_days} วันล่าสุด)${quota.coverage_pct != null ? ` จับคู่สูตรได้ ${quota.coverage_pct}% ของยอดขาย` : ''}`);
    const warn = [];
    if (quota && quota.unmatched_menus) warn.push(`มี ${quota.unmatched_menus} เมนูยังไม่จับคู่สูตร วัตถุดิบของเมนูเหล่านั้นยังไม่ถูกนับ PAR จึงอาจต่ำกว่าจริง`);
    const usingDefault = [...new Set(data.map((r) => r.category))].filter((c) => !isOwn(c));
    if (usingDefault.length) warn.push(`หมวดที่ยังใช้ค่าเริ่มต้น (Lead ${settings.defaults.lead_days} / สำรอง ${settings.defaults.safety_days} / รอบสั่ง ${settings.defaults.order_days} วัน) เป็นค่ากลาง ยังไม่ได้ยืนยันกับซัพพลายเออร์: ${usingDefault.join(', ')}`);
    const thin = data.filter((r) => r.sales_days < minDays).length;
    if (thin) warn.push(`${thin} แถวมีข้อมูลขายไม่ถึง ${minDays} วัน ตัวเลขอาจไม่นิ่ง`);
    const gaps = data.filter(gappy);
    if (gaps.length) {
      const worst = gaps.reduce((a, r) => (r.missing_days > a.missing_days ? r : a));
      warn.push(`${gaps.length} แถวไม่มียอดขายหลายวัน (มากสุด ${worst.missing_days} จาก ${worst.days} วัน ที่ ${worst.branch}) ถ้าสาขาไม่ได้ปิด ให้ตรวจว่าอัปโหลดไฟล์ POS ครบ ไม่งั้นค่าเฉลี่ยและ PAR จะต่ำเกินจริง`);
    }
    const unk = unknownCount();
    if (unk) warn.push(`${unk} วัตถุดิบยังไม่ทราบหน่วยสั่ง จึงแสดงเป็นหน่วยในสูตร (g / ml / ชิ้น) ซึ่งกรอกใน FMH ตรงๆ ไม่ได้ ตั้งหน่วยสั่งก่อนที่ปุ่ม "หน่วยสั่ง"`);
    const bumped = data.filter((r) => r.bumped).length;
    if (bumped) warn.push(`${bumped} แถว Max เท่ากับ Min ในหน่วยสั่ง จึงเพิ่ม Max อีก 1 หน่วยสั่ง (ต้องสั่งอย่างน้อยครั้งละ 1 หน่วย)`);
    $('.par-notes').innerHTML = `<p class="widget-foot">${esc(li.join(' · '))}</p>${warn.length ? `<ul class="par-warn">${warn.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}`;
  }

  function drawTable() {
    const data = viewRows();
    drawNotes(data);
    const cols = [
      ['ingredient_name', 'วัตถุดิบ', false], ['category', 'หมวด', false], ['branch', 'สาขา', false], ['unit', 'หน่วยสั่ง', false],
      ['avg_daily', 'ใช้เฉลี่ย/วัน', true], ['peak_daily', 'ใช้สูงสุด/วัน', true], ['min', 'Min PAR', true], ['max', 'Max PAR', true], ['sales_days', 'ข้อมูล (วัน)', true],
    ];
    const head = cols.map(([f, l, n]) => {
      const on = sort.field === f;
      return `<th class="${n ? 'num' : ''}" tabindex="0" data-field="${f}" aria-sort="${on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">${esc(l)}${on ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`;
    }).join('');
    const limit = cfg.top_n || 500;
    const tr = data.slice(0, limit).map((r) => `<tr>
      <td>${esc(r.ingredient_name)}<span class="par-code">${esc(r.ingredient_code)}</span></td>
      <td>${esc(r.category)}${isOwn(r.category) ? '' : '<span class="par-flag" title="ใช้ค่าเริ่มต้น ยังไม่ได้ยืนยัน">ค่าเริ่มต้น</span>'}</td>
      <td>${esc(r.branch)}</td>
      <td>${r.known ? `${esc(r.unit)}<span class="par-code">1 = ${fmt(r.ratio)} ${esc(r.uom)}${r.unitVia === 'auto' ? ' (จากข้อมูลซื้อ)' : ''}</span>` : `<span class="par-flag par-flag-warn">ไม่ทราบหน่วยสั่ง</span><span class="par-code">แสดงเป็น ${esc(r.uom)}</span>`}</td>
      <td class="num">${fmt(r.avg_daily)}<span class="par-code">${esc(r.uom)}</span></td>
      <td class="num">${fmt(r.peak_daily)}<span class="par-code">${esc(PAR_WEEKDAYS[r.peak_weekday - 1] || '')}</span></td>
      <td class="num par-min"><b>${fmt(r.min)}</b> ${esc(r.unit)}${r.known ? `<span class="par-code">≈ ${fmt(r.minB)} ${esc(r.uom)}</span>` : ''}</td>
      <td class="num par-max"><b>${fmt(r.max)}</b> ${esc(r.unit)}${r.known ? `<span class="par-code">≈ ${fmt(r.maxB)} ${esc(r.uom)}</span>` : ''}</td>
      <td class="num${r.sales_days < minDays || gappy(r) ? ' par-thin' : ''}">${r.sales_days}<span class="par-code">จาก ${r.days} วัน</span>${r.sales_days < minDays ? '<span class="par-flag">ข้อมูลน้อย</span>' : ''}${gappy(r) ? `<span class="par-flag">ขาด ${r.missing_days} วัน</span>` : ''}</td></tr>`).join('');
    scroller.innerHTML = data.length
      ? `<table class="report-table ct-table nums-many"><thead><tr>${head}</tr></thead><tbody>${tr}</tbody></table>`
      : '<p class="muted">ไม่พบวัตถุดิบที่ตรงกับตัวกรอง</p>';
    $('.par-count').textContent = data.length > limit ? `แสดง ${limit.toLocaleString('th-TH')} จาก ${data.length.toLocaleString('th-TH')} แถว (Export ได้ครบ)` : `${data.length.toLocaleString('th-TH')} แถว`;
    $('.par-csv').disabled = !data.length;
    scroller.querySelectorAll('th').forEach((th) => {
      const go = () => { const f = th.dataset.field; sort = sort.field === f ? { field: f, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { field: f, dir: ['ingredient_name', 'category', 'branch', 'unit'].includes(f) ? 'asc' : 'desc' }; drawTable(); const again = scroller.querySelector(`th[data-field="${f}"]`); if (again) again.focus(); };
      th.addEventListener('click', go);
      th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
  }

  // ---- settings panels ----
  // A save error belongs in the row that failed, with the field marked and focused.
  const rowError = (rowEl, text, field) => {
    const el = rowEl.querySelector('.par-err');
    el.textContent = text;
    el.hidden = !text;
    rowEl.querySelectorAll('input').forEach((i) => i.removeAttribute('aria-invalid'));
    if (text && field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
  };
  const lead = (c) => { const v = rows.filter((r) => r.category === c && r.obs_lead_days != null); return v.length ? v.reduce((a, r) => a + r.obs_lead_days, 0) / v.length : null; };
  function drawCatPanel() {
    const can = settings.can_edit;
    const own = Object.keys(settings.categories).length;
    const line = (key, label, s, isDef, hint) => `<div class="par-row" data-cat="${esc(key)}" role="group" aria-label="${esc(label)}">
      <div class="par-cat-name"><b>${esc(label)}</b>${hint ? `<span class="par-code">${esc(hint)}</span>` : ''}</div>
      ${[['lead_days', 'Lead time (วัน)'], ['safety_days', 'วันสำรอง'], ['order_days', 'รอบสั่ง (วัน)']].map(([f, l]) => `<label class="par-field"><span>${l}</span><input type="number" inputmode="decimal" min="0" max="60" step="0.5" value="${s[f]}" data-f="${f}"${can ? '' : ' disabled'}></label>`).join('')}
      ${can ? `<div class="par-actions"><button type="button" class="btn small par-save">บันทึก</button>${!isDef && isOwn(key) ? '<button type="button" class="btn small ghost par-reset">ใช้ค่าเริ่มต้น</button>' : ''}</div>` : ''}
      <p class="par-err" role="alert" hidden></p></div>`;
    panel.innerHTML = `<p class="ct-hint">${can ? 'ตั้งค่าแยกตามหมวดวัตถุดิบ หมวดที่ไม่ได้ตั้งใช้ "ค่าเริ่มต้น" ซึ่งเป็นค่ากลางที่ยังไม่ได้ยืนยัน ตารางคำนวณใหม่ทันทีหลังบันทึก' : 'ผู้ดูแลบริษัทเป็นผู้ตั้งค่านี้ คุณดูตัวเลขได้อย่างเดียว'}${own ? '' : ' ตอนนี้ทุกหมวดใช้ค่าเริ่มต้น'} "รอบสั่ง" = จำนวนวันระหว่างรอบสั่ง (หรือระยะห่างที่ยาวที่สุดระหว่างวันที่ส่งของได้)</p>
      ${line('', 'ค่าเริ่มต้น', settings.defaults, true, 'ใช้กับหมวดที่ไม่ได้ตั้งเอง')}
      ${cats.map((c) => { const o = lead(c); return line(c, c, setFor(c), false, `${isOwn(c) ? 'ตั้งเองแล้ว' : 'ใช้ค่าเริ่มต้น'}${o != null ? ` · ส่งของจริงเฉลี่ย ${fmt(o)} วัน` : ''}`); }).join('')}`;
    panel.querySelectorAll('.par-row').forEach((rowEl) => {
      const cat = rowEl.dataset.cat;
      const sv = rowEl.querySelector('.par-save');
      const call = async (btn, label, body2, done) => {
        btn.disabled = true; const was = btn.textContent; btn.textContent = 'กำลังบันทึก…';
        try {
          settings = { ...settings, ...(await api(`/api/dashboards/${ctx.dashboardId}/par-settings`, { method: 'PUT', body: JSON.stringify({ category: cat, ...body2 }) })) };
          msg.textContent = done;
          drawCatPanel(); drawTable();
        } catch (e) { btn.disabled = false; btn.textContent = was; rowError(rowEl, e.message || 'บันทึกไม่สำเร็จ ลองอีกครั้ง'); }
      };
      if (sv) sv.addEventListener('click', () => {
        const v = {}; let badInput = null;
        rowEl.querySelectorAll('input').forEach((i) => { const n = Number(i.value); if (!badInput && (i.value === '' || !Number.isFinite(n) || n < 0 || n > 60)) badInput = i; v[i.dataset.f] = n; });
        if (badInput) return rowError(rowEl, 'ตัวเลขต้องอยู่ระหว่าง 0–60 วัน', badInput);
        rowError(rowEl, '');
        call(sv, '', v, `บันทึกค่าของ "${cat || 'ค่าเริ่มต้น'}" แล้ว ตารางคำนวณใหม่`);
      });
      const rs = rowEl.querySelector('.par-reset');
      if (rs) rs.addEventListener('click', () => call(rs, '', { reset: true }, `"${cat}" กลับไปใช้ค่าเริ่มต้นแล้ว`));
    });
  }
  function drawUomPanel() {
    const can = settings.can_edit;
    const list = [...ingredients].sort((a, b) => (!!unitOf(a) - !!unitOf(b)) || a.ingredient_name.localeCompare(b.ingredient_name, 'th'));
    panel.innerHTML = `<p class="ct-hint">PAR ตั้งใน FMH ที่หน่วยสั่งซื้อเท่านั้น ส่วนสูตรเขียนเป็นหน่วยเล็ก (g / ml / ชิ้น) ระบบจึงแปลงด้วยอัตราส่วน "1 หน่วยสั่ง = กี่หน่วยในสูตร" ซึ่งอ่านจากข้อมูลการสั่งซื้อเมื่ออ่านได้ (เช่น BAG (5KG)) ที่เหลือ${can ? 'กรอกเอง' : 'ให้ผู้ดูแลบริษัทกรอก'} · ตอนนี้ยังไม่ทราบ ${unknownCount()} จาก ${ingredients.length} รายการ</p>
      ${list.map((r) => {
        const u = unitOf(r);
        const status = u ? (u.via === 'manual' ? 'ตั้งเอง' : 'อ่านจากข้อมูลสั่งซื้อ') : 'ยังไม่ทราบ';
        return `<div class="par-row par-uom-row" data-code="${esc(r.ingredient_code)}" role="group" aria-label="${esc(r.ingredient_name)}">
          <div class="par-cat-name"><b>${esc(r.ingredient_name)}</b><span class="par-code">${esc(r.ingredient_code)} · ${esc(status)}${r.order_uom && !u ? ` · ข้อมูลซื้อใช้หน่วย "${esc(r.order_uom)}"` : ''}</span></div>
          <label class="par-field"><span>ชื่อหน่วยสั่ง</span><input type="text" maxlength="60" value="${esc(u ? u.uom : r.order_uom || '')}" data-f="order_uom" placeholder="เช่น BAG, กก., ลัง"${can ? '' : ' disabled'}></label>
          <label class="par-field"><span>1 หน่วยสั่ง = กี่ ${esc(r.uom)}</span><input type="number" inputmode="decimal" min="0" step="any" value="${u ? u.ratio : ''}" data-f="ratio"${can ? '' : ' disabled'}></label>
          ${can ? `<div class="par-actions"><button type="button" class="btn small par-save">บันทึก</button>${u && u.via === 'manual' ? '<button type="button" class="btn small ghost par-reset">ลบที่ตั้งเอง</button>' : ''}</div>` : ''}
          <p class="par-err" role="alert" hidden></p></div>`;
      }).join('')}`;
    panel.querySelectorAll('.par-uom-row').forEach((rowEl) => {
      const code = rowEl.dataset.code;
      const call = async (btn, payload, done) => {
        btn.disabled = true; const was = btn.textContent; btn.textContent = 'กำลังบันทึก…';
        try {
          settings = { ...settings, ...(await api(`/api/dashboards/${ctx.dashboardId}/par-uom`, { method: 'PUT', body: JSON.stringify({ code, ...payload }) })) };
          msg.textContent = done;
          drawUomPanel(); drawTable();
        } catch (e) { btn.disabled = false; btn.textContent = was; rowError(rowEl, e.message || 'บันทึกไม่สำเร็จ ลองอีกครั้ง'); }
      };
      const sv = rowEl.querySelector('.par-save');
      if (sv) sv.addEventListener('click', () => {
        const nameI = rowEl.querySelector('[data-f="order_uom"]'), ratioI = rowEl.querySelector('[data-f="ratio"]');
        if (!nameI.value.trim()) return rowError(rowEl, 'ระบุชื่อหน่วยสั่ง เช่น BAG, กก., ลัง', nameI);
        const n = Number(ratioI.value);
        if (ratioI.value === '' || !Number.isFinite(n) || n <= 0) return rowError(rowEl, 'อัตราส่วนต้องเป็นตัวเลขมากกว่า 0', ratioI);
        rowError(rowEl, '');
        call(sv, { order_uom: nameI.value.trim(), ratio: n }, 'บันทึกหน่วยสั่งแล้ว ตารางคำนวณใหม่');
      });
      const rs = rowEl.querySelector('.par-reset');
      if (rs) rs.addEventListener('click', () => call(rs, { reset: true }, 'ลบหน่วยสั่งที่ตั้งเองแล้ว'));
    });
  }
  const showPanel = (which) => {
    openPanel = which;
    panel.hidden = !which;
    body.querySelectorAll('.par-open').forEach((b) => b.setAttribute('aria-expanded', String(b.dataset.p === which)));
    if (which === 'cat') drawCatPanel();
    if (which === 'uom') drawUomPanel();
  };

  function exportParCsv() {
    const data = viewRows();
    if (!data.length) return;
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Product code', 'Product name', 'Category', 'Branch', 'Order UOM', 'Base units per order UOM', 'Min PAR (order UOM)', 'Max PAR (order UOM)', 'Base UOM', 'Avg daily usage (base)', 'Peak daily usage (base)', 'Min PAR (base)', 'Max PAR (base)', 'Lead time (days)', 'Safety days', 'Order every (days)', 'Settings', 'Days with sales', 'Calendar days'];
    const out = [head.map(q).join(',')].concat(data.map((r) => {
      const s = setFor(r.category);
      return [r.ingredient_code, r.ingredient_name, r.category, r.branch, r.known ? r.unit : '', r.known ? r.ratio : '', r.known ? r.min : '', r.known ? r.max : '', r.uom, r.avg_daily, r.peak_daily, round2(r.minB), round2(r.maxB), s.lead_days, s.safety_days, s.order_days, isOwn(r.category) ? 'custom' : 'default (unconfirmed)', r.sales_days, r.days].map(q).join(',');
    }));
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(['﻿' + out.join('\r\n')], { type: 'text/csv;charset=utf-8;' }));
    link.download = `auto-par-level${branch ? '_' + branch.replace(/[\\/:*?"<>|\s]+/g, '-') : ''}.csv`;
    link.click();
    const unk = data.filter((r) => !r.known).length;
    msg.textContent = `ส่งออก ${data.length.toLocaleString('th-TH')} แถวแล้ว${unk ? ` · ${unk} แถวไม่ทราบหน่วยสั่ง ช่อง PAR ในหน่วยสั่งเว้นว่างไว้ ใช้คอลัมน์หน่วยในสูตรแทน` : ''}`;
  }
  const round2 = (v) => Math.round(v * 100) / 100;

  body.querySelectorAll('.par-open').forEach((b) => b.addEventListener('click', () => showPanel(openPanel === b.dataset.p ? '' : b.dataset.p)));
  $('.par-csv').addEventListener('click', exportParCsv);
  const bsel = $('.par-branch');
  if (bsel) bsel.addEventListener('change', () => { branch = bsel.value; msg.textContent = branch ? `แสดงเฉพาะ ${branch}` : 'แสดงทุกสาขา'; drawTable(); });
  const csel = $('.par-cat');
  if (csel) csel.addEventListener('change', () => { catSel = csel.value; msg.textContent = catSel ? `แสดงเฉพาะหมวด ${catSel}` : 'แสดงทุกหมวด'; drawTable(); });
  $('.ct-search input').addEventListener('input', (e) => { query = e.target.value.trim(); drawTable(); });
  drawTable();

  // Settings load after the first draw (defaults show at once); the category panel opens
  // by itself while nothing has been set, so the numbers are not taken as final.
  if (ctx.dashboardId) {
    api(`/api/dashboards/${ctx.dashboardId}/par-settings`).then((s) => {
      settings = { ...settings, ...s, uoms: s.uoms || {} };
      drawTable();
      if (!Object.keys(s.categories).length && s.can_edit) showPanel('cat');
    }).catch(() => { msg.textContent = `โหลดการตั้งค่า PAR ไม่สำเร็จ ตอนนี้ใช้ค่าเริ่มต้น (Lead ${PAR_DEFAULTS.lead_days} วัน, สำรอง ${PAR_DEFAULTS.safety_days} วัน, รอบสั่ง ${PAR_DEFAULTS.order_days} วัน)`; });
  }
}

// ---------- date_grid: product rows x branch groups x delivery dates (FMH "Order Items by Branch") ----------
// One row per product (code, unit, tag, category); above the dates sits a band per
// branch, each with every day of the range, so a kitchen reads "what did each branch
// order on which day" across the page. Quantities of the same product / branch / day
// add up. Paged like FMH, with a product search and a CSV laid out like FMH's own export (branch x day, "-" for none, Grand total).
function renderDateGrid(body, rows, cfg, ctx) {
  const cols = cfg.row_fields || [{ field: 'product', label: 'Product' }];
  const GF = cfg.group_field || 'branch';
  const DF = cfg.date_field || 'requested_delivery_date';
  const VF = cfg.value_field || 'quantity';
  const PAGE = cfg.page_size || 12;
  const dayOf = (r) => { const d = String(pick(r, DF) ?? '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : ''; };
  const lines = rows.filter((r) => dayOf(r));
  if (!lines.length) { body.insertAdjacentHTML('beforeend', '<p class="muted ct-empty">ไม่มีข้อมูล</p>'); return; }
  // Picker filters (customer, product, supplying branch, tag, status). They narrow the rows, then the grid is rebuilt
  // from what is left, so the dates, branches and CSV all follow the same selection. A filter whose field the data
  // doesn't carry, or that has fewer than two values, is not shown.
  const valuesOf = (r, f) => {
    const v = pick(r, f.field);
    if (v === null || v === undefined || v === '') return [];
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    return f.split ? String(v).split(f.split).map((x) => x.trim()).filter(Boolean) : [String(v).trim()];
  };
  const filters = (cfg.filters || []).map((f) => {
    const counts = new Map();
    lines.forEach((r) => valuesOf(r, f).forEach((v) => counts.set(v, (counts.get(v) || 0) + 1)));
    return { ...f, options: [...counts.keys()].sort((a, b) => a.localeCompare(b, 'th', { numeric: true })) };
  }).filter((f) => f.options.length > 1);
  const chosen = {}; filters.forEach((f) => { chosen[f.key] = new Set(); });
  const keyFields = (cfg.key_fields && cfg.key_fields.length ? cfg.key_fields : cols.map((c) => c.field));
  const rowKey = (r) => keyFields.map((f) => String(pick(r, f) ?? '')).join('\u0001');
  const dmy = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
  const fmt = (v) => v.toLocaleString('th-TH', { maximumFractionDigits: 2 });
  const WIN = cfg.max_days || 14;
  // Branches follow the order the baskets sit on the trolley (cfg.branch_order); the rest by name, numbers as numbers.
  const branchOrder = Array.isArray(cfg.branch_order) ? cfg.branch_order : [];
  const bRank = (n) => { const i = branchOrder.indexOf(n); return i < 0 ? 1e6 : i; };
  const cmpBranch = (a, b) => bRank(a) - bRank(b) || a.localeCompare(b, 'th', { numeric: true });
  let query = ''; let page = 1; let view = null; let winStart = 0;
  body.insertAdjacentHTML('beforeend', `
    <div class="ct-tools dg-tools">
      <label class="ct-search"><span class="sr-only">ค้นหาสินค้า</span><input type="search" placeholder="ค้นหาชื่อหรือรหัสสินค้า" autocomplete="off"></label>
      <div class="dg-filters" role="group" aria-label="ตัวกรอง"></div>
      <button type="button" class="btn small ghost dg-clear" hidden>ล้างตัวกรอง</button>
      <button type="button" class="btn small ghost dg-csv">ส่งออก CSV</button>
      <button type="button" class="btn small dg-print" data-mode="product" title="เดินคลังทีละสินค้า แล้วแบ่งลงตะกร้าของแต่ละสาขา" aria-describedby="dg-hint">พิมพ์ใบจัดตามสินค้า</button>
      <button type="button" class="btn small dg-print" data-mode="branch" title="จัดทีละสาขา ได้ใบแยกต่อสาขา" aria-describedby="dg-hint">พิมพ์ใบจัดตามสาขา</button>
    </div>
    <p class="ct-msg dg-msg" role="status"></p>
    <p class="ct-msg dg-export" role="status" hidden></p>
    <p class="ct-msg dg-export dg-bad" role="alert" hidden></p>
    <p class="muted dg-hint" id="dg-hint">ใบจัดตามสินค้า = เดินคลังทีละสินค้าแล้วแบ่งลงตะกร้าสาขา · ใบจัดตามสาขา = จัดทีละสาขา ใช้ตัวกรองด้านบนกำหนดว่าจะพิมพ์อะไร</p>
    <div class="dg-win" hidden><button type="button" class="btn small ghost dg-prev">◀ วันก่อนหน้า</button><span class="dg-win-lbl" role="status"></span><button type="button" class="btn small ghost dg-next">วันถัดไป ▶</button></div>
    <div class="table-scroll dg-scroll" tabindex="0" role="region" aria-label="ตารางรายการสั่งของแต่ละสาขาตามวัน เลื่อนไปทางขวาเพื่อดูวันถัดไป"></div>
    <nav class="dg-pages" aria-label="หน้าของตาราง"></nav>`);
  const scroller = body.querySelector('.dg-scroll'); const pager = body.querySelector('.dg-pages'); const msg = body.querySelector('.dg-msg');
  const expOk = body.querySelector('.dg-export:not(.dg-bad)'); const expBad = body.querySelector('.dg-export.dg-bad');
  const filterBox = body.querySelector('.dg-filters'); const clearBtn = body.querySelector('.dg-clear');

  const selected = () => lines.filter((r) => filters.every((f) => {
    const set = chosen[f.key];
    return !set.size || valuesOf(r, f).some((v) => set.has(v));
  }) && (!query || cols.some((c) => String(pick(r, c.field) ?? '').toLowerCase().includes(query))));

  function build() {
    const sel = selected();
    const products = new Map(); const branchSet = new Set(); const cell = new Map();
    let min = '9999-99-99'; let max = '0000-00-00';
    sel.forEach((r) => {
      const rk = rowKey(r); const b = String(pick(r, GF) ?? 'ไม่ระบุ'); const d = dayOf(r);
      if (!products.has(rk)) products.set(rk, r);
      branchSet.add(b);
      if (d < min) min = d; if (d > max) max = d;
      const k = `${rk}\u0002${b}\u0002${d}`;
      cell.set(k, (cell.get(k) || 0) + (Number(pick(r, VF)) || 0));
    });
    // every day between the first and the last (a gap day shows "-"); a very long range falls back to days with data
    const days = [];
    if (sel.length) {
      const span = (Date.parse(max) - Date.parse(min)) / 86400000;
      if (span <= 120) { for (let t = Date.parse(min); t <= Date.parse(max); t += 86400000) days.push(new Date(t).toISOString().slice(0, 10)); }
      else { [...new Set(sel.map(dayOf))].sort().forEach((d) => days.push(d)); }
    }
    const sf = cfg.sort_field || cols[0].field;
    const sorted = [...products.entries()].sort((a, b) => String(pick(a[1], sf) ?? '').localeCompare(String(pick(b[1], sf) ?? ''), 'th', { numeric: true }));
    // several codes sold in more than one unit are separate rows; say so rather than leave it looking like a duplicate
    const unitsByCode = new Map();
    products.forEach((r) => { const c = String(pick(r, 'product_code') ?? ''); if (c) unitsByCode.set(c, (unitsByCode.get(c) || 0) + 1); });
    const multiUnit = [...unitsByCode.values()].filter((n) => n > 1).length;
    view = { sel, cell, days, sorted, multiUnit, skipped: sel.length && days.length && (Date.parse(max) - Date.parse(min)) / 86400000 > 120, branches: [...branchSet].sort(cmpBranch) };
  }

  function draw() {
    build();
    const { cell, sorted: list, branches } = view;
    if (winStart >= view.days.length) winStart = Math.max(0, view.days.length - WIN);
    const days = view.days.slice(winStart, winStart + WIN);
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    if (page > pages) page = pages;
    const part = list.slice((page - 1) * PAGE, page * PAGE);
    const head1 = cols.map((c, i) => `<th rowspan="2" scope="col" class="dg-h dg-c${i}">${esc(c.label || c.field)}</th>`).join('')
      + branches.map((b, bi) => `<th colspan="${days.length}" scope="colgroup" class="dg-branch dg-b${bi % 2}" title="${esc(b)}"><span class="dg-bl">${esc(b)}</span></th>`).join('');
    const head2 = branches.map((b, bi) => days.map((d, di) => `<th scope="col" class="dg-day dg-b${bi % 2}${di === 0 ? ' dg-first' : ''}">${dmy(d)}</th>`).join('')).join('');
    const rowsHtml = part.map(([rk, r]) => {
      const lead = cols.map((c, i) => `<${i === 0 ? 'th scope="row"' : 'td'} class="dg-c${i}">${esc(pick(r, c.field) == null || pick(r, c.field) === '' ? '-' : pick(r, c.field))}</${i === 0 ? 'th' : 'td'}>`).join('');
      const cells = branches.map((b, bi) => days.map((d, di) => { const v = cell.get(`${rk}\u0002${b}\u0002${d}`); const cls = `dg-n dg-b${bi % 2}${di === 0 ? ' dg-first' : ''}`; return v === undefined ? `<td class="${cls} dg-0"><span class="sr-only">ไม่มีการสั่ง</span><span aria-hidden="true">-</span></td>` : `<td class="${cls}">${fmt(v)}</td>`; }).join('')).join('');
      return `<tr>${lead}${cells}</tr>`;
    }).join('');
    scroller.innerHTML = list.length
      ? `<table class="dg-table"><thead><tr>${head1}</tr><tr>${head2}</tr></thead><tbody>${rowsHtml}</tbody></table>`
      : '<p class="muted ct-empty">ไม่พบรายการที่ตรงกับตัวกรอง</p>';
    const nums = [];
    for (let i = 1; i <= pages; i++) if (i === 1 || i === pages || Math.abs(i - page) <= 2) nums.push(i);
    pager.innerHTML = pages < 2 ? '' : nums.map((n, i) => `${i && n - nums[i - 1] > 1 ? '<span class="dg-gap" aria-hidden="true">…</span>' : ''}<button type="button" class="dg-page" data-p="${n}"${n === page ? ' aria-current="page"' : ''} aria-label="หน้า ${n}">${n}</button>`).join('');
    pager.querySelectorAll('.dg-page').forEach((b) => b.addEventListener('click', () => { page = Number(b.dataset.p); draw(); const again = pager.querySelector(`.dg-page[data-p="${page}"]`); if (again) again.focus(); scroller.scrollTop = 0; }));
    // sticky offsets are measured, not guessed: the date row sits under the real height of the first header row, and
    // the branch name stays beside the product column while the days scroll
    const tbl = scroller.querySelector('table');
    if (tbl) {
      const h1 = tbl.querySelector('thead tr').getBoundingClientRect().height;
      const c0 = tbl.querySelector('th.dg-c0');
      tbl.style.setProperty('--dg-h1', `${h1}px`);
      tbl.style.setProperty('--dg-c0w', `${c0 ? c0.getBoundingClientRect().width : 0}px`);
    }
    const win = body.querySelector('.dg-win');
    win.hidden = view.days.length <= WIN;
    if (!win.hidden) {
      body.querySelector('.dg-win-lbl').textContent = `วันที่ ${dmy(days[0])} – ${dmy(days[days.length - 1])} (${winStart + 1}–${winStart + days.length} จาก ${view.days.length} วัน)`;
      body.querySelector('.dg-prev').disabled = winStart <= 0;
      body.querySelector('.dg-next').disabled = winStart + WIN >= view.days.length;
    }
    const active = filters.some((f) => chosen[f.key].size) || !!query;
    clearBtn.hidden = !active;
    msg.textContent = `${list.length.toLocaleString('th-TH')} รายการสินค้า · ${branches.length.toLocaleString('th-TH')} สาขา · ${days.length.toLocaleString('th-TH')} วัน${active ? ` · กรองแล้ว ${view.sel.length.toLocaleString('th-TH')} จาก ${lines.length.toLocaleString('th-TH')} บรรทัด` : ''}${view.multiUnit ? ` · มี ${view.multiUnit.toLocaleString('th-TH')} รหัสสินค้าที่สั่งหลายหน่วย (แยกเป็นคนละแถว)` : ''}${view.skipped ? ' · ช่วงยาวเกิน 120 วัน แสดงเฉพาะวันที่มีออเดอร์' : ''}`;
  }

  // One picker per filter: a button that opens a searchable checklist (several values can be chosen).
  filters.forEach((f) => {
    const wrap = document.createElement('div');
    wrap.className = 'dg-pick';
    wrap.innerHTML = `<button type="button" class="dg-pick-btn" aria-haspopup="true" aria-expanded="false"></button>
      <div class="dg-pick-panel" hidden role="group" aria-label="${esc(f.label)}">
        <input type="search" class="dg-pick-q" placeholder="ค้นหา${esc(f.label)}" aria-label="ค้นหา${esc(f.label)}" autocomplete="off">
        <div class="dg-pick-list"></div>
        <div class="dg-pick-foot"><button type="button" class="btn small ghost dg-pick-none">ล้าง</button><button type="button" class="btn small dg-pick-done">เสร็จ</button></div>
      </div>`;
    filterBox.appendChild(wrap);
    const btn = wrap.querySelector('.dg-pick-btn'); const panel = wrap.querySelector('.dg-pick-panel');
    const list = wrap.querySelector('.dg-pick-list'); const q = wrap.querySelector('.dg-pick-q');
    const label = () => {
      const n = chosen[f.key].size;
      btn.textContent = `${f.label}: ${n === 0 ? (f.all || 'ทั้งหมด') : n === 1 ? [...chosen[f.key]][0] : `${n} ${f.unit || 'รายการ'}`}`;
      btn.classList.toggle('active', n > 0);
      btn.title = n ? [...chosen[f.key]].join(', ') : '';
    };
    const paint = () => {
      const needle = q.value.trim().toLowerCase();
      const shown = f.options.filter((o) => !needle || o.toLowerCase().includes(needle));
      list.innerHTML = shown.slice(0, 200).map((o, i) => `<label class="dg-opt"><input type="checkbox" value="${esc(o)}"${chosen[f.key].has(o) ? ' checked' : ''}><span>${esc(o)}</span></label>`).join('')
        + (shown.length > 200 ? `<p class="muted dg-more">แสดง 200 จาก ${shown.length.toLocaleString('th-TH')} — พิมพ์ค้นหาเพื่อกรองต่อ</p>` : '')
        + (!shown.length ? '<p class="muted dg-more">ไม่พบ</p>' : '');
      list.querySelectorAll('input').forEach((c) => c.addEventListener('change', () => { if (c.checked) chosen[f.key].add(c.value); else chosen[f.key].delete(c.value); label(); page = 1; draw(); }));
    };
    const close = (focus) => { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); if (focus) btn.focus(); };
    const open = () => { filterBox.querySelectorAll('.dg-pick-panel').forEach((p) => { p.hidden = true; }); filterBox.querySelectorAll('.dg-pick-btn').forEach((b) => b.setAttribute('aria-expanded', 'false')); panel.hidden = false; btn.setAttribute('aria-expanded', 'true'); q.value = ''; paint(); q.focus(); };
    btn.addEventListener('click', () => (panel.hidden ? open() : close(true)));
    q.addEventListener('input', paint);
    wrap.querySelector('.dg-pick-none').addEventListener('click', () => { chosen[f.key].clear(); label(); paint(); page = 1; draw(); });
    wrap.querySelector('.dg-pick-done').addEventListener('click', () => close(true));
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { e.stopPropagation(); close(true); } });
    document.addEventListener('click', (e) => { if (!panel.hidden && !wrap.contains(e.target)) close(false); });
    f.reset = () => { chosen[f.key].clear(); label(); };
    label();
  });
  body.querySelector('.dg-prev').addEventListener('click', () => { winStart = Math.max(0, winStart - WIN); draw(); });
  body.querySelector('.dg-next').addEventListener('click', () => { winStart += WIN; draw(); });
  clearBtn.addEventListener('click', () => { filters.forEach((f) => f.reset()); query = ''; body.querySelector('.ct-search input').value = ''; page = 1; draw(); });
  body.querySelector('.ct-search input').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); page = 1; draw(); });
  // The CSV is the underlying lines of exactly what the filters leave, not the whole pull.
  // Pick list: one A4 sheet per delivery day and ordering customer, from exactly the rows the filters leave.
  // It is built into a hidden #print-sheet that only the print stylesheet shows, then the browser's own print
  // dialog does the rest (a printer, or "Save as PDF") — nothing is generated on the server.
  let printAsk = 0;
  const printSheets = (mode) => {
    expOk.hidden = true; expBad.hidden = true;
    const sel = view.sel;
    if (!sel.length) { msg.textContent = 'ไม่มีรายการให้พิมพ์ — ลองล้างตัวกรองหรือเลือกช่วงวันที่อื่น'; return; }
    // by product: one sheet per delivery day (and supplying kitchen); the list runs product by product, the picker
    // stands at one product and sets out every branch's share in turn.
    // by branch: one sheet per delivery day, customer and kitchen, the traditional "walk this branch's order" list.
    const byBranch = mode === 'branch';
    const sheetKey = (r) => `${dayOf(r)}\u0002${pick(r, 'ck_branch') ?? ''}${byBranch ? `\u0002${pick(r, GF) ?? 'ไม่ระบุ'}` : ''}`;
    const bySheet = new Map();
    sel.forEach((r) => { const k = sheetKey(r); if (!bySheet.has(k)) bySheet.set(k, []); bySheet.get(k).push(r); });
    const sheets = bySheet.size;
    if (sheets > 60 && Date.now() - printAsk > 15000) { printAsk = Date.now(); msg.textContent = `จะพิมพ์ ${sheets.toLocaleString('th-TH')} ใบ — กดปุ่มพิมพ์เดิมอีกครั้งภายใน 15 วินาทีเพื่อยืนยัน หรือกรองให้แคบลงก่อน`; return; }
    const thDate = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const fmtT = (t) => new Date(t).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
    const printedAt = fmtT(Date.now());
    // "ข้อมูล ณ" is when the report was last pulled, not when the button was pressed
    const stamp = ctx && ctx.syncedAt ? fmtT(ctx.syncedAt) : `${printedAt} (ไม่ทราบเวลาที่โหลดข้อมูล)`;
    const used = filters.filter((f) => chosen[f.key].size).map((f) => `${f.label}: ${[...chosen[f.key]].join(', ')}`);
    if (query) used.push(`ค้นหา: ${query}`);
    const str = (r, f) => String(pick(r, f) ?? '');
    // Zones follow the walking route of the warehouse (cfg.zones, in route order: [{ name, match: [words] }], a word
    // matches the product's category or tags). Without zones the list falls back to category order.
    const zones = Array.isArray(cfg.zones) ? cfg.zones : [];
    const unzoned = new Set();
    const UNZ = 'อื่นๆ (ยังไม่จัดโซน)';
    const unzNote = (its) => { const c = its.filter((i) => i.zone === UNZ).length; return zones.length && c ? `<p class="ps-alert"><b>มี ${c.toLocaleString('th-TH')} รายการยังไม่จัดโซน</b> (อยู่ท้ายใบ) — ตั้งค่าโซนคลังเพื่อให้เรียงตามเส้นทางเดิน</p>` : ''; };
    // order numbers, when the report carries them; this report is a per-line pull, so say so when it does not
    const poField = ['order_number', 'so_number', 'po_number', 'order_no'].find((f) => lines.some((r) => pick(r, f)));
    const poNote = poField ? '' : '<p class="ps-note">รายงานนี้ไม่มีเลขออเดอร์ ใบนี้รวมทุกออเดอร์ของสาขาในวันเดียวกัน</p>';
    const orderNos = (rs2) => (poField ? [...new Set(rs2.map((r) => str(r, poField)).filter(Boolean))] : []);
    const zoneOf = (r) => {
      if (!zones.length) return str(r, 'category') || 'ไม่ระบุหมวด';
      const hay = `${str(r, 'category')} ${valuesOf(r, { field: 'tags', split: ',' }).join(' ')}`.toLowerCase();
      // the longest matching word wins ("ผักแห้ง" beats "ผัก"); a tie goes to the zone listed first
      // a whole category/tag equal to the word beats a word found inside text ("นม" the category, not "ขนมปัง")
      const toks = [str(r, 'category'), ...valuesOf(r, { field: 'tags', split: ',' })].map((x) => x.trim().toLowerCase());
      let best = -1; let bestLen = 0;
      zones.forEach((z, i) => (z.match || []).forEach((w) => {
        const ww = String(w).trim().toLowerCase(); if (!ww) return;
        const score = toks.includes(ww) ? 1000 + ww.length : hay.includes(ww) ? ww.length : 0;
        if (score > bestLen) { best = i; bestLen = score; }
      }));
      if (best < 0) { unzoned.add(str(r, 'product')); return UNZ; }
      return zones[best].name;
    };
    const zoneRank = (name) => { const i = zones.findIndex((z) => z.name === name); return i < 0 ? 1e6 : i; };
    // The list is grouped by category, and inside a category by the product's (first) tag. When zones are set they
    // only decide which category comes first along the route; the headings stay category / tag.
    const NOTAG = 'ไม่มีแท็ก';
    const catOf = (r) => str(r, 'category') || 'ไม่ระบุหมวด';
    // the tag shown is the one that put the product in its zone; without zones (or no match) the first tag A-Z, so the
    // result does not depend on the order the API sends the tags in
    const tagOf = (r) => {
      const tags = valuesOf(r, { field: 'tags', split: ',' }).map((x) => x.trim()).filter(Boolean);
      if (!tags.length) return NOTAG;
      const z = zones.length ? zones.find((x) => x.name === zoneOf(r)) : null;
      if (z) {
        let best = null; let bestScore = 0;
        tags.forEach((t) => (z.match || []).forEach((w) => {
          const ww = String(w).trim().toLowerCase(); if (!ww) return;
          const tl = t.toLowerCase(); const sc = tl === ww ? 1000 + ww.length : tl.includes(ww) ? ww.length : 0;
          if (sc > bestScore) { best = t; bestScore = sc; }
        }));
        if (best) return best;
      }
      return [...tags].sort((a, b) => a.localeCompare(b, 'th', { numeric: true }))[0];
    };
    const tagCmp = (a, b) => (a === NOTAG) - (b === NOTAG) || a.localeCompare(b, 'th', { numeric: true });
    const groupCmp = (x, y) => (zones.length ? zoneRank(x.zone) - zoneRank(y.zone) : 0) || x.cat.localeCompare(y.cat, 'th') || tagCmp(x.tag, y.tag);
    // a tag heading only appears in a category that really has more than one tag on this sheet; the category (and tag)
    // is also printed small under each product, so a page that starts mid-category still says where it is
    const ckey = (it) => `${it.zone}\u0001${it.cat}`;
    const catTagMap = (its) => { const m = new Map(); its.forEach((i) => { const k = ckey(i); if (!m.has(k)) m.set(k, new Set()); m.get(k).add(i.tag); }); return m; };
    const showTag = (it, ct) => (ct.get(ckey(it))?.size || 0) > 1;
    const tagName = (t) => (t === NOTAG ? 'ไม่มีแท็ก' : t);
    const grp = (it, ct) => `${esc(it.cat)}${showTag(it, ct) ? ` › ${esc(tagName(it.tag))}` : ''}`;
    const heads = (it, st, cols, wrapTbody, ct) => {
      let out = '';
      if (ckey(it) !== st.cat) { out += `<tr class="ps-cat"><td colspan="${cols}">${it.cat === 'ไม่ระบุหมวด' ? esc(it.cat) : `หมวด ${esc(it.cat)}`}${zones.length ? ` · โซน ${esc(it.zone)}` : ''}</td></tr>`; st.cat = ckey(it); st.tag = null; }
      if (showTag(it, ct) && it.tag !== st.tag) { out += `<tr class="ps-tag"><td colspan="${cols}">${esc(tagName(it.tag))}</td></tr>`; st.tag = it.tag; }
      return wrapTbody && out ? `<tbody class="ps-catb">${out}</tbody>` : out;
    };
    const CHUNK = 12; // a product shared by more branches than this continues in a second block, name and total repeated
    // A sheet's number is fixed by what it is (day, kitchen, customer), in the Buddhist year the sheet shows, so a reprint
    // keeps its number; how many times it was printed, and whether the orders changed since, is kept in this browser.
    const be = (dd) => `${Number(dd.slice(0, 4)) + 543}${dd.slice(5, 7)}${dd.slice(8, 10)}`;
    const short = (t) => { let h = 5381; for (const ch of String(t)) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0; return h.toString(36).toUpperCase().padStart(4, '0').slice(-4); };
    const docNoOf = (pre, dd, ck, cust) => `${pre}-${be(dd)}-${String(ck || 'ALL').replace(/\s+/g, '').slice(0, 10)}${cust === undefined ? '' : `-${short(cust)}`}`;
    const memo = {
      get: (k) => { try { return JSON.parse(localStorage.getItem(`kss.pl.${k}`) || 'null'); } catch (e) { return null; } },
      set: (k, v) => { try { localStorage.setItem(`kss.pl.${k}`, JSON.stringify(v)); } catch (e) { /* storage unavailable: numbers still print, counts just restart */ } },
    };
    // The reference for "changed since last print" is kept per sheet AND per filter set (a filtered sheet never
    // becomes the baseline for the full one), compared product by product and branch by branch, and only
    // written when the print dialog closes. The count is "in this browser": it is a local aid, not a ledger.
    const commits = [];
    const meta = (docNo, rs) => {
      const sig = short(used.join('|'));
      const key = `${docNo}.${sig}`;
      const cur = new Map();
      rs.forEach((r) => { const k = `${str(r, 'product_code')}|${str(r, 'uom')}|${str(r, GF)}`; cur.set(k, Math.round(((cur.get(k) || 0) + (Number(pick(r, VF)) || 0)) * 100) / 100); });
      const prev = memo.get(key);
      const n = (prev ? prev.n : 0) + 1;
      let note = '';
      if (prev && prev.items) {
        const diffs = [];
        new Set([...Object.keys(prev.items), ...cur.keys()]).forEach((k) => { const x = prev.items[k] || 0; const y = cur.get(k) || 0; if (Math.abs(x - y) > 1e-9) diffs.push(`${k.split('|').join(' · ')}: ${fmt(x)} → ${fmt(y)}`); });
        note = diffs.length
          ? `<p class="ps-alert"><b>ยอดเปลี่ยนจากครั้งก่อน ${diffs.length.toLocaleString('th-TH')} จุด</b> (พิมพ์ ${esc(prev.at)}) เช่น ${esc(diffs.slice(0, 3).join(' ; '))}${diffs.length > 3 ? ' …' : ''} — ตรวจส่วนต่างก่อนจัด</p>`
          : `<p class="ps-note">ยอดเท่ากับที่พิมพ์ครั้งก่อน (${esc(prev.at)})</p>`;
      } else if (prev) {
        const tot = Math.round([...cur.values()].reduce((t, v) => t + v, 0) * 100) / 100;
        if (prev.qty !== tot) note = `<p class="ps-alert"><b>ยอดรวมเปลี่ยนจากครั้งก่อน</b> (${esc(fmt(prev.qty))} → ${esc(fmt(tot))}) ตรวจส่วนต่างก่อนจัด</p>`;
      }
      commits.push(() => memo.set(key, { n, at: printedAt, qty: Math.round([...cur.values()].reduce((t, v) => t + v, 0) * 100) / 100, items: cur.size <= 800 ? Object.fromEntries(cur) : null }));
      return { n, note };
    };
    const html = [...bySheet.entries()].sort((x, y) => x[0].localeCompare(y[0], 'th')).map(([k, rs], si) => {
      const [d, kitchen, customer] = k.split('\u0002');
      if (byBranch) {
        const agg = new Map();
        rs.forEach((r) => {
          const pk = `${str(r, 'product_code')}\u0001${str(r, 'uom')}\u0001${str(r, 'product')}`;
          const e = agg.get(pk) || { r, qty: 0, zone: zoneOf(r), cat: catOf(r), tag: tagOf(r), po: new Set() };
          e.qty += Number(pick(r, VF)) || 0; agg.set(pk, e);
          if (poField && str(r, poField)) e.po.add(str(r, poField));
        });
        const unitsOfB = new Map();
        agg.forEach((e) => { const c = str(e.r, 'product_code'); if (c) unitsOfB.set(c, (unitsOfB.get(c) || 0) + 1); });
        const list = [...agg.values()].sort((x, y) => groupCmp(x, y)
          || str(x.r, 'product').localeCompare(str(y.r, 'product'), 'th', { numeric: true }) || str(x.r, 'product_code').localeCompare(str(y.r, 'product_code')) || str(x.r, 'uom').localeCompare(str(y.r, 'uom'), 'th'));
        const docB = docNoOf('PB', d, kitchen, customer); const mB = meta(docB, rs);
        const stB = { cat: null, tag: null }; const ctB = catTagMap(list); let nb = 0;
        const rowsB = list.map((it) => {
          const head = heads(it, stB, 5, false, ctB); nb += 1;
          const multi = unitsOfB.get(str(it.r, 'product_code')) > 1;
          return `${head}<tr><td class="ps-n">${nb}</td><td><b>${esc(str(it.r, 'product'))}</b><br><small>${esc(str(it.r, 'product_code'))} · ${grp(it, ctB)}${multi ? ' · <b class="ps-warn">มีหลายหน่วย ดูแถวอื่นด้วย</b>' : ''}${it.po.size ? `<br>ออเดอร์ ${esc([...it.po].join(', '))}` : ''}</small></td><td class="ps-q ps-tot">${esc(fmt(it.qty))} <small>${esc(str(it.r, 'uom'))}</small></td><td class="ps-real"></td><td class="ps-box"><i></i></td></tr>`;
        }).join('');
        const filteredB = used.length ? `<p class="ps-alert"><b>ใบนี้ถูกกรอง ไม่ใช่ใบเต็ม</b> — ${esc(used.join(' | '))}</p>` : '';
        return `<section class="ps-sheet ps-compact">
          <div class="ps-banner"><p class="ps-alert"><b>นับเฉพาะออเดอร์ที่อนุมัติแล้ว</b> ออเดอร์ที่รออนุมัติ ยกเลิก หรือเข้ามาหลัง ${esc(stamp)} ไม่อยู่ในใบนี้</p>${filteredB}${poNote}${unzNote(list)}${mB.note}</div>
          <table><thead><tr class="ps-run"><th colspan="5"><span>ใบจัดของ (ตามสาขา)</span> ${esc(thDate(d))}${kitchen ? ` · ครัว ${esc(kitchen)}` : ''}<br><b class="ps-cust">${esc(customer)}</b><em>เลขที่ ${esc(docB)}</em></th></tr>
          <tr class="ps-runwarn"><th colspan="5">ใบที่ ${si + 1} จาก ${sheets} · ${esc(docB)} · พิมพ์ครั้งที่ ${mB.n} (ในเครื่องนี้) · เฉพาะออเดอร์ที่อนุมัติแล้ว${used.length ? ' · ใบกรอง ไม่ใช่ใบเต็ม' : ''}</th></tr>
          <tr><th>#</th><th>สินค้า</th><th class="ps-q">สั่ง</th><th>จัดจริง</th><th>จัดแล้ว</th></tr></thead><tbody>${rowsB}</tbody></table>
          <footer><p class="ps-note">${list.length.toLocaleString('th-TH')} รายการสินค้า · ข้อมูล ณ ${esc(stamp)} · พิมพ์เมื่อ ${esc(printedAt)} · ใบเลขที่ ${esc(docB)}</p>
          <p class="ps-end">— จบใบ ${esc(customer)} · ${esc(docB)} —</p>
          <div class="ps-sign"><span>ผู้จัด</span><span>ผู้ตรวจ</span><span>ผู้รับ</span></div></footer></section>`;
      }
      const prods = new Map();
      rs.forEach((r) => {
        const pk = `${str(r, 'product_code')}\u0001${str(r, 'uom')}\u0001${str(r, 'product')}`;
        const e = prods.get(pk) || { r, total: 0, by: new Map(), po: new Map(), zone: zoneOf(r), cat: catOf(r), tag: tagOf(r) };
        const c = String(pick(r, GF) ?? 'ไม่ระบุ'); const q = Number(pick(r, VF)) || 0;
        e.total += q; e.by.set(c, (e.by.get(c) || 0) + q); prods.set(pk, e);
        if (poField && str(r, poField)) { if (!e.po.has(c)) e.po.set(c, new Set()); e.po.get(c).add(str(r, poField)); }
      });
      // a code sold in more than one unit stays together and is flagged, so the second line is not missed
      const unitsOf = new Map();
      prods.forEach((e) => { const c = str(e.r, 'product_code'); if (c) unitsOf.set(c, (unitsOf.get(c) || 0) + 1); });
      const items = [...prods.values()].sort((x, y) => groupCmp(x, y)
        || str(x.r, 'product').localeCompare(str(y.r, 'product'), 'th', { numeric: true }) || str(x.r, 'product_code').localeCompare(str(y.r, 'product_code')) || str(x.r, 'uom').localeCompare(str(y.r, 'uom'), 'th'));
      const branches = new Set(rs.map((r) => String(pick(r, GF) ?? 'ไม่ระบุ')));
      const docNo = docNoOf('PL', d, kitchen); const mP = meta(docNo, rs);
      const stP = { cat: null, tag: null }; const ctP = catTagMap(items); let n = 0;
      const blocks = items.map((it) => {
        const catRow = heads(it, stP, 7, true, ctP); n += 1;
        const parts = [...it.by.entries()].sort((x, y) => cmpBranch(x[0], y[0]));
        const multi = unitsOf.get(str(it.r, 'product_code')) > 1;
        const sub = `${esc(str(it.r, 'product_code'))} · ${grp(it, ctP)}${multi ? ' · <b class="ps-warn">มีหลายหน่วย ดูแถวถัดไปด้วย</b>' : ''}`;
        const chunks = []; for (let i = 0; i < parts.length; i += CHUNK) chunks.push(parts.slice(i, i + CHUNK));
        return catRow + chunks.map((ch, ci) => `<tbody class="ps-prod">${ch.map(([cust, q], i) => `<tr>${i === 0 ? `<td class="ps-n" rowspan="${ch.length}">${n}</td><td rowspan="${ch.length}"><b>${esc(str(it.r, 'product'))}</b>${ci ? ' <small>(ต่อ)</small>' : ''}<br><small>${sub}</small></td><td class="ps-q ps-tot" rowspan="${ch.length}">${esc(fmt(it.total))}<br><small>${esc(str(it.r, 'uom'))}</small></td>` : ''}<td>${esc(cust)}${it.po.get(cust) ? `<br><small>ออเดอร์ ${esc([...it.po.get(cust)].join(', '))}</small>` : ''}</td><td class="ps-q">${esc(fmt(q))}</td><td class="ps-real"></td><td class="ps-box"><i></i></td></tr>`).join('')}</tbody>`).join('');
      }).join('');
      const label = `${thDate(d)}${kitchen ? ` · ครัว ${kitchen}` : ''}`;
      const filtered = used.length ? `<p class="ps-alert"><b>ใบนี้ถูกกรอง ไม่ใช่ใบเต็ม</b> — ${esc(used.join(' | '))}</p>` : '';
      return `<section class="ps-sheet">
        <div class="ps-banner"><p class="ps-alert"><b>นับเฉพาะออเดอร์ที่อนุมัติแล้ว</b> ออเดอร์ที่รออนุมัติ ยกเลิก หรือเข้ามาหลัง ${esc(stamp)} ไม่อยู่ในใบนี้</p>${filtered}${poNote}${unzNote(items)}${mP.note}</div>
        <table><thead><tr class="ps-run"><th colspan="7"><span>ใบจัดของ</span> ${esc(label)}<em>เลขที่ ${esc(docNo)}</em></th></tr>
        <tr class="ps-runwarn"><th colspan="7">ใบที่ ${si + 1} จาก ${sheets} · ${esc(docNo)} · พิมพ์ครั้งที่ ${mP.n} (ในเครื่องนี้) · เฉพาะออเดอร์ที่อนุมัติแล้ว${used.length ? ' · ใบกรอง ไม่ใช่ใบเต็ม' : ''}</th></tr>
        <tr><th>#</th><th>สินค้า</th><th class="ps-q">รวม</th><th>สาขา</th><th class="ps-q">สั่ง</th><th>จัดจริง</th><th>จัดแล้ว</th></tr></thead>${blocks}</table>
        <footer><p class="ps-note">${items.length.toLocaleString('th-TH')} รายการสินค้า · ${branches.size.toLocaleString('th-TH')} สาขา · ข้อมูล ณ ${esc(stamp)} · พิมพ์เมื่อ ${esc(printedAt)} · ใบเลขที่ ${esc(docNo)}</p>
        <p class="ps-end">— จบใบ ${esc(docNo)} —</p>
        <div class="ps-sign"><span>ผู้จัด</span><span>ผู้ตรวจ</span><span>ผู้รับ</span></div></footer></section>`;
    }).join('');
    document.getElementById('print-sheet')?.remove();
    const host = document.createElement('div');
    host.id = 'print-sheet';
    host.innerHTML = html;
    document.body.appendChild(host);
    const done = () => { host.remove(); commits.forEach((f) => f()); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    const un = [...unzoned];
    msg.textContent = `เปิดหน้าต่างพิมพ์ ${sheets.toLocaleString('th-TH')} ใบ (เลือก "Save as PDF" ในหน้าต่างพิมพ์ถ้าต้องการไฟล์)${un.length ? ` · มี ${un.length.toLocaleString('th-TH')} รายการที่ยังไม่จัดโซน (อยู่ท้ายใบ): ${un.slice(0, 5).join(', ')}${un.length > 5 ? ' …' : ''} — ตั้งค่าโซนคลังเพื่อให้เรียงตามเส้นทางเดิน` : ''}`;
    window.print();
  };
  body.querySelectorAll('.dg-print').forEach((btn) => btn.addEventListener('click', () => printSheets(btn.dataset.mode)));
  // CSV in the layout FMH's own export uses: two heading rows (the branch repeated over its dates, then the dates),
  // product / code / unit / category on the left, "-" where nothing was ordered, a Grand total column on the right.
  // It carries every day of the picked range and follows the filters; products come out by the first day they are
  // needed, then in the order the report sent them.
  const exportGridCsv = () => {
    const { sel, cell, branches } = view;
    // the result stays on screen until the next export or print, since the warnings in it matter after the file is opened;
    // a failure is a separate alert line, so it is read out whenever it appears
    const say = (html, bad) => {
      const el = bad ? expBad : expOk; const other = bad ? expOk : expBad;
      other.hidden = true; el.hidden = false; el.innerHTML = html;
    };
    if (!sel.length || !view.days.length) { say(`<b>ส่งออกไม่ได้:</b> ไม่มีข้อมูลให้ส่งออก — ล้างตัวกรองหรือเปลี่ยนช่วงวันที่ก่อน`, true); return; }
    // the columns are the days of the range picked on the page (a day with no orders stays as "-", as in FMH's file),
    // plus any day outside it that still has data; a range over 120 days uses only the days with data
    const iso = (t) => new Date(t).toISOString().slice(0, 10);
    let days = view.days;
    const rg = ctx && ctx.range;
    if (rg && /^\d{4}-\d{2}-\d{2}$/.test(rg.start || '') && /^\d{4}-\d{2}-\d{2}$/.test(rg.end || '') && (Date.parse(rg.end) - Date.parse(rg.start)) / 86400000 <= 120) {
      const set = new Set(view.days);
      for (let t = Date.parse(rg.start); t <= Date.parse(rg.end); t += 86400000) set.add(iso(t));
      days = [...set].sort();
    }
    const q = (v) => { const t = String(v ?? ''); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const n2 = (v) => String(Math.round(v * 100) / 100);
    const first = new Map(); const seen = new Map();
    sel.forEach((r) => { const k = rowKey(r); const d = dayOf(r); if (!seen.has(k)) seen.set(k, { r, at: seen.size }); if (!first.has(k) || d < first.get(k)) first.set(k, d); });
    const prods = [...seen.entries()].sort((a, b) => (first.get(a[0]) < first.get(b[0]) ? -1 : first.get(a[0]) > first.get(b[0]) ? 1 : 0) || a[1].at - b[1].at);
    // Excel stops at 16,384 columns and drops the rest without a word, so refuse a file that wide
    const width = 5 + branches.length * days.length;
    if (width > 16000) { say(`<b>ส่งออกไม่ได้:</b> ไฟล์กว้างเกินที่ Excel เปิดได้ (${width.toLocaleString('th-TH')} คอลัมน์ จากสาขา ${branches.length.toLocaleString('th-TH')} × ${days.length.toLocaleString('th-TH')} วัน) — ลดช่วงวันที่หรือเลือกลูกค้าก่อน แล้วส่งออกใหม่`, true); return; }
    const out = [];
    out.push(['', '', '', '', ...branches.flatMap((b) => days.map(() => b)), ''].map(q).join(','));
    out.push(['Product', 'Product code', 'UOM', 'Category', ...branches.flatMap(() => days.map(dmy)), 'Grand total'].map(q).join(','));
    prods.forEach(([k, { r }]) => {
      let tot = 0;
      const vals = branches.flatMap((b) => days.map((d) => { const v = cell.get(`${k}\u0002${b}\u0002${d}`) || 0; tot += v; return v ? n2(v) : '-'; }));
      out.push([pick(r, 'product'), pick(r, 'product_code'), pick(r, 'uom'), pick(r, 'category'), ...vals, n2(tot)].map(q).join(','));
    });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(['﻿' + out.join('\r\n')], { type: 'text/csv;charset=utf-8;' }));
    // which filters are on, in words for the message and shortened for the file name
    const used = filters.filter((f) => chosen[f.key].size).map((f) => ({ label: f.label, vals: [...chosen[f.key]] }));
    if (query) used.push({ label: 'ค้นหา', vals: [query] });
    const filtered = used.length > 0;
    const short = used.flatMap((u) => u.vals).slice(0, 2).map((v) => String(v).replace(/[\\/:*?"<>|\s.,()[\]]+/g, '').slice(0, 14)).filter(Boolean).join('+');
    // the data's own time, always in Thai time whatever the computer's clock says
    const at = ctx && ctx.syncedAt ? new Date(ctx.syncedAt) : null;
    const okAt = at && !Number.isNaN(at.getTime());
    const bk = okAt ? Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((x) => [x.type, x.value])) : null;
    const ymd = (d) => d.replace(/-/g, '');
    // the days are written year-month-day so a Thai reader cannot mistake 5 Nov for 11 May
    link.download = `Order_Items_By_Branch_Report_${ymd(days[0])}-${ymd(days[days.length - 1])}_approved${filtered ? `_filtered${short ? `_${short}` : ''}` : ''}${okAt ? `_asof_${bk.year}${bk.month}${bk.day}_${bk.hour}${bk.minute}` : ''}.csv`;
    try {
      link.click();
    } catch (e) {
      say(`<b>ส่งออกไม่ได้:</b> เบราว์เซอร์ไม่ยอมให้ดาวน์โหลด — ลองใหม่หรือเปิดหน้านี้ใน Chrome`, true);
      return;
    }
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
    const asOf = okAt ? `ข้อมูลซิงก์ ณ ${bk.day}/${bk.month}/${bk.year} ${bk.hour}:${bk.minute} (เวลาไทย)` : 'ไม่ทราบเวลาที่โหลดข้อมูล';
    const zeroCode = prods.some(([, { r }]) => /^0\d/.test(String(pick(r, 'product_code') ?? '')));
    const nowT = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
    const warn = [];
    if (filtered) warn.push(`ไฟล์นี้เฉพาะที่กรองไว้ ไม่ใช่ไฟล์เต็ม (${sel.length.toLocaleString('th-TH')} จาก ${lines.length.toLocaleString('th-TH')} รายการสั่ง) — ${used.map((u) => `${u.label}: ${u.vals.slice(0, 3).join(', ')}${u.vals.length > 3 ? ` +${u.vals.length - 3}` : ''}`).join(' · ')}`);
    if (zeroCode) warn.push('รหัสสินค้าบางตัวขึ้นต้นด้วย 0 — เปิดใน Excel ให้ตั้งคอลัมน์รหัสเป็นข้อความ ไม่เช่นนั้น 0 หน้ารหัสจะหาย');
    say(`${warn.map((w) => `<b>⚠ ${esc(w)}</b><br>`).join('')}สั่งดาวน์โหลดแล้ว (${esc(nowT)}) — ดูในโฟลเดอร์ดาวน์โหลด · ${prods.length.toLocaleString('th-TH')} สินค้า · ${branches.length.toLocaleString('th-TH')} สาขา · ${days.length.toLocaleString('th-TH')} วันทั้งช่วง · นับเฉพาะออเดอร์ที่อนุมัติแล้ว · ${esc(asOf)}`);
  };
  body.querySelector('.dg-csv').addEventListener('click', exportGridCsv);
  draw();
}

// ---------- change password ----------
el('open-password-btn').addEventListener('click', () => el('password-modal').classList.remove('hidden'));
el('close-password-btn').addEventListener('click', () => el('password-modal').classList.add('hidden'));
el('password-modal-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  el('password-modal-error').classList.add('hidden');
  try {
    await api('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current_password: el('current-password').value, new_password: el('new-password').value }),
    });
    el('password-modal').classList.add('hidden');
    el('password-modal-form').reset();
  } catch (err) {
    el('password-modal-error').textContent = err.message;
    el('password-modal-error').classList.remove('hidden');
  }
});

document.addEventListener('DOMContentLoaded', boot);


// ---------- what's new (the bell) ----------
// Posts KSS writes in the Admin Console: new widgets, new features. The badge
// counts posts since this user last opened the panel.
const notif = { items: [], open: false };

async function loadNotifications() {
  try {
    // KSS replies to what this person reported or asked for count with the posts
    const mine = state.user && state.user.company_id && !isSuper() ? api('/api/support/mine').catch(() => null) : Promise.resolve(null);
    const [r, m] = await Promise.all([api('/api/announcements'), mine]);
    notif.items = r.items;
    notif.replies = m ? m.list.filter((x) => x.reply_unseen) : [];
    const unread = r.unread + notif.replies.length;
    const badge = el('notif-badge');
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.classList.toggle('hidden', !unread);
    el('notif-btn').setAttribute('aria-label', unread ? `มีอะไรใหม่ (${unread} ยังไม่ได้อ่าน)` : 'มีอะไรใหม่');
  } catch (err) {
    /* the bell is a nicety; never block the app on it */
  }
}
setInterval(() => state.user && loadNotifications(), 15 * 60 * 1000);

function renderNotifPanel() {
  const en = I18N.lang === 'en';
  const panel = el('notif-panel');
  const canAdd = isCompanyAdmin() || isSuper();
  panel.innerHTML = `
    <div class="notif-head"><strong>มีอะไรใหม่</strong><button type="button" class="icon-mini notif-close" aria-label="ปิด">✕</button></div>
    ${(notif.replies || []).length ? `<article class="notif-item unread notif-reply">
        <div class="notif-meta"><span class="notif-new">ทีม KSS ตอบแล้ว</span></div>
        <ul class="notif-replies">${notif.replies.slice(0, 3).map((x) => `<li><button type="button" class="notif-reply-item" data-id="${x.id}"><b>${esc(x.message.slice(0, 80))}${x.message.length > 80 ? '…' : ''}</b><span>${esc(x.note || OPS_STATUS[x.status] || '')}</span></button></li>`).join('')}</ul>
        <button type="button" class="btn small ghost notif-mine">${notif.replies.length > 3 ? `ดูทั้งหมด (อีก ${notif.replies.length - 3} เรื่อง) →` : 'ดูเรื่องที่แจ้งไว้ทั้งหมด →'}</button>
      </article>` : ''}
    ${
      notif.items.length
        ? notif.items
            .map((n) => {
              const title = en && n.title_en ? n.title_en : n.title;
              const body = en && n.body_en ? n.body_en : n.body;
              return `<article class="notif-item${n.unread ? ' unread' : ''}">
                <div class="notif-meta">${n.unread ? '<span class="notif-new">ใหม่</span>' : ''}<span class="muted">${esc(new Date(n.published_at).toLocaleDateString(I18N.locale(), { day: 'numeric', month: 'short', year: 'numeric' }))}</span></div>
                <h4 data-no-i18n>${esc(title)}</h4>
                <p data-no-i18n>${esc(body)}</p>
                ${
                  n.widgets.length
                    ? `<div class="notif-widgets">${n.widgets.slice(0, 5).map((w) => `<span class="notif-chip">${esc(w.name)}</span>`).join('')}${n.widgets.length > 5 ? `<span class="notif-chip">+${n.widgets.length - 5} widget</span>` : ''}</div>
                       ${canAdd ? '<button type="button" class="btn small ghost notif-add">เพิ่ม widget ลง Dashboard →</button>' : ''}`
                    : ''
                }
              </article>`;
            })
            .join('')
        : '<p class="muted notif-empty">ยังไม่มีประกาศ</p>'
    }`;
  panel.querySelector('.notif-close').addEventListener('click', () => toggleNotif(false));
  const mineBtn = panel.querySelector('.notif-mine');
  if (mineBtn) mineBtn.addEventListener('click', () => { toggleNotif(false); fbOpenMine(); });
  panel.querySelectorAll('.notif-reply-item').forEach((b) => b.addEventListener('click', () => { toggleNotif(false); fbOpenMine(Number(b.dataset.id)); }));
  panel.querySelectorAll('.notif-add').forEach((b) =>
    b.addEventListener('click', () => {
      toggleNotif(false);
      if (!isSuper()) adminState.selected = { type: 'my-dashboards', id: state.user.company_id };
      openAdminConsole();
    })
  );
}

function toggleNotif(open) {
  notif.open = open === undefined ? !notif.open : open;
  el('notif-panel').classList.toggle('hidden', !notif.open);
  el('notif-btn').setAttribute('aria-expanded', String(notif.open));
  if (notif.open) {
    renderNotifPanel();
    // Opening counts as reading; the "new" marks stay until the panel closes.
    if (notif.items.some((n) => n.unread)) {
      api('/api/announcements/seen', { method: 'POST' }).catch(() => {});
      el('notif-badge').classList.add('hidden');
    }
  } else {
    notif.items.forEach((n) => (n.unread = false));
  }
}

el('notif-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleNotif();
});
document.addEventListener('click', (e) => {
  if (notif.open && !e.target.closest('.notif-wrap')) toggleNotif(false);
});
document.addEventListener('keydown', (e) => {
  if (notif.open && e.key === 'Escape') toggleNotif(false);
});
