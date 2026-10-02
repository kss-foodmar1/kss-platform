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
  return new Date(String(iso).replace(' ', 'T')).toLocaleString('th-TH', {
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
    default:
      return 0;
  }
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

async function boot() {
  try {
    const { user } = await api('/api/auth/me');
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
  el('open-admin-btn').classList.toggle('hidden', !isSuper());
  el('open-manage-users-btn').classList.toggle('hidden', !isCompanyAdmin());
  el('open-settings-btn').classList.toggle('hidden', !isCompanyAdmin());
  el('company-picker-wrap').classList.toggle('hidden', !isSuper());
  el('company-name').classList.toggle('hidden', isSuper() || !state.user.company_name);
  el('company-name').textContent = state.user.company_name || '';
  showScreen('app');

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
  await loadCompanyPicker(companyId);
  showDashboardView();
  await loadDashboards(dashboardId);
}

function showDashboardView() {
  el('dashboard-view').classList.remove('hidden');
  el('admin-view').classList.add('hidden');
  el('open-admin-btn').textContent = '🏢 Admin Console';
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

const todayIso = () => new Date().toISOString().slice(0, 10);
const daysAgoIso = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

class DashboardView {
  constructor(wrap, { dashboard, widgets, sources }) {
    this.wrap = wrap;
    this.dashboard = dashboard;
    this.widgets = widgets;
    this.sources = sources;
    this.results = {}; // source -> { data, meta } | { error, code }
    this.hasDateSource = Object.values(sources).some((s) => s.date_field);
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

  bindRange(header) {
    const start = header.querySelector('.range-start');
    const end = header.querySelector('.range-end');
    const chips = header.querySelectorAll('.range-chip');
    chips.forEach((chip) =>
      chip.addEventListener('click', () => {
        chips.forEach((c) => c.classList.toggle('active', c === chip));
        this.range = { start: daysAgoIso(Number(chip.dataset.days)), end: todayIso() };
        start.value = this.range.start;
        end.value = this.range.end;
        this.renderWidgets();
      })
    );
    [start, end].forEach((input) =>
      input.addEventListener('change', () => {
        chips.forEach((c) => c.classList.remove('active'));
        this.range = { start: start.value, end: end.value };
        this.renderWidgets();
      })
    );
  }

  async load() {
    await Promise.all(
      Object.entries(this.sources).map(async ([key, info]) => {
        const qs = info.grouping ? `?group=${encodeURIComponent(info.grouping)}` : '';
        try {
          this.results[key] = await api(`/api/dashboards/${this.dashboard.id}/data/${info.source || key}${qs}`);
        } catch (err) {
          this.results[key] = { error: err.message, code: err.code };
        }
      })
    );
    if (state.activeDashboardId !== this.dashboard.id) return;
    this.renderStatus();
    this.renderWidgets();
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
      .filter((r) => r.meta && r.meta.quota)
      .sort((a, b) => String(b.meta.synced_at).localeCompare(String(a.meta.synced_at)))[0];

    this.statusEl.innerHTML = '';
    const bar = document.createElement('div');
    bar.className = 'fmh-status-bar';
    const oldest = fmtDateTime(syncedTimes[0]);
    bar.innerHTML = `
      <div class="fmh-sync-line">
        <span>${oldest ? `ข้อมูลล่าสุด: ${esc(oldest)} · ระบบอัปเดตอัตโนมัติทุกวันตี 1` : keyMissing ? '' : 'ยังไม่เคย sync ข้อมูล'}</span>
        ${keyMissing ? '' : '<button type="button" class="btn small ghost fmh-refresh-btn">Refresh ด่วน</button>'}
      </div>`;

    if (latest) {
      const q = latest.meta.quota;
      const limit = Number(q.monthly_row_limit) || 0;
      const used = Number(q.rows_used) || 0;
      const remaining = q.rows_remaining ?? Math.max(0, limit - used);
      const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
      const low = limit ? remaining / limit < 0.1 : false;
      const resets = q.resets_at ? new Date(q.resets_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' }) : null;
      bar.insertAdjacentHTML(
        'beforeend',
        `<div class="fmh-quota">
           <span>FMH API quota เดือนนี้: ${used.toLocaleString('th-TH')} / ${limit.toLocaleString('th-TH')} แถว (เหลือ ${Number(remaining).toLocaleString('th-TH')})${resets ? ` · รีเซ็ต ${esc(resets)}` : ''}</span>
           <span class="fmh-quota-track" role="img" aria-label="ใช้ไป ${pct.toFixed(0)}%"><span class="fmh-quota-fill${low ? ' fmh-quota-fill-low' : ''}" style="width:${pct}%"></span></span>
         </div>`
      );
    }
    if (keyMissing) bar.insertAdjacentHTML('beforeend', `<div class="error-msg" style="margin:4px 0 0;">${esc(keyMissingMessage())}</div>`);
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
        return;
      }
      const rows = this.rowsFor(key);
      if (!rows.length) {
        body.innerHTML = '<p class="muted">ไม่พบข้อมูลในช่วงวันที่เลือก</p>';
        return;
      }
      const renderer = RENDERERS[widget.chart_type];
      if (!renderer) {
        body.innerHTML = `<p class="muted">ไม่รู้จักประเภท widget: ${esc(widget.chart_type)}</p>`;
        return;
      }
      try {
        renderer(body, rows, widget.config || {});
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

function bucketKey(dateStr, bucket) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
  if (isNaN(d)) return null;
  if (bucket === 'day') return d.toISOString().slice(0, 10);
  if (bucket === 'month') return d.toISOString().slice(0, 7) + '-01';
  const day = d.getDay(); // week: Monday of that week
  d.setDate(d.getDate() + ((day === 0 ? -6 : 1) - day));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
  const series = cfg.series || [];
  const chart = new Chart(wrap.querySelector('canvas'), {
    type: 'line',
    data: {
      labels: keys.map((k) =>
        new Date(k + 'T00:00:00').toLocaleDateString('th-TH', cfg.bucket === 'month' ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' })
      ),
      datasets: series.map((s) => ({
        label: s.label,
        data: keys.map((k) => evalMetric(s.value, buckets.get(k))),
        borderColor: s.color,
        backgroundColor: s.color,
        borderWidth: 2,
        pointRadius: 3,
        pointHoverRadius: 6,
        pointBorderColor: '#fff',
        pointBorderWidth: 1.5,
        tension: 0.25,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8, color: '#1B2B22' } },
        tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmtValue(ctx.parsed.y, cfg.format)}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#6b7268' } },
        y: { grid: { color: '#f0ece0' }, border: { display: false }, ticks: { color: '#6b7268', callback: (v) => fmtAxis(v, cfg.format) } },
      },
    },
  });
  activeCharts.push(chart);
}

function renderTable(body, rows, cfg) {
  const columns = cfg.columns && cfg.columns.length ? cfg.columns : Object.keys(rows[0]).map((field) => ({ field }));
  let sort = null; // { field, dir }
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

const RENDERERS = {
  kpi: renderKpi,
  bar: renderBar,
  line: renderLine,
  table: renderTable,
  sensitivity: renderSensitivity,
  menu_breakdown: renderMenuBreakdown,
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
