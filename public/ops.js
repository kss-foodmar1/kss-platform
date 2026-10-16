// Support loop, on both sides of the glass.
//
//   KSS staff   งานวันนี้ (companies that need looking after)
//               เรื่องที่ลูกค้าแจ้ง (inbox)
//   Customer    Settings › สถานะระบบ (is my setup working, and how do I fix it)
//               แจ้งทีมงาน (a report that carries its own context)
//
// Both sides read the same health checks (lib/health.js), so what a customer
// sees on their status page is what KSS sees in the queue.

const OPS_KIND = {
  data: 'ตัวเลข/ข้อมูลไม่ตรง',
  connect: 'เชื่อมต่อข้อมูล',
  howto: 'วิธีใช้งาน',
  billing: 'แพ็กเกจ/ชำระเงิน',
  other: 'เรื่องอื่น',
};
const OPS_STATUS = { open: 'รอทีมงาน', doing: 'กำลังดูแล', done: 'เรียบร้อย' };
const OPS_STATE = { bad: 'ต้องแก้', warn: 'ควรดู', ok: 'ปกติ', off: 'ยังไม่ได้ตั้ง' };
// What a check's "go" means to each audience.
const OPS_TAB_KSS = { data: 'data', alerts: 'line', plan: 'billing', support: 'overview' };

const opsChip = (state) => `<span class="ops-chip ops-${state}">${esc(OPS_STATE[state] || state)}</span>`;
const opsAgo = (iso) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'เมื่อสักครู่';
  if (m < 60) return `${m} นาทีที่แล้ว`;
  if (m < 1440) return `${Math.round(m / 60)} ชั่วโมงที่แล้ว`;
  return `${Math.round(m / 1440)} วันที่แล้ว`;
};

// Icons for the KSS sidebar (the customer side nav uses navIcon directly).
function opsInitNavIcons() {
  document.querySelectorAll('#admin-view .admin-nav-item[data-icon]').forEach((b) => {
    if (!b.querySelector('svg')) b.insertAdjacentHTML('afterbegin', navIcon(b.dataset.icon));
  });
}
opsInitNavIcons();

// ---------- health checks list (both audiences) ----------
// opts.fixLabel: button text; opts.onGo(check): what the button does.
function renderHealthChecks(container, checks, opts = {}) {
  container.innerHTML = `<ul class="ops-checks">${checks
    .map((c, i) => `<li class="ops-check ops-${c.state}">
      <span class="ops-dot" aria-hidden="true"></span>
      <div class="ops-check-body">
        <div class="ops-check-head"><b>${esc(c.label)}</b>${opsChip(c.state)}</div>
        <p class="ops-detail">${esc(c.detail)}${c.since ? ` <span class="muted">· ${esc(opsAgo(c.since))}</span>` : ''}</p>
        ${c.fix && c.state !== 'ok' ? `<p class="ops-fix">${esc(c.fix)}</p>` : ''}
        ${opts.showRaw && c.raw ? `<p class="ops-raw"><code>${esc(c.raw)}</code></p>` : ''}
      </div>
      ${c.go && c.state !== 'ok' && opts.onGo ? `<button type="button" class="btn small ghost" data-i="${i}">${esc(c.go === 'support' && opts.supportLabel ? opts.supportLabel : opts.fixLabel || 'ไปแก้')}</button>` : ''}
    </li>`)
    .join('')}</ul>`;
  container.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => opts.onGo(checks[Number(b.dataset.i)])));
}

// ---------- KSS: badges in the sidebar ----------
async function refreshOpsBadges() {
  if (!isSuper()) return null;
  try {
    const d = await api('/api/admin/ops/attention');
    const set = (id, n) => {
      const b = el(id);
      if (!b) return;
      b.textContent = n;
      b.classList.toggle('hidden', !n);
    };
    set('home-badge', d.queue.filter((q) => q.level === 'bad').length);
    set('support-badge', d.inbox.support_new);
    return d;
  } catch (e) {
    return null;
  }
}

