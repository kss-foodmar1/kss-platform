// KSS Internal Admin Console (kss_superadmin only), plus two components that
// are shared with a client's own company_admin:
//   renderFmhKeyPanel  — enter/remove a company's FMH API key
//   renderUserManager  — users, roles, passwords, per-user dashboard access
// Relies on helpers from app.js (el, api, esc, state, isSuper, ...).

// ---------- shared: FMH key panel ----------
async function renderFmhKeyPanel(container, companyId, onSaved) {
  const qs = isSuper() ? `?company_id=${companyId}` : '';
  container.innerHTML = '<p class="muted">กำลังโหลด...</p>';
  const { configured, updated_at } = await api(`/api/settings/fmh-key${qs}`);
  container.innerHTML = `
    <p class="status-line">${
      configured
        ? `<span class="dot dot-good" aria-hidden="true"></span> เชื่อมต่อแล้ว · อัปเดตล่าสุด ${esc(fmtDateTime(updated_at))}`
        : '<span class="dot dot-off" aria-hidden="true"></span> ยังไม่ได้ตั้งค่า FMH API Key'
    }</p>
    <div class="form-msg"></div>
    <form class="inline-form">
      <input type="password" class="fmh-key-input" placeholder="${configured ? 'ใส่ Key ใหม่เพื่อเปลี่ยน' : 'fmh_rpt_...'}" autocomplete="off" aria-label="FMH API Key">
      <button type="submit" class="btn small primary">บันทึก Key</button>
      ${configured ? '<button type="button" class="btn small danger fmh-remove">ลบ Key</button>' : ''}
    </form>`;
  const msg = container.querySelector('.form-msg');
  container.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { message } = await api(`/api/settings/fmh-key${qs}`, {
        method: 'POST',
        body: JSON.stringify({ api_key: container.querySelector('.fmh-key-input').value.trim() }),
      });
      await renderFmhKeyPanel(container, companyId, onSaved);
      container.querySelector('.form-msg').innerHTML = `<div class="ok-msg">${esc(message)}</div>`;
      if (onSaved) onSaved();
    } catch (err) {
      msg.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    }
  });
  const remove = container.querySelector('.fmh-remove');
  if (remove) {
    remove.addEventListener('click', async () => {
      if (!confirm('ลบ FMH API Key ของบริษัทนี้? ข้อมูลที่ sync ไว้แล้วยังอยู่ แต่จะไม่อัปเดตอีก')) return;
      await api(`/api/settings/fmh-key${qs}`, { method: 'DELETE' });
      await renderFmhKeyPanel(container, companyId, onSaved);
      if (onSaved) onSaved();
    });
  }
}

// ---------- shared: user manager ----------
// scope: { companyId } for a company's users, or { kss: true } for KSS staff.
async function renderUserManager(container, scope) {
  const qs = scope.kss ? '?company_id=kss' : isSuper() ? `?company_id=${scope.companyId}` : '';
  container.innerHTML = '<p class="muted">กำลังโหลด...</p>';
  const [{ users }, dashboards] = await Promise.all([
    api(`/api/users${qs}`),
    scope.kss
      ? Promise.resolve([])
      : isSuper()
        ? api(`/api/admin/companies/${scope.companyId}/dashboards`).then((r) => r.dashboards)
        : api('/api/dashboards').then((r) => r.dashboards),
  ]);
  const roleLabel = { kss_superadmin: 'KSS', company_admin: 'Admin บริษัท', client: 'ผู้ใช้งาน' };

  container.innerHTML = `
    <div class="user-list"></div>
    <details class="add-user">
      <summary class="btn small ghost">+ เพิ่มผู้ใช้งาน</summary>
      <form class="add-user-form">
        <div class="form-msg"></div>
        <div class="grid-2">
          <div class="field"><label>ชื่อที่แสดง</label><input name="display_name" required></div>
          <div class="field"><label>อีเมล</label><input name="email" type="email" required></div>
          <div class="field"><label>รหัสผ่านชั่วคราว (≥ 8 ตัว)</label><input name="temp_password" type="text" required minlength="8"></div>
          ${
            scope.kss
              ? ''
              : `<div class="field"><label>สิทธิ์</label><select name="role"><option value="client">ผู้ใช้งาน (ดูอย่างเดียว)</option><option value="company_admin">Admin บริษัท</option></select></div>`
          }
        </div>
        <button type="submit" class="btn small primary">เพิ่มผู้ใช้งาน</button>
        <p class="helper-text" style="margin:8px 0 0;">ผู้ใช้ใหม่ต้องเปลี่ยนรหัสผ่านตอนเข้าระบบครั้งแรก</p>
      </form>
    </details>`;

  const list = container.querySelector('.user-list');
  if (!users.length) list.innerHTML = '<p class="muted">ยังไม่มีผู้ใช้งาน</p>';
  users.forEach((u) => {
    const self = state.user && u.id === state.user.id;
    const wrap = document.createElement('div');
    wrap.className = 'user-row-wrap';
    wrap.innerHTML = `
      <div class="user-row">
        <div>
          <div><strong>${esc(u.display_name)}</strong> <span class="pill">${esc(roleLabel[u.role] || u.role)}</span></div>
          <div class="meta">${esc(u.email)}${u.must_change_password ? ' · รอเปลี่ยนรหัสผ่านครั้งแรก' : ''}</div>
        </div>
        <div class="user-actions">
          ${
            scope.kss
              ? ''
              : `<select class="user-role-select" aria-label="สิทธิ์ของ ${esc(u.display_name)}" ${self ? 'disabled' : ''}>
                   <option value="client" ${u.role === 'client' ? 'selected' : ''}>ผู้ใช้งาน</option>
                   <option value="company_admin" ${u.role === 'company_admin' ? 'selected' : ''}>Admin บริษัท</option>
                 </select>
                 <button type="button" class="btn small ghost toggle-access">Dashboard ▾</button>`
          }
          <button type="button" class="btn small ghost toggle-reset">รีเซ็ตรหัส</button>
          <button type="button" class="btn small danger delete-user" ${self ? 'disabled' : ''}>ลบ</button>
        </div>
      </div>
      <form class="user-subpanel reset-panel hidden">
        <input type="text" minlength="8" required placeholder="รหัสผ่านชั่วคราวใหม่ (≥ 8 ตัว)" aria-label="รหัสผ่านชั่วคราวใหม่">
        <button type="submit" class="btn small primary">ตั้งรหัสใหม่</button>
        <span class="inline-note"></span>
      </form>
      <div class="user-subpanel access-panel hidden"></div>`;
    list.appendChild(wrap);

    const roleSelect = wrap.querySelector('.user-role-select');
    if (roleSelect) {
      roleSelect.addEventListener('change', async () => {
        try {
          await api(`/api/users/${u.id}/role${qs}`, { method: 'PATCH', body: JSON.stringify({ role: roleSelect.value }) });
          renderUserManager(container, scope);
        } catch (err) {
          alert(`เปลี่ยนสิทธิ์ไม่สำเร็จ: ${err.message}`);
          roleSelect.value = u.role;
        }
      });
    }

    const resetPanel = wrap.querySelector('.reset-panel');
    wrap.querySelector('.toggle-reset').addEventListener('click', () => resetPanel.classList.toggle('hidden'));
    resetPanel.addEventListener('submit', async (e) => {
      e.preventDefault();
      const note = resetPanel.querySelector('.inline-note');
      try {
        await api(`/api/users/${u.id}/reset-password${qs}`, {
          method: 'POST',
          body: JSON.stringify({ temp_password: resetPanel.querySelector('input').value }),
        });
        note.textContent = 'ตั้งรหัสใหม่แล้ว — ผู้ใช้ต้องเปลี่ยนตอนเข้าระบบ';
        resetPanel.querySelector('input').value = '';
      } catch (err) {
        note.textContent = err.message;
      }
    });

    wrap.querySelector('.delete-user').addEventListener('click', async () => {
      if (!confirm(`ลบผู้ใช้งาน ${u.email}?`)) return;
      try {
        await api(`/api/users/${u.id}${qs}`, { method: 'DELETE' });
        renderUserManager(container, scope);
      } catch (err) {
        alert(err.message);
      }
    });

    // Per-user dashboard access — changes apply only on an explicit Save.
    const accessToggle = wrap.querySelector('.toggle-access');
    if (accessToggle) {
      const panel = wrap.querySelector('.access-panel');
      let loaded = false;
      accessToggle.addEventListener('click', async () => {
        panel.classList.toggle('hidden');
        if (loaded || panel.classList.contains('hidden')) return;
        loaded = true;
        if (u.role === 'company_admin') {
          panel.innerHTML = '<p class="helper-text" style="margin:0;">Admin บริษัทเห็นทุก dashboard ของบริษัทเสมอ</p>';
          return;
        }
        if (!dashboards.length) {
          panel.innerHTML = '<p class="helper-text" style="margin:0;">บริษัทนี้ยังไม่มี dashboard</p>';
          return;
        }
        const { dashboard_ids } = await api(`/api/users/${u.id}/dashboard-access${qs}`);
        panel.innerHTML = `
          <div class="user-tabs-checklist">${dashboards
            .map(
              (d) =>
                `<label class="user-tab-checkbox"><input type="checkbox" value="${d.id}" ${dashboard_ids.includes(d.id) ? 'checked' : ''}> ${esc(d.display_name)}</label>`
            )
            .join('')}</div>
          <div class="user-tabs-save-row">
            <span class="user-tabs-dirty-note hidden">มีการเปลี่ยนแปลงที่ยังไม่บันทึก</span>
            <button type="button" class="btn small primary user-tabs-save" disabled>บันทึก</button>
          </div>`;
        const save = panel.querySelector('.user-tabs-save');
        const dirty = panel.querySelector('.user-tabs-dirty-note');
        panel.querySelectorAll('input[type="checkbox"]').forEach((cb) =>
          cb.addEventListener('change', () => {
            dirty.classList.remove('hidden');
            save.disabled = false;
          })
        );
        save.addEventListener('click', async () => {
          const ids = [...panel.querySelectorAll('input:checked')].map((c) => Number(c.value));
          save.disabled = true;
          save.textContent = 'กำลังบันทึก...';
          try {
            await api(`/api/users/${u.id}/dashboard-access${qs}`, { method: 'PUT', body: JSON.stringify({ dashboard_ids: ids }) });
            dirty.classList.add('hidden');
            save.textContent = 'บันทึกแล้ว ✓';
            setTimeout(() => (save.textContent = 'บันทึก'), 1500);
          } catch (err) {
            alert(`บันทึกไม่สำเร็จ: ${err.message}`);
            save.disabled = false;
            save.textContent = 'บันทึก';
          }
        });
      });
    }
  });

  const form = container.querySelector('.add-user-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form).entries());
    try {
      await api(`/api/users${qs}`, { method: 'POST', body: JSON.stringify(body) });
      await renderUserManager(container, scope);
    } catch (err) {
      form.querySelector('.form-msg').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    }
  });
}

// ---------- company_admin modals ----------
el('open-settings-btn').addEventListener('click', () => {
  el('settings-modal').classList.remove('hidden');
  renderFmhKeyPanel(el('fmh-key-panel'), state.user.company_id);
});
el('close-settings-btn').addEventListener('click', () => {
  el('settings-modal').classList.add('hidden');
  loadDashboards(state.activeDashboardId);
});
el('open-manage-users-btn').addEventListener('click', () => {
  el('manage-users-modal').classList.remove('hidden');
  renderUserManager(el('user-manager'), { companyId: state.user.company_id });
});
el('close-manage-users-btn').addEventListener('click', () => el('manage-users-modal').classList.add('hidden'));

// ================= KSS Internal Admin Console =================
const adminState = { meta: null, templates: [], selected: null };
const STATUS_LABEL = { active: 'ใช้งาน', trial: 'ทดลองใช้', suspended: 'ระงับ', demo: 'Demo' };
const TIER_LABEL = { starter: 'Starter', growth: 'Growth', enterprise: 'Enterprise' };
const CHART_LABEL = {
  kpi: 'KPI cards',
  bar: 'Bar ranking',
  line: 'Line (ตามเวลา)',
  table: 'Table',
  sensitivity: 'Price sensitivity',
  menu_breakdown: 'Menu breakdown',
  donut: 'Donut',
  pareto: 'Pareto',
  scatter: 'Scatter',
  treemap: 'Treemap',
  range: 'Range (ต่ำสุด–สูงสุด)',
  stack: 'Stacked bar',
  panels: 'หลายกราฟในใบเดียว',
  tabs_bar: 'Bar แยกแท็บ',
};
const sourceLabel = (s) => (adminState.meta && adminState.meta.report_sources[s] ? adminState.meta.report_sources[s].label : s);

el('open-admin-btn').addEventListener('click', () => {
  if (el('admin-view').classList.contains('hidden')) openAdminConsole();
  else {
    if (!leavePicker()) return;
    pickerDirty = false;
    showDashboardView();
    (isSuper() ? loadCompanyPicker(state.viewCompanyId) : Promise.resolve()).then(() => loadDashboards(state.activeDashboardId));
  }
});

async function openAdminConsole() {
  destroyCharts();
  el('dashboard-view').classList.add('hidden');
  el('admin-view').classList.remove('hidden');
  el('open-admin-btn').textContent = '← กลับไปดู Dashboard';
  el('admin-view').classList.toggle('company-mode', !isSuper());
  if (!adminState.meta) adminState.meta = await api('/api/admin/meta');
  await loadTemplates();
  if (!isSuper()) {
    if (!adminState.selected || !['my-dashboards', 'picker'].includes(adminState.selected.type)) {
      adminState.selected = { type: 'my-dashboards', id: state.user.company_id };
    }
    return renderAdminMain();
  }
  await renderAdminCompanyList();
  if (!adminState.selected) adminState.selected = state.viewCompanyId ? { type: 'company', id: state.viewCompanyId } : { type: 'catalog' };
  renderAdminMain();
}

async function loadTemplates() {
  adminState.templates = (await api('/api/admin/widget-templates')).templates;
}

