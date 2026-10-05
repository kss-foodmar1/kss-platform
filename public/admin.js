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
};
const sourceLabel = (s) => (adminState.meta && adminState.meta.report_sources[s] ? adminState.meta.report_sources[s].label : s);

el('open-admin-btn').addEventListener('click', () => {
  if (el('admin-view').classList.contains('hidden')) openAdminConsole();
  else {
    showDashboardView();
    loadCompanyPicker(state.viewCompanyId).then(() => loadDashboards(state.activeDashboardId));
  }
});

async function openAdminConsole() {
  destroyCharts();
  el('dashboard-view').classList.add('hidden');
  el('admin-view').classList.remove('hidden');
  el('open-admin-btn').textContent = '← กลับไปดู Dashboard';
  if (!adminState.meta) adminState.meta = await api('/api/admin/meta');
  await loadTemplates();
  await renderAdminCompanyList();
  if (!adminState.selected) adminState.selected = state.viewCompanyId ? { type: 'company', id: state.viewCompanyId } : { type: 'catalog' };
  renderAdminMain();
}

async function loadTemplates() {
  adminState.templates = (await api('/api/admin/widget-templates')).templates;
}

async function renderAdminCompanyList() {
  const { companies } = await api('/api/admin/companies');
  state.companies = companies;
  const list = el('admin-company-list');
  list.innerHTML = companies
    .map(
      (c) => `<button type="button" class="admin-nav-item company-item" data-id="${c.id}">
        <span class="company-item-name">${esc(c.name)}</span>
        <span class="company-item-meta">
          <span class="dot ${c.fmh_configured ? 'dot-good' : 'dot-off'}" title="${c.fmh_configured ? 'เชื่อม FMH แล้ว' : 'ยังไม่ได้ใส่ FMH key'}"></span>
          ${esc(STATUS_LABEL[c.status] || c.status)} · ${c.dashboard_count} dashboards
        </span>
      </button>`
    )
    .join('');
  list.querySelectorAll('.company-item').forEach((b) =>
    b.addEventListener('click', () => {
      adminState.selected = { type: 'company', id: Number(b.dataset.id) };
      renderAdminMain();
    })
  );
  markActiveNav();
}

function markActiveNav() {
  const sel = adminState.selected || {};
  document.querySelectorAll('#admin-view .admin-nav-item').forEach((b) => {
    const active = b.dataset.id ? sel.type === 'company' && Number(b.dataset.id) === sel.id : b.dataset.view === sel.type;
    b.classList.toggle('active', !!active);
  });
}

document.querySelectorAll('#admin-view .admin-nav-item[data-view]').forEach((b) =>
  b.addEventListener('click', () => {
    adminState.selected = { type: b.dataset.view };
    renderAdminMain();
  })
);

el('admin-add-company-btn').addEventListener('click', () => {
  adminState.selected = { type: 'new-company' };
  renderAdminMain();
});

