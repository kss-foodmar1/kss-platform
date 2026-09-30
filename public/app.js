// KSS Platform — vanilla JS SPA. No build step, so this can be deployed as-is.

const state = {
  user: null,
  dashboards: [],
  activeDashboardId: null,
  sortState: {}, // { [reportKey]: { by, dir } }
};

const el = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// Renders the FMH monthly row-quota status (returned as `meta.quota` on every
// FMH-backed report response) into the given container. Safe to call with a
// missing/undefined quota — just clears the container in that case.
function renderFmhQuota(container, quota) {
  container.innerHTML = '';
  if (!quota || typeof quota.monthly_row_limit !== 'number') return;
  const limit = quota.monthly_row_limit;
  const used = quota.rows_used ?? 0;
  const remaining = quota.rows_remaining ?? Math.max(0, limit - used);
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  const low = limit ? remaining / limit < 0.1 : false;
  const resets = quota.resets_at
    ? new Date(quota.resets_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })
    : null;
  container.innerHTML = `
    <div class="fmh-quota">
      <span>FMH API quota เดือนนี้: ${used.toLocaleString('th-TH')} / ${limit.toLocaleString('th-TH')} แถว (เหลือ ${remaining.toLocaleString('th-TH')})${resets ? ` · รีเซ็ต ${resets}` : ''}</span>
      <span class="fmh-quota-track"><span class="fmh-quota-fill${low ? ' fmh-quota-fill-low' : ''}" style="width:${pct}%"></span></span>
    </div>
  `;
}

function showScreen(name) {
  el('login-screen').classList.toggle('hidden', name !== 'login');
  el('force-change-screen').classList.toggle('hidden', name !== 'force-change');
  el('app-shell').classList.toggle('hidden', name !== 'app');
}

// ---------- Boot ----------
async function boot() {
  try {
    const { user } = await api('/api/auth/me');
    state.user = user;
    if (user.must_change_password) {
      showScreen('force-change');
    } else {
      await enterApp();
    }
  } catch {
    showScreen('login');
  }
}

// ---------- Login ----------
el('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  el('login-error').classList.add('hidden');
  try {
    const { user } = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: el('login-email').value.trim(),
        password: el('login-password').value,
      }),
    });
    state.user = user;
    if (user.must_change_password) {
      showScreen('force-change');
    } else {
      await enterApp();
    }
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

// ---------- App shell ----------
async function enterApp() {
  el('user-display-name').textContent = state.user.display_name;
  el('open-settings-btn').classList.toggle('hidden', state.user.role !== 'admin');
  el('open-manage-users-btn').classList.toggle('hidden', state.user.role !== 'admin');
  showScreen('app');

  const { dashboards } = await api('/api/dashboards');
  state.dashboards = dashboards;
  renderTabs();
  if (dashboards[0]) selectDashboard(dashboards[0].id);
}

function renderTabs() {
  const tabsEl = el('tabs');
  tabsEl.innerHTML = '';
  state.dashboards.forEach((d) => {
    const btn = document.createElement('button');
    btn.className = 'tab' + (d.id === state.activeDashboardId ? ' active' : '');
    btn.textContent = d.display_name;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('tabindex', '0');
    btn.addEventListener('click', () => selectDashboard(d.id));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectDashboard(d.id); }
    });
    tabsEl.appendChild(btn);
  });
}

function selectDashboard(id) {
  state.activeDashboardId = id;
  renderTabs();
  const dash = state.dashboards.find((d) => d.id === id);
  const wrap = el('tab-panel-wrap');
  wrap.innerHTML = '';
  if (!dash || !dash.reports.length) {
    wrap.innerHTML = '<p style="color:#6b7268;">ยังไม่มีรายงานใน dashboard นี้</p>';
    return;
  }
  dash.reports.forEach((report) => renderReportBlock(wrap, report));
}

function renderReportBlock(wrap, report) {
  const block = document.createElement('div');
  block.className = 'report-block';
  block.innerHTML = `<h2>${report.display_name}</h2>`;

  const FMH_ENDPOINTS = {
    cogs: { path: '/api/reports/cogs', dateRange: true },
    'menu-costing': { path: '/api/reports/menu-costing', dateRange: false },
    'sales-by-branch': { path: '/api/reports/sales-by-branch', dateRange: true },
  };

  if (report.report_key === 'price_change') {
    block.appendChild(buildPriceChangeReport(report));
  } else if (report.report_key === 'cogs-visual') {
    block.appendChild(buildCogsDashboard());
  } else if (report.report_key === 'purchase-analysis-visual') {
    block.appendChild(buildPurchaseAnalysisDashboard());
  } else if (report.report_key === 'menu-ingredient-impact') {
    block.appendChild(buildMenuIngredientImpactDashboard());
  } else if (FMH_ENDPOINTS[report.report_key]) {
    block.appendChild(buildFmhReport(report, FMH_ENDPOINTS[report.report_key]));
  } else {
    const p = document.createElement('p');
    p.style.color = '#6b7268';
    p.textContent = 'รายงานนี้กำลังจะมาเร็ว ๆ นี้';
    block.appendChild(p);
  }
  wrap.appendChild(block);
}