async function renderAdminCompanyList() {
  if (!isSuper()) return; // company admins have no company list
  const { companies } = await api('/api/admin/companies');
  state.companies = companies;
  const list = el('admin-company-list');
  // Search by name, code (KSS-0007) or any name the company had before.
  let search = el('admin-company-search');
  if (!search) {
    search = document.createElement('input');
    search.id = 'admin-company-search';
    search.type = 'search';
    search.className = 'admin-company-search';
    search.placeholder = 'ค้นหาชื่อ / รหัส KSS-…';
    search.setAttribute('aria-label', 'ค้นหาบริษัท');
    list.parentNode.insertBefore(search, list);
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      list.querySelectorAll('.company-item').forEach((b) => (b.hidden = !!q && !b.dataset.search.includes(q)));
    });
  }
  list.innerHTML = companies
    .map(
      (c) => `<button type="button" class="admin-nav-item company-item" data-id="${c.id}" data-search="${esc([c.name, c.company_code, c.former_names, c.id].join(' ').toLowerCase())}">
        <span class="company-item-name">${esc(c.name)}</span>
        ${c.former_names ? `<span class="company-item-meta">ชื่อเดิม: ${esc(c.former_names)}</span>` : ''}
        <span class="company-item-meta">
          <span class="dot ${c.fmh_configured ? 'dot-good' : 'dot-off'}" title="${c.fmh_configured ? 'เชื่อม FMH แล้ว' : 'ยังไม่ได้ใส่ FMH key'}"></span>
          <span class="company-code">${esc(c.company_code || '')}</span> ${esc(STATUS_LABEL[c.status] || c.status)} · ${c.dashboard_count} dashboards
        </span>
      </button>`
    )
    .join('');
  if (search.value) search.dispatchEvent(new Event('input'));
  list.querySelectorAll('.company-item').forEach((b) =>
    b.addEventListener('click', () => {
      if (!leavePicker()) return;
      pickerDirty = false;
      adminState.selected = { type: 'company', id: Number(b.dataset.id) };
      renderAdminMain();
    })
  );
  markActiveNav();
}

function markActiveNav() {
  const sel = adminState.selected || {};
  document.querySelectorAll('#admin-view .admin-nav-item').forEach((b) => {
    const active = b.dataset.id ? (sel.type === 'company' || sel.type === 'picker') && Number(b.dataset.id) === sel.id : b.dataset.view === sel.type;
    b.classList.toggle('active', !!active);
  });
}

document.querySelectorAll('#admin-view .admin-nav-item[data-view]').forEach((b) =>
  b.addEventListener('click', () => {
    if (!leavePicker()) return;
    pickerDirty = false;
    adminState.selected = { type: b.dataset.view };
    renderAdminMain();
  })
);

el('admin-add-company-btn').addEventListener('click', () => {
  if (!leavePicker()) return;
  pickerDirty = false;
  adminState.selected = { type: 'new-company' };
  renderAdminMain();
});

function renderAdminMain() {
  markActiveNav();
  const sel = adminState.selected || {};
  const main = el('admin-main');
  main.scrollTop = 0;
  if (sel.type === 'company') return renderCompanyDetail(main, sel.id);
  if (sel.type === 'picker') return renderWidgetPicker(main, sel.id, sel.dashboardId);
  if (sel.type === 'my-dashboards') return renderMyDashboards(main, sel.id);
  if (sel.type === 'new-company') return renderNewCompany(main);
  if (sel.type === 'catalog') return renderCatalog(main);
  if (sel.type === 'fmh') return renderFmhDiagnostics(main);
  if (sel.type === 'news') return renderNews(main);
  if (sel.type === 'staff') {
    main.innerHTML = `<h1 class="admin-h1">ทีม KSS</h1>
      <p class="muted">บัญชีทีม KSS เห็นทุกบริษัทและใช้ Admin Console ได้</p>
      <section class="admin-card"><div class="staff-users"></div></section>`;
    return renderUserManager(main.querySelector('.staff-users'), { kss: true });
  }
}

