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
      const { data } = await api(`${config.path}?${params.toString()}`);
      currentData = data;
      statusWrap.innerHTML = '';
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

// ---------- Settings modal (admin) ----------
el('open-settings-btn').addEventListener('click', async () => {
  el('settings-modal').classList.remove('hidden');
  await loadUserList();
});
el('close-settings-btn').addEventListener('click', () => el('settings-modal').classList.add('hidden'));

// ---------- Settings modal: tab switching ----------
document.querySelectorAll('.modal-tabs button[data-panel]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.modal-tabs button[data-panel]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    el('settings-users-panel').classList.toggle('hidden', btn.dataset.panel !== 'users');
    el('settings-fmh-panel').classList.toggle('hidden', btn.dataset.panel !== 'fmh');
    if (btn.dataset.panel === 'fmh') await loadFmhKeyStatus();
  });
});

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
  const { users } = await api('/api/users');
  const listEl = el('user-list');
  listEl.innerHTML = '';
  users.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `
      <div>
        <div><strong>${u.display_name}</strong> <span class="badge ${u.role === 'admin' ? 'up' : 'down'}">${u.role}</span></div>
        <div class="meta">${u.email}${u.must_change_password ? ' · รอเปลี่ยนรหัสผ่านครั้งแรก' : ''}</div>
      </div>
      <button class="btn small danger" data-id="${u.id}">ลบ</button>
    `;
    row.querySelector('button').addEventListener('click', async () => {
      if (!confirm(`ลบผู้ใช้งาน ${u.email}?`)) return;
      await api(`/api/users/${u.id}`, { method: 'DELETE' });
      loadUserList();
    });
    listEl.appendChild(row);
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