// ---------- Price Change report ----------
function buildPriceChangeReport(report) {
  const container = document.createElement('div');

  const filters = document.createElement('div');
  filters.className = 'filters-row';
  filters.innerHTML = `
    <input type="date" id="pc-start" />
    <input type="date" id="pc-end" />
    <select id="pc-supplier"><option value="">ทุกซัพพลายเออร์</option></select>
    <input type="text" id="pc-search" placeholder="ค้นหาสินค้า..." />
    <button class="btn small" id="pc-export">Export Excel</button>
  `;
  container.appendChild(filters);

  const tableWrap = document.createElement('div');
  tableWrap.id = 'pc-table-wrap';
  container.appendChild(tableWrap);

  const today = new Date();
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  filters.querySelector('#pc-end').value = today.toISOString().slice(0, 10);
  filters.querySelector('#pc-start').value = weekAgo.toISOString().slice(0, 10);

  api('/api/reports/price-change/suppliers').then(({ suppliers }) => {
    const sel = filters.querySelector('#pc-supplier');
    suppliers.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      sel.appendChild(opt);
    });
  });

  let currentData = [];

  async function load() {
    const params = new URLSearchParams({
      start: filters.querySelector('#pc-start').value,
      end: filters.querySelector('#pc-end').value,
    });
    const supplier = filters.querySelector('#pc-supplier').value;
    const search = filters.querySelector('#pc-search').value;
    if (supplier) params.set('supplier', supplier);
    if (search) params.set('search', search);

    const sortState = state.sortState.price_change;
    if (sortState) {
      params.set('sort_by', sortState.by);
      params.set('sort_dir', sortState.dir);
    }

    const { data } = await api(`/api/reports/price-change?${params.toString()}`);
    currentData = data;
    renderTable();
  }

  function renderTable() {
    const columns = [
      { key: 'product', label: 'สินค้า' },
      { key: 'supplier', label: 'ซัพพลายเออร์' },
      { key: 'branch', label: 'สาขา' },
      { key: 'unit_price', label: 'ราคาปัจจุบัน' },
      { key: 'previous_unit_price', label: 'ราคาก่อนหน้า' },
      { key: 'variance', label: 'เปลี่ยนแปลง %' },
    ];

    const table = document.createElement('table');
    table.className = 'report-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    columns.forEach((col) => {
      const th = document.createElement('th');
      th.textContent = col.label;
      th.setAttribute('tabindex', '0');
      const sortState = state.sortState.price_change;
      const arrow = sortState && sortState.by === col.key ? (sortState.dir === 'asc' ? ' ▲' : ' ▼') : '';
      th.textContent = col.label + arrow;
      th.addEventListener('click', () => {
        const current = state.sortState.price_change;
        let dir = 'asc';
        if (current && current.by === col.key) {
          dir = current.dir === 'asc' ? 'desc' : (current.dir === 'desc' ? null : 'asc');
        }
        if (dir === null) {
          delete state.sortState.price_change;
        } else {
          state.sortState.price_change = { by: col.key, dir };
        }
        load();
      });
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); th.click(); }
      });
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    currentData.forEach((row) => {
      const tr = document.createElement('tr');
      columns.forEach((col) => {
        const td = document.createElement('td');
        if (col.key === 'variance') {
          const badge = document.createElement('span');
          badge.className = 'badge ' + (row.variance >= 0 ? 'up' : 'down');
          badge.textContent = (row.variance >= 0 ? '+' : '') + row.variance.toFixed(2) + '%';
          td.appendChild(badge);
        } else if (col.key === 'unit_price' || col.key === 'previous_unit_price') {
          td.textContent = Number(row[col.key]).toLocaleString('th-TH', { minimumFractionDigits: 2 });
        } else {
          td.textContent = row[col.key];
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    tableWrap.innerHTML = '';
    if (!currentData.length) {
      tableWrap.innerHTML = '<p style="color:#6b7268;">ไม่พบข้อมูลตามเงื่อนไขที่เลือก</p>';
      return;
    }
    tableWrap.appendChild(table);
  }

  filters.querySelectorAll('input, select').forEach((f) => f.addEventListener('change', load));
  filters.querySelector('#pc-export').addEventListener('click', () => exportToExcel(currentData));

  load();
  return container;
}

// ---------- Generic FMH-backed report (COGS, Menu Costing, Sales by Branch) ----------
function buildFmhReport(report, config) {
  const container = document.createElement('div');

  const filters = document.createElement('div');
  filters.className = 'filters-row';

  if (config.dateRange) {
    filters.innerHTML = `
      <input type="date" class="fmh-start" />
      <input type="date" class="fmh-end" />
      <button class="btn small fmh-reload">โหลดข้อมูล</button>
      <button class="btn small fmh-export">Export Excel</button>
    `;
    const today = new Date();
    const monthAgo = new Date(Date.now() - 30 * 86400000);
    filters.querySelector('.fmh-end').value = today.toISOString().slice(0, 10);
    filters.querySelector('.fmh-start').value = monthAgo.toISOString().slice(0, 10);
  } else {
    filters.innerHTML = `
      <button class="btn small fmh-reload">โหลดข้อมูล</button>
      <button class="btn small fmh-export">Export Excel</button>
    `;
  }
  container.appendChild(filters);

  const quotaWrap = document.createElement('div');
  container.appendChild(quotaWrap);

  const statusWrap = document.createElement('div');
  container.appendChild(statusWrap);

  const tableWrap = document.createElement('div');
  container.appendChild(tableWrap);

  let currentData = [];

  async function load() {
    tableWrap.innerHTML = '';
    statusWrap.innerHTML = '<p style="color:#6b7268;">กำลังโหลดข้อมูลจาก FMH...</p>';
    const params = new URLSearchParams();
    if (config.dateRange) {
      params.set('start', filters.querySelector('.fmh-start').value);
      params.set('end', filters.querySelector('.fmh-end').value);
    }
    try {
      const { data, meta } = await api(`${config.path}?${params.toString()}`);
      currentData = data;
      statusWrap.innerHTML = '';
      renderFmhQuota(quotaWrap, meta && meta.quota);
      renderTable();
    } catch (err) {
      currentData = [];
      if (err.message && err.message.includes('FMH API key not configured')) {
        statusWrap.innerHTML =
          '<div class="error-msg">ยังไม่ได้ตั้งค่า FMH API Key — ไปที่เมนู ⚙️ ตั้งค่า → แท็บ "FMH API" เพื่อใส่ Key ก่อนใช้งานรายงานนี้</div>';
      } else {
        statusWrap.innerHTML = `<div class="error-msg">โหลดข้อมูลไม่สำเร็จ: ${err.message}</div>`;
      }
    }
  }

  function renderTable() {
    tableWrap.innerHTML = '';
    if (!currentData.length) {
      tableWrap.innerHTML = '<p style="color:#6b7268;">ไม่พบข้อมูลตามเงื่อนไขที่เลือก</p>';
      return;
    }
    const columns = Object.keys(currentData[0]);
    const table = document.createElement('table');
    table.className = 'report-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    columns.forEach((col) => {
      const th = document.createElement('th');
      th.textContent = col.replace(/_/g, ' ');
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    currentData.forEach((row) => {
      const tr = document.createElement('tr');
      columns.forEach((col) => {
        const td = document.createElement('td');
        const val = row[col];
        td.textContent = typeof val === 'number' ? val.toLocaleString('th-TH', { maximumFractionDigits: 2 }) : (val ?? '');
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
  }

  filters.querySelector('.fmh-reload').addEventListener('click', load);
  filters.querySelector('.fmh-export').addEventListener('click', () => exportToExcel(currentData));

  load();
  return container;
}

// ---------- COGS dashboard (Menu Costing Analysis tab) ----------
// Same underlying FMH 'cogs' report as the COGS Analysis tab, but summarized
// as KPI cards + lowest-margin list + by-branch breakdown, matching the
// look of the standalone menucogs app.
function buildCogsDashboard() {
  const container = document.createElement('div');

  const filters = document.createElement('div');
  filters.className = 'filters-row';
  filters.innerHTML = `
    <input type="date" class="cd-start" />
    <input type="date" class="cd-end" />
    <button class="btn small cd-reload">โหลดข้อมูล</button>
  `;
  const today = new Date();
  const monthAgo = new Date(Date.now() - 30 * 86400000);
  filters.querySelector('.cd-end').value = today.toISOString().slice(0, 10);
  filters.querySelector('.cd-start').value = monthAgo.toISOString().slice(0, 10);
  container.appendChild(filters);

  const statusWrap = document.createElement('div');
  container.appendChild(statusWrap);

  const bodyWrap = document.createElement('div');
  container.appendChild(bodyWrap);

  function fmtCurrency(n) {
    return '฿' + Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 0 });
  }
  function marginClass(pct) {
    if (pct < 0) return 'margin-fill-danger';
    if (pct < 20) return 'margin-fill-warning';
    return 'margin-fill-success';
  }

  async function load() {
    bodyWrap.innerHTML = '';
    statusWrap.innerHTML = '<p style="color:#6b7268;">กำลังโหลดข้อมูลจาก FMH...</p>';
    const params = new URLSearchParams({
      start: filters.querySelector('.cd-start').value,
      end: filters.querySelector('.cd-end').value,
    });
    try {
      const { data } = await api(`/api/reports/cogs?${params.toString()}`);
      statusWrap.innerHTML = '';
      renderBody(data || []);
    } catch (err) {
      if (err.message && err.message.includes('FMH API key not configured')) {
        statusWrap.innerHTML =
          '<div class="error-msg">ยังไม่ได้ตั้งค่า FMH API Key — ไปที่เมนู ⚙️ ตั้งค่า → แท็บ "FMH API" ก่อนใช้งานรายงานนี้</div>';
      } else {
        statusWrap.innerHTML = `<div class="error-msg">โหลดข้อมูลไม่สำเร็จ: ${err.message}</div>`;
      }
    }
  }

  function renderBody(rows) {
    bodyWrap.innerHTML = '';
    if (!rows.length) {
      bodyWrap.innerHTML = '<p style="color:#6b7268;">ไม่พบข้อมูลตามเงื่อนไขที่เลือก</p>';
      return;
    }

    const totalSales = rows.reduce((s, r) => s + Number(r.total_sales || 0), 0);
    const totalCogs = rows.reduce((s, r) => s + Number(r.total_cost || 0), 0);
    const grossProfit = rows.reduce((s, r) => s + Number(r.gross_profit || 0), 0);
    const grossMarginPct = totalSales ? (grossProfit / totalSales) * 100 : 0;

    const kpiRow = document.createElement('div');
    kpiRow.className = 'kpi-row';
    kpiRow.innerHTML = `
      <div class="kpi-card"><div class="kpi-label">Total sales</div><div class="kpi-value">${fmtCurrency(totalSales)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Total COGS</div><div class="kpi-value">${fmtCurrency(totalCogs)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Gross profit</div><div class="kpi-value">${fmtCurrency(grossProfit)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Gross margin</div><div class="kpi-value">${grossMarginPct.toFixed(1)}%</div></div>
    `;
    bodyWrap.appendChild(kpiRow);

    const panels = document.createElement('div');
    panels.className = 'cogs-panels';

    // Lowest-margin menu items
    const byMenu = {};
    rows.forEach((r) => {
      const key = r.menu_name || r.sku || 'ไม่ระบุ';
      if (!byMenu[key]) byMenu[key] = { sales: 0, profit: 0 };
      byMenu[key].sales += Number(r.total_sales || 0);
      byMenu[key].profit += Number(r.gross_profit || 0);
    });
    const menuList = Object.entries(byMenu)
      .map(([name, v]) => ({ name, pct: v.sales ? (v.profit / v.sales) * 100 : 0 }))
      .sort((a, b) => a.pct - b.pct)
      .slice(0, 10);

    const menuPanel = document.createElement('div');
    menuPanel.className = 'panel-card';
    menuPanel.innerHTML = '<h3>Lowest-margin menu items</h3>';
    menuList.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'margin-item-row';
      const widthPct = Math.min(100, Math.max(4, Math.abs(item.pct)));
      row.innerHTML = `
        <span class="margin-name">${item.name}</span>
        <span class="margin-bar-track"><span class="margin-bar-fill ${marginClass(item.pct)}" style="width:${widthPct}%"></span></span>
        <span class="margin-pct">${item.pct.toFixed(1)}%</span>
      `;
      menuPanel.appendChild(row);
    });
    panels.appendChild(menuPanel);

    // Gross margin by branch
    const byBranch = {};
    rows.forEach((r) => {
      const key = r.branch_name || 'ไม่ระบุสาขา';
      if (!byBranch[key]) byBranch[key] = { sales: 0, profit: 0 };
      byBranch[key].sales += Number(r.total_sales || 0);
      byBranch[key].profit += Number(r.gross_profit || 0);
    });
    const branchList = Object.entries(byBranch)
      .map(([name, v]) => ({ name, pct: v.sales ? (v.profit / v.sales) * 100 : 0 }))
      .sort((a, b) => b.pct - a.pct);

    const branchPanel = document.createElement('div');
    branchPanel.className = 'panel-card';
    branchPanel.innerHTML = '<h3>Gross margin by branch</h3>';
    branchList.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'margin-item-row';
      const widthPct = Math.min(100, Math.max(4, Math.abs(item.pct)));
      row.innerHTML = `
        <span class="margin-name">${item.name}</span>
        <span class="margin-bar-track"><span class="margin-bar-fill ${marginClass(item.pct)}" style="width:${widthPct}%"></span></span>
        <span class="margin-pct">${item.pct.toFixed(1)}%</span>
      `;
      branchPanel.appendChild(row);
    });
    panels.appendChild(branchPanel);

    bodyWrap.appendChild(panels);
  }

  filters.querySelector('.cd-reload').addEventListener('click', load);
  load();
  return container;
}

// ---------- Purchase Analysis dashboard (real FMH purchase_analysis data) ----------
function buildPurchaseAnalysisDashboard() {
  const container = document.createElement('div');

  const filters = document.createElement('div');
  filters.className = 'filters-row';
  filters.innerHTML = `
    <input type="date" class="pa-start" />
    <input type="date" class="pa-end" />
    <button class="btn small pa-reload">โหลดข้อมูล</button>
  `;
  const today = new Date();
  const monthAgo = new Date(Date.now() - 30 * 86400000);
  filters.querySelector('.pa-end').value = today.toISOString().slice(0, 10);
  filters.querySelector('.pa-start').value = monthAgo.toISOString().slice(0, 10);
  container.appendChild(filters);

  const quotaWrap = document.createElement('div');
  container.appendChild(quotaWrap);

  const statusWrap = document.createElement('div');
  container.appendChild(statusWrap);

  const bodyWrap = document.createElement('div');
  container.appendChild(bodyWrap);

  function fmtCurrency(n) {
    return '฿' + Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 0 });
  }
  function fmtPct(n) {
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(1)}%`;
  }
  function barClass(v) {
    return v < 0 ? 'margin-fill-danger' : 'margin-fill-success';
  }

  async function load() {
    bodyWrap.innerHTML = '';
    statusWrap.innerHTML = '<p style="color:#6b7268;">กำลังโหลดข้อมูลจาก FMH...</p>';
    const params = new URLSearchParams({
      start: filters.querySelector('.pa-start').value,
      end: filters.querySelector('.pa-end').value,
    });
    try {
      const { data, meta } = await api(`/api/reports/purchase-analysis?${params.toString()}`);
      statusWrap.innerHTML = '';
      renderFmhQuota(quotaWrap, meta && meta.quota);
      renderBody(data || []);
    } catch (err) {
      if (err.message && err.message.includes('FMH API key not configured')) {
        statusWrap.innerHTML =
          '<div class="error-msg">ยังไม่ได้ตั้งค่า FMH API Key — ไปที่เมนู ⚙️ ตั้งค่า → แท็บ "FMH API" ก่อนใช้งานรายงานนี้</div>';
      } else {
        statusWrap.innerHTML = `<div class="error-msg">โหลดข้อมูลไม่สำเร็จ: ${err.message}</div>`;
      }
    }
  }

  let chartInstance = null;

  function renderBody(rows) {
    bodyWrap.innerHTML = '';
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    if (!rows.length) {
      bodyWrap.innerHTML = '<p style="color:#6b7268;">ไม่พบข้อมูลตามเงื่อนไขที่เลือก</p>';
      return;
    }

    const totalPO = rows.reduce((s, r) => s + Number(r.po_total || 0), 0);
    const totalGRN = rows.reduce((s, r) => s + Number(r.grn_total || 0), 0);
    const totalInvoice = rows.reduce((s, r) => s + Number(r.invoice_total || 0), 0);
    const grnVsPoPct = totalPO ? ((totalGRN - totalPO) / totalPO) * 100 : 0;
    const invVsGrnPct = totalGRN ? ((totalInvoice - totalGRN) / totalGRN) * 100 : 0;

    const kpiRow = document.createElement('div');
    kpiRow.className = 'kpi-row';
    kpiRow.innerHTML = `
      <div class="kpi-card"><div class="kpi-label">Total PO value</div><div class="kpi-value">${fmtCurrency(totalPO)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Total GRN value</div><div class="kpi-value">${fmtCurrency(totalGRN)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Total Invoice value</div><div class="kpi-value">${fmtCurrency(totalInvoice)}</div></div>
      <div class="kpi-card"><div class="kpi-label">GRN vs PO</div><div class="kpi-value">${fmtPct(grnVsPoPct)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Invoice vs GRN</div><div class="kpi-value">${fmtPct(invVsGrnPct)}</div></div>
    `;
    bodyWrap.appendChild(kpiRow);

    // ---- PO vs GRN vs Invoice over time (weekly buckets) ----
    const byWeek = {};
    rows.forEach((r) => {
      const dateStr = r.order_date || r.issued_date || r.grn_date || r.invoice_date;
      if (!dateStr) return;
      const d = new Date(dateStr);
      if (isNaN(d)) return;
      // bucket to the Monday of that week
      const day = d.getDay();
      const diff = (day === 0 ? -6 : 1) - day;
      const monday = new Date(d);
      monday.setDate(d.getDate() + diff);
      const key = monday.toISOString().slice(0, 10);
      if (!byWeek[key]) byWeek[key] = { po: 0, grn: 0, inv: 0 };
      byWeek[key].po += Number(r.po_total || 0);
      byWeek[key].grn += Number(r.grn_total || 0);
      byWeek[key].inv += Number(r.invoice_total || 0);
    });
    const weekKeys = Object.keys(byWeek).sort();

    const chartCard = document.createElement('div');
    chartCard.className = 'chart-card';
    chartCard.innerHTML = '<h3>PO vs GRN vs Invoice value over time</h3><div class="chart-wrap"><canvas></canvas></div>';
    bodyWrap.appendChild(chartCard);

    if (weekKeys.length && window.Chart) {
      const canvas = chartCard.querySelector('canvas');
      chartInstance = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: weekKeys.map((k) => new Date(k).toLocaleDateString('th-TH', { day: '2-digit', month: 'short' })),
          datasets: [
            { label: 'PO', data: weekKeys.map((k) => byWeek[k].po), borderColor: '#A9812F', backgroundColor: '#A9812F', tension: 0.25 },
            { label: 'GRN', data: weekKeys.map((k) => byWeek[k].grn), borderColor: '#1B2B22', backgroundColor: '#1B2B22', tension: 0.25 },
            { label: 'Invoice', data: weekKeys.map((k) => byWeek[k].inv), borderColor: '#BE4229', backgroundColor: '#BE4229', tension: 0.25 },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: 'top' } },
          scales: {
            y: { ticks: { callback: (v) => fmtCurrency(v) } },
          },
        },
      });
    } else if (!weekKeys.length) {
      chartCard.querySelector('.chart-wrap').innerHTML = '<p style="color:#6b7268;">ไม่มีวันที่ในข้อมูลสำหรับสร้างกราฟ</p>';
    }

    const panels = document.createElement('div');
    panels.className = 'panels-3col';

    // ---- Top products needing attention (largest GRN-vs-PO value gap) ----
    const byProduct = {};
    rows.forEach((r) => {
      const key = r.product_name || r.product_code || 'ไม่ระบุสินค้า';
      if (!byProduct[key]) byProduct[key] = { po: 0, grn: 0, inv: 0 };
      byProduct[key].po += Number(r.po_total || 0);
      byProduct[key].grn += Number(r.grn_total || 0);
      byProduct[key].inv += Number(r.invoice_total || 0);
    });
    const productList = Object.entries(byProduct)
      .map(([name, v]) => ({
        name,
        po: v.po,
        variance: v.grn - v.po,
        variancePct: v.po ? ((v.grn - v.po) / v.po) * 100 : 0,
      }))
      .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))
      .slice(0, 10);

    const attentionPanel = document.createElement('div');
    attentionPanel.className = 'panel-card';
    attentionPanel.innerHTML = '<h3>Top products needing attention</h3>';
    if (!productList.length) {
      attentionPanel.innerHTML += '<p style="color:#6b7268;font-size:13px;">ไม่มีข้อมูล</p>';
    }
    productList.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'margin-item-row';
      const widthPct = Math.min(100, Math.max(4, Math.abs(item.variancePct)));
      const tag = Math.abs(item.variancePct) > 15 ? '<span class="attention-tag">ส่วนต่างสูง</span>' : '';
      row.innerHTML = `
        <span class="margin-name">${item.name}${tag}</span>
        <span class="margin-bar-track"><span class="margin-bar-fill ${barClass(item.variancePct)}" style="width:${widthPct}%"></span></span>
        <span class="margin-pct">${fmtPct(item.variancePct)}</span>
      `;
      attentionPanel.appendChild(row);
    });
    panels.appendChild(attentionPanel);

    // ---- Top suppliers by PO spend ----
    const bySupplier = {};
    rows.forEach((r) => {
      const key = r.supplier || 'ไม่ระบุซัพพลายเออร์';
      bySupplier[key] = (bySupplier[key] || 0) + Number(r.po_total || 0);
    });
    const supplierList = Object.entries(bySupplier)
      .map(([name, po]) => ({ name, po }))
      .sort((a, b) => b.po - a.po)
      .slice(0, 10);
    const maxSupplierPO = Math.max(1, ...supplierList.map((s) => s.po));

    const supplierPanel = document.createElement('div');
    supplierPanel.className = 'panel-card';
    supplierPanel.innerHTML = '<h3>Top suppliers by PO spend</h3>';
    supplierList.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'margin-item-row';
      const widthPct = Math.min(100, Math.max(4, (item.po / maxSupplierPO) * 100));
      row.innerHTML = `
        <span class="margin-name">${item.name}</span>
        <span class="margin-bar-track"><span class="margin-bar-fill margin-fill-success" style="width:${widthPct}%"></span></span>
        <span class="margin-pct">${fmtCurrency(item.po)}</span>
      `;
      supplierPanel.appendChild(row);
    });
    panels.appendChild(supplierPanel);

    // ---- PO / GRN value by category — variance highlighted ----
    const byCategory = {};
    rows.forEach((r) => {
      const key = r.category_name || 'ไม่ระบุหมวดหมู่';
      if (!byCategory[key]) byCategory[key] = { po: 0, grn: 0 };
      byCategory[key].po += Number(r.po_total || 0);
      byCategory[key].grn += Number(r.grn_total || 0);
    });
    const categoryList = Object.entries(byCategory)
      .map(([name, v]) => ({ name, po: v.po, variancePct: v.po ? ((v.grn - v.po) / v.po) * 100 : 0 }))
      .sort((a, b) => b.po - a.po)
      .slice(0, 10);

    const categoryPanel = document.createElement('div');
    categoryPanel.className = 'panel-card';
    categoryPanel.innerHTML = '<h3>GRN vs PO variance by category</h3>';
    categoryList.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'margin-item-row';
      const widthPct = Math.min(100, Math.max(4, Math.abs(item.variancePct)));
      row.innerHTML = `
        <span class="margin-name">${item.name}</span>
        <span class="margin-bar-track"><span class="margin-bar-fill ${barClass(item.variancePct)}" style="width:${widthPct}%"></span></span>
        <span class="margin-pct">${fmtPct(item.variancePct)}</span>
      `;
      categoryPanel.appendChild(row);
    });
    panels.appendChild(categoryPanel);

    bodyWrap.appendChild(panels);
  }

  filters.querySelector('.pa-reload').addEventListener('click', load);
  load();
  return container;
}

// ---------- Menu Costing Analysis: ingredient cost impact & price sensitivity ----------
function buildMenuIngredientImpactDashboard() {
  const container = document.createElement('div');

  const filters = document.createElement('div');
  filters.className = 'filters-row';
  filters.innerHTML = `<button class="btn small mi-reload">โหลดข้อมูล</button>`;
  container.appendChild(filters);

  const quotaWrap = document.createElement('div');
  container.appendChild(quotaWrap);

  const statusWrap = document.createElement('div');
  container.appendChild(statusWrap);

  const bodyWrap = document.createElement('div');
  container.appendChild(bodyWrap);

  function fmtCurrency(n) {
    return '฿' + Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 0 });
  }

  let chartInstance = null;
  let topIngredients = []; // filled by renderBody, reused by the sensitivity simulator

  async function load() {
    bodyWrap.innerHTML = '';
    statusWrap.innerHTML = '<p style="color:#6b7268;">กำลังโหลดข้อมูลจาก FMH...</p>';
    try {
      const { data, meta } = await api('/api/reports/menu-costing');
      statusWrap.innerHTML = '';
      renderFmhQuota(quotaWrap, meta && meta.quota);
      renderBody(data || []);
    } catch (err) {
      if (err.message && err.message.includes('FMH API key not configured')) {
        statusWrap.innerHTML =
          '<div class="error-msg">ยังไม่ได้ตั้งค่า FMH API Key — ไปที่เมนู ⚙️ ตั้งค่า → แท็บ "FMH API" ก่อนใช้งานรายงานนี้</div>';
      } else {
        statusWrap.innerHTML = `<div class="error-msg">โหลดข้อมูลไม่สำเร็จ: ${err.message}</div>`;
      }
    }
  }

  function renderBody(rows) {
    bodyWrap.innerHTML = '';
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    if (!rows.length) {
      bodyWrap.innerHTML = '<p style="color:#6b7268;">ไม่พบข้อมูล</p>';
      return;
    }

    // Pass 1: total recipe cost per menu (so we can express each ingredient's
    // share of that menu's cost).
    const menuTotalCost = {};
    rows.forEach((r) => {
      const menuKey = r.menu_name || r.menu_code || 'ไม่ระบุเมนู';
      menuTotalCost[menuKey] = (menuTotalCost[menuKey] || 0) + Number(r.total_cost || 0);
    });

    // Pass 2: per-ingredient totals, how many menus it appears in, and its
    // cost share within each of those menus.
    const byIngredient = {};
    rows.forEach((r) => {
      const menuKey = r.menu_name || r.menu_code || 'ไม่ระบุเมนู';
      const ingKey = r.ingredient_name || r.ingredient_code || 'ไม่ระบุวัตถุดิบ';
      const cost = Number(r.total_cost || 0);
      if (!byIngredient[ingKey]) byIngredient[ingKey] = { totalCost: 0, menus: new Set(), shares: [] };
      byIngredient[ingKey].totalCost += cost;
      byIngredient[ingKey].menus.add(menuKey);
      const menuTotal = menuTotalCost[menuKey];
      if (menuTotal) byIngredient[ingKey].shares.push(cost / menuTotal);
    });

    const totalRecipeCost = Object.values(menuTotalCost).reduce((s, v) => s + v, 0);
    const menuCount = Object.keys(menuTotalCost).length;
    const ingredientCount = Object.keys(byIngredient).length;
    const avgIngredientsPerMenu = menuCount ? (rows.length / menuCount) : 0;

    const kpiRow = document.createElement('div');
    kpiRow.className = 'kpi-row';
    kpiRow.innerHTML = `
      <div class="kpi-card"><div class="kpi-label">Total recipe cost</div><div class="kpi-value">${fmtCurrency(totalRecipeCost)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Menus</div><div class="kpi-value">${menuCount}</div></div>
      <div class="kpi-card"><div class="kpi-label">Distinct ingredients</div><div class="kpi-value">${ingredientCount}</div></div>
      <div class="kpi-card"><div class="kpi-label">Avg ingredients / menu</div><div class="kpi-value">${avgIngredientsPerMenu.toFixed(1)}</div></div>
    `;
    bodyWrap.appendChild(kpiRow);

    topIngredients = Object.entries(byIngredient)
      .map(([name, v]) => ({
        name,
        totalCost: v.totalCost,
        menuCount: v.menus.size,
        avgSharePct: v.shares.length ? (v.shares.reduce((s, x) => s + x, 0) / v.shares.length) * 100 : 0,
      }))
      .sort((a, b) => b.totalCost - a.totalCost)
      .slice(0, 12);

    // ---- Chart: top ingredients by total cost impact ----
    const chartCard = document.createElement('div');
    chartCard.className = 'chart-card';
    chartCard.innerHTML = '<h3>Top ingredients by cost impact (across all menus)</h3><div class="chart-wrap"><canvas></canvas></div>';
    bodyWrap.appendChild(chartCard);

    if (window.Chart) {
      const canvas = chartCard.querySelector('canvas');
      chartInstance = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels: topIngredients.map((i) => `${i.name} (${i.menuCount} เมนู)`),
          datasets: [{
            label: 'Total cost impact',
            data: topIngredients.map((i) => i.totalCost),
            backgroundColor: '#BE4229',
          }],
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { callback: (v) => fmtCurrency(v) } },
          },
        },
      });
    }

    // ---- Price sensitivity simulator ----
    const sensitivityCard = document.createElement('div');
    sensitivityCard.className = 'panel-card';
    sensitivityCard.style.marginTop = '16px';
    sensitivityCard.innerHTML = `
      <h3>Ingredient price sensitivity</h3>
      <p class="helper-text" style="margin-top:-4px;">
        ถ้าราคาวัตถุดิบ (X) ขยับ ต้นทุนเมนูที่ใช้วัตถุดิบนั้นจะขยับตาม % ที่วัตถุดิบนั้นคิดเป็นสัดส่วนของต้นทุนเมนู (Y ≈ สัดส่วน × X)
      </p>
      <div class="field" style="max-width:260px;">
        <label for="mi-pct-input">ราคาวัตถุดิบเปลี่ยน (X%)</label>
        <input id="mi-pct-input" type="number" value="10" step="1">
      </div>
      <div id="mi-sensitivity-list"></div>
    `;
    bodyWrap.appendChild(sensitivityCard);

    const listEl = sensitivityCard.querySelector('#mi-sensitivity-list');
    const pctInput = sensitivityCard.querySelector('#mi-pct-input');

    function renderSensitivityList() {
      const x = Number(pctInput.value) || 0;
      const bySensitivity = [...topIngredients].sort((a, b) => b.avgSharePct - a.avgSharePct).slice(0, 10);
      const maxShare = Math.max(1, ...bySensitivity.map((i) => i.avgSharePct));
      listEl.innerHTML = '';
      bySensitivity.forEach((item) => {
        const y = (item.avgSharePct / 100) * x;
        const row = document.createElement('div');
        row.className = 'margin-item-row';
        const widthPct = Math.min(100, Math.max(4, (item.avgSharePct / maxShare) * 100));
        row.innerHTML = `
          <span class="margin-name">${item.name} <span style="color:#6b7268;font-weight:400;">(${item.menuCount} เมนู)</span></span>
          <span class="margin-bar-track"><span class="margin-bar-fill margin-fill-warning" style="width:${widthPct}%"></span></span>
          <span class="margin-pct">${x >= 0 ? '+' : ''}${y.toFixed(1)}%</span>
        `;
        listEl.appendChild(row);
      });
    }
    pctInput.addEventListener('input', renderSensitivityList);
    renderSensitivityList();

    // ---- Menu view: cost breakdown & sensitivity for one menu at a time ----
    const byMenu = {};
    rows.forEach((r) => {
      const menuKey = r.menu_name || r.menu_code || 'ไม่ระบุเมนู';
      const ingKey = r.ingredient_name || r.ingredient_code || 'ไม่ระบุวัตถุดิบ';
      const cost = Number(r.total_cost || 0);
      if (!byMenu[menuKey]) byMenu[menuKey] = { totalCost: 0, ingredients: {} };
      byMenu[menuKey].totalCost += cost;
      byMenu[menuKey].ingredients[ingKey] = (byMenu[menuKey].ingredients[ingKey] || 0) + cost;
    });
    const menuList = Object.entries(byMenu)
      .map(([name, v]) => ({ name, totalCost: v.totalCost, ingredients: v.ingredients }))
      .sort((a, b) => b.totalCost - a.totalCost);

    const menuViewCard = document.createElement('div');
    menuViewCard.className = 'panel-card';
    menuViewCard.style.marginTop = '16px';
    menuViewCard.innerHTML = `
      <h3>มุมมองรายเมนู — วัตถุดิบไหนคุมต้นทุนเมนูนี้</h3>
      <p class="helper-text" style="margin-top:-4px;">
        เลือกเมนู เพื่อดูว่าวัตถุดิบตัวไหนเป็นสัดส่วนต้นทุนมากที่สุดของเมนูนั้น และถ้าราคาวัตถุดิบตัวนั้นขยับ X% ต้นทุนเมนูนี้จะขยับเท่าไหร่
      </p>
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end;margin-bottom:4px;">
        <div class="field" style="max-width:320px;flex:1;min-width:220px;">
          <label for="mi-menu-select">เลือกเมนู (เรียงตามต้นทุนรวมมากไปน้อย)</label>
          <select id="mi-menu-select"></select>
        </div>
        <div class="field" style="max-width:180px;">
          <label for="mi-menu-pct-input">วัตถุดิบเปลี่ยนราคา (X%)</label>
          <input id="mi-menu-pct-input" type="number" value="10" step="1">
        </div>
      </div>
      <div id="mi-menu-summary" style="margin:6px 0 14px;font-size:13px;color:#6b7268;"></div>
      <div id="mi-menu-ingredient-list"></div>
    `;
    bodyWrap.appendChild(menuViewCard);

    const menuSelect = menuViewCard.querySelector('#mi-menu-select');
    const menuPctInput = menuViewCard.querySelector('#mi-menu-pct-input');
    const menuSummaryEl = menuViewCard.querySelector('#mi-menu-summary');
    const menuIngListEl = menuViewCard.querySelector('#mi-menu-ingredient-list');

    menuList.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = `${m.name} — ${fmtCurrency(m.totalCost)}`;
      menuSelect.appendChild(opt);
    });

    function renderMenuView() {
      const selected = menuList.find((m) => m.name === menuSelect.value) || menuList[0];
      if (!selected) {
        menuSummaryEl.textContent = 'ไม่มีข้อมูลเมนู';
        menuIngListEl.innerHTML = '';
        return;
      }
      const x = Number(menuPctInput.value) || 0;
      const ingCount = Object.keys(selected.ingredients).length;
      menuSummaryEl.textContent = `ต้นทุนรวมเมนูนี้: ${fmtCurrency(selected.totalCost)} · ใช้วัตถุดิบทั้งหมด ${ingCount} รายการ`;

      const ingList = Object.entries(selected.ingredients)
        .map(([name, cost]) => ({
          name,
          cost,
          sharePct: selected.totalCost ? (cost / selected.totalCost) * 100 : 0,
        }))
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 10);
      const maxCost = Math.max(1, ...ingList.map((i) => i.cost));

      menuIngListEl.innerHTML = '';
      ingList.forEach((item) => {
        const y = (item.sharePct / 100) * x;
        const row = document.createElement('div');
        row.className = 'margin-item-row';
        const widthPct = Math.min(100, Math.max(4, (item.cost / maxCost) * 100));
        row.innerHTML = `
          <span class="margin-name">${item.name} <span style="color:#6b7268;font-weight:400;">(${item.sharePct.toFixed(1)}% ของต้นทุนเมนู)</span></span>
          <span class="margin-bar-track"><span class="margin-bar-fill margin-fill-warning" style="width:${widthPct}%"></span></span>
          <span class="margin-pct">${x >= 0 ? '+' : ''}${y.toFixed(1)}%</span>
        `;
        menuIngListEl.appendChild(row);
      });
    }
    menuSelect.addEventListener('change', renderMenuView);
    menuPctInput.addEventListener('input', renderMenuView);
    if (menuList.length) renderMenuView();
  }

  filters.querySelector('.mi-reload').addEventListener('click', load);
  load();
  return container;
}

function exportToExcel(data) {
  if (!data.length) return;
  const headers = Object.keys(data[0]);
  const csvRows = [headers.join(',')].concat(
    data.map((row) => headers.map((h) => `"${String(row[h]).replace(/"/g, '""')}"`).join(','))
  );
  const blob = new Blob(['﻿' + csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'price-change-report.csv';
  link.click();
}

// ---------- Change password modal ----------
el('open-password-btn').addEventListener('click', () => el('password-modal').classList.remove('hidden'));
el('close-password-btn').addEventListener('click', () => el('password-modal').classList.add('hidden'));
el('password-modal-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  el('password-modal-error').classList.add('hidden');
  try {
    await api('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({
        current_password: el('current-password').value,
        new_password: el('new-password').value,
      }),
    });
    el('password-modal').classList.add('hidden');
    el('password-modal-form').reset();
  } catch (err) {
    el('password-modal-error').textContent = err.message;
    el('password-modal-error').classList.remove('hidden');
  }
});