// ---------- What's new: posts behind the bell in the header ----------
const toLocalInput = (d) => {
  const t = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}`;
};

async function renderNews(main, editId = null, flash = '') {
  main.innerHTML = '<p class="muted">กำลังโหลด...</p>';
  let items;
  try {
    ({ items } = await api('/api/announcements/admin'));
  } catch (err) {
    main.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    return;
  }
  const editing = items.find((n) => n.id === editId) || null;
  const picked = new Set(editing ? editing.template_keys : []);
  const byCat = new Map();
  adminState.templates.filter((t) => t.active).forEach((t) => {
    if (!byCat.has(t.category)) byCat.set(t.category, []);
    byCat.get(t.category).push(t);
  });
  const now = Date.now();
  main.innerHTML = `
    <h1 class="admin-h1">ประกาศ (มีอะไรใหม่)</h1>
    <p class="muted">ข้อความที่ผู้ใช้เห็นเมื่อกดกระดิ่ง 🔔 มุมขวาบน จุดแดงขึ้นจนกว่าผู้ใช้จะเปิดอ่าน ใช้แจ้ง widget ใหม่หรือฟีเจอร์ใหม่</p>
    ${flash}
    <section class="admin-card">
      <h2>${editing ? 'แก้ไขประกาศ' : 'เขียนประกาศใหม่'}</h2>
      <form class="news-form">
        <div class="grid-2">
          <div class="field"><label>หัวข้อ (ไทย) *</label><input name="title" maxlength="200" required value="${esc(editing ? editing.title : '')}"></div>
          <div class="field"><label>หัวข้อ (อังกฤษ)</label><input name="title_en" maxlength="200" value="${esc(editing ? editing.title_en || '' : '')}"></div>
          <div class="field"><label>รายละเอียด (ไทย) *</label><textarea name="body" rows="4" required>${esc(editing ? editing.body : '')}</textarea></div>
          <div class="field"><label>รายละเอียด (อังกฤษ)</label><textarea name="body_en" rows="4">${esc(editing ? editing.body_en || '' : '')}</textarea></div>
          <div class="field"><label>ผู้ที่เห็น</label>
            <select name="audience">
              <option value="all">ผู้ใช้ทุกคน</option>
              <option value="admins"${editing && editing.audience === 'admins' ? ' selected' : ''}>เฉพาะ Admin ของบริษัท</option>
            </select></div>
          <div class="field"><label>เผยแพร่เมื่อ</label><input type="datetime-local" name="published_at" value="${toLocalInput(editing ? editing.published_at : new Date())}"></div>
        </div>
        <details class="news-widgets"${picked.size ? ' open' : ''}><summary>Widget ที่ประกาศนี้แนะนำ (${picked.size})</summary>
          ${[...byCat.entries()]
            .sort((a, b) => catRank(a[0]) - catRank(b[0]))
            .map(
              ([cat, list]) => `<fieldset><legend>${esc(catLabel(cat))}</legend>${list
                .map((t) => `<label class="news-check"><input type="checkbox" name="tk" value="${esc(t.template_key)}"${picked.has(t.template_key) ? ' checked' : ''}> ${esc(t.name)}</label>`)
                .join('')}</fieldset>`
            )
            .join('')}
        </details>
        <p class="helper-text">ไม่ใส่ภาษาอังกฤษ ผู้ใช้ที่ตั้งภาษาอังกฤษจะเห็นข้อความภาษาไทย · ตั้งเวลาในอนาคตได้ ประกาศจะขึ้นเมื่อถึงเวลา</p>
        <div class="inline-form">
          <button type="submit" class="btn small primary">${editing ? 'บันทึกการแก้ไข' : 'เผยแพร่'}</button>
          ${editing ? '<button type="button" class="btn small ghost news-cancel">ยกเลิก</button>' : ''}
        </div>
        <div class="news-msg"></div>
      </form>
    </section>
    <section class="admin-card">
      <h2>ประกาศทั้งหมด (${items.length})</h2>
      ${
        items.length
          ? items
              .map((n) => {
                const future = new Date(n.published_at).getTime() > now;
                return `<article class="news-row" data-id="${n.id}">
                  <div><strong>${esc(n.title)}</strong> <span class="muted">· ${esc(fmtDateTime(n.published_at))}${future ? ' · ตั้งเวลาไว้' : ''} · ${n.audience === 'admins' ? 'เฉพาะ Admin' : 'ทุกคน'}${n.widgets.length ? ` · ${n.widgets.length} widget` : ''}</span></div>
                  <p class="muted">${esc(n.body)}</p>
                  <div class="inline-form"><button type="button" class="btn small ghost news-edit">แก้ไข</button><button type="button" class="btn small danger news-del">ลบ</button></div>
                </article>`;
              })
              .join('')
          : '<p class="muted">ยังไม่มีประกาศ</p>'
      }
    </section>`;

  const form = main.querySelector('.news-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {
      title: fd.get('title'), body: fd.get('body'), title_en: fd.get('title_en'), body_en: fd.get('body_en'),
      audience: fd.get('audience'), template_keys: fd.getAll('tk'),
      published_at: fd.get('published_at') ? new Date(fd.get('published_at')).toISOString() : null,
    };
    try {
      await api(editing ? `/api/announcements/admin/${editing.id}` : '/api/announcements/admin', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) });
      await renderNews(main, null, `<div class="ok-msg">${editing ? 'บันทึกแล้ว' : 'เผยแพร่แล้ว — ผู้ใช้จะเห็นจุดแดงที่กระดิ่ง'}</div>`);
      loadNotifications();
    } catch (err) {
      form.querySelector('.news-msg').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    }
  });
  form.querySelectorAll('[name=tk]').forEach((c) =>
    c.addEventListener('change', () => {
      form.querySelector('.news-widgets summary').textContent = `Widget ที่ประกาศนี้แนะนำ (${form.querySelectorAll('[name=tk]:checked').length})`;
    })
  );
  const cancel = form.querySelector('.news-cancel');
  if (cancel) cancel.addEventListener('click', () => renderNews(main));
  main.querySelectorAll('.news-edit').forEach((b) => b.addEventListener('click', () => renderNews(main, Number(b.closest('.news-row').dataset.id))));
  main.querySelectorAll('.news-del').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('ลบประกาศนี้? ผู้ใช้จะไม่เห็นอีก')) return;
      await api(`/api/announcements/admin/${b.closest('.news-row').dataset.id}`, { method: 'DELETE' });
      renderNews(main);
      loadNotifications();
    })
  );
}

// ---------- FMH Diagnostics ----------
// Settles questions about what the FMH API actually does, using a client's own
// key. Each probe is read-only but spends a little of their monthly row quota,
// so nothing runs until the button is pressed.
const PROBE_LIST = [
  { k: 'sources', n: 'ชุดข้อมูลไหนมีจริง ชุดไหนว่าง',
    d: 'ไล่ทุก (source, grouping) ที่แอปใช้ โดยส่ง request ชุดเดียวกับที่ sync ส่งจริง ขอแค่แถวเดียวต่อ pull — ใช้ตอบว่า widget ที่ขึ้นว่าไม่พบข้อมูล เป็นเพราะบัญชีนี้ไม่มีข้อมูล หรือแอปเรียกผิด' },
  { k: 'catalog', n: 'รายงานทั้งหมดที่บัญชีนี้เรียกได้',
    d: 'ดึง catalog มาดูว่ามีกี่รายงาน รายงานไหนจัดกลุ่มฝั่ง server ได้ และตัวไหนมีตัวกรองสถานะ ไม่กินโควตาแถว' },
  { k: 'statuses_purchase', n: 'ยอดสั่งซื้อรวมใบที่ยกเลิกอยู่หรือไม่',
    d: 'เทียบยอดเมื่อไม่ส่งตัวกรองสถานะ กับเมื่อนับเฉพาะใบที่ยืนยันแล้ว ถ้าต่างกันแปลว่าตัวเลขที่ลูกค้าเห็นสูงเกินจริง' },
  { k: 'statuses_orders', n: 'คำสั่งซื้อรายสาขารวมใบที่ยกเลิกหรือไม่',
    d: 'ทดสอบเดียวกันกับรายงาน order_items_by_branch' },
  { k: 'join_keys', n: 'รหัสสินค้าสองฝั่งตรงกันจริงไหม',
    d: 'เทียบ product_code ระหว่างฝั่งซื้อ ฝั่งขาย สาขาเบิก และสูตร ชื่อฟิลด์ตรงกันไม่ได้แปลว่าค่าตรงกัน ถ้ารหัสคนละชุด widget ที่ต่อหลายรายงานจะได้ข้อมูลไม่ครบโดยไม่มีใครรู้' },
  { k: 'date_filter', n: 'ตัวกรองวันที่รับรูปแบบไหนบ้าง',
    d: 'ลองส่ง date_range สี่แบบ เพื่อดูว่าแบบที่แอปใช้อยู่ถูกต้องไหม และเลือกฟิลด์วันที่ฝั่ง server ได้หรือเปล่า' },
  { k: 'ck_sales', n: 'ยอดขาย CK ที่ FMH ส่งมา เทียบกับที่ Dashboard เก็บไว้',
    d: 'ดึงยอดขายครัวกลางตามช่วงเวลาจาก FMH ตรง ๆ แล้ววางข้างข้อมูลที่ sync ไว้ ใช้ตอบว่ายอดขายหายเพราะ FMH, เพราะ sync ไม่สำเร็จ หรือเพราะวิธีรวมเป็นช่วง กินโควตาไม่กี่แถว' },
  { k: 'group_by', n: 'จัดกลุ่มฝั่ง server ประหยัดโควตาได้แค่ไหน',
    d: 'เทียบจำนวนแถวระหว่างดึงแบบรายการกับจัดกลุ่มตามสาขา ซัพพลายเออร์ หมวด และสินค้า' },
];

function fmhProbeView(r, key) {
  if (r.error) return `<p class="probe-bad">${esc(r.error)}</p>${r.detail ? `<pre>${esc(r.detail)}</pre>` : ''}`;
  if (key === 'catalog') {
    const g = r.reports.filter((x) => x.groupBy.length > 1).length;
    const st = r.reports.filter((x) => x.hasStatuses).length;
    return `<p><b>${r.count} รายงาน</b> · จัดกลุ่มฝั่ง server ได้ ${g} รายงาน · มีตัวกรองสถานะ ${st} รายงาน
        ${r.apiVersion ? ` · API version ${esc(r.apiVersion)}` : ''}</p>
      ${r.deprecation ? `<p class="probe-bad">FMH ส่ง deprecation header มาแล้ว: ${esc(r.deprecation)}${r.sunset ? ` · ปิดใช้ ${esc(r.sunset)}` : ''}</p>` : ''}
      <table class="probe-table"><thead><tr><th>report</th><th>scope</th><th>cards</th><th>group_by</th><th>statuses</th></tr></thead><tbody>
      ${r.reports.map((x) => `<tr><td><code>${esc(x.key)}</code><br><span class="muted">${esc(x.name)}</span></td>
        <td>${esc(x.scope || '')}</td><td>${x.cards}</td>
        <td>${x.groupBy.length ? x.groupBy.map((v) => `<code>${esc(v)}</code>`).join(' ') : '—'}</td>
        <td>${x.hasStatuses ? 'มี' : '—'}</td></tr>`).join('')}
      </tbody></table>`;
  }
  if (key === 'sources') {
    const c = r.counts || {};
    const cls = c.failed ? 'probe-bad' : c.empty ? '' : 'probe-good';
    const row = (x) => `<tr><td><code>${esc(x.key)}</code><br><span class="muted">${esc(x.label || '')}</span></td>
        <td class="muted"><code>${esc(x.reportKey)}</code> / <code>${esc(x.cardKey)}</code></td>
        <td class="${x.ok ? (x.hasRows ? 'probe-good' : 'probe-bad') : 'probe-bad'}">${x.ok ? (x.hasRows ? 'มีข้อมูล' : 'ว่าง') : 'HTTP ' + x.status}</td>
        <td class="muted">${x.sentDateRange ? 'ช่วงวัน' : '—'}${x.sentStatuses ? ' · สถานะ' : ''}</td>
        <td class="muted">${x.message ? esc(x.message) : x.fields.length ? x.fields.slice(0, 6).map((f) => `<code>${esc(f)}</code>`).join(' ') : '—'}</td></tr>`;
    const problems = r.results.filter((x) => !x.ok || x.hasRows === false);
    const fine = r.results.filter((x) => x.ok && x.hasRows === true);
    return `<p class="${cls}">${esc(r.verdict || '')}</p>
      <p>${c.total} pull · มีข้อมูล ${c.live} · ว่าง ${c.empty} · เรียกไม่สำเร็จ ${c.failed}</p>
      ${problems.length ? `<p><b>ที่ต้องดู</b></p><table class="probe-table"><thead><tr><th>pull</th><th>report / card</th><th>ผล</th><th>filter ที่ส่ง</th><th>ฟิลด์ / ข้อความ</th></tr></thead><tbody>${problems.map(row).join('')}</tbody></table>` : ''}
      ${fine.length ? `<details><summary>pull ที่ปกติ (${fine.length})</summary><table class="probe-table"><tbody>${fine.map(row).join('')}</tbody></table></details>` : ''}
      <p class="muted">ช่วงที่ทดสอบ ${esc(r.window.start)} ถึง ${esc(r.window.end)} · ขอแค่ 1 แถวต่อ pull</p>`;
  }
  if (key === 'statuses_purchase' || key === 'statuses_orders') {
    const fmt = (m) => (m ? `${m.total.toLocaleString('th-TH', { maximumFractionDigits: 0 })} <span class="muted">(${esc(m.field)})</span>` : '—');
    const bad = r.overstatedPct && Math.abs(r.overstatedPct) >= 0.1;
    return `<p class="${bad ? 'probe-bad' : 'probe-good'}">${esc(r.verdict || '')}</p>
      <table class="probe-table"><thead><tr><th></th><th>แถว</th><th>มูลค่ารวม</th><th>จำนวนรวม</th></tr></thead><tbody>
        <tr><td>ไม่ส่งตัวกรองสถานะ (แบบที่แอปทำอยู่)</td><td>${r.noFilter.rows}</td><td>${fmt(r.noFilter.money)}</td><td>${fmt(r.noFilter.qty)}</td></tr>
        <tr><td>นับเฉพาะใบที่ยืนยันแล้ว</td><td>${r.committed.rows}</td><td>${fmt(r.committed.money)}</td><td>${fmt(r.committed.qty)}</td></tr>
      </tbody></table>
      <p class="muted">ช่วงที่ทดสอบ ${esc(r.window.start)} ถึง ${esc(r.window.end)} · จัดกลุ่มตาม ${esc(r.groupBy || 'รายการ')}
      ${r.quota ? ` · โควตาเหลือ ${Number(r.quota.rows_remaining || 0).toLocaleString('th-TH')} แถว` : ''}</p>
      ${r.sampleRow ? `<pre>${esc(JSON.stringify(r.sampleRow, null, 1))}</pre>` : ''}`;
  }
  if (key === 'join_keys') {
    return `${r.pairs.map((p) => {
      if (p.error) return `<div class="probe-pair"><b>${esc(p.name)}</b><p class="probe-bad">${esc(p.error)}</p></div>`;
      const cls = p.sharesNamespace === false ? 'probe-bad' : p.pct >= 95 ? 'probe-good' : '';
      return `<div class="probe-pair">
        <b>${esc(p.name)}</b>
        <p class="${cls}">${p.pct != null ? `ตรงกัน ${p.pct}%` : ''} — ${esc(p.verdict || '')}</p>
        <table class="probe-table"><tbody>
          <tr><td>${esc(p.a)}</td><td><code>${esc(p.field)}</code></td><td>${p.aRows ?? '—'} แถว</td><td>${p.aCodes ?? '—'} รหัสไม่ซ้ำ</td><td>${p.aHasField === false ? '<span class="probe-bad">ไม่มีฟิลด์นี้</span>' : ''}</td></tr>
          <tr><td>${esc(p.b)}</td><td><code>${esc(p.bField)}</code></td><td>${p.bRows ?? '—'} แถว</td><td>${p.bCodes ?? '—'} รหัสไม่ซ้ำ</td><td>${p.bHasField === false ? '<span class="probe-bad">ไม่มีฟิลด์นี้</span>' : ''}</td></tr>
        </tbody></table>
        ${p.missed && p.missed.length ? `<p class="muted">อยู่เฉพาะใน <code>${esc(p.smallSide || '')}</code>: ${p.missed.map((m) => `<code>${esc(m.code)}</code>${m.name ? ` ${esc(m.name)}` : ''}`).join(' · ')}</p>` : ''}
      </div>`;
    }).join('')}
    <p class="muted">ช่วงที่ทดสอบ ${esc(r.window.start)} ถึง ${esc(r.window.end)} · อ่านแบบจัดกลุ่มตามสินค้า จึงกินโควตาหลักสิบแถว</p>`;
  }
  if (key === 'date_filter') {
    return `<table class="probe-table"><thead><tr><th>รูปแบบที่ส่ง</th><th>ผล</th><th>แถว</th><th>ข้อความจาก FMH</th></tr></thead><tbody>
      ${r.results.map((x) => `<tr><td>${esc(x.name)}</td>
        <td class="${x.ok ? 'probe-good' : 'probe-bad'}">${x.ok ? 'ผ่าน' : 'HTTP ' + x.status}</td>
        <td>${x.rows ?? '—'}</td><td class="muted">${esc(x.message)}</td></tr>`).join('')}
    </tbody></table>`;
  }
  if (key === 'ck_sales') {
    const baht = (v) => Number(v || 0).toLocaleString('th-TH', { maximumFractionDigits: 0 });
    const cached = new Map(((r.cache && r.cache.rows) || []).map((x) => [x.period, x.sales]));
    const allPeriods = [...new Set([...r.periods.map((p) => p.period), ...cached.keys()])].sort();
    const live = new Map(r.periods.map((p) => [p.period, p.sales]));
    return `<p class="${/ตรงกัน/.test(r.verdict) ? 'probe-good' : 'probe-bad'}">${esc(r.verdict)}</p>
      ${r.message ? `<p class="probe-bad">${esc(r.message)}</p>` : ''}
      <p>FMH รวมยอดเป็นช่วง: <b>${esc(r.bucket)}</b> · ข้อมูลที่เก็บไว้ sync ล่าสุด ${esc(r.cache ? fmtDateTime(r.cache.synced_at) : '—')}
      ${r.last_error ? ` · <span class="probe-bad">sync ล่าสุดล้มเหลว ${esc(fmtDateTime(r.last_error.failed_at))}: ${esc(r.last_error.error_text)}</span>` : ''}</p>
      <table class="probe-table"><thead><tr><th>period (วันเริ่มช่วง)</th><th class="num">FMH ตอนนี้</th><th class="num">ที่ Dashboard เก็บไว้</th></tr></thead><tbody>
      ${allPeriods.map((p) => `<tr><td>${esc(p)}</td><td class="num">${live.has(p) ? baht(live.get(p)) : '—'}</td>
        <td class="num ${live.get(p) !== cached.get(p) ? 'probe-bad' : ''}">${cached.has(p) ? baht(cached.get(p)) : '—'}</td></tr>`).join('') || '<tr><td colspan="3">ไม่มีแถว</td></tr>'}
      </tbody></table>
      <p><b>ยอดขายรวมจากการ์ดสรุปของ FMH</b></p>
      <table class="probe-table"><tbody>${r.stats.map((s) => `<tr><td>${esc(s.start)} ถึง ${esc(s.end)}</td>
        <td class="num">${s.ok ? baht(s.total_sales) : 'HTTP ' + s.status}</td><td class="muted">${esc(s.message)}</td></tr>`).join('')}</tbody></table>
      <p class="muted">ช่วงที่ทดสอบ ${esc(r.window.start)} ถึง ${esc(r.window.end)}</p>`;
  }
  if (key === 'group_by') {
    return `${r.saving ? `<p class="probe-good">${esc(r.saving)}</p>` : ''}
      <table class="probe-table"><thead><tr><th>group_by</th><th>ผล</th><th>แถวที่ได้</th><th>ฟิลด์ที่คืนมา</th></tr></thead><tbody>
      ${r.results.map((x) => `<tr><td><code>${esc(x.group)}</code></td>
        <td class="${x.ok ? 'probe-good' : 'probe-bad'}">${x.ok ? 'ผ่าน' : 'HTTP ' + x.status}</td>
        <td>${x.rows ?? '—'}</td>
        <td class="muted">${x.fields.length ? x.fields.map((f) => `<code>${esc(f)}</code>`).join(' ') : esc(x.message)}</td></tr>`).join('')}
    </tbody></table>
      <p class="muted">ช่วงที่ทดสอบ ${esc(r.window.start)} ถึง ${esc(r.window.end)} · นับเฉพาะใบที่ยืนยันแล้ว</p>`;
  }
  return `<pre>${esc(JSON.stringify(r, null, 1))}</pre>`;
}

async function renderFmhDiagnostics(main) {
  if (!adminState.companies) {
    main.innerHTML = '<h1 class="admin-h1">FMH Diagnostics</h1><p class="muted">กำลังโหลดรายชื่อบริษัท…</p>';
    try {
      const { companies } = await api('/api/admin/companies');
      adminState.companies = companies;
    } catch {
      adminState.companies = [];
    }
  }
  const companies = (adminState.companies || []).filter((c) => c.fmh_configured);
  main.innerHTML = `<h1 class="admin-h1">FMH Diagnostics</h1>
    <p class="muted">ถาม FMH ตรง ๆ ว่า API ทำอะไรได้บ้าง โดยใช้ key ของลูกค้ารายที่เลือก ทุกการทดสอบเป็นการอ่านอย่างเดียว
      ไม่แก้ข้อมูลใด ๆ แต่ใช้โควตาแถวรายเดือนของลูกค้าเล็กน้อย จึงต้องกดเองทีละรายการ</p>
    ${companies.length
      ? `<section class="admin-card">
          <div class="field"><label>บริษัทที่จะใช้ทดสอบ</label>
            <select id="probe-company">${companies.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
          </div>
        </section>
        <div class="probe-list">${PROBE_LIST.map((p) => `<section class="admin-card probe" data-probe="${p.k}">
            <div class="probe-head">
              <div><h3>${esc(p.n)}</h3><p class="muted">${esc(p.d)}</p></div>
              <button type="button" class="btn small probe-run">รันทดสอบ</button>
            </div>
            <div class="probe-out"></div>
          </section>`).join('')}</div>`
      : `<section class="admin-card"><p class="muted">ยังไม่มีบริษัทที่ตั้งค่า FMH API key ไว้ ตั้งค่าก่อนจึงจะทดสอบได้</p></section>`}`;

  main.querySelectorAll('.probe-run').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const card = btn.closest('.probe');
      const key = card.dataset.probe;
      const out = card.querySelector('.probe-out');
      const companyId = Number(el('probe-company').value);
      btn.disabled = true;
      btn.textContent = 'กำลังถาม FMH…';
      out.innerHTML = '';
      try {
        const { result } = await api('/api/admin/fmh-probe', { method: 'POST', body: JSON.stringify({ company_id: companyId, probe: key }) });
        out.innerHTML = fmhProbeView(result, key);
      } catch (e) {
        out.innerHTML = `<p class="probe-bad">${esc(e.message || 'เรียกไม่สำเร็จ')}</p>`;
      } finally {
        btn.disabled = false;
        btn.textContent = 'รันอีกครั้ง';
      }
    })
  );
}

function tierStatusSelects(company = {}) {
  const meta = adminState.meta;
  return `
    <div class="field"><label>สถานะ</label><select name="status">${meta.statuses
      .map((s) => `<option value="${s}" ${company.status === s ? 'selected' : ''}>${esc(STATUS_LABEL[s] || s)}</option>`)
      .join('')}</select></div>
    <div class="field"><label>Plan tier</label><select name="plan_tier">${meta.tiers
      .map((t) => `<option value="${t}" ${company.plan_tier === t ? 'selected' : ''}>${esc(TIER_LABEL[t] || t)}</option>`)
      .join('')}</select></div>
    ${
      company.id
        ? `<div class="field"><label>แหล่งข้อมูล</label><select name="data_source">
            <option value="fmh" ${company.data_source !== 'demo' ? 'selected' : ''}>FMH จริง (ใช้ API key และโควตา)</option>
            <option value="demo" ${company.data_source === 'demo' ? 'selected' : ''}>ข้อมูลตัวอย่าง (ไม่เรียก FMH)</option>
          </select></div>`
        : ''
    }`;
}

function renderNewCompany(main) {
  main.innerHTML = `
    <h1 class="admin-h1">เพิ่มบริษัทใหม่</h1>
    <section class="admin-card">
      <form class="new-company-form">
        <div class="form-msg"></div>
        <div class="grid-3">
          <div class="field"><label>ชื่อบริษัท</label><input name="name" required></div>
          ${tierStatusSelects({ status: 'trial', plan_tier: 'starter' })}
        </div>
        <button type="submit" class="btn primary">สร้างบริษัท</button>
      </form>
      <p class="helper-text" style="margin:12px 0 0;">ขั้นต่อไป: สร้าง dashboard + วาง widget, เพิ่ม Admin บริษัทคนแรก แล้วให้ลูกค้าใส่ FMH API Key เอง (หรือใส่ให้ที่นี่)</p>
    </section>`;
  const form = main.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { id } = await api('/api/admin/companies', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      adminState.selected = { type: 'company', id };
      await renderAdminCompanyList();
      renderAdminMain();
    } catch (err) {
      form.querySelector('.form-msg').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    }
  });
}

async function renderCompanyDetail(main, companyId) {
  main.innerHTML = '<p class="muted">กำลังโหลด...</p>';
  let data;
  try {
    data = await api(`/api/admin/companies/${companyId}`);
  } catch (err) {
    main.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    return;
  }
  const c = data.company;
  main.innerHTML = `
    <div class="admin-head">
      <div>
        <h1 class="admin-h1">${esc(c.name)} <span class="company-code big">${esc(c.company_code || '')}</span></h1>
        ${
          c.name_history && c.name_history.length
            ? `<p class="muted">ชื่อเดิม: ${c.name_history
                .map((h) => `${esc(h.old_name)} <span class="nowrap">(เปลี่ยนเป็น "${esc(h.new_name)}" ${esc(fmtDateTime(h.changed_at))}${h.changed_by_email ? ` โดย ${esc(h.changed_by_email)}${h.changed_by_role === 'company_admin' ? ' — ลูกค้า' : ''}` : ''})</span>`)
                .join(' · ')}</p>`
            : ''
        }
        <p class="muted">${esc(STATUS_LABEL[c.status] || c.status)} · ${esc(TIER_LABEL[c.plan_tier] || c.plan_tier)} · สร้างเมื่อ ${esc(fmtDateTime(c.created_at))}</p>
      </div>
      <button type="button" class="btn small view-dashboards">ดู dashboard ของบริษัทนี้ →</button>
    </div>

    <section class="admin-card">
      <h2>1. ข้อมูลบริษัท</h2>
      <form class="company-form">
        <div class="form-msg"></div>
        <div class="grid-3">
          <div class="field"><label>ชื่อบริษัท</label><input name="name" value="${esc(c.name)}" required></div>
          ${tierStatusSelects(c)}
        </div>
        <button type="submit" class="btn small primary">บันทึก</button>
      </form>
    </section>

    <section class="admin-card">
      <h2>2. FMH API Key</h2>
      <p class="helper-text" style="margin-top:0;">ปกติให้ Admin บริษัทของลูกค้าใส่ Key เองผ่านปุ่ม ⚙️ — ใส่แทนได้ที่นี่ในกรณีจำเป็น (เช่น Demo Co)</p>
      <div class="fmh-panel"></div>
      <div class="sync-block"></div>
    </section>

    <section class="admin-card">
      <h2>3. Dashboards &amp; Widgets</h2>
      <div class="composer"></div>
    </section>

    <section class="admin-card">
      <h2>4. ผู้ใช้งาน</h2>
      <div class="company-users"></div>
    </section>

    <section class="admin-card">
      <h2>5. การชำระเงินและอายุการใช้งาน</h2>
      <div class="billing"></div>
    </section>

    <section class="admin-card">
      <h2>6. ยอดขาย POS (Foodstory และ POS ที่ไม่มี API)</h2>
      <div class="pos-panel"></div>
    </section>

    <section class="admin-card" id="fmh-files">
      <h2>7. ข้อมูลย้อนหลังจากไฟล์ FMH (เกิน 90 วัน)</h2>
      <div class="fmh-files-panel"></div>
    </section>`;

  main.querySelector('.view-dashboards').addEventListener('click', () => viewCompanyDashboards(companyId));
  const form = main.querySelector('.company-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/admin/companies/${companyId}`, { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      await renderAdminCompanyList();
      renderCompanyDetail(main, companyId);
    } catch (err) {
      form.querySelector('.form-msg').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    }
  });

  const refreshSyncBlock = async () => {
    const block = main.querySelector('.sync-block');
    const { company, sync_status } = await api(`/api/admin/companies/${companyId}`);
    block.innerHTML = `
      <div class="sync-head">
        <strong>ข้อมูลที่ sync ไว้</strong>
        ${company.fmh_configured ? '<button type="button" class="btn small ghost sync-now">Sync ตอนนี้</button>' : ''}
      </div>
      ${
        sync_status.length
          ? `<table class="mini-table"><thead><tr><th>Report source</th><th class="num">แถว</th><th>Sync ล่าสุด</th></tr></thead><tbody>${sync_status
              .map((s) => `<tr><td>${esc(sourceLabel(s.cache_key))}</td><td class="num">${Number(s.rows_cached).toLocaleString('th-TH')}</td><td>${esc(fmtDateTime(s.synced_at))}</td></tr>`)
              .join('')}</tbody></table>`
          : '<p class="muted">ยังไม่มีข้อมูล — จะ sync เฉพาะ report source ที่มี widget ใช้งาน</p>'
      }
      <div class="sync-result"></div>
      <div class="usage-block"></div>`;
    renderUsage(block.querySelector('.usage-block'), companyId);
    const btn = block.querySelector('.sync-now');
    if (btn) {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'กำลัง sync...';
        try {
          const { results } = await api(`/api/admin/companies/${companyId}/sync`, { method: 'POST' });
          const failed = Object.entries(results).filter(([, r]) => !r.ok);
          await refreshSyncBlock();
          block.querySelector('.sync-result').innerHTML = failed.length
            ? `<div class="error-msg">${failed.map(([s, r]) => `${esc(sourceLabel(s))}: ${esc(r.error)}`).join('<br>')}</div>`
            : Object.keys(results).length
              ? '<div class="ok-msg">Sync สำเร็จ</div>'
              : '<p class="muted">ยังไม่มี widget ที่ต้องใช้ข้อมูล</p>';
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Sync ตอนนี้';
          block.querySelector('.sync-result').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
        }
      });
    }
  };

  renderFmhKeyPanel(main.querySelector('.fmh-panel'), companyId, async () => {
    await renderAdminCompanyList();
    setTimeout(refreshSyncBlock, 1500); // first sync runs in the background
  });
  refreshSyncBlock();
  renderComposer(main.querySelector('.composer'), companyId);
  renderUserManager(main.querySelector('.company-users'), { companyId });
  renderBillingPanel(main.querySelector('.billing'), companyId);
  renderPosPanel(main.querySelector('.pos-panel'), companyId);
  renderFmhFilesPanel(main.querySelector('.fmh-files-panel'), companyId);
  if (adminState.focus === 'fmh-files') {
    adminState.focus = null;
    main.querySelector('#fmh-files').scrollIntoView({ block: 'start' });
  }
}

