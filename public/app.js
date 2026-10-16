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
    // Reports whose older months can come from FMH export files: these pages
    // offer 6-month / 1-year ranges.
    this.fileCapable = Object.values(sources).some((s) => FILE_SOURCES.includes(s.source) && !s.grouping);
    this.useSaved = savedMode.get();
    this.rangeDays = 30; // the active chip; null after a custom date pick
    this.range = { start: daysAgoIso(30), end: todayIso() };
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
        ${!this.preview && !isSuper() && state.user && state.user.company_id ? '<button type="button" class="btn small ghost dash-wish" title="บอกทีม KSS ว่าอยากเห็นข้อมูลอะไรเพิ่ม">ขอข้อมูลเพิ่ม</button>' : ''}
        ${
          !this.preview && (isSuper() || isCompanyAdmin())
            ? `<div class="dash-actions">
                 <button type="button" class="btn small ghost dash-edit"><svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="18" height="7" rx="1.5"/></svg>จัดเรียง</button>
                 <button type="button" class="btn small primary dash-add">+ เพิ่ม Widget</button>
               </div>`
            : ''
        }
        ${
          this.hasDateSource
            ? `<div class="range-control" role="group" aria-label="ช่วงวันที่">
                 <button type="button" class="range-chip" data-days="7">7 วัน</button>
                 <button type="button" class="range-chip active" data-days="30">30 วัน</button>
                 <button type="button" class="range-chip" data-days="80">80 วัน</button>
                 ${this.fileCapable ? '<button type="button" class="range-chip" data-days="182">6 เดือน</button><button type="button" class="range-chip" data-days="365">1 ปี</button>' : ''}
                 <input type="date" class="range-start" value="${this.range.start}" aria-label="วันที่เริ่ม">
                 <span class="muted">–</span>
                 <input type="date" class="range-end" value="${this.range.end}" aria-label="วันที่สิ้นสุด">
               </div>`
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
      card.className = `widget-card size-${w.config.size || 'half'} widget-${w.chart_type}${[2, 3].includes(Number(w.config.rows)) ? ` rows-${w.config.rows}` : ''}`;
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
    this.rangeDays = null;
    this.range = { start: startIso, end: endIso };
    this.wrap.querySelectorAll('.range-chip').forEach((c) => c.classList.remove('active'));
    const s = this.wrap.querySelector('.range-start');
    const e = this.wrap.querySelector('.range-end');
    if (s) s.value = startIso;
    if (e) e.value = endIso;
    this.renderWidgets();
  }

  bindRange(header) {
    const start = header.querySelector('.range-start');
    const end = header.querySelector('.range-end');
    const chips = header.querySelectorAll('.range-chip');
    chips.forEach((chip) =>
      chip.addEventListener('click', () => {
        chips.forEach((c) => c.classList.toggle('active', c === chip));
        this.rangeDays = Number(chip.dataset.days);
        this.range = { start: daysAgoIso(this.rangeDays), end: todayIso() };
        start.value = this.range.start;
        end.value = this.range.end;
        this.renderWidgets();
      })
    );
    [start, end].forEach((input) =>
      input.addEventListener('change', () => {
        chips.forEach((c) => c.classList.remove('active'));
        this.rangeDays = null;
        this.range = { start: start.value, end: end.value };
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

  // Saved mode: anchor "today" to the newest saved pull and move the date range
  // with it; live mode: back to the real today.
  applyAnchor() {
    const times = this.useSaved
      ? Object.values(this.results).filter((r) => r && r.meta && r.meta.synced_at).map((r) => new Date(r.meta.synced_at).getTime())
      : [];
    dataAnchor = times.length ? Math.max(...times) : null;
    if (this.rangeDays) this.range = { start: daysAgoIso(this.rangeDays), end: todayIso() };
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

  // First day a pull has data for: uploaded files first, then the API window,
  // else the oldest row. Null when the pull is undated.
  coverageFrom(key) {
    const r = this.results[key];
    const info = this.sources[key];
    if (!r || r.error || !info || !info.date_field) return null;
    const h = r.meta && r.meta.history;
    if (h && (h.archive_from || h.file_from || h.api_from)) return [h.archive_from, h.file_from, h.api_from].filter(Boolean).sort()[0];
    let min = null;
    (r.data || []).forEach((row) => {
      const d = row[info.date_field] ? String(row[info.date_field]).slice(0, 10) : null;
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

  // Page level: every report the page reads.
  renderCoverage() {
    if (!this.coverageEl) return;
    const lines = [...new Set(Object.keys(this.sources).map((k) => this.coverageLine(k)).filter(Boolean))];
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
    const dateField = dateOverride || (this.sources[key] && this.sources[key].date_field);
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
               : oldest ? `ข้อมูลล่าสุด: ${esc(oldest)} · ระบบอัปเดตอัตโนมัติทุกวันตี 1` : keyMissing ? '' : 'ยังไม่เคย sync ข้อมูล'
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
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'กำลัง refresh...';
        try {
          await api(`/api/dashboards/${this.dashboard.id}/refresh`, { method: 'POST' });
          await this.load();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'ดึงข้อมูลใหม่';
          const note = document.createElement('div');
          note.className = 'inline-note';
          note.textContent = err.message;
          bar.appendChild(note);
          setTimeout(() => note.remove(), 6000);
        }
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
      const t = (c.querySelector('.widget-title') || {}).textContent || 'widget';
      const tools = document.createElement('div');
      tools.className = 'arr-tools';
      tools.innerHTML = `<button type="button" class="arr-grip" aria-label="ย้าย ${esc(t)} (ใช้ลูกศรซ้าย/ขวาก็ได้)" title="ลากเพื่อย้าย"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg><span>ลากเพื่อย้าย</span></button>
        <span class="arr-size" role="group" aria-label="ความกว้าง">${SIZES.map(([k, , l]) => `<button type="button" data-size="${k}" aria-pressed="${sizeOf(c) === k}">${l}</button>`).join('')}</span>`;
      c.prepend(tools);
      const rz = document.createElement('button');
      rz.type = 'button';
      rz.className = 'arr-resize';
      rz.setAttribute('aria-label', `ปรับขนาด ${t}`);
      rz.title = 'ลากเพื่อปรับขนาด';
      c.appendChild(rz);
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
      const cfg = themedCfg(widget.config || {});
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
        renderer(body, rows, useCfg);
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
    if (!top.length && !welcome) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const sample = this.dashboard.data_source === 'demo';
    const money = (v) => fmtValue(v, 'currency');
    // announced once, not on every range or filter change
    const announce = welcome && !this.welcomeAnnounced;
    if (welcome) this.welcomeAnnounced = true;
    const hid = `ins-h-${this.dashboard.id}`;
    el.setAttribute('aria-labelledby', hid);
    el.removeAttribute('aria-label');
    el.innerHTML = `
      ${welcome ? `<div class="ins-welcome"${announce ? ' role="status"' : ''}>
        <div><b>Dashboard ของคุณพร้อมแล้ว</b>${welcome.said && welcome.said.length ? `<span class="ins-said">จัดให้ตามที่คุณบอก: ${esc(welcome.said.join(' · '))}</span>` : ''}</div>
        <button type="button" class="btn small ghost ins-close" aria-label="ปิดข้อความต้อนรับ">ปิด</button>
      </div>` : ''}
      ${top.length ? `<div class="ins-head"><h2 id="${hid}">เราเจอให้คุณ${sample ? ' <span class="demo-pill">ตัวอย่าง</span>' : ''}</h2><span class="muted">${esc(dayLabel(this.range.start))} – ${esc(dayLabel(this.range.end))}</span></div>
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
      ${!isSuper() && state.user && state.user.company_id ? '<p class="ins-ask">อยากเห็นข้อมูลอื่นที่ยังไม่มีในหน้านี้? <button type="button" class="link-btn ins-wish">บอกเรา</button></p>' : ''}` : ''}`;
    const wishLink = el.querySelector('.ins-wish');
    if (wishLink) wishLink.addEventListener('click', () => openSupportForm({ kind: 'wish' }));
    const close = el.querySelector('.ins-close');
    if (close) close.addEventListener('click', () => {
      try { sessionStorage.removeItem(`kss_welcome_${this.dashboard.id}`); } catch (e) { /* none */ }
      this.renderInsights();
      const h = el.querySelector('h2');
      if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
    });
    el.querySelectorAll('.ins-go').forEach((b) => b.addEventListener('click', () => {
      const f = top[Number(b.dataset.i)];
      const card = this.wrap.querySelector(`.widget-card[data-wid="${f.widget.id}"]`);
      if (!card) return;
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      card.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
      // keyboard and screen-reader users land on the widget, not back on the card
      if (!card.hasAttribute('tabindex')) card.tabIndex = -1;
      setTimeout(() => card.focus({ preventScroll: true }), still ? 0 : 350);
      card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1600);
    }));
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

  // Order: what the customer said they care about, then the rest; within each, money to act
  // on before money that is waiting or unsure (an unfinished month), then by size.
  const wanted = new Set(goals || []);
  const rank = (f) => (wanted.size && f.goals.some((g) => wanted.has(g)) ? 0 : 2) + (f.tone === 'info' || f.unsure ? 1 : 0);
  const top = [...out].sort((a, b) => rank(a) - rank(b) || b.baht - a.baht).slice(0, 3);
  return { top, all: out };
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

function renderTable(body, rows, cfg) {
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
};

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
    const r = await api('/api/announcements');
    notif.items = r.items;
    const badge = el('notif-badge');
    badge.textContent = r.unread > 9 ? '9+' : String(r.unread);
    badge.classList.toggle('hidden', !r.unread);
    el('notif-btn').setAttribute('aria-label', r.unread ? `มีอะไรใหม่ (${r.unread} ยังไม่ได้อ่าน)` : 'มีอะไรใหม่');
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