// ---------- Settings modal (admin) — FMH API key only ----------
el('open-settings-btn').addEventListener('click', async () => {
  el('settings-modal').classList.remove('hidden');
  await loadFmhKeyStatus();
});
el('close-settings-btn').addEventListener('click', () => el('settings-modal').classList.add('hidden'));

// ---------- Manage Users modal (admin) — separate menu from Settings ----------
el('open-manage-users-btn').addEventListener('click', async () => {
  el('manage-users-modal').classList.remove('hidden');
  await loadUserList();
});
el('close-manage-users-btn').addEventListener('click', () => el('manage-users-modal').classList.add('hidden'));

// ---------- Settings modal: FMH API key ----------
async function loadFmhKeyStatus() {
  const statusEl = el('fmh-status');
  statusEl.textContent = 'กำลังโหลดสถานะ...';
  try {
    const { configured, updated_at } = await api('/api/settings/fmh-key');
    statusEl.textContent = configured
      ? `ตั้งค่าแล้ว (อัปเดตล่าสุด: ${new Date(updated_at).toLocaleString('th-TH')})`
      : 'ยังไม่ได้ตั้งค่า FMH API Key';
  } catch (err) {
    statusEl.textContent = `โหลดสถานะไม่สำเร็จ: ${err.message}`;
  }
}