// ---------- FMH quota: where the rows went ----------
const TRIGGER_LABEL = {
  cron: 'Sync อัตโนมัติตี 1', boot: 'ตอน deploy', refresh: 'ปุ่ม Refresh ของผู้ใช้', admin: 'Sync จาก Admin',
  warm: 'เพิ่ม widget ใหม่', key_saved: 'ตอนใส่ API key', probe: 'Diagnostics', other: 'อื่น ๆ',
};
async function renderUsage(container, companyId) {
  let u;
  try {
    u = await api(`/api/admin/companies/${companyId}/fmh-usage`);
  } catch (err) {
    container.innerHTML = '';
    return;
  }
  if (!u.by_pull.length) {
    container.innerHTML = '<p class="muted" style="margin-top:12px">ยังไม่มีบันทึกการใช้โควตา FMH (เริ่มบันทึกหลัง deploy นี้)</p>';
    return;
  }
  const total = u.by_pull.reduce((a, r) => a + r.rows_fetched, 0);
  const fmt = (n) => Number(n).toLocaleString('th-TH');
  container.innerHTML = `
    <h3 style="margin:16px 0 6px;font-size:15px;">โควตา FMH ที่ใช้ไป ${u.days} วันล่าสุด: ${fmt(total)} แถว</h3>
    <div class="grid-2" style="gap:16px;align-items:start">
      <table class="mini-table"><thead><tr><th>ใช้ไปกับ</th><th class="num">แถว</th><th class="num">ครั้ง</th></tr></thead><tbody>${u.by_trigger
        .map((r) => `<tr><td>${esc(TRIGGER_LABEL[r.trig] || r.trig)}</td><td class="num">${fmt(r.rows_fetched)}</td><td class="num">${fmt(r.calls)}</td></tr>`)
        .join('')}</tbody></table>
      <table class="mini-table"><thead><tr><th>รายงาน</th><th class="num">แถว</th><th class="num">ครั้ง</th></tr></thead><tbody>${u.by_pull
        .slice(0, 12)
        .map((r) => `<tr><td>${esc(r.pull_key)}</td><td class="num">${fmt(r.rows_fetched)}</td><td class="num">${fmt(r.calls)}</td></tr>`)
        .join('')}</tbody></table>
    </div>`;
}

// ---------- billing (stage 1): payment requests + subscription end date ----------
const PAY_STATUS = { pending: 'รอชำระ', paid: 'ชำระแล้ว', cancelled: 'ยกเลิก' };
const bahtFmt = (satang) => (satang / 100).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function renderBillingPanel(container, companyId) {
  container.innerHTML = '<p class="muted">กำลังโหลด...</p>';
  let info, cfg;
  try {
    [info, cfg] = await Promise.all([api(`/api/admin/billing/companies/${companyId}`), api('/api/admin/billing/status')]);
  } catch (err) {
    container.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    return;
  }
  const modeLine = !cfg.online_payments
    ? 'Omise: <strong>ปิดอยู่</strong>'
    : cfg.omise_mode
    ? `Omise: โหมด <strong>${cfg.omise_mode === 'test' ? 'ทดสอบ' : 'ใช้งานจริง'}</strong>`
    : '<span class="error-msg" style="display:inline-block">ยังไม่ได้ตั้งค่า OMISE_SECRET_KEY — สร้าง QR ไม่ได้ (ยังบันทึกโอนเงินเองได้)</span>';
  container.innerHTML = `
    <p class="helper-text" style="margin-top:0;">${modeLine} · Webhook ${cfg.webhook_secret_set ? 'ตั้งค่าแล้ว' : 'ยังไม่ได้ตั้งค่า (ระบบยังตรวจสถานะเองทุก 10 นาที)'} · ระงับอัตโนมัติเมื่อหมดอายุ: ${cfg.enforce_expiry ? `เปิด (ผ่อนผัน ${cfg.grace_days} วัน)` : 'ปิดอยู่'}</p>
    <form class="inline-form sub-form">
      <label>ใช้งานได้ถึง <input type="date" name="subscription_ends_at" value="${esc(info.subscription_ends_at || '')}"></label>
      <button type="submit" class="btn small">บันทึกวันหมดอายุ</button>
      <span class="muted">${info.subscription_ends_at ? '' : 'ว่าง = ไม่มีวันหมดอายุ (ลูกค้านำร่อง)'}</span>
    </form>
    <div class="sub-msg"></div>
    ${cfg.online_payments ? '' : '<p class="muted" style="margin-top:16px">การชำระเงินออนไลน์ผ่าน Omise ยังไม่เปิดใช้ในระบบนี้ — กำหนดวันหมดอายุด้านบนได้ตามปกติ</p>'}
    <div class="online-pay"${cfg.online_payments ? '' : ' hidden'}>
    <h3 style="margin:20px 0 8px;font-size:15px;">ออกรายการชำระเงินใหม่</h3>
    <form class="inline-form pay-form">
      <input name="description" placeholder="รายละเอียด เช่น KSS Dashboard สมาชิกรายปี" required style="flex:2;min-width:220px">
      <input name="amount_baht" type="number" step="0.01" min="20" placeholder="จำนวนเงิน (บาท)" required>
      <input name="period_months" type="number" min="1" max="60" value="12" title="ต่ออายุกี่เดือน" style="width:90px">
      <button type="submit" class="btn small primary">สร้างลิงก์ชำระเงิน</button>
    </form>
    <div class="pay-msg"></div>
    ${
      info.payments.length
        ? `<table class="mini-table" style="margin-top:12px"><thead><tr><th>รายการ</th><th class="num">บาท</th><th>สถานะ</th><th>ต่ออายุถึง</th><th></th></tr></thead><tbody>${info.payments
            .map(
              (p) => `<tr data-id="${p.id}">
                <td>${esc(p.description)}<br><span class="muted">${esc(fmtDateTime(p.created_at))}${p.paid_via ? ` · ${p.paid_via === 'omise' ? 'PromptPay' : 'โอนเอง: ' + esc(p.manual_note || '')}` : ''}</span></td>
                <td class="num">${bahtFmt(p.amount_satang)}</td>
                <td>${esc(PAY_STATUS[p.status])}</td>
                <td>${esc(p.extended_to || '–')}</td>
                <td>${
                  p.status === 'pending'
                    ? `<button type="button" class="btn small ghost copy-link" data-url="${esc(p.pay_url)}">คัดลอกลิงก์</button>
                       ${p.has_charge ? '<button type="button" class="btn small ghost check">ตรวจสถานะ</button>' : ''}
                       <button type="button" class="btn small ghost mark-paid">โอนแล้ว</button>
                       <button type="button" class="btn small danger cancel">ยกเลิก</button>`
                    : ''
                }</td></tr>`
            )
            .join('')}</tbody></table>`
        : '<p class="muted" style="margin-top:12px">ยังไม่มีรายการชำระเงิน</p>'
    }
    </div>`;

  const msg = (sel, html) => (container.querySelector(sel).innerHTML = html);
  container.querySelector('.sub-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/admin/billing/companies/${companyId}/subscription`, { method: 'PUT', body: JSON.stringify({ subscription_ends_at: e.target.subscription_ends_at.value || null }) });
      renderBillingPanel(container, companyId);
    } catch (err) {
      msg('.sub-msg', `<div class="error-msg">${esc(err.message)}</div>`);
    }
  });
  container.querySelector('.pay-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { payment } = await api(`/api/admin/billing/companies/${companyId}/payments`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())) });
      await renderBillingPanel(container, companyId);
      msg('.pay-msg', `<div class="ok-msg">สร้างแล้ว — ส่งลิงก์นี้ให้ลูกค้า: <code>${esc(payment.pay_url)}</code></div>`);
    } catch (err) {
      msg('.pay-msg', `<div class="error-msg">${esc(err.message)}</div>`);
    }
  });
  const act = (sel, fn) =>
    container.querySelectorAll(sel).forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          await fn(b, b.closest('tr').dataset.id);
        } catch (err) {
          msg('.pay-msg', `<div class="error-msg">${esc(err.message)}</div>`);
        }
      })
    );
  act('.copy-link', async (b) => {
    try { await navigator.clipboard.writeText(b.dataset.url); b.textContent = 'คัดลอกแล้ว'; } catch (e) { msg('.pay-msg', `<code>${esc(b.dataset.url)}</code>`); }
  });
  act('.check', async (b, id) => { await api(`/api/admin/billing/payments/${id}/check`, { method: 'POST' }); renderBillingPanel(container, companyId); });
  act('.cancel', async (b, id) => {
    if (!confirm('ยกเลิกรายการนี้? ลิงก์ที่ส่งให้ลูกค้าจะใช้ไม่ได้อีก')) return;
    await api(`/api/admin/billing/payments/${id}/cancel`, { method: 'POST' });
    renderBillingPanel(container, companyId);
  });
  act('.mark-paid', async (b, id) => {
    const note = prompt('บันทึกว่าลูกค้าโอนเงินแล้ว — ใส่หมายเหตุ (วันที่โอน/เลขอ้างอิง) การกดนี้จะต่ออายุบริษัททันที');
    if (!note) return;
    await api(`/api/admin/billing/payments/${id}/mark-paid`, { method: 'POST', body: JSON.stringify({ note }) });
    renderBillingPanel(container, companyId);
  });
}