// ---------- KSS: งานวันนี้ ----------
async function renderAdminHome(main, shown = 25, filter = null) {
  main.innerHTML = '<p class="muted">กำลังโหลด...</p>';
  const d = await refreshOpsBadges();
  if (!d) {
    main.innerHTML = '<div class="error-msg">โหลดไม่สำเร็จ ลองรีเฟรชหน้านี้</div>';
    return;
  }
  const t = d.totals;
  if (!filter) filter = d.queue.some((q) => q.level === 'bad') ? 'bad' : 'all';
  const full = d.queue;
  d.queue = filter === 'all' ? full : full.filter((q) => q.level === filter);
  const nBad = full.filter((q) => q.level === 'bad').length, nWarn = full.filter((q) => q.level === 'warn').length;
  const today = new Date().toLocaleDateString(I18N.locale(), { weekday: 'long', day: 'numeric', month: 'long' });
  const inbox = [
    ['self-serve', 'คำขอสมัครที่รออนุมัติ', d.inbox.signups, ''],
    ['support', 'เรื่องที่ลูกค้าแจ้ง', d.inbox.support, d.inbox.support_new ? `ใหม่ ${d.inbox.support_new}` : ''],
    ['ai-questions', 'คำถามที่แชทตอบไม่ได้', d.inbox.chat_misses, ''],
  ];
  main.innerHTML = `
    <div class="admin-head"><div><h1 class="admin-h1">งานวันนี้</h1><p class="muted">${esc(today)}</p></div></div>
    <section class="ops-inbox" aria-label="กล่องงาน">
      ${inbox.map(([v, label, n, extra]) => `<button type="button" class="ops-inbox-item${n ? ' has' : ''}" data-view="${v}"><span class="ops-inbox-n">${n}</span><span>${esc(label)}${extra ? ` <b class="ops-new">${esc(extra)}</b>` : ''}</span></button>`).join('')}
    </section>
    <section class="admin-card">
      <h2>บริษัทที่ต้องดูแล</h2>
      <div class="settings-tabs" role="group" aria-label="กรองตามความเร่งด่วน">
        ${[['bad', `ต้องแก้ (${nBad})`], ['warn', `ควรดู (${nWarn})`], ['all', `ทั้งหมด (${full.length})`]].map(([k, l]) => `<button type="button" class="settings-tab${filter === k ? ' on' : ''}" data-f="${k}" aria-pressed="${filter === k}">${l}</button>`).join('')}
      </div>
      <p class="ops-sum muted">บริษัทปกติ ${t.ok} · เรียงตามความเร่งด่วน: เชื่อมข้อมูลไม่ได้ ก่อนหมดอายุ ก่อน LINE ก่อน POS</p>
      ${d.queue.length
        ? `<ul class="ops-queue">${d.queue.slice(0, shown).map((q, i) => `<li class="ops-q ops-${q.level}">
            <div class="ops-q-head">
              <button type="button" class="ops-q-name" data-i="${i}">${esc(q.name)}</button>
              <span class="company-code">${esc(q.code || '')}</span>
              ${q.open_support ? `<button type="button" class="ops-q-sup" data-sup="${q.company_id}">แจ้งไว้ ${q.open_support} เรื่อง</button>` : ''}
            </div>
            <ul class="ops-q-issues">${q.issues.map((c) => `<li>${opsChip(c.state)} <b>${esc(c.label)}</b> — ${esc(c.detail)}<button type="button" class="link-btn ops-q-go" data-i="${i}" data-k="${esc(c.key)}">เปิดดู</button></li>`).join('')}</ul>
          </li>`).join('')}</ul>${d.queue.length > shown ? `<button type="button" class="btn small ghost ops-more">แสดงเพิ่ม (เหลือ ${d.queue.length - shown} บริษัท)</button>` : ''}`
        : '<p class="ops-empty">ไม่มีบริษัทที่ต้องดูแลตอนนี้ ทุกบริษัทเชื่อมข้อมูลปกติ และไม่มีเรื่องค้าง</p>'}
    </section>`;
  main.querySelectorAll('.ops-inbox-item').forEach((b) => b.addEventListener('click', () => { adminState.selected = { type: b.dataset.view }; renderAdminMain(); }));
  const open = (i, key) => openCompanyTab(d.queue[i].company_id, key ? ({ fmh: 'overview', pos: 'data', line: 'line', plan: 'billing' }[key] || 'overview') : 'overview');
  main.querySelectorAll('.ops-q-name').forEach((b) => b.addEventListener('click', () => open(Number(b.dataset.i))));
  main.querySelectorAll('.ops-q-go').forEach((b) => b.addEventListener('click', () => open(Number(b.dataset.i), b.dataset.k)));
  main.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => renderAdminHome(main, 25, b.dataset.f)));
  const more = main.querySelector('.ops-more');
  if (more) more.addEventListener('click', () => renderAdminHome(main, shown + 25, filter));
  main.querySelectorAll('.ops-q-sup').forEach((b) => b.addEventListener('click', () => openCompanyTab(Number(b.dataset.sup), 'support')));
}