el('fmh-key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  el('fmh-key-error').classList.add('hidden');
  el('fmh-key-success').classList.add('hidden');
  try {
    const { message } = await api('/api/settings/fmh-key', {
      method: 'POST',
      body: JSON.stringify({ api_key: el('fmh-api-key').value.trim() }),
    });
    el('fmh-key-form').reset();
    el('fmh-key-success').textContent = message;
    el('fmh-key-success').classList.remove('hidden');
    await loadFmhKeyStatus();
  } catch (err) {
    el('fmh-key-error').textContent = err.message;
    el('fmh-key-error').classList.remove('hidden');
  }
});

async function loadUserList() {
  const [{ users }, { dashboards: allDashboards }] = await Promise.all([
    api('/api/users'),
    api('/api/dashboards/admin/all'),
  ]);
  const listEl = el('user-list');
  listEl.innerHTML = '';
  const isSelf = (u) => state.user && u.id === state.user.id;

  users.forEach((u) => {
    const wrap = document.createElement('div');
    wrap.className = 'user-row-wrap';

    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `
      <div>
        <div><strong>${u.display_name}</strong> <span class="badge ${u.role === 'admin' ? 'up' : 'down'}">${u.role}</span></div>
        <div class="meta">${u.email}${u.must_change_password ? ' · รอเปลี่ยนรหัสผ่านครั้งแรก' : ''}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <select class="user-role-select" data-id="${u.id}" ${isSelf(u) ? 'disabled title="เปลี่ยนสิทธิ์ตัวเองไม่ได้"' : ''}>
          <option value="client" ${u.role === 'client' ? 'selected' : ''}>Client</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
        </select>
        <button class="btn small ghost user-tabs-toggle" data-id="${u.id}">Dashboard ▾</button>
        <button class="btn small danger" data-id="${u.id}" ${isSelf(u) ? 'disabled title="ลบตัวเองไม่ได้"' : ''}>ลบ</button>
      </div>
    `;
    row.querySelector('.user-role-select').addEventListener('change', async (e) => {
      const newRole = e.target.value;
      try {
        await api(`/api/users/${u.id}/role`, {
          method: 'PATCH',
          body: JSON.stringify({ role: newRole }),
        });
        loadUserList();
      } catch (err) {
        alert(`เปลี่ยนสิทธิ์ไม่สำเร็จ: ${err.message}`);
        e.target.value = u.role;
      }
    });
    row.querySelector('button.danger').addEventListener('click', async () => {
      if (!confirm(`ลบผู้ใช้งาน ${u.email}?`)) return;
      await api(`/api/users/${u.id}`, { method: 'DELETE' });
      loadUserList();
    });

    // ---- Per-user dashboard (tab) access ----
    const tabsPanel = document.createElement('div');
    tabsPanel.className = 'user-tabs-panel hidden';

    if (u.role === 'admin') {
      tabsPanel.innerHTML = '<p class="helper-text" style="margin:8px 0 0;">Admin เห็นทุกแท็บเสมอ ไม่ต้องกำหนด</p>';
    } else if (!allDashboards.length) {
      tabsPanel.innerHTML = '<p class="helper-text" style="margin:8px 0 0;">ยังไม่มี dashboard ในระบบ</p>';
    } else {
      const checklistWrap = document.createElement('div');
      checklistWrap.className = 'user-tabs-checklist';
      allDashboards.forEach((d) => {
        const label = document.createElement('label');
        label.className = 'user-tab-checkbox';
        label.innerHTML = `<input type="checkbox" value="${d.id}"> ${d.display_name}${d.active ? '' : ' (ปิดใช้งาน)'}`;
        checklistWrap.appendChild(label);
      });
      tabsPanel.appendChild(checklistWrap);

      const saveRow = document.createElement('div');
      saveRow.className = 'user-tabs-save-row';
      saveRow.innerHTML = `
        <span class="user-tabs-dirty-note hidden">มีการเปลี่ยนแปลงที่ยังไม่บันทึก</span>
        <button type="button" class="btn small primary user-tabs-save" disabled>บันทึก</button>
      `;
      tabsPanel.appendChild(saveRow);

      const dirtyNote = saveRow.querySelector('.user-tabs-dirty-note');
      const saveBtn = saveRow.querySelector('.user-tabs-save');

      checklistWrap.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.addEventListener('change', () => {
          dirtyNote.classList.remove('hidden');
          saveBtn.disabled = false;
        });
      });

      saveBtn.addEventListener('click', async () => {
        const checkedIds = Array.from(checklistWrap.querySelectorAll('input[type="checkbox"]:checked')).map((c) =>
          Number(c.value)
        );
        saveBtn.disabled = true;
        saveBtn.textContent = 'กำลังบันทึก...';
        try {
          await api(`/api/users/${u.id}/dashboard-access`, {
            method: 'PUT',
            body: JSON.stringify({ dashboard_ids: checkedIds }),
          });
          dirtyNote.classList.add('hidden');
          saveBtn.textContent = 'บันทึกแล้ว ✓';
          setTimeout(() => {
            saveBtn.textContent = 'บันทึก';
          }, 1500);
        } catch (err) {
          alert(`บันทึกไม่สำเร็จ: ${err.message}`);
          saveBtn.disabled = false;
          saveBtn.textContent = 'บันทึก';
        }
      });
    }

    let loadedAccess = false;
    row.querySelector('.user-tabs-toggle').addEventListener('click', async () => {
      const willShow = tabsPanel.classList.contains('hidden');
      tabsPanel.classList.toggle('hidden');
      if (willShow && u.role !== 'admin' && !loadedAccess) {
        loadedAccess = true;
        const { dashboard_ids } = await api(`/api/users/${u.id}/dashboard-access`);
        tabsPanel.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
          cb.checked = dashboard_ids.includes(Number(cb.value));
        });
      }
    });

    wrap.appendChild(row);
    wrap.appendChild(tabsPanel);
    listEl.appendChild(wrap);
  });
}

el('add-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  el('add-user-error').classList.add('hidden');
  try {
    await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        display_name: el('new-user-name').value.trim(),
        email: el('new-user-email').value.trim(),
        temp_password: el('new-user-password').value,
        role: el('new-user-role').value,
      }),
    });
    el('add-user-form').reset();
    loadUserList();
  } catch (err) {
    el('add-user-error').textContent = err.message;
    el('add-user-error').classList.remove('hidden');
  }
});

boot();