// ---------- dashboard composer ----------
async function renderComposer(container, companyId) {
  const { dashboards } = await api(`/api/admin/companies/${companyId}/dashboards`);
  container.innerHTML = `
    <div class="composer-list"></div>
    <form class="inline-form new-dash-form">
      <input name="display_name" required placeholder="ชื่อ dashboard ใหม่ เช่น ภาพรวมผู้บริหาร" aria-label="ชื่อ dashboard ใหม่">
      <input name="description" placeholder="คำอธิบาย (ไม่บังคับ)" aria-label="คำอธิบาย dashboard">
      <button type="submit" class="btn small primary">+ สร้าง dashboard</button>
    </form>`;
  const list = container.querySelector('.composer-list');
  if (!dashboards.length) list.innerHTML = '<p class="muted">ยังไม่มี dashboard</p>';

  dashboards.forEach((d, idx) => {
    const block = document.createElement('div');
    block.className = 'composer-dash';
    block.innerHTML = `
      <div class="composer-dash-head">
        <div class="order-btns">
          <button type="button" class="icon-mini move-dash" data-dir="-1" ${idx === 0 ? 'disabled' : ''} aria-label="เลื่อนขึ้น">▲</button>
          <button type="button" class="icon-mini move-dash" data-dir="1" ${idx === dashboards.length - 1 ? 'disabled' : ''} aria-label="เลื่อนลง">▼</button>
        </div>
        <form class="dash-meta-form">
          <input name="display_name" value="${esc(d.display_name)}" required aria-label="ชื่อ dashboard">
          <input name="description" value="${esc(d.description || '')}" placeholder="คำอธิบาย" aria-label="คำอธิบาย">
          <button type="submit" class="btn small ghost">บันทึกชื่อ</button>
        </form>
        <div class="composer-dash-actions">
          <span class="muted nowrap">${Number(d.widget_count) || 0} widget</span>
          <button type="button" class="btn small primary pick-widgets">เลือก Widget →</button>
          <button type="button" class="btn small ghost preview-dash">ดูตัวอย่าง</button>
          <button type="button" class="btn small danger delete-dash">ลบ</button>
        </div>
      </div>`;
    list.appendChild(block);

    block.querySelector('.dash-meta-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await api(`/api/admin/dashboards/${d.id}`, { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())) });
      renderComposer(container, companyId);
    });
    block.querySelectorAll('.move-dash').forEach((b) =>
      b.addEventListener('click', async () => {
        const ids = dashboards.map((x) => x.id);
        const j = idx + Number(b.dataset.dir);
        [ids[idx], ids[j]] = [ids[j], ids[idx]];
        await api(`/api/admin/companies/${companyId}/dashboard-order`, { method: 'PUT', body: JSON.stringify({ dashboard_ids: ids }) });
        renderComposer(container, companyId);
      })
    );
    block.querySelector('.preview-dash').addEventListener('click', () => viewCompanyDashboards(companyId, d.id));
    block.querySelector('.delete-dash').addEventListener('click', async () => {
      if (!confirm(`ลบ dashboard "${d.display_name}" และ widget ทั้งหมดในนั้น?`)) return;
      await api(`/api/admin/dashboards/${d.id}`, { method: 'DELETE' });
      await renderAdminCompanyList();
      renderComposer(container, companyId);
    });
    block.querySelector('.pick-widgets').addEventListener('click', () => {
      adminState.selected = { type: 'picker', id: companyId, dashboardId: d.id };
      renderAdminMain();
    });
  });

  container.querySelector('.new-dash-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api(`/api/admin/companies/${companyId}/dashboards`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())) });
    await renderAdminCompanyList();
    renderComposer(container, companyId);
  });
}

// ---------- company admin: manage their own dashboards ----------
async function renderMyDashboards(main, companyId) {
  main.innerHTML = `
    <div class="admin-head">
      <div>
        <h1 class="admin-h1">จัดการ Dashboard</h1>
        <p class="muted">สร้าง dashboard เลือก widget จาก catalog และจัดลำดับได้เอง ผู้ใช้ที่ดูอย่างเดียวจะเห็นเฉพาะ dashboard ที่คุณให้สิทธิ์ (ปุ่ม 👥)</p>
      </div>
    </div>
    <section class="admin-card">
      <h2>ข้อมูลบริษัท</h2>
      <form class="inline-form company-name-form">
        <label class="field" style="flex:2;min-width:220px;margin:0"><span>ชื่อบริษัท</span><input name="name" required minlength="2" maxlength="120" value="${esc(state.user.company_name || '')}"></label>
        <button type="submit" class="btn small primary">บันทึกชื่อ</button>
      </form>
      <p class="helper-text">รหัสบริษัท <strong class="company-code big">${esc(state.user.company_code || '')}</strong> — รหัสนี้ไม่เปลี่ยนแม้เปลี่ยนชื่อบริษัท ใช้อ้างอิงเมื่อติดต่อทีม KSS</p>
      <div class="name-msg"></div>
    </section>
    <section class="admin-card"><div class="composer"></div></section>
    <section class="admin-card" id="fmh-files">
      <h2>ข้อมูลย้อนหลังจากไฟล์ FMH (เกิน 90 วัน)</h2>
      <div class="fmh-files-panel"></div>
    </section>
    <section class="admin-card" id="pos-sales">
      <h2>ยอดขาย POS (Foodstory และ POS ที่ไม่มี API)</h2>
      <div class="pos-panel"></div>
    </section>`;
  renderComposer(main.querySelector('.composer'), companyId);
  renderFmhFilesPanel(main.querySelector('.fmh-files-panel'), companyId);
  renderPosPanel(main.querySelector('.pos-panel'), companyId);
  const nameForm = main.querySelector('.company-name-form');
  nameForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = main.querySelector('.name-msg');
    try {
      const { company } = await api(`/api/admin/companies/${companyId}/name`, { method: 'PATCH', body: JSON.stringify({ name: nameForm.name.value }) });
      state.user.company_name = company.name;
      el('company-name').textContent = `${company.name} · ${company.company_code}`;
      out.innerHTML = '<div class="ok-msg">บันทึกชื่อบริษัทแล้ว</div>';
    } catch (err) {
      out.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    }
  });
  if (adminState.focus === 'pos' || adminState.focus === 'fmh-files') {
    const target = main.querySelector(adminState.focus === 'pos' ? '#pos-sales' : '#fmh-files');
    adminState.focus = null;
    target.scrollIntoView({ block: 'start' });
  }
}

// ---------- History older than the API window, from FMH export files ----------
// FMH's API serves ~90 days. For six months or a year the customer exports the
// older months from FMH's report screen (one month per file is fine) and
// uploads them here. The browser reads the file (fmh-file.js) into rows shaped
// like the API's and sends them in chunks; the server merges them into the
// report before the API window. A document uploaded again replaces itself.
const FMH_FILE_CHUNK = 2000;
async function renderFmhFilesPanel(container, companyId, flash = '') {
  if (!container.innerHTML) container.innerHTML = '<p class="muted">กำลังโหลด...</p>';
  let o;
  try {
    o = await api(`/api/fmh-files/companies/${companyId}`);
  } catch (err) {
    container.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    return;
  }
  const months = Math.round(o.history_days / 30.4);
  const nameOf = (src) => (o.sources.find((x) => x.source === src) || {}).name || src;
  container.innerHTML = `
    <p class="helper-text" style="margin-top:0;">FMH API ดึงข้อมูลย้อนหลังได้ราว 90 วัน ถ้าต้องการดู 6 เดือนหรือทั้งปี ให้เปิดรายงานใน FMH เลือกช่วงวันที่ (ทีละเดือนก็ได้) กด Export แล้วอัปโหลดไฟล์ที่นี่ ไฟล์ถูกอ่านในเครื่องของคุณก่อนส่ง เก็บย้อนหลังได้ไม่เกิน ${months} เดือน และไม่ใช้โควตา FMH</p>
    <ul class="helper-text fmh-file-rules">
      <li>อัปโหลดเดือนเดิมซ้ำได้ — เอกสารเลขเดิม (SO / PO) จะแทนที่ของเดิม ไม่นับซ้ำ</li>
      <li>ช่วงที่ API มีข้อมูลอยู่แล้ว ระบบใช้ข้อมูลจาก API เสมอ ไฟล์ใช้เติมเฉพาะช่วงก่อนหน้า</li>
      <li>ตอน Export ให้เลือกเฉพาะออเดอร์ที่อนุมัติแล้ว (ไม่เอาที่ยกเลิก ถูกปฏิเสธ หรือรออนุมัติ) เพื่อให้ตัวเลขตรงกับข้อมูลจาก API</li>
    </ul>
    <table class="mini-table fmh-cover"><thead><tr><th>รายงาน</th><th>จาก API</th><th>จากไฟล์</th><th>ดาวน์โหลดจาก FMH ที่</th></tr></thead><tbody>${o.sources
      .map(
        (x) => `<tr><td>${esc(x.name)}</td>
          <td>${x.has_api && x.api_from ? `ตั้งแต่ ${esc(thDate(x.api_from))}` : '<span class="muted">–</span>'}</td>
          <td>${x.file_from ? `${esc(thDate(x.file_from))} – ${esc(thDate(x.file_to))}` : '<span class="muted">ยังไม่มี</span>'}</td>
          <td class="muted">${esc(x.fmh_menu)}</td></tr>`
      )
      .join('')}</tbody></table>
    <form class="inline-form fmh-file-form">
      <label class="pos-source">รายงาน
        <select name="source" aria-label="รายงาน">
          <option value="">ตรวจจากไฟล์อัตโนมัติ</option>
          ${o.sources.map((x) => `<option value="${esc(x.source)}">${esc(x.name)}</option>`).join('')}
        </select>
      </label>
      <input type="file" name="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" required aria-label="ไฟล์รายงานจาก FMH">
      <button type="submit" class="btn small primary">อ่านไฟล์</button>
    </form>
    <div class="fmh-file-msg">${flash}</div>
    <div class="fmh-file-step"></div>
    ${
      o.uploads.length
        ? `<h3 class="pos-h3">ไฟล์ที่อัปโหลด</h3>
           <div class="table-scroll"><table class="mini-table"><thead><tr><th>ไฟล์</th><th>รายงาน</th><th>ช่วงวันที่</th><th class="num">รายการ</th><th class="num">ยอดรวม</th><th>อัปโหลดเมื่อ</th><th></th></tr></thead><tbody>${o.uploads
             .map(
               (u) => `<tr data-id="${u.id}"><td>${esc(u.filename)}</td><td>${esc(nameOf(u.source))}</td>
                 <td>${esc(thDate(u.date_from))} – ${esc(thDate(u.date_to))}</td>
                 <td class="num">${Number(u.row_count).toLocaleString('th-TH')}<br><span class="muted">${Number(u.doc_count).toLocaleString('th-TH')} เอกสาร</span></td>
                 <td class="num">${baht(u.total)}</td>
                 <td>${esc(fmtDateTime(u.created_at))}${u.uploaded_by_email ? `<br><span class="muted">${esc(u.uploaded_by_email)}</span>` : ''}</td>
                 <td><button type="button" class="btn small danger fmh-file-del">ลบ</button></td></tr>`
             )
             .join('')}</tbody></table></div>`
        : '<p class="muted">ยังไม่มีไฟล์ย้อนหลัง</p>'
    }`;

  const msg = (html) => (container.querySelector('.fmh-file-msg').innerHTML = html);
  const step = container.querySelector('.fmh-file-step');
  const form = container.querySelector('.fmh-file-form');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = form.file.files[0];
    if (!file) return;
    msg('<p class="muted">กำลังอ่านไฟล์...</p>');
    step.innerHTML = '';
    let r;
    try {
      r = await FmhFile.read(await file.arrayBuffer(), file.name, { source: form.source.value || null });
    } catch (err) {
      msg(`<div class="error-msg">${esc(err.message)}</div>`);
      return;
    }
    if (r.error) {
      msg(`<div class="error-msg">${esc(r.error)}</div>`);
      return;
    }
    msg('');
    const info = o.sources.find((x) => x.source === r.profile) || {};
    const st = r.stats;
    const overlap = info.has_api && info.api_from && st.to >= info.api_from;
    const tooOld = st.from < isoDaysAgo(o.history_days);
    step.innerHTML = `
      <div class="pos-confirm">
        <h3 class="pos-h3">${esc(r.name)} · ${esc(file.name)}</h3>
        <div class="pos-summary">
          <div><span class="muted">ช่วงวันที่สั่ง</span><strong>${esc(thDate(st.from))} – ${esc(thDate(st.to))}</strong></div>
          <div><span class="muted">รายการ</span><strong>${st.rows.toLocaleString('th-TH')}</strong><span class="muted">${st.docs.toLocaleString('th-TH')} เอกสาร</span></div>
          <div><span class="muted">ยอดรวม</span><strong>${baht(st.total)}</strong></div>
        </div>
        ${overlap ? `<div class="warn-msg">ตั้งแต่ ${esc(thDate(info.api_from))} มีข้อมูลจาก API อยู่แล้ว — ช่วงนั้นระบบใช้ข้อมูลจาก API ส่วนไฟล์ใช้เติมช่วงก่อนหน้า</div>` : ''}
        ${tooOld ? `<div class="warn-msg">รายการที่เก่ากว่า ${esc(thDate(isoDaysAgo(o.history_days)))} จะไม่ถูกเก็บ</div>` : ''}
        ${!st.has_status ? '<p class="helper-text">ไฟล์นี้ไม่มีคอลัมน์สถานะ ระบบจึงนับทุกรายการในไฟล์ — ถ้า export รวมออเดอร์ที่ยกเลิกมาด้วย ให้ export ใหม่โดยกรองเฉพาะที่อนุมัติแล้ว</p>' : ''}
        ${st.skipped ? `<p class="helper-text">ข้าม ${st.skipped} บรรทัดที่ไม่มีเลขเอกสารหรือวันที่ (เช่น บรรทัดรวมท้ายไฟล์)</p>` : ''}
        <div class="inline-form"><button type="button" class="btn small primary fmh-file-save">บันทึกไฟล์นี้</button><button type="button" class="btn small ghost fmh-file-cancel">ยกเลิก</button><span class="fmh-file-progress muted"></span></div>
      </div>`;
    step.querySelector('.fmh-file-cancel').addEventListener('click', () => { step.innerHTML = ''; form.reset(); });
    step.querySelector('.fmh-file-save').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      const prog = step.querySelector('.fmh-file-progress');
      try {
        const { upload_id } = await api(`/api/fmh-files/companies/${companyId}/uploads`, { method: 'POST', body: JSON.stringify({ source: r.profile, filename: file.name }) });
        for (let i = 0; i < r.rows.length; i += FMH_FILE_CHUNK) {
          prog.textContent = `กำลังส่ง ${Math.min(i + FMH_FILE_CHUNK, r.rows.length).toLocaleString('th-TH')} / ${r.rows.length.toLocaleString('th-TH')} รายการ`;
          await api(`/api/fmh-files/companies/${companyId}/uploads/${upload_id}/rows`, { method: 'POST', body: JSON.stringify({ rows: r.rows.slice(i, i + FMH_FILE_CHUNK) }) });
        }
        prog.textContent = 'กำลังรวมเข้ากับข้อมูลเดิม...';
        const res = await api(`/api/fmh-files/companies/${companyId}/uploads/${upload_id}/commit`, { method: 'POST' });
        const replaced = res.replaced_lines ? ` · แทนที่ ${res.replaced_lines.toLocaleString('th-TH')} รายการของเอกสารเดิม` : '';
        container.innerHTML = '';
        renderFmhFilesPanel(container, companyId, `<div class="ok-msg">บันทึกแล้ว ${res.rows.toLocaleString('th-TH')} รายการ (${esc(thDate(res.date_from))} – ${esc(thDate(res.date_to))})${replaced} — เปิด dashboard แล้วเลือกช่วง 6 เดือนหรือ 1 ปีได้เลย</div>`);
      } catch (err) {
        btn.disabled = false;
        prog.textContent = '';
        msg(`<div class="error-msg">${esc(err.message)}</div>`);
      }
    });
  });

  container.querySelectorAll('.fmh-file-del').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('ลบไฟล์นี้? ข้อมูลย้อนหลังของช่วงในไฟล์นี้จะหายจาก dashboard (ข้อมูลจาก API ไม่หาย)')) return;
      try {
        await api(`/api/fmh-files/companies/${companyId}/uploads/${b.closest('tr').dataset.id}`, { method: 'DELETE' });
        renderFmhFilesPanel(container, companyId);
      } catch (err) {
        msg(`<div class="error-msg">${esc(err.message)}</div>`);
      }
    })
  );
}
const isoDaysAgo = (n) => {
  const d = new Date(Date.now() - n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------- POS sales file: upload + match menus to FMH recipes ----------
// The file is read and totalled in the browser (pos-parse.js): only daily
// totals per branch + menu are sent, never bill numbers, customer names or
// phone numbers. Matching is by menu name; what doesn't match is fixed here
// once and remembered.
const POS_STATUS = { matched: 'จับคู่แล้ว', unmatched: 'ยังไม่จับคู่', ignored: 'ไม่คิดต้นทุน' };
const baht = (n) => '฿' + Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 0 });
const thDate = (iso) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString(I18N.locale(), { day: 'numeric', month: 'short', year: 'numeric' }) : '–');

