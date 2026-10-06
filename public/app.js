// KSS Platform — vanilla JS SPA, no build step.
//
//   app.js   — login, app shell, dashboard view, the generic widget renderers
//   admin.js — KSS Internal Admin Console + the shared user manager
//
// A dashboard is a list of widgets. Each widget = one report source + a
// chart_type (which renderer below draws it) + a config. The page fetches
// each report source once from the server-side cache and every widget that
// uses that source renders from the same rows.

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
    case 'currency':
      return '฿' + Math.round(n).toLocaleString('th-TH');
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
  if (format === 'currency') return '฿' + compactFmt.format(v);
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
      const side = byAlias[c.from] || [];
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
  if (expr.field !== undefined) return num(pick(row, expr.field));
  const a = () => evalRow(expr.a, row);
  const b = () => evalRow(expr.b, row);
  switch (expr.op) {
    case 'add': return a() + b();
    case 'sub': return a() - b();
    case 'mul': return a() * b();
    case 'div': { const d = b(); return d ? a() / d : 0; }
    case 'pct_of': { const d = b(); return d ? (a() / d) * 100 : 0; }
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
    case 'matches': return new RegExp(rule.pattern).test(String(pick(row, rule.field) ?? ''));
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
        derived.forEach((d) => { copy[d.field] = evalRow(d.expr, r); });
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
  el('login-screen').classList.toggle('hidden', name !== 'login');
  el('force-change-screen').classList.toggle('hidden', name !== 'force-change');
  el('app-shell').classList.toggle('hidden', name !== 'app');
}

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
  el('user-display-name').textContent = state.user.display_name;
  el('open-admin-btn').classList.toggle('hidden', !isSuper() && !isCompanyAdmin());
  el('open-admin-btn').textContent = adminBtnLabel();
  el('open-manage-users-btn').classList.toggle('hidden', !isCompanyAdmin());
  el('open-settings-btn').classList.toggle('hidden', !isCompanyAdmin());
  el('company-picker-wrap').classList.toggle('hidden', !isSuper());
  el('company-name').classList.toggle('hidden', isSuper() || !state.user.company_name);
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
  el('open-admin-btn').textContent = adminBtnLabel();
}

// KSS staff get the whole Admin Console; a client's company admin gets the
// same composer and widget picker, for their own company only.
function adminBtnLabel() {
  return isSuper() ? '🏢 Admin Console' : '✎ จัดการ Dashboard';
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
    wrap.innerHTML = `<p class="muted">${
      isSuper() ? 'บริษัทนี้ยังไม่มี dashboard — สร้างได้ใน Admin Console' : 'ยังไม่มี dashboard ที่คุณเข้าถึงได้ กรุณาติดต่อผู้ดูแลระบบ'
    }</p>`;
  }
}

function renderTabs() {
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
}