function openCompanyTab(companyId, tab) {
  if (typeof leavePicker === 'function' && !leavePicker()) return;
  adminState.selected = { type: 'company', id: companyId, tab };
  renderAdminMain();
}

// ---------- support cards (KSS inbox and a company's own tab) ----------
function opsContextChips(ctx) {
  const labels = { page: 'หน้า', dashboard_name: 'Dashboard', widget_title: 'Widget', date_range: 'ช่วงวันที่', filters: 'ตัวกรอง', error: 'ข้อความที่เห็น' };
  return Object.keys(labels).filter((k) => ctx && ctx[k]).map((k) => `<span class="ops-ctx"><i>${labels[k]}</i> ${esc(ctx[k])}</span>`).join('');
}

function renderSupportList(container, list, { withCompany, onChange }) {
  if (!list.length) {
    container.innerHTML = '<p class="ops-empty">ไม่มีเรื่องค้าง</p>';
    return;
  }
  container.innerHTML = `<ul class="ops-sup">${list.map((r) => `<li class="ops-sup-item ops-s-${r.status}" data-id="${r.id}">
    <div class="ops-sup-head">
      <span class="ops-kind">${esc(OPS_KIND[r.kind] || r.kind)}</span>
      ${withCompany ? `<button type="button" class="ops-q-name" data-co="${r.company_id}">${esc(r.company)}</button>` : ''}
      <span class="muted">${esc(r.who || r.who_email || '')} · ${esc(opsAgo(r.created_at))}</span>
      <span class="ops-status ops-st-${r.status}">${esc(OPS_STATUS[r.status])}</span>
    </div>
    <p class="ops-msg">${esc(r.message)}</p>
    ${opsContextChips(r.context) ? `<div class="ops-ctxs">${opsContextChips(r.context)}</div>` : ''}
    <div class="ops-sup-act">
      <label class="sr-only" for="sn-${r.id}">บันทึกถึงลูกค้า</label>
      <input id="sn-${r.id}" class="ops-note" maxlength="500" placeholder="ข้อความถึงลูกค้า (ลูกค้าเห็นในหน้าสถานะระบบ)" value="${esc(r.note || '')}">
      ${r.status === 'open' ? '<button type="button" class="btn small" data-st="doing">รับเรื่อง</button>' : ''}
      ${r.status !== 'done' ? '<button type="button" class="btn small primary" data-st="done">เสร็จแล้ว</button>' : '<button type="button" class="btn small ghost" data-st="open">เปิดใหม่</button>'}
    </div>
  </li>`).join('')}</ul>`;
  container.querySelectorAll('[data-co]').forEach((b) => b.addEventListener('click', () => openCompanyTab(Number(b.dataset.co), 'support')));
  container.querySelectorAll('[data-st]').forEach((b) =>
    b.addEventListener('click', async () => {
      const item = b.closest('.ops-sup-item');
      b.disabled = true;
      try {
        await api(`/api/admin/ops/support/${item.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ status: b.dataset.st, note: item.querySelector('.ops-note').value }) });
        refreshOpsBadges();
        onChange();
      } catch (err) {
        b.disabled = false;
        item.insertAdjacentHTML('beforeend', `<div class="error-msg" role="alert">${esc(err.message)}</div>`);
      }
    })
  );
}

async function renderSupportInbox(main, view = {}) {
  const status = view.status || '';
  main.innerHTML = '<p class="muted">กำลังโหลด...</p>';
  let r;
  try {
    r = await api(`/api/admin/ops/support${status ? `?status=${status}` : ''}`);
  } catch (err) {
    main.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    return;
  }
  main.innerHTML = `
    <h1 class="admin-h1">เรื่องที่ลูกค้าแจ้ง</h1>
    <p class="muted">ลูกค้ากด แจ้งทีมงาน จากหน้าที่เจอปัญหา ระบบแนบหน้า Dashboard และ widget มาให้ ข้อความที่คุณพิมพ์ในช่องบันทึกลูกค้าจะเห็นเอง</p>
    <div class="settings-tabs" role="tablist">
      ${[['', 'ที่ยังไม่เสร็จ'], ['done', 'เสร็จแล้ว']].map(([k, l]) => `<button type="button" role="tab" class="settings-tab${status === k ? ' on' : ''}" data-st="${k}" aria-selected="${status === k}">${l}</button>`).join('')}
    </div>
    <div class="sup-list"></div>`;
  main.querySelectorAll('.settings-tab').forEach((b) => b.addEventListener('click', () => renderSupportInbox(main, { status: b.dataset.st })));
  renderSupportList(main.querySelector('.sup-list'), r.list, { withCompany: true, onChange: () => renderSupportInbox(main, { status }) });
}

async function renderCompanySupport(container, companyId) {
  container.innerHTML = '<p class="muted">กำลังโหลด...</p>';
  const open = await api(`/api/admin/ops/support?company_id=${companyId}`);
  const done = await api(`/api/admin/ops/support?company_id=${companyId}&status=done`);
  container.innerHTML = `
    <section class="admin-card"><h2>ที่ยังไม่เสร็จ</h2><div class="sup-open"></div></section>
    <section class="admin-card"><h2>เสร็จแล้ว</h2><div class="sup-done"></div></section>`;
  const again = () => renderCompanySupport(container, companyId);
  renderSupportList(container.querySelector('.sup-open'), open.list, { withCompany: false, onChange: again });
  renderSupportList(container.querySelector('.sup-done'), done.list, { withCompany: false, onChange: again });
}

// ---------- Customer: สถานะระบบ ----------
async function renderStatusTab(body, companyId) {
  body.innerHTML = '<p class="muted">กำลังตรวจสถานะ...</p>';
  let h, mine;
  try {
    [h, mine] = await Promise.all([api(`/api/health${isSuper() ? `?company_id=${companyId}` : ''}`), api('/api/support/mine')]);
  } catch (err) {
    body.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    return;
  }
  const headline = { ok: 'ทุกอย่างทำงานปกติ', warn: 'มีเรื่องที่ควรดู', bad: 'มีเรื่องที่ต้องแก้' }[h.level] || 'ทุกอย่างทำงานปกติ';
  const level = h.level === 'off' ? 'ok' : h.level;
  body.innerHTML = `
    <div class="ops-banner ops-${level}" role="status"><span class="ops-dot" aria-hidden="true"></span><b>${esc(headline)}</b></div>
    <p class="muted settings-lead">ตรวจจากข้อมูลจริงของบริษัทคุณ ถ้ามีรายการที่ต้องแก้ กดปุ่มข้างรายการเพื่อไปหน้าที่แก้ได้เลย แก้เองไม่ได้หรือไม่แน่ใจ กด แจ้งทีมงาน</p>
    <section class="admin-card"><div class="health-list"></div></section>
    <section class="admin-card">
      <div class="admin-head"><h2>เรื่องที่แจ้งทีมงานไว้</h2><button type="button" class="btn small primary" id="status-report">แจ้งทีมงาน</button></div>
      ${mine.list.length
        ? `<ul class="ops-mine">${mine.list.map((r) => `<li><div class="ops-sup-head"><span class="ops-kind">${esc(OPS_KIND[r.kind] || r.kind)}</span><span class="muted">${esc(r.who || '')} · ${esc(opsAgo(r.created_at))}</span><span class="ops-status ops-st-${r.status}">${esc(OPS_STATUS[r.status])}</span></div><p class="ops-msg">${esc(r.message)}</p>${r.note ? `<p class="ops-reply"><b>ทีมงานตอบ:</b> ${esc(r.note)}</p>` : ''}</li>`).join('')}</ul>`
        : '<p class="ops-empty">ยังไม่เคยแจ้ง</p>'}
    </section>`;
  renderHealthChecks(body.querySelector('.health-list'), h.checks, {
    fixLabel: 'ไปแก้ที่นี่',
    supportLabel: 'แจ้งทีมงาน',
    onGo: (c) => c.go === 'support' ? openSupportForm({ kind: c.kind || 'connect', message: c.ask || '', onSent: () => renderStatusTab(body, companyId) }) : (c.go === 'plan' && !(state.user.subscription && state.user.subscription.self_serve) ? openSupportForm({ kind: 'billing', message: 'ขอต่ออายุ/สอบถามแพ็กเกจ' }) : openCompanySettings(c.go)),
  });
  body.querySelector('#status-report').addEventListener('click', () => openSupportForm({ onSent: () => renderStatusTab(body, companyId) }));
}

// ---------- Customer: แจ้งทีมงาน ----------
function supportContext(extra) {
  const inDash = !el('dashboard-view').classList.contains('hidden');
  const d = (state.dashboards || []).find((x) => x.id === state.activeDashboardId);
  const ctx = {};
  if (inDash) {
    ctx.page = 'Dashboard';
    if (d) { ctx.dashboard_id = d.id; ctx.dashboard_name = d.display_name; }
  } else if (state.navCurrent && state.navCurrent.kind === 'settings') {
    const t = (SETTINGS_TABS.find(([k]) => k === state.navCurrent.tab) || [])[1];
    ctx.page = `ตั้งค่า${t ? ' › ' + t : ''}`;
  } else if (state.navCurrent && state.navCurrent.kind === 'library') ctx.page = 'คลัง Widget';
  return Object.assign(ctx, extra || {});
}

function openSupportForm(opts = {}) {
  if (isSuper() || !state.user || !state.user.company_id) return;
  const prev = document.activeElement;
  const ctx = supportContext(opts.context);
  const root = document.createElement('div');
  root.className = 'modal-overlay';
  root.innerHTML = `
    <div class="modal-card ops-form" role="dialog" aria-modal="true" aria-labelledby="sup-title">
      <h2 id="sup-title">แจ้งทีมงาน</h2>
      <form novalidate>
        <fieldset class="ops-kinds"><legend class="sr-only">เรื่องอะไร</legend>
          ${Object.entries(OPS_KIND).map(([k, l]) => `<label class="ops-kind-opt"><input type="radio" name="kind" value="${k}"${k === (opts.kind || 'data') ? ' checked' : ''}><span>${esc(l)}</span></label>`).join('')}
        </fieldset>
        <div class="field"><label for="sup-msg">เกิดอะไรขึ้น</label>
          <textarea id="sup-msg" name="message" rows="4" maxlength="1000" required placeholder="เช่น ยอดซื้อสัปดาห์นี้ไม่ตรงกับที่เห็นใน FMH">${esc(opts.message || '')}</textarea></div>
        <p class="ops-attach">อย่าใส่รหัสผ่าน, API key หรือเลขบัตรในข้อความ ทีมงานไม่ต้องใช้ในการช่วยคุณ</p>
        ${opsContextChips(ctx) ? `<p class="ops-attach"><b>ระบบแนบให้อัตโนมัติ</b></p><div class="ops-ctxs">${opsContextChips(ctx)}</div>` : ''}
        <div class="sup-msg-out" role="alert"></div>
        <div class="row-actions" style="margin-top:14px"><button type="submit" class="btn primary">ส่งให้ทีมงาน</button><button type="button" class="btn ghost" data-close>ยกเลิก</button></div>
      </form>
    </div>`;
  document.body.appendChild(root);
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); if (prev && prev.focus) prev.focus(); };
  const onKey = (e) => {
    if (e.key === 'Escape') return close();
    if (e.key !== 'Tab') return;
    const f = [...root.querySelectorAll('button, input, textarea')].filter((n) => !n.disabled && n.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  };
  document.addEventListener('keydown', onKey);
  root.addEventListener('click', (e) => { if (e.target === root || e.target.closest('[data-close]')) close(); });
  const form = root.querySelector('form');
  form.message.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = root.querySelector('.sup-msg-out');
    const btn = form.querySelector('button[type=submit]');
    if (form.message.value.trim().length < 5) { out.innerHTML = '<div class="error-msg">บอกหน่อยว่าเกิดอะไรขึ้น (อย่างน้อย 5 ตัวอักษร)</div>'; form.message.focus(); return; }
    btn.disabled = true;
    try {
      await api('/api/support', { method: 'POST', body: JSON.stringify({ kind: form.kind.value, message: form.message.value, context: ctx }) });
      root.querySelector('.modal-card').innerHTML = `<h2 id="sup-title">ส่งให้ทีมงานแล้ว</h2><p>ทีมงาน KSS จะดูเรื่องนี้ และตอบกลับที่หน้า ตั้งค่า › สถานะระบบ</p><div class="row-actions"><button type="button" class="btn primary" data-close>ปิด</button></div>`;
      root.querySelector('[data-close]').focus();
      if (opts.onSent) opts.onSent();
    } catch (err) {
      btn.disabled = false;
      out.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
    }
  });
}