async function renderPosPanel(container, companyId, view = { filter: 'unmatched' }, flash = '') {
  if (!container.innerHTML) container.innerHTML = '<p class="muted">กำลังโหลด...</p>';
  let o;
  try {
    o = await api(`/api/pos/companies/${companyId}`);
  } catch (err) {
    container.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    return;
  }
  const s = o.summary;
  const counts = { all: o.menus.length };
  o.menus.forEach((m) => (counts[m.status] = (counts[m.status] || 0) + 1));
  if (view.filter === 'unmatched' && !counts.unmatched) view.filter = 'all';
  const shown = o.menus.filter((m) => view.filter === 'all' || m.status === view.filter);
  const recipeOptions = o.fmh_menus.map((m) => `<option value="${esc(m.name)}">${esc(m.name)} (฿${Number(m.cost).toLocaleString('th-TH', { maximumFractionDigits: 2 })})</option>`).join('');

  container.innerHTML = `
    <p class="helper-text" style="margin-top:0;">สำหรับร้านที่ POS ไม่มี API (เช่น Foodstory): export ไฟล์ยอดขายรายบิลแบบละเอียดเป็น CSV แล้วอัปโหลดที่นี่ ระบบจับคู่ชื่อเมนูกับสูตรใน FMH เพื่อคิดต้นทุนและกำไรขั้นต้น ไฟล์ถูกอ่านในเครื่องของคุณ ส่งขึ้นระบบเฉพาะยอดรวมรายวันต่อเมนู — ชื่อลูกค้าและเบอร์โทรไม่ถูกส่ง</p>
    <form class="inline-form pos-upload-form">
      <label class="pos-source">ไฟล์มาจาก POS
        <select name="source" aria-label="ไฟล์มาจาก POS">
          <option value="auto">ตรวจจากไฟล์อัตโนมัติ</option>
          ${o.builtin_profiles.map((b) => `<option value="b:${esc(b.id)}">${esc(b.name)}</option>`).join('')}
          ${o.profiles.map((p) => `<option value="p:${p.id}">${esc(p.name)} (รูปแบบที่บันทึกไว้)</option>`).join('')}
          <option value="custom">POS อื่น — จับคู่คอลัมน์เอง</option>
        </select>
      </label>
      <input type="file" name="file" accept=".csv,.txt,text/csv" required aria-label="ไฟล์ยอดขาย CSV">
      <button type="submit" class="btn small primary">อ่านไฟล์</button>
    </form>
    <div class="pos-msg">${flash}</div>
    <div class="pos-step"></div>
    ${
      o.profiles.length
        ? `<details class="pos-profiles"><summary>รูปแบบไฟล์ POS ที่บันทึกไว้ (${o.profiles.length})</summary>
             <table class="mini-table"><tbody>${o.profiles
               .map((p) => `<tr data-pid="${p.id}"><td>${esc(p.name)}</td><td class="muted">${esc(PosParse.ROLES.filter((r) => p.columns[r.key]).map((r) => `${r.label} = ${p.columns[r.key]}`).join(' · '))}</td><td><button type="button" class="btn small danger pos-del-profile">ลบ</button></td></tr>`)
               .join('')}</tbody></table></details>`
        : ''
    }
    ${
      o.demo_data
        ? '<p class="muted"><span class="demo-pill">ข้อมูลตัวอย่าง</span> ยังไม่มีไฟล์จริง — ใช้ไฟล์ POS ตัวอย่างของร้านเดโม อัปโหลดไฟล์จริงเมื่อไรจะใช้ไฟล์นั้นแทน</p>'
        : ''
    }
    ${
      !o.fmh_menus.length
        ? '<div class="warn-msg">ยังไม่มีสูตรเมนูจาก FMH ในระบบ — ต้องเชื่อม FMH API Key ก่อน ระบบจะดึงสูตรให้เองเมื่อมีการอัปโหลดหรือ sync</div>'
        : ''
    }
    ${
      s.date_from
        ? `<div class="pos-summary">
             <div><span class="muted">ช่วงข้อมูล</span><strong>${esc(thDate(s.date_from))} – ${esc(thDate(s.date_to))}</strong></div>
             <div><span class="muted">ยอดขายสุทธิ</span><strong>${baht(s.net_sales)}</strong></div>
             <div><span class="muted">จับคู่สูตรได้</span><strong>${s.coverage_pct == null ? '–' : s.coverage_pct + '%'}</strong><span class="muted">ของยอดขายอาหาร</span></div>
             <div><span class="muted">เมนูที่ยังไม่จับคู่</span><strong>${s.unmatched_menus}</strong></div>
           </div>`
        : '<p class="muted">ยังไม่มีไฟล์ยอดขาย</p>'
    }
    ${
      o.uploads.length
        ? `<h3 class="pos-h3">ไฟล์ที่อัปโหลด</h3>
           <table class="mini-table"><thead><tr><th>ไฟล์</th><th>POS</th><th>ช่วงวันที่</th><th class="num">ยอดสุทธิ</th><th>อัปโหลดเมื่อ</th><th></th></tr></thead><tbody>${o.uploads
             .map(
               (u) => `<tr data-id="${u.id}"><td>${esc(u.filename)}</td><td>${esc(u.pos_name || '')}</td>
                 <td>${esc(thDate(u.date_from))} – ${esc(thDate(u.date_to))}</td>
                 <td class="num">${baht(u.net_sales)}</td>
                 <td>${esc(fmtDateTime(u.created_at))}${u.uploaded_by_email ? `<br><span class="muted">${esc(u.uploaded_by_email)}</span>` : ''}</td>
                 <td><button type="button" class="btn small danger pos-del">ลบ</button></td></tr>`
             )
             .join('')}</tbody></table>`
        : ''
    }
    ${
      o.menus.length
        ? `<h3 class="pos-h3">จับคู่เมนู POS กับสูตร FMH</h3>
           <p class="helper-text" style="margin-top:0;">ชื่อที่ตรงกัน (ไม่สนช่องว่าง ตัวพิมพ์ และวงเล็บ) จับคู่ให้อัตโนมัติ ที่เหลือเลือกสูตรครั้งเดียว ระบบจำไว้ใช้กับไฟล์ต่อไป รายการที่ไม่ใช่อาหาร เช่น ค่าส่ง ค่าบริการ ให้กด "ไม่ใช่อาหาร" เพื่อไม่นับใน COGS %</p>
           <div class="pos-filter" role="group" aria-label="แสดง">
             ${['unmatched', 'matched', 'ignored', 'all']
               .map((f) => `<button type="button" class="range-chip${view.filter === f ? ' active' : ''}" data-f="${f}">${f === 'all' ? 'ทั้งหมด' : POS_STATUS[f]} (${counts[f] || 0})</button>`)
               .join('')}
           </div>
           <div class="table-scroll"><table class="mini-table pos-map-table"><thead><tr><th>เมนูใน POS</th><th class="num">ยอดขาย</th><th>สูตรใน FMH</th><th class="num">ต้นทุน/จาน</th><th></th></tr></thead><tbody>${shown
             .map(
               (m) => `<tr data-name="${esc(m.pos_menu_name)}" class="pos-${m.status}">
                 <td>${esc(m.pos_menu_name)}${m.pos_category ? `<br><span class="muted">${esc(m.pos_category)}</span>` : ''}</td>
                 <td class="num">${baht(m.net_sales)}<br><span class="muted">${Number(m.qty).toLocaleString('th-TH')} จาน</span></td>
                 <td>${
                   m.status === 'ignored'
                     ? '<span class="muted">ไม่ใช่อาหาร — ไม่คิดต้นทุน</span>'
                     : `<select class="pos-pick" aria-label="สูตรใน FMH"><option value="">— ${m.status === 'matched' ? 'เลิกจับคู่' : 'เลือกสูตร'} —</option>${recipeOptions}</select>
                        ${m.status === 'matched' && m.via === 'name' ? '<span class="muted pos-via">ชื่อตรงกัน</span>' : ''}
                        ${m.status === 'unmatched' && m.suggestion ? `<button type="button" class="btn small ghost pos-suggest" data-s="${esc(m.suggestion)}">ใช้ "${esc(m.suggestion)}"?</button>` : ''}`
                 }</td>
                 <td class="num">${m.unit_cost == null ? '–' : '฿' + Number(m.unit_cost).toLocaleString('th-TH', { maximumFractionDigits: 2 })}</td>
                 <td>${
                   m.status === 'ignored' || (m.via === 'manual' && m.status !== 'unmatched')
                     ? '<button type="button" class="btn small ghost pos-reset">ยกเลิก</button>'
                     : '<button type="button" class="btn small ghost pos-ignore">ไม่ใช่อาหาร</button>'
                 }</td></tr>`
             )
             .join('')}</tbody></table></div>`
        : ''
    }`;

  // Selected recipe per row (set after render so the option text stays plain).
  container.querySelectorAll('tr[data-name]').forEach((tr) => {
    const m = o.menus.find((x) => x.pos_menu_name === tr.dataset.name);
    const sel = tr.querySelector('.pos-pick');
    if (sel && m && m.status === 'matched') sel.value = m.fmh_menu_name;
  });

  const msg = (html) => (container.querySelector('.pos-msg').innerHTML = html);
  const save = async (body) => {
    try {
      await api(`/api/pos/companies/${companyId}/map`, { method: 'PUT', body: JSON.stringify(body) });
      renderPosPanel(container, companyId, view);
    } catch (err) {
      msg(`<div class="error-msg">${esc(err.message)}</div>`);
    }
  };
  container.querySelectorAll('.pos-filter .range-chip').forEach((b) =>
    b.addEventListener('click', () => renderPosPanel(container, companyId, { filter: b.dataset.f }))
  );
  container.querySelectorAll('.pos-pick').forEach((sel) =>
    sel.addEventListener('change', () => save({ pos_menu_name: sel.closest('tr').dataset.name, fmh_menu_name: sel.value || null }))
  );
  container.querySelectorAll('.pos-suggest').forEach((b) =>
    b.addEventListener('click', () => save({ pos_menu_name: b.closest('tr').dataset.name, fmh_menu_name: b.dataset.s }))
  );
  container.querySelectorAll('.pos-ignore').forEach((b) =>
    b.addEventListener('click', () => save({ pos_menu_name: b.closest('tr').dataset.name, ignore: true }))
  );
  container.querySelectorAll('.pos-reset').forEach((b) =>
    b.addEventListener('click', () => save({ pos_menu_name: b.closest('tr').dataset.name, fmh_menu_name: null, ignore: false }))
  );
  container.querySelectorAll('.pos-del').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('ลบไฟล์นี้? ยอดขายของวันที่อยู่ในไฟล์นี้จะหายจาก dashboard')) return;
      try {
        await api(`/api/pos/companies/${companyId}/uploads/${b.closest('tr').dataset.id}`, { method: 'DELETE' });
        renderPosPanel(container, companyId, view);
      } catch (err) {
        msg(`<div class="error-msg">${esc(err.message)}</div>`);
      }
    })
  );

  container.querySelectorAll('.pos-del-profile').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('ลบรูปแบบไฟล์นี้? ไฟล์ที่อัปโหลดไปแล้วไม่หาย แต่ครั้งหน้าต้องจับคู่คอลัมน์ใหม่')) return;
      try {
        await api(`/api/pos/companies/${companyId}/profiles/${b.closest('tr').dataset.pid}`, { method: 'DELETE' });
        renderPosPanel(container, companyId, view);
      } catch (err) {
        msg(`<div class="error-msg">${esc(err.message)}</div>`);
      }
    })
  );

  // ---- upload: read the file, settle which POS layout it is, preview, send ----
  const step = container.querySelector('.pos-step');
  const saved = o.profiles.map((p) => ({ id: `p:${p.id}`, name: p.name, columns: p.columns, date_order: p.date_order }));
  const builtins = PosParse.BUILTIN.map((b) => ({ ...b, id: `b:${b.id}` }));
  let file = null;
  let text = '';
  let info = null;

  const upload = async (profile, parsed, saveAs) => {
    step.innerHTML = '<p class="muted">กำลังอัปโหลด...</p>';
    try {
      const r = await api(`/api/pos/companies/${companyId}/uploads`, {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          format: profile.id === 'b:foodstory' ? 'foodstory' : 'custom',
          pos_name: saveAs ? saveAs.name : profile.name,
          profile: saveAs || undefined,
          rows: parsed.rows,
        }),
      });
      const st = parsed.stats;
      renderPosPanel(
        container,
        companyId,
        { filter: 'unmatched' },
        `<div class="ok-msg">อัปโหลดแล้ว: ${esc(r.pos_name)} · ${esc(thDate(r.date_from))} – ${esc(thDate(r.date_to))} · ${st.lines.toLocaleString('th-TH')} รายการ · ${st.branches.map(esc).join(', ')} · ยอดสุทธิ ${baht(r.net_sales)}${r.replaced ? ' · แทนที่ข้อมูลเดิมของวันเดียวกันแล้ว' : ''}${st.skipped ? ` · ข้าม ${st.skipped} แถวที่ไม่ใช่รายการขาย` : ''}${saveAs ? ' · บันทึกรูปแบบไฟล์แล้ว ครั้งหน้าไม่ต้องจับคู่คอลัมน์อีก' : ''}</div>`
      );
    } catch (err) {
      step.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    }
  };

  const previewTable = (parsed) => `
    <div class="table-scroll"><table class="mini-table"><thead><tr><th>วันที่</th><th>สาขา</th><th>เมนู</th><th class="num">จำนวน</th><th class="num">ยอดสุทธิ</th></tr></thead><tbody>${parsed.rows
      .slice(0, 5)
      .map((r) => `<tr><td>${esc(thDate(r.sale_date))}</td><td>${esc(r.branch)}</td><td>${esc(r.menu_name)}</td><td class="num">${Number(r.qty).toLocaleString('th-TH')}</td><td class="num">${baht(r.net_sales)}</td></tr>`)
      .join('')}</tbody></table></div>`;
  const statsLine = (st) =>
    `${st.lines.toLocaleString('th-TH')} รายการ · ${st.menus} เมนู · ${st.branches.length} สาขา · ${esc(thDate(st.date_from))} – ${esc(thDate(st.date_to))} · ยอดสุทธิ ${baht(st.net_sales)}`;

  // A layout the file matches: show what was read and confirm.
  function showConfirm(profile) {
    let parsed;
    try {
      parsed = PosParse.aggregate(text, { columns: profile.columns, dateOrder: profile.date_order });
    } catch (err) {
      return showMapping(profile, err.message);
    }
    step.innerHTML = `
      <div class="pos-card">
        <p><strong>ไฟล์จาก ${esc(profile.name)}</strong> · ${statsLine(parsed.stats)}</p>
        ${previewTable(parsed)}
        <p class="helper-text">ตัวอย่าง 5 แถวแรกหลังรวมยอดรายวันต่อเมนู ถ้าวันที่หรือยอดไม่ถูก ให้จับคู่คอลัมน์ใหม่</p>
        <div class="inline-form">
          <button type="button" class="btn small primary pos-go">ยืนยันอัปโหลด</button>
          <button type="button" class="btn small ghost pos-remap">จับคู่คอลัมน์เอง</button>
          <button type="button" class="btn small ghost pos-cancel">ยกเลิก</button>
        </div>
      </div>`;
    step.querySelector('.pos-go').addEventListener('click', () => upload(profile, parsed, null));
    step.querySelector('.pos-remap').addEventListener('click', () => showMapping(profile));
    step.querySelector('.pos-cancel').addEventListener('click', () => (step.innerHTML = ''));
  }

  // A file no layout fits (or the user wants to fix one): map the columns.
  function showMapping(start, problem) {
    const header = info.header;
    const sampleOf = (name) => {
      const i = header.indexOf(name);
      const vals = i < 0 ? [] : info.sample.map((r) => String(r[i] ?? '').trim()).filter(Boolean).slice(0, 2);
      return vals.join(' · ');
    };
    const pre = { ...info.guess, ...((start && start.columns) || {}) };
    const isSaved = start && String(start.id).startsWith('p:');
    step.innerHTML = `
      <div class="pos-card">
        ${problem ? `<div class="warn-msg">${esc(problem)}</div>` : ''}
        <p><strong>จับคู่คอลัมน์ของไฟล์</strong> · ${info.row_count.toLocaleString('th-TH')} แถว · ${header.length} คอลัมน์</p>
        <p class="helper-text" style="margin-top:0;">บอกระบบว่าคอลัมน์ไหนในไฟล์คือข้อมูลอะไร ช่องที่มี * ต้องเลือก ระบบจะจำรูปแบบนี้ไว้ ไฟล์ต่อไปจาก POS เดียวกันอัปโหลดได้ทันที</p>
        <div class="grid-2 pos-map-form">
          <div class="field"><label>ชื่อ POS *</label><input name="pos_name" maxlength="100" placeholder="เช่น Ocha, Loyverse, Wongnai POS" value="${esc(isSaved ? start.name : '')}"></div>
          <div class="field"><label>รูปแบบวันที่ในไฟล์</label>
            <select name="date_order">
              <option value="dmy">วัน/เดือน/ปี (31/12/2025)</option>
              <option value="mdy">เดือน/วัน/ปี (12/31/2025)</option>
              <option value="ymd">ปี-เดือน-วัน (2025-12-31)</option>
            </select></div>
          ${PosParse.ROLES.map(
            (r) => `<div class="field"><label>${esc(r.label)}${r.required ? ' *' : ''}</label>
              <select name="col_${r.key}" data-role="${r.key}"><option value="">— ${r.required ? 'เลือกคอลัมน์' : 'ไม่มีในไฟล์'} —</option>${header
                .map((h) => `<option value="${esc(h)}">${esc(h)}</option>`)
                .join('')}</select>
              <span class="muted pos-sample" data-role="${r.key}"></span></div>`
          ).join('')}
        </div>
        <div class="pos-live"></div>
        <div class="inline-form">
          <button type="button" class="btn small primary pos-go" disabled>บันทึกรูปแบบและอัปโหลด</button>
          <button type="button" class="btn small ghost pos-cancel">ยกเลิก</button>
        </div>
      </div>`;
    const form = step.querySelector('.pos-map-form');
    form.querySelector('[name=date_order]').value = (start && start.date_order) || info.date_order || 'dmy';
    PosParse.ROLES.forEach((r) => {
      const sel = form.querySelector(`[name=col_${r.key}]`);
      if (pre[r.key] && header.includes(pre[r.key])) sel.value = pre[r.key];
    });
    let current = null;
    const refresh = () => {
      const columns = {};
      PosParse.ROLES.forEach((r) => {
        const v = form.querySelector(`[name=col_${r.key}]`).value;
        if (v) columns[r.key] = v;
        form.querySelector(`.pos-sample[data-role=${r.key}]`).textContent = v ? `ตัวอย่าง: ${sampleOf(v) || '(ว่าง)'}` : '';
      });
      const live = step.querySelector('.pos-live');
      const go = step.querySelector('.pos-go');
      current = null;
      try {
        const parsed = PosParse.aggregate(text, { columns, dateOrder: form.querySelector('[name=date_order]').value });
        current = { columns, parsed };
        live.innerHTML = `<p class="muted">${statsLine(parsed.stats)}</p>${previewTable(parsed)}`;
      } catch (err) {
        live.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
      }
      go.disabled = !current || !form.querySelector('[name=pos_name]').value.trim();
    };
    form.addEventListener('change', refresh);
    form.querySelector('[name=pos_name]').addEventListener('input', refresh);
    refresh();
    step.querySelector('.pos-cancel').addEventListener('click', () => (step.innerHTML = ''));
    step.querySelector('.pos-go').addEventListener('click', () => {
      if (!current) return;
      const name = form.querySelector('[name=pos_name]').value.trim();
      const saveAs = { name, columns: current.columns, date_order: form.querySelector('[name=date_order]').value, signature: info.signature };
      upload({ id: 'custom', name }, current.parsed, saveAs);
    });
  }

  container.querySelector('.pos-upload-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    file = e.target.file.files[0];
    if (!file) return;
    msg('');
    step.innerHTML = '<p class="muted">กำลังอ่านไฟล์...</p>';
    try {
      if (!window.PosParse) throw new Error('ตัวอ่านไฟล์ยังโหลดไม่เสร็จ ลองใหม่อีกครั้ง');
      text = PosParse.decode(await file.arrayBuffer());
      info = PosParse.inspect(text, saved);
    } catch (err) {
      step.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
      return;
    }
    const choice = e.target.source.value;
    if (choice === 'custom') return showMapping(null);
    if (choice === 'auto') {
      const found = [...saved, ...builtins].find((p) => PosParse.profileFits(p, info.header));
      return found ? showConfirm(found) : showMapping(null, 'ไม่รู้จักรูปแบบไฟล์นี้ — จับคู่คอลัมน์ครั้งเดียว แล้วระบบจะจำไว้');
    }
    const picked = [...saved, ...builtins].find((p) => p.id === choice);
    if (picked && PosParse.profileFits(picked, info.header)) return showConfirm(picked);
    showMapping(picked, `ไฟล์นี้ไม่ตรงกับรูปแบบของ ${picked ? picked.name : 'POS ที่เลือก'} — ตรวจการจับคู่คอลัมน์ด้านล่าง`);
  });
}