function renderAdminMain() {
  markActiveNav();
  const sel = adminState.selected || {};
  const main = el('admin-main');
  main.scrollTop = 0;
  if (sel.type === 'company') return renderCompanyDetail(main, sel.id);
  if (sel.type === 'new-company') return renderNewCompany(main);
  if (sel.type === 'catalog') return renderCatalog(main);
  if (sel.type === 'fmh') return renderFmhDiagnostics(main);
  if (sel.type === 'staff') {
    main.innerHTML = `<h1 class="admin-h1">ทีม KSS</h1>
      <p class="muted">บัญชีทีม KSS เห็นทุกบริษัทและใช้ Admin Console ได้</p>
      <section class="admin-card"><div class="staff-users"></div></section>`;
    return renderUserManager(main.querySelector('.staff-users'), { kss: true });
  }
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
      .join('')}</select></div>`;
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
        <h1 class="admin-h1">${esc(c.name)}</h1>
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
  const modeLine = cfg.omise_mode
    ? `Omise: โหมด <strong>${cfg.omise_mode === 'test' ? 'ทดสอบ' : 'ใช้งานจริง'}</strong>`
    : '<span class="error-msg" style="display:inline-block">ยังไม่ได้ตั้งค่า OMISE_SECRET_KEY — สร้าง QR ไม่ได้ (ยังบันทึกโอนเงินเองได้)</span>';
  container.innerHTML = `
    <p class="helper-text" style="margin-top:0;">${modeLine} · Webhook ${cfg.webhook_secret_set ? 'ตั้งค่าแล้ว' : 'ยังไม่ได้ตั้งค่า (ระบบยังตรวจสถานะเองทุก 10 นาที)'} · ระงับอัตโนมัติเมื่อหมดอายุ: ${cfg.enforce_expiry ? `เปิด (ผ่อนผัน ${cfg.grace_days} วัน)` : 'ปิด'}</p>
    <form class="inline-form sub-form">
      <label>ใช้งานได้ถึง <input type="date" name="subscription_ends_at" value="${esc(info.subscription_ends_at || '')}"></label>
      <button type="submit" class="btn small">บันทึกวันหมดอายุ</button>
      <span class="muted">${info.subscription_ends_at ? '' : 'ว่าง = ไม่มีวันหมดอายุ (ลูกค้านำร่อง)'}</span>
    </form>
    <div class="sub-msg"></div>
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
    }`;

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
function templateOptions() {
  const byCat = {};
  adminState.templates
    .filter((t) => t.active)
    .forEach((t) => {
      (byCat[t.category] = byCat[t.category] || []).push(t);
    });
  return Object.entries(byCat)
    .map(
      ([cat, list]) =>
        `<optgroup label="${esc(cat)}">${list
          .map((t) => `<option value="${t.id}">${esc(t.name)} — ${esc(CHART_LABEL[t.chart_type] || t.chart_type)}</option>`)
          .join('')}</optgroup>`
    )
    .join('');
}

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
          <button type="button" class="btn small ghost preview-dash">ดูตัวอย่าง</button>
          <button type="button" class="btn small danger delete-dash">ลบ</button>
        </div>
      </div>
      <div class="widget-rows"><p class="muted">กำลังโหลด widget...</p></div>
      <div class="inline-form add-widget-row">
        <select class="add-widget-select" aria-label="เลือก widget จาก catalog">${templateOptions()}</select>
        <button type="button" class="btn small primary add-widget">+ วาง widget</button>
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
    block.querySelector('.add-widget').addEventListener('click', async () => {
      const templateId = Number(block.querySelector('.add-widget-select').value);
      if (!templateId) return;
      await api(`/api/admin/dashboards/${d.id}/widgets`, { method: 'POST', body: JSON.stringify({ template_id: templateId }) });
      renderWidgetRows(block.querySelector('.widget-rows'), d.id);
    });
    renderWidgetRows(block.querySelector('.widget-rows'), d.id);
  });

  container.querySelector('.new-dash-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api(`/api/admin/companies/${companyId}/dashboards`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())) });
    await renderAdminCompanyList();
    renderComposer(container, companyId);
  });
}

async function renderWidgetRows(container, dashboardId) {
  const { widgets } = await api(`/api/admin/dashboards/${dashboardId}/widgets`);
  if (!widgets.length) {
    container.innerHTML = '<p class="muted">ยังไม่มี widget — เลือกจาก catalog ด้านล่าง</p>';
    return;
  }
  container.innerHTML = '';
  widgets.forEach((w, idx) => {
    const row = document.createElement('div');
    row.className = 'widget-row';
    const size = w.config.size || 'half';
    row.innerHTML = `
      <div class="widget-row-main">
        <div class="order-btns">
          <button type="button" class="icon-mini move-w" data-dir="-1" ${idx === 0 ? 'disabled' : ''} aria-label="เลื่อนขึ้น">▲</button>
          <button type="button" class="icon-mini move-w" data-dir="1" ${idx === widgets.length - 1 ? 'disabled' : ''} aria-label="เลื่อนลง">▼</button>
        </div>
        <div class="widget-row-text">
          <strong>${esc(w.title)}</strong>
          <span class="meta">${esc(w.custom_title ? `${w.template_name} · ` : '')}${esc(CHART_LABEL[w.chart_type] || w.chart_type)} · ${esc(sourceLabel(w.report_source))}</span>
        </div>
        <select class="size-select" aria-label="ความกว้าง">
          <option value="full" ${size === 'full' ? 'selected' : ''}>เต็มแถว</option>
          <option value="half" ${size === 'half' ? 'selected' : ''}>ครึ่งแถว</option>
          <option value="third" ${size === 'third' ? 'selected' : ''}>1/3 แถว</option>
        </select>
        <button type="button" class="btn small ghost edit-w">ตั้งค่า</button>
        <button type="button" class="icon-mini danger-mini remove-w" aria-label="ลบ widget">✕</button>
      </div>
      <form class="widget-edit hidden">
        <div class="field"><label>ชื่อที่แสดง (เว้นว่าง = ใช้ชื่อจาก catalog)</label><input name="title" value="${esc(w.custom_title || '')}" placeholder="${esc(w.template_name)}"></div>
        <div class="field"><label>Config override (JSON — ค่าที่ต่างจาก template เช่น {"top_n": 5})</label>
          <textarea name="config" rows="4" spellcheck="false">${esc(Object.keys(w.config_overrides).length ? JSON.stringify(w.config_overrides, null, 2) : '')}</textarea></div>
        <div class="form-msg"></div>
        <button type="submit" class="btn small primary">บันทึก widget</button>
      </form>`;
    container.appendChild(row);

    const save = (title, overrides) =>
      api(`/api/admin/widgets/${w.id}`, { method: 'PATCH', body: JSON.stringify({ title, config_overrides: overrides }) });

    row.querySelectorAll('.move-w').forEach((b) =>
      b.addEventListener('click', async () => {
        const ids = widgets.map((x) => x.id);
        const j = idx + Number(b.dataset.dir);
        [ids[idx], ids[j]] = [ids[j], ids[idx]];
        await api(`/api/admin/dashboards/${dashboardId}/widget-order`, { method: 'PUT', body: JSON.stringify({ widget_ids: ids }) });
        renderWidgetRows(container, dashboardId);
      })
    );
    row.querySelector('.size-select').addEventListener('change', async (e) => {
      await save(w.custom_title, { ...w.config_overrides, size: e.target.value });
      renderWidgetRows(container, dashboardId);
    });
    row.querySelector('.edit-w').addEventListener('click', () => row.querySelector('.widget-edit').classList.toggle('hidden'));
    row.querySelector('.widget-edit').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await save(f.elements.title.value, f.elements.config.value.trim() || {});
        renderWidgetRows(container, dashboardId);
      } catch (err) {
        f.querySelector('.form-msg').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
      }
    });
    row.querySelector('.remove-w').addEventListener('click', async () => {
      if (!confirm(`เอา widget "${w.title}" ออกจาก dashboard นี้?`)) return;
      await api(`/api/admin/widgets/${w.id}`, { method: 'DELETE' });
      renderWidgetRows(container, dashboardId);
    });
  });
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