function keyMissingMessage() {
  if (isSuper()) return 'ยังไม่ได้ตั้งค่า FMH API Key ของบริษัทนี้ — ตั้งค่าได้ใน Admin Console';
  if (isCompanyAdmin()) return 'ยังไม่ได้ตั้งค่า FMH API Key — กดปุ่ม ⚙️ มุมขวาบนเพื่อใส่ Key';
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

class DashboardView {
  constructor(wrap, { dashboard, widgets, sources }) {
    this.wrap = wrap;
    this.dashboard = dashboard;
    this.widgets = widgets;
    this.sources = sources;
    this.results = {}; // source -> { data, meta } | { error, code }
    this.hasDateSource = Object.values(sources).some((s) => s.date_field);
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
      <div>
        <h1 class="dash-title">${esc(this.dashboard.display_name)}</h1>
        ${this.dashboard.description ? `<p class="dash-desc">${esc(this.dashboard.description)}</p>` : ''}
      </div>
      <div class="dash-controls">
        ${
          this.hasDateSource
            ? `<div class="range-control" role="group" aria-label="ช่วงวันที่">
                 <button type="button" class="range-chip" data-days="7">7 วัน</button>
                 <button type="button" class="range-chip active" data-days="30">30 วัน</button>
                 <button type="button" class="range-chip" data-days="80">80 วัน</button>
                 <input type="date" class="range-start" value="${this.range.start}" aria-label="วันที่เริ่ม">
                 <span class="muted">–</span>
                 <input type="date" class="range-end" value="${this.range.end}" aria-label="วันที่สิ้นสุด">
               </div>`
            : ''
        }
      </div>`;
    this.wrap.appendChild(header);

    this.statusEl = document.createElement('div');
    this.wrap.appendChild(this.statusEl);

    if (!this.widgets.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'dashboard นี้ยังไม่มี widget';
      this.wrap.appendChild(p);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'widget-grid';
    this.cards = this.widgets.map((w) => {
      const card = document.createElement('section');
      card.className = `widget-card size-${w.config.size || 'half'} widget-${w.chart_type}`;
      card.innerHTML = `<h3 class="widget-title">${esc(w.title)}</h3><div class="widget-body"><p class="muted">กำลังโหลด...</p></div>`;
      grid.appendChild(card);
      return { widget: w, body: card.querySelector('.widget-body') };
    });
    this.wrap.appendChild(grid);

    if (this.hasDateSource) this.bindRange(header);
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
        const qs = params.toString() ? `?${params}` : '';
        try {
          this.results[key] = await api(`/api/dashboards/${this.dashboard.id}/data/${info.source || key}${qs}`);
        } catch (err) {
          this.results[key] = { error: err.message, code: err.code, health: err.data && err.data.health };
        }
      })
    );
    if (state.activeDashboardId !== this.dashboard.id) return;
    this.applyAnchor();
    this.renderStatus();
    this.renderWidgets();
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
    (this.cards || []).forEach(({ body }) => (body.innerHTML = '<p class="muted">กำลังโหลด...</p>'));
    await this.load();
  }

  // Widgets address data by the same key the server cached it under.
  keyFor(widget) {
    return widget.grouping ? `${widget.report_source}|${widget.grouping}` : widget.report_source;
  }

  rowsFor(key) {
    const r = this.results[key];
    if (!r || r.error) return null;
    const dateField = this.sources[key] && this.sources[key].date_field;
    if (!dateField || !this.hasDateSource) return r.data;
    const { start, end } = this.range;
    if (this.sources[key].date_is_bucket) return keepOverlappingBuckets(r.data, dateField, start, end);
    return r.data.filter((row) => {
      const d = row[dateField] ? String(row[dateField]).slice(0, 10) : null;
      return d && (!start || d >= start) && (!end || d <= end);
    });
  }

  renderStatus() {
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
               ? '<span class="demo-pill">ข้อมูลตัวอย่าง</span> <span class="muted">ข้อมูลตัวอย่างสำหรับเดโม — ไม่ใช่ข้อมูลจริงและไม่ใช้โควตา FMH</span>'
               : oldest ? `ข้อมูลล่าสุด: ${esc(oldest)} · ระบบอัปเดตอัตโนมัติทุกวันตี 1` : keyMissing ? '' : 'ยังไม่เคย sync ข้อมูล'
           }</span>
           <span class="sync-actions">${toggle}${keyMissing ? '' : '<button type="button" class="btn small ghost fmh-refresh-btn">Refresh ด่วน</button>'}</span>
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
          btn.textContent = 'Refresh ด่วน';
          const note = document.createElement('div');
          note.className = 'inline-note';
          note.textContent = err.message;
          bar.appendChild(note);
          setTimeout(() => note.remove(), 6000);
        }
      });
    }
  }

  renderWidgets() {
    destroyCharts();
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
      const cfg = widget.config || {};
      // A composite widget draws several small charts, each from its own pull.
      if (widget.pulls && cfg.panels) {
        const byAlias = {};
        widget.pulls.forEach((p) => {
          const r = this.results[p.key];
          byAlias[p.as] = r && !r.error ? this.rowsFor(p.key) || [] : null;
        });
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
        widget.pulls.forEach((p) => { byAlias[p.as] = this.rowsFor(p.key) || []; });
        raw = pivotRows(byAlias, cfg) || [];
      } else {
        raw = this.rowsFor(key);
      }
      const rows = applyRowLayer(raw, cfg);
      if (!rows.length) {
        // Three different situations used to share one sentence, and it named
        // the date range even for sources that carry no date — which sent me
        // looking at the range picker when the pull itself was empty.
        const filtered = raw.length && !rows.length;
        const dated = !widget.pulls && !!(this.sources[key] && this.sources[key].date_field) && this.hasDateSource;
        body.innerHTML = `<p class="muted">${esc(
          filtered
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
        return;
      }
      const renderer = RENDERERS[widget.chart_type];
      if (!renderer) {
        body.innerHTML = `<p class="muted">ไม่รู้จักประเภท widget: ${esc(widget.chart_type)}</p>`;
        return;
      }
      try {
        renderer(body, rows, cfg);
        // A note on how to read the widget. Renderers that place it themselves
        // (range) are left alone.
        if (cfg.foot && widget.chart_type !== 'range') body.insertAdjacentHTML('beforeend', `<p class="widget-foot widget-note">${esc(cfg.foot)}</p>`);
      } catch (err) {
        console.error('Widget render failed', widget, err);
        body.innerHTML = `<p class="muted">แสดงผล widget นี้ไม่สำเร็จ (${esc(err.message)})</p>`;
      }
    });
  }
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
  if (cfg.color_mode === 'signed') return value < 0 ? 'var(--chili)' : 'var(--series-blue)';
  // Money out: paying more is the bad direction, so it is the red one.
  if (cfg.color_mode === 'signed_cost') return value > 0 ? 'var(--chili)' : 'var(--series-blue)';
  if (cfg.color_mode === 'margin') return value < 0 ? 'var(--chili)' : value < 20 ? 'var(--brass)' : 'var(--status-good)';
  // A target makes "good" directional: food cost is better low, margin better
  // high, so the widget says which way it reads rather than the renderer
  // guessing from the number's sign.
  if (cfg.threshold != null) {
    const lowerIsBetter = cfg.lower_is_better !== false;
    const miss = lowerIsBetter ? value > cfg.threshold : value < cfg.threshold;
    if (!miss) return 'var(--status-good)';
    const far = lowerIsBetter ? value > cfg.threshold * 1.15 : value < cfg.threshold * 0.85;
    return far ? 'var(--chili)' : 'var(--brass)';
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
  const keys = [...buckets.keys()].sort();
  if (!keys.length || !window.Chart) {
    body.innerHTML = `<p class="muted">${window.Chart ? 'ไม่มีวันที่ในข้อมูลสำหรับสร้างกราฟ' : 'โหลดไลบรารีกราฟไม่สำเร็จ'}</p>`;
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  wrap.innerHTML = '<canvas></canvas>';
  body.appendChild(wrap);
  // `series_by` makes one series per value of a field (a line per category),
  // the largest first; the rest fold into one, so the legend stays readable.
  let series = cfg.series || [];
  if (cfg.series_by) {
    const totals = new Map();
    rows.forEach((r) => {
      const k = String(pick(r, cfg.series_by) ?? 'ไม่ระบุ');
      totals.set(k, (totals.get(k) || 0) + evalMetric(cfg.value, [r]));
    });
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const top = ranked.slice(0, cfg.top_n || 6);
    const inTop = new Set(top);
    series = top.map((k, i) => ({
      label: k,
      color: CAT_COLORS[i % CAT_COLORS.length],
      value: { op: 'sum_where', field: cfg.value.field, where: { op: 'in', field: cfg.series_by, values: [k] } },
    }));
    if (ranked.length > top.length) {
      series.push({
        label: `อื่น ๆ (${ranked.length - top.length})`,
        color: '#B8B09A',
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
      datasets: series.map((s) => {
        const data = keys.map((k) => evalMetric(s.value, buckets.get(k)));
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
          pointRadius: 3,
          pointHoverRadius: 6,
          pointBorderColor: '#fff',
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
        legend: { display: cfg.legend !== false, position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8, color: '#1B2B22' } },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${fmtValue(ctx.parsed.y, cfg.format)}`,
            footer: (its) => (cfg.stacked && its.length > 1 ? `รวม ${fmtValue(its.reduce((a, i) => a + i.parsed.y, 0), cfg.format)}` : ''),
          },
        },
      },
      scales: {
        x: { stacked: !!cfg.stacked, grid: { display: false }, ticks: { color: '#6b7268' } },
        y: { stacked: !!cfg.stacked, beginAtZero: asBar || cfg.zero === true, grid: { color: '#f0ece0' }, border: { display: false }, ticks: { color: '#6b7268', callback: (v) => fmtAxis(v, cfg.format) } },
      },
    },
  });
  activeCharts.push(chart);
}

function renderTable(body, rows, cfg) {
  const columns = cfg.columns && cfg.columns.length ? cfg.columns : Object.keys(rows[0]).map((field) => ({ field }));
  let sort = cfg.sort_by ? { ...cfg.sort_by } : null; // { field, dir }
  const limit = cfg.top_n || 200;

  const tools = document.createElement('div');
  tools.className = 'table-tools';
  tools.innerHTML = `<span class="widget-foot"></span><button type="button" class="btn small ghost">Export CSV</button>`;
  tools.querySelector('button').addEventListener('click', () => exportCsv(rows, columns));
  const scroller = document.createElement('div');
  scroller.className = 'table-scroll';
  body.appendChild(tools);
  body.appendChild(scroller);

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
    const shown = data.slice(0, limit);
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
                ? `<td class="num">${esc(c.format ? fmtValue(v, c.format) : v.toLocaleString('th-TH', { maximumFractionDigits: 2 }))}</td>`
                : `<td>${esc(v)}</td>`;
            })
            .join('')}</tr>`
      )
      .join('');
    scroller.innerHTML = `<table class="report-table"><thead><tr>${head}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
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
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, (item[shareKey] / maxShare) * 100)}%;background:var(--brass)"></span></span>
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
const SEQ_RAMP = ['#184f95', '#2a78d6', '#5598e7', '#9ec5f4', '#cde2fb'];
// Distinct in hue AND lightness, so neighbouring slices separate in greyscale too.
// No chili: in this app red means "needs action" (overdue, awaiting invoice).
const CAT_COLORS = ['#2F6FB0', '#A9812F', '#2F8F4E', '#1B2B22', '#8FB4DC', '#C9A15A', '#7A6A9E'];
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
    (cfg.colors && cfg.colors[it.name]) || (it.other ? '#D6CFBC' : CAT_COLORS[i % CAT_COLORS.length])
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
        legend: { position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8, color: '#1B2B22' } },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${fmtValue(ctx.parsed.x, cfg.format)}`,
            footer: (its) => (its.length ? `รวม ${fmtValue(shown[its[0].dataIndex].total, cfg.format)}` : ''),
          },
        },
      },
      scales: {
        x: { stacked: true, beginAtZero: true, grid: { color: '#f0ece0' }, border: { display: false }, ticks: { color: '#6b7268', callback: (v) => fmtAxis(v, cfg.format) } },
        y: { stacked: true, grid: { display: false }, ticks: { color: '#1B2B22' } },
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
        .map((m) => `<span><span class="dot" style="background:${m.color || '#6b7268'}"></span>${esc(m.label)}: <b style="color:${m.color || '#1B2B22'}">${esc(fmtValue(evalMetric(m.value, rows), m.format || panel.format))}</b></span>`)
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
  if (cfg.foot) body.insertAdjacentHTML('beforeend', `<p class="widget-foot">${esc(cfg.foot)}</p>`);
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
        { type: 'bar', label: cfg.bar_label || 'มูลค่า', data: items.map((i) => i.value), backgroundColor: '#2a78d6', borderRadius: 3, order: 2 },
        { type: 'line', label: 'สะสม %', data: cum, yAxisID: 'y2', borderColor: '#A9812F', backgroundColor: '#A9812F', borderWidth: 2, pointRadius: 3, tension: 0.2, order: 1 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8, color: '#1B2B22' } },
        tooltip: {
          callbacks: {
            label: (ctx) => (ctx.dataset.yAxisID === 'y2' ? ` ${t(`สะสม ${ctx.parsed.y.toFixed(0)}%`)}` : ` ${fmtValue(ctx.parsed.y, cfg.format)}`),
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#6b7268', maxRotation: 50, minRotation: 0, autoSkip: false } },
        y: { beginAtZero: true, grid: { color: '#f0ece0' }, border: { display: false }, ticks: { color: '#6b7268', callback: (v) => fmtAxis(v, cfg.format) } },
        y2: { position: 'right', min: 0, max: 100, grid: { display: false }, border: { display: false }, ticks: { color: '#A9812F', callback: (v) => v + '%' } },
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
    ctx.strokeStyle = '#b9b6ab';
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    const px = scales.x.getPixelForValue(opts.x);
    const py = scales.y.getPixelForValue(opts.y);
    ctx.beginPath(); ctx.moveTo(px, chartArea.top); ctx.lineTo(px, chartArea.bottom); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(chartArea.left, py); ctx.lineTo(chartArea.right, py); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#8a877f';
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
    qx == null ? '#2a78d6' : p.x >= qx && p.y >= qy ? '#0ca30c' : p.x < qx && p.y < qy ? '#BE4229' : '#2a78d6';
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
        x: { title: { display: !!cfg.x_label, text: cfg.x_label, color: '#6b7268' }, grid: { color: '#f7f5ee' }, ticks: { color: '#6b7268', callback: (v) => fmtAxis(v, cfg.x_format) } },
        y: { title: { display: !!cfg.y_label, text: cfg.y_label, color: '#6b7268' }, grid: { color: '#f0ece0' }, border: { display: false }, ticks: { color: '#6b7268', callback: (v) => fmtAxis(v, cfg.y_format) } },
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
    el.title = `${it.name}: ${fmtValue(it.value, cfg.format)} (${share.toFixed(1)}%)`;
    el.innerHTML = `<span class="treemap-name">${esc(it.name)}</span><span class="treemap-val">${esc(fmtValue(it.value, cfg.format))} · ${share.toFixed(0)}%</span>`;
    if (i >= 3) el.classList.add('on-light');
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