// ---------- step 2: pick widgets for one dashboard from the catalog ----------
// Catalog groups in the order a client usually thinks about them, with Thai names.
const CAT_ORDER = [
  ['Cost Control', 'ต้นทุนและกำไรขั้นต้น'],
  ['POS COGS', 'ต้นทุนจากยอดขาย POS (อัปโหลดไฟล์ เช่น Foodstory)'],
  ['Cross-report', 'เทียบข้ามรายงาน (ซื้อ × ขาย × สูตร)'],
  ['Menu Costing', 'เมนูและสูตรอาหาร'],
  ['Actual vs Theoretical', 'ใช้จริงเทียบตามสูตร'],
  ['Purchasing', 'จัดซื้อ'],
  ['Price Change', 'ราคาที่ขยับ'],
  ['Supplier Quality', 'คุณภาพซัพพลายเออร์'],
  ['Line Checks', 'ตรวจเอกสารรายบรรทัด (PO / GRN / Invoice)'],
  ['Stock', 'สต็อกและของเสีย'],
  ['Branch', 'สาขาและครัวกลาง'],
  ['Sales', 'ยอดขายครัวกลาง'],
];
const catLabel = (c) => (CAT_ORDER.find(([k]) => k === c) || [c, c])[1];
const catRank = (c) => {
  const i = CAT_ORDER.findIndex(([k]) => k === c);
  return i < 0 ? 99 : i;
};
// Everything is staged in the browser and saved in one request, so a half-built
// dashboard never reaches the client. Selected widgets carry a yellow check and
// can be reordered; the rest of the catalog sits below with a + to add.
let pickerDirty = false;
window.addEventListener('beforeunload', (e) => {
  if (pickerDirty) { e.preventDefault(); e.returnValue = ''; }
});
const leavePicker = () => !pickerDirty || confirm('มีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก ออกจากหน้านี้เลยไหม?');

async function renderWidgetPicker(main, companyId, dashboardId) {
  main.innerHTML = '<p class="muted">กำลังโหลด...</p>';
  let company, dashboards, widgets;
  try {
    await loadTemplates();
    [{ company }, { dashboards }, { widgets }] = await Promise.all([
      api(`/api/admin/companies/${companyId}`),
      api(`/api/admin/companies/${companyId}/dashboards`),
      api(`/api/admin/dashboards/${dashboardId}/widgets`),
    ]);
  } catch (err) {
    main.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    return;
  }
  const dash = dashboards.find((d) => d.id === dashboardId);
  if (!dash) {
    adminState.selected = isSuper() ? { type: 'company', id: companyId } : { type: 'my-dashboards', id: companyId };
    return renderAdminMain();
  }
  const templates = adminState.templates.filter((t) => t.active);
  const tplById = new Map(adminState.templates.map((t) => [t.id, t]));
  const fromServer = (list) =>
    list.map((w) => ({ id: w.id, template_id: w.template_id, title: w.custom_title || '', overrides: { ...w.config_overrides } }));
  let picked = fromServer(widgets);
  let saved = JSON.stringify(picked);
  const filter = { q: '', cat: '', only: false };
  const open = new Set(); // rows with settings expanded
  pickerDirty = false;

  const cats = [...new Set(templates.map((t) => t.category))].sort((a, b) => catRank(a) - catRank(b) || a.localeCompare(b));
  const openCats = new Set(); // catalog groups the user expanded
  main.innerHTML = `
    <div class="picker-top">
      <button type="button" class="link-btn back-company">← ${esc(company.name)} · Dashboards</button>
      <div class="admin-head">
        <div>
          <h1 class="admin-h1">เลือก Widget: ${esc(dash.display_name)}</h1>
          <p class="muted">ติ๊กเพื่อเพิ่ม เรียงลำดับด้วย ▲▼ แล้วกดบันทึกครั้งเดียว</p>
        </div>
        <span class="picked-chip"><span class="ycheck sm" aria-hidden="true">✓</span> <span class="picked-count"></span></span>
      </div>
      <div class="picker-toolbar">
        <input type="search" class="picker-q" placeholder="ค้นหา widget..." aria-label="ค้นหา widget">
        <select class="picker-cat" aria-label="หมวด"><option value="">ทุกหมวด</option>${cats.map((c) => `<option value="${esc(c)}">${esc(catLabel(c))}</option>`).join('')}</select>
        <label class="nowrap"><input type="checkbox" class="picker-only"> เฉพาะที่เลือก</label>
      </div>
      <div class="picker-countline">
        <span class="muted picker-summary"></span>
        <span class="nowrap">
          <button type="button" class="btn small ghost pick-all">เลือกทั้งหมดที่แสดง</button>
          <button type="button" class="btn small ghost pick-none">ล้างที่เลือก</button>
        </span>
      </div>
    </div>
    <div class="picker-lists"></div>
    <div class="picker-bar">
      <button type="button" class="btn small ghost picker-discard">ยกเลิกการเปลี่ยนแปลง</button>
      <span class="picker-msg"></span>
      <button type="button" class="btn small ghost picker-preview">ดูตัวอย่าง</button>
      <button type="button" class="btn small primary picker-save">บันทึก</button>
    </div>`;

  const lists = main.querySelector('.picker-lists');
  const matches = (t) => {
    if (!t) return false;
    if (filter.cat && t.category !== filter.cat) return false;
    if (!filter.q) return true;
    const hay = `${t.name} ${t.description || ''} ${t.category} ${sourceLabel(t.report_source)}`.toLowerCase();
    return hay.includes(filter.q);
  };
  const filtering = () => !!(filter.q || filter.cat);
  const metaLine = (t) => `${esc(CHART_LABEL[t.chart_type] || t.chart_type)} · ${esc(sourceLabel(t.report_source))} · ${esc(catLabel(t.category))}`;
  const setDirty = () => {
    pickerDirty = JSON.stringify(picked) !== saved;
    const save = main.querySelector('.picker-save');
    save.disabled = !pickerDirty;
    main.querySelector('.picker-discard').disabled = !pickerDirty;
    main.querySelector('.picker-msg').textContent = pickerDirty ? 'มีการเปลี่ยนแปลงที่ยังไม่บันทึก' : '';
  };

  const draw = () => {
    const usedTpl = new Set(picked.map((p) => p.template_id));
    main.querySelector('.picked-count').textContent = `เลือกแล้ว ${picked.length} widget`;
    main.querySelector('.picker-summary').textContent = `เลือกแล้ว ${picked.length} จาก ${templates.length} widget ใน catalog`;

    const sel = picked.map((p, i) => ({ p, i, t: tplById.get(p.template_id) })).filter(({ t }) => !filtering() || matches(t));
    const rest = filter.only ? [] : templates.filter((t) => !usedTpl.has(t.id) && matches(t));
    const canMove = !filtering();

    lists.innerHTML = `
      <h3 class="picker-h">บน dashboard นี้ <span class="muted">(เรียงตามที่แสดงจริง)</span></h3>
      ${!filtering() ? '' : '<p class="muted small">ล้างคำค้นและหมวดก่อน ถึงจะเลื่อนลำดับได้</p>'}
      <div class="picker-rows">${
        sel.length
          ? sel
              .map(({ p, i, t }) => {
                const size = p.overrides.size || (t && JSON.parse(t.default_config_json || '{}').size) || 'half';
                return `<div class="picker-row is-picked" data-i="${i}">
                  <div class="picker-row-main">
                    <div class="order-btns">
                      <button type="button" class="icon-mini mv" data-dir="-1" ${!canMove || i === 0 ? 'disabled' : ''} aria-label="เลื่อนขึ้น">▲</button>
                      <button type="button" class="icon-mini mv" data-dir="1" ${!canMove || i === picked.length - 1 ? 'disabled' : ''} aria-label="เลื่อนลง">▼</button>
                    </div>
                    <span class="pos">${i + 1}</span>
                    <div class="widget-row-text">
                      <strong>${esc(p.title || (t ? t.name : 'template ที่ถูกลบ'))}</strong>
                      <span class="meta">${p.title && t ? `${esc(t.name)} · ` : ''}${t ? metaLine(t) : ''}</span>
                    </div>
                    <button type="button" class="ycheck unpick" title="เอาออก" aria-label="เอาออกจาก dashboard">✓</button>
                    <select class="size-select" aria-label="ความกว้าง">
                      <option value="full" ${size === 'full' ? 'selected' : ''}>เต็มแถว</option>
                      <option value="half" ${size === 'half' ? 'selected' : ''}>ครึ่งแถว</option>
                      <option value="third" ${size === 'third' ? 'selected' : ''}>1/3 แถว</option>
                    </select>
                    <button type="button" class="btn small ghost cfg">ตั้งค่า</button>
                    <button type="button" class="icon-mini danger-mini unpick" aria-label="เอาออก">✕</button>
                  </div>
                  ${
                    open.has(i)
                      ? `<div class="widget-edit">
                          <div class="field"><label>ชื่อที่แสดง (เว้นว่าง = ใช้ชื่อจาก catalog)</label><input class="cfg-title" value="${esc(p.title)}" placeholder="${esc(t ? t.name : '')}"></div>
                          ${
                            isSuper()
                              ? `<div class="field"><label>Config override (JSON เช่น {"top_n": 5})</label>
                            <textarea class="cfg-json" rows="4" spellcheck="false">${esc(Object.keys(p.overrides).length ? JSON.stringify(p.overrides, null, 2) : '')}</textarea></div>`
                              : ''
                          }
                          <div class="form-msg"></div>
                          <button type="button" class="btn small primary cfg-apply">ใช้ค่านี้</button>
                        </div>`
                      : ''
                  }
                </div>`;
              })
              .join('')
          : `<p class="muted">${filtering() ? 'ไม่มี widget ที่เลือกไว้ตรงกับตัวกรอง' : 'ยังไม่ได้เลือก widget — ติ๊กจากรายการด้านล่าง'}</p>`
      }</div>
      ${
        filter.only
          ? ''
          : `<h3 class="picker-h">เพิ่มจาก Catalog <span class="muted">(${rest.length})</span></h3>
             ${
               rest.length
                 ? cats
                     .map((c) => {
                       const items = rest.filter((t) => t.category === c);
                       if (!items.length) return '';
                       // Expanded when searching/filtering, otherwise only the groups the user opened.
                       const isOpen = filtering() || openCats.has(c);
                       return `<details class="cat-group" data-cat="${esc(c)}" ${isOpen ? 'open' : ''}>
                         <summary><span class="cat-name">${esc(catLabel(c))}</span> <span class="muted">${items.length}</span>
                           <button type="button" class="btn small ghost add-cat" data-cat="${esc(c)}">+ ทั้งหมวด</button></summary>
                         <div class="picker-rows">${items
                           .map(
                             (t) => `<button type="button" class="picker-row add-row" data-t="${t.id}">
                               <span class="addcheck" aria-hidden="true">+</span>
                               <span class="widget-row-text"><strong>${esc(t.name)}</strong><span class="meta">${esc(CHART_LABEL[t.chart_type] || t.chart_type)} · ${esc(sourceLabel(t.report_source))}</span>${t.description ? `<span class="desc">${esc(t.description)}</span>` : ''}</span>
                             </button>`
                           )
                           .join('')}</div>
                       </details>`;
                     })
                     .join('')
                 : '<p class="muted">ไม่มี widget ที่ตรงกับตัวกรอง</p>'
             }`
      }`;

    lists.querySelectorAll('.is-picked').forEach((row) => {
      const i = Number(row.dataset.i);
      row.querySelectorAll('.mv').forEach((b) =>
        b.addEventListener('click', () => {
          const j = i + Number(b.dataset.dir);
          [picked[i], picked[j]] = [picked[j], picked[i]];
          const oi = open.has(i), oj = open.has(j);
          open.delete(i); open.delete(j);
          if (oi) open.add(j);
          if (oj) open.add(i);
          draw(); setDirty();
        })
      );
      row.querySelectorAll('.unpick').forEach((b) =>
        b.addEventListener('click', () => {
          picked.splice(i, 1);
          open.clear();
          draw(); setDirty();
        })
      );
      row.querySelector('.size-select').addEventListener('change', (e) => {
        picked[i].overrides = { ...picked[i].overrides, size: e.target.value };
        draw(); setDirty();
      });
      row.querySelector('.cfg').addEventListener('click', () => {
        open.has(i) ? open.delete(i) : open.add(i);
        draw();
      });
      const apply = row.querySelector('.cfg-apply');
      if (apply)
        apply.addEventListener('click', () => {
          const box = row.querySelector('.cfg-json');
          // Company admins only rename; their size choice etc. is kept as is.
          const raw = box ? box.value.trim() : JSON.stringify(picked[i].overrides);
          let obj = {};
          try {
            obj = raw ? JSON.parse(raw) : {};
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error();
          } catch {
            row.querySelector('.form-msg').innerHTML = '<div class="error-msg">Config ต้องเป็น JSON object</div>';
            return;
          }
          picked[i] = { ...picked[i], title: row.querySelector('.cfg-title').value.trim(), overrides: obj };
          open.delete(i);
          draw(); setDirty();
        });
    });
    lists.querySelectorAll('.cat-group').forEach((d) =>
      d.addEventListener('toggle', () => {
        if (filtering()) return;
        d.open ? openCats.add(d.dataset.cat) : openCats.delete(d.dataset.cat);
      })
    );
    lists.querySelectorAll('.add-cat').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.preventDefault(); // don't toggle the group
        const used = new Set(picked.map((p) => p.template_id));
        templates
          .filter((t) => t.category === b.dataset.cat && !used.has(t.id) && matches(t))
          .forEach((t) => picked.push({ id: null, template_id: t.id, title: '', overrides: {} }));
        draw(); setDirty();
      })
    );
    lists.querySelectorAll('.add-row').forEach((b) =>
      b.addEventListener('click', () => {
        picked.push({ id: null, template_id: Number(b.dataset.t), title: '', overrides: {} });
        draw(); setDirty();
      })
    );
  };

  const q = main.querySelector('.picker-q');
  q.addEventListener('input', () => { filter.q = q.value.trim().toLowerCase(); draw(); });
  main.querySelector('.picker-cat').addEventListener('change', (e) => { filter.cat = e.target.value; draw(); });
  main.querySelector('.picker-only').addEventListener('change', (e) => { filter.only = e.target.checked; draw(); });
  main.querySelector('.pick-all').addEventListener('click', () => {
    const used = new Set(picked.map((p) => p.template_id));
    templates.filter((t) => !used.has(t.id) && matches(t)).forEach((t) => picked.push({ id: null, template_id: t.id, title: '', overrides: {} }));
    draw(); setDirty();
  });
  main.querySelector('.pick-none').addEventListener('click', () => {
    if (!picked.length) return;
    if (!confirm('เอา widget ทั้งหมดออกจาก dashboard นี้? (ยังไม่มีผลจนกว่าจะกดบันทึก)')) return;
    picked = [];
    open.clear();
    draw(); setDirty();
  });
  main.querySelector('.back-company').addEventListener('click', () => {
    if (!leavePicker()) return;
    pickerDirty = false;
    adminState.selected = isSuper() ? { type: 'company', id: companyId } : { type: 'my-dashboards', id: companyId };
    renderAdminMain();
  });
  main.querySelector('.picker-discard').addEventListener('click', () => {
    picked = JSON.parse(saved);
    open.clear();
    draw(); setDirty();
  });
  main.querySelector('.picker-preview').addEventListener('click', () => {
    if (!leavePicker()) return;
    pickerDirty = false;
    viewCompanyDashboards(companyId, dashboardId);
  });
  main.querySelector('.picker-save').addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'กำลังบันทึก...';
    try {
      const items = picked.map((p) => ({ ...(p.id ? { id: p.id } : { template_id: p.template_id }), title: p.title, config_overrides: p.overrides }));
      const r = await api(`/api/admin/dashboards/${dashboardId}/layout`, { method: 'PUT', body: JSON.stringify({ items }) });
      picked = fromServer(r.widgets);
      saved = JSON.stringify(picked);
      open.clear();
      draw(); setDirty();
      main.querySelector('.picker-msg').textContent = 'บันทึกแล้ว';
      renderAdminCompanyList();
    } catch (err) {
      main.querySelector('.picker-msg').textContent = err.message;
    } finally {
      btn.textContent = 'บันทึก';
    }
  });

  draw();
  setDirty();
}

// ---------- widget catalog ----------
async function renderCatalog(main) {
  await loadTemplates();
  const meta = adminState.meta;
  main.innerHTML = `
    <div class="admin-head">
      <div>
        <h1 class="admin-h1">Widget Catalog</h1>
        <p class="muted">คลัง widget กลางที่ใช้ซ้ำได้ทุกบริษัท — แก้ template ที่นี่ มีผลกับทุก dashboard ที่ใช้ template นั้น</p>
      </div>
      <button type="button" class="btn small primary new-template">+ สร้าง template ใหม่</button>
    </div>
    <div class="template-editor"></div>
    <section class="admin-card">
      <div class="table-scroll">
        <table class="report-table catalog-table">
          <thead><tr><th>Template</th><th>หมวด</th><th>Report source</th><th>ประเภท</th><th class="num">ใช้อยู่</th><th></th></tr></thead>
          <tbody>${adminState.templates
            .map(
              (t) => `<tr class="${t.active ? '' : 'inactive-row'}">
                <td><strong>${esc(t.name)}</strong>${t.customized ? ' <span class="pill">แก้ไขแล้ว</span>' : ''}${t.active ? '' : ' <span class="pill">ปิดใช้งาน</span>'}<div class="meta">${esc(t.description || '')}</div></td>
                <td>${esc(t.category)}</td>
                <td>${esc(sourceLabel(t.report_source))}</td>
                <td>${esc(CHART_LABEL[t.chart_type] || t.chart_type)}</td>
                <td class="num">${t.usage_count}</td>
                <td class="nowrap">
                  <button type="button" class="btn small ghost edit-t" data-id="${t.id}">แก้ไข</button>
                  <button type="button" class="btn small ghost copy-t" data-id="${t.id}">ทำสำเนา</button>
                  <button type="button" class="btn small ghost toggle-t" data-id="${t.id}">${t.active ? 'ปิด' : 'เปิด'}</button>
                </td></tr>`
            )
            .join('')}</tbody>
        </table>
      </div>
    </section>`;

  const editor = main.querySelector('.template-editor');
  const openEditor = (tpl, mode) => {
    const cfg = tpl ? JSON.stringify(JSON.parse(tpl.default_config_json || '{}'), null, 2) : '{\n  "size": "half"\n}';
    editor.innerHTML = `
      <section class="admin-card editor-card">
        <h2>${mode === 'edit' ? `แก้ไข: ${esc(tpl.name)}` : 'Template ใหม่'}</h2>
        <form class="template-form">
          <div class="grid-3">
            <div class="field"><label>ชื่อ</label><input name="name" required value="${esc(tpl ? (mode === 'copy' ? `${tpl.name} (สำเนา)` : tpl.name) : '')}"></div>
            <div class="field"><label>หมวด</label><input name="category" value="${esc(tpl ? tpl.category : 'General')}"></div>
            <div class="field"><label>Report source</label><select name="report_source">${Object.entries(meta.report_sources)
              .map(([k, v]) => `<option value="${k}" ${tpl && tpl.report_source === k ? 'selected' : ''}>${esc(v.label)}</option>`)
              .join('')}</select></div>
            <div class="field"><label>ประเภท (renderer)</label><select name="chart_type">${meta.chart_types
              .map((c) => `<option value="${c}" ${tpl && tpl.chart_type === c ? 'selected' : ''}>${esc(CHART_LABEL[c] || c)}</option>`)
              .join('')}</select></div>
            <div class="field span-2"><label>คำอธิบาย</label><input name="description" value="${esc(tpl ? tpl.description || '' : '')}"></div>
          </div>
          <div class="field"><label>Default config (JSON)</label><textarea name="default_config" rows="12" spellcheck="false">${esc(cfg)}</textarea></div>
          <div class="form-msg"></div>
          <div class="inline-form">
            <button type="submit" class="btn small primary">บันทึก template</button>
            <button type="button" class="btn small ghost cancel-edit">ยกเลิก</button>
          </div>
        </form>
      </section>`;
    editor.querySelector('.cancel-edit').addEventListener('click', () => (editor.innerHTML = ''));
    editor.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = Object.fromEntries(new FormData(f).entries());
      try {
        JSON.parse(body.default_config);
      } catch {
        f.querySelector('.form-msg').innerHTML = '<div class="error-msg">Default config ไม่ใช่ JSON ที่ถูกต้อง</div>';
        return;
      }
      try {
        if (mode === 'edit') await api(`/api/admin/widget-templates/${tpl.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        else await api('/api/admin/widget-templates', { method: 'POST', body: JSON.stringify(body) });
        renderCatalog(main);
      } catch (err) {
        f.querySelector('.form-msg').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
      }
    });
    editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const byId = (id) => adminState.templates.find((t) => t.id === Number(id));
  main.querySelector('.new-template').addEventListener('click', () => openEditor(null, 'new'));
  main.querySelectorAll('.edit-t').forEach((b) => b.addEventListener('click', () => openEditor(byId(b.dataset.id), 'edit')));
  main.querySelectorAll('.copy-t').forEach((b) => b.addEventListener('click', () => openEditor(byId(b.dataset.id), 'copy')));
  main.querySelectorAll('.toggle-t').forEach((b) =>
    b.addEventListener('click', async () => {
      const t = byId(b.dataset.id);
      await api(`/api/admin/widget-templates/${t.id}`, { method: 'PATCH', body: JSON.stringify({ active: !t.active }) });
      renderCatalog(main);
    })
  );
}
