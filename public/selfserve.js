// Self-serve signup, trial banner, plan page, lock screen, and the KSS review
// screen (server side: lib/selfServe.js, routes/selfServe.js).
// Loaded after app.js and admin.js; uses their helpers (api, esc, el, state…).

const SS_PLAN_LABEL = { 1: 'รายเดือน', 12: 'รายปี' };
const ssBaht = (n) => '฿' + Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const ssDay = (iso) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString(I18N.locale(), { day: 'numeric', month: 'short', year: 'numeric' }) : '–');

// ---------- signup (login screen) ----------
(async function initSignup() {
  let cfg = { enabled: false, trial_days: 30 };
  try { cfg = await api('/api/signup/config'); } catch (e) { return; }
  document.querySelectorAll('.trial-days').forEach((s) => { s.textContent = cfg.trial_days; });
  if (!cfg.enabled) return;
  const cta = el('signup-cta'), box = el('signup-box'), login = el('login-form');
  const sub = document.querySelector('#login-screen .sub');
  const subText = sub ? sub.textContent : '';
  cta.classList.remove('hidden');
  const showSignup = (on) => {
    login.classList.toggle('hidden', on);
    cta.classList.toggle('hidden', on);
    el('login-error').classList.add('hidden');
    box.classList.toggle('hidden', !on);
    if (sub) sub.textContent = on ? `ทดลองใช้ฟรี ${cfg.trial_days} วัน เริ่มจากข้อมูลตัวอย่าง แล้วเชื่อม FMH ของคุณเมื่อพร้อม` : subText;
    if (on) el('su-company').focus();
  };
  el('show-signup').addEventListener('click', (e) => { e.preventDefault(); showSignup(true); });
  el('show-login').addEventListener('click', (e) => { e.preventDefault(); showSignup(false); });
  el('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, err = el('signup-error');
    err.classList.add('hidden');
    const body = Object.fromEntries(new FormData(f).entries());
    body.consent = el('su-consent').checked;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api('/api/signup', { method: 'POST', body: JSON.stringify(body) });
      f.classList.add('hidden');
      el('signup-done').classList.remove('hidden');
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    }
    btn.disabled = false;
  });
})();

// ---------- trial / plan banner ----------
function renderSubBanner() {
  const b = el('sub-banner');
  const sub = state.user && state.user.subscription;
  if (!b) return;
  if (!sub || !sub.self_serve || sub.state === 'locked') { b.classList.add('hidden'); return; }
  const admin = isCompanyAdmin();
  const parts = [];
  let tone = 'info';
  if (sub.state === 'trial') {
    parts.push(`<strong>ทดลองใช้ฟรี</strong> เหลือ ${sub.days_left} วัน (ถึง ${esc(ssDay(sub.ends_at))})`);
    if (sub.days_left <= 7) tone = 'warn';
  } else if (sub.in_grace) {
    parts.push(`<strong>แพ็กเกจหมดอายุแล้ว</strong> เมื่อ ${esc(ssDay(sub.ends_at))} — ต่ออายุเพื่อใช้งานต่อ`);
    tone = 'warn';
  } else if (sub.days_left !== null && sub.days_left <= 7) {
    parts.push(`แพ็กเกจจะหมดอายุใน ${sub.days_left} วัน (${esc(ssDay(sub.ends_at))})`);
    tone = 'warn';
  } else { b.classList.add('hidden'); return; }
  if (sub.data_source === 'demo') parts.push('กำลังดู<strong>ข้อมูลตัวอย่าง</strong>');
  const buttons = [
    admin && sub.data_source === 'demo' ? '<button type="button" class="btn small ghost sb-key">ใส่ FMH API key เพื่อดูข้อมูลจริง</button>' : '',
    admin ? `<button type="button" class="btn small primary sb-plan">${sub.state === 'trial' ? 'ดูแพ็กเกจ' : 'ต่ออายุ'}</button>` : '',
  ].join('');
  b.className = `sub-banner tone-${tone}`;
  b.innerHTML = `<span>${parts.join(' · ')}</span><span class="sb-actions">${buttons}</span>`;
  const key = b.querySelector('.sb-key');
  if (key) key.addEventListener('click', () => el('open-settings-btn').click());
  const plan = b.querySelector('.sb-plan');
  if (plan) plan.addEventListener('click', openPlan);
}

function openPlan() {
  adminState.selected = { type: 'my-dashboards', id: state.user.company_id };
  adminState.focus = 'plan';
  openAdminConsole();
}

// ---------- plan page (company admin) ----------
async function renderPlanPanel(container) {
  container.innerHTML = '<p class="muted">กำลังโหลด...</p>';
  let d;
  try { d = await api('/api/subscription'); } catch (err) { container.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`; return; }
  const sub = d.subscription || {};
  const admin = isCompanyAdmin();
  const monthly = (d.prices || []).find((p) => p.period_months === 1);
  const yearly = (d.prices || []).find((p) => p.period_months === 12);
  const saving = monthly && yearly && monthly.amount_baht && yearly.amount_baht ? Math.round((1 - yearly.amount_baht / (monthly.amount_baht * 12)) * 100) : 0;
  const status =
    sub.state === 'trial' ? `ทดลองใช้ฟรี ถึง ${esc(ssDay(sub.ends_at))} (เหลือ ${sub.days_left} วัน) — ชำระตอนนี้ วันที่เหลือของช่วงทดลองไม่หาย แพ็กเกจเริ่มนับต่อจากวันหมดทดลอง`
    : sub.state === 'locked' ? `หมดอายุตั้งแต่ ${esc(ssDay(sub.ends_at))} — ชำระแล้วใช้งานต่อได้ทันที`
    : `ใช้งานได้ถึง ${esc(ssDay(sub.ends_at))}${sub.in_grace ? ' (หมดอายุแล้ว อยู่ในช่วงผ่อนผัน)' : ''} — ต่ออายุตอนนี้ เริ่มนับต่อจากวันหมดอายุเดิม`;
  const card = (p, extra) => {
    if (!p || !p.amount_baht) return '';
    const per = p.period_months === 12 ? `เฉลี่ย ${ssBaht(p.amount_baht / 12)} / เดือน` : 'ต่ออายุทีละเดือน';
    return `<div class="plan-option${p.period_months === 12 ? ' best' : ''}">
      ${p.period_months === 12 && saving > 0 ? `<span class="plan-flag">ประหยัด ${saving}%</span>` : ''}
      <div class="plan-name">${esc(SS_PLAN_LABEL[p.period_months])}</div>
      <div class="plan-price">${ssBaht(p.amount_baht)}</div>
      <div class="plan-per muted">${per}${extra || ''}</div>
      ${admin ? `<button type="button" class="btn ${p.period_months === 12 ? 'primary' : 'ghost'} block plan-pay" data-m="${p.period_months}" ${d.payments_enabled ? '' : 'disabled'}>ชำระด้วย PromptPay QR</button>` : ''}
    </div>`;
  };
  const anyPrice = (monthly && monthly.amount_baht) || (yearly && yearly.amount_baht);
  const history = (d.payments || []).length
    ? `<h3 class="pos-h3">ประวัติการชำระ</h3><div class="table-scroll"><table class="mini-table"><thead><tr><th>วันที่</th><th>รายการ</th><th class="num">จำนวนเงิน</th><th>สถานะ</th><th></th></tr></thead><tbody>${d.payments
        .map((p) => `<tr><td>${esc(fmtDateTime(p.paid_at || p.created_at))}</td><td>${esc(p.description)}</td><td class="num">${ssBaht(p.amount_baht)}</td>
          <td>${p.status === 'paid' ? `ชำระแล้ว${p.extended_to ? ` · ใช้ได้ถึง ${esc(ssDay(p.extended_to))}` : ''}` : p.status === 'pending' ? 'รอชำระ' : 'ยกเลิก'}</td>
          <td>${p.pay_path ? `<a href="${esc(p.pay_path)}">ไปหน้าชำระ</a>` : ''}</td></tr>`)
        .join('')}</tbody></table></div>`
    : '';
  container.innerHTML = `
    <p class="status-line">${status}</p>
    ${anyPrice ? `<div class="plan-options">${card(monthly)}${card(yearly)}</div>` : '<p class="muted">ยังไม่ได้ประกาศราคาแพ็กเกจ กรุณาติดต่อทีม KSS</p>'}
    ${!d.payments_enabled && anyPrice ? '<p class="warn-msg">ตอนนี้ยังชำระออนไลน์ไม่ได้ ติดต่อทีม KSS เพื่อชำระโดยการโอน แล้วทีมจะต่ออายุให้</p>' : ''}
    ${!admin ? '<p class="muted">ผู้ดูแลของบริษัทเป็นผู้ชำระเงิน</p>' : ''}
    <div class="plan-msg"></div>
    ${history}`;
  container.querySelectorAll('.plan-pay').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await api('/api/subscription/checkout', { method: 'POST', body: JSON.stringify({ period_months: Number(btn.dataset.m) }) });
        location.href = r.pay_path;
      } catch (err) {
        container.querySelector('.plan-msg').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
        btn.disabled = false;
      }
    })
  );
}

// ---------- lock screen ----------
async function showLockScreen() {
  if (showLockScreen.busy) return;
  showLockScreen.busy = true;
  try {
    if (!state.user || !state.user.subscription) state.user = (await api('/api/auth/me')).user;
  } catch (e) { /* render what we have */ }
  const sub = (state.user && state.user.subscription) || {};
  const wasTrial = state.user && state.user.company_status === 'trial';
  showScreen('lock');
  const body = el('lock-body');
  body.innerHTML = `
    <h1>${wasTrial ? 'ช่วงทดลองใช้ฟรีหมดแล้ว' : 'แพ็กเกจหมดอายุแล้ว'}</h1>
    <p class="sub">${esc(state.user ? state.user.company_name || '' : '')}</p>
    <p>${sub.data_purged
      ? 'ข้อมูลของบริษัทถูกลบไปแล้วเพราะหมดอายุนานเกินระยะเก็บรักษา ชำระแล้วตั้งค่าใหม่ได้ หรือติดต่อทีม KSS'
      : 'Dashboard การตั้งค่า และข้อมูลของคุณยังอยู่ครบ ชำระเงินแล้วใช้งานต่อได้ทันที'}</p>
    ${isCompanyAdmin() ? '<div class="plan-panel"></div>' : '<p class="muted">ติดต่อผู้ดูแลของบริษัทคุณเพื่อต่ออายุ</p>'}`;
  const panel = body.querySelector('.plan-panel');
  if (panel) await renderPlanPanel(panel);
  showLockScreen.busy = false;
}
document.querySelector('#lock-screen .lock-logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

// ---------- KSS: review signups, set prices, locked companies ----------
async function refreshSignupBadge() {
  const b = el('signup-badge');
  if (!b || !isSuper()) return;
  try {
    const d = await api('/api/admin/self-serve');
    b.textContent = d.pending_count;
    b.classList.toggle('hidden', !d.pending_count);
  } catch (e) { b.classList.add('hidden'); }
}

async function renderSelfServeAdmin(main, view = { status: 'pending' }, flash = '') {
  main.innerHTML = '<p class="muted">กำลังโหลด...</p>';
  let d;
  try { d = await api(`/api/admin/self-serve?status=${encodeURIComponent(view.status)}`); } catch (err) { main.innerHTML = `<div class="error-msg">${esc(err.message)}</div>`; return; }
  const price = (m) => { const p = d.prices.find((x) => x.period_months === m); return p && p.amount_baht ? p.amount_baht : ''; };
  const tabs = [['pending', `รออนุมัติ (${d.pending_count})`], ['approved', 'อนุมัติแล้ว'], ['rejected', 'ไม่อนุมัติ'], ['all', 'ทั้งหมด']];
  const FMH = { yes: 'ใช้ FMH อยู่', no: 'ยังไม่ใช้ FMH', unsure: 'ไม่แน่ใจเรื่อง FMH' };
  main.innerHTML = `
    <h1 class="admin-h1">สมัครเอง / ทดลองใช้</h1>
    <p class="muted">ลูกค้าสมัครจากหน้าเข้าสู่ระบบ → ทีม KSS อนุมัติ → บริษัททดลองใช้ ${d.trial_days} วันบนข้อมูลตัวอย่าง (ใส่ FMH key เองได้) → ชำระรายเดือน/รายปีในแอป → ถ้าไม่ชำระ ล็อกเหลือหน้าชำระเงิน เก็บข้อมูล ${d.retention_days} วัน</p>
    <p class="status-line"><span class="dot ${d.enabled ? 'dot-good' : 'dot-off'}" aria-hidden="true"></span> ${d.enabled ? 'เปิดรับสมัครอยู่' : 'ปิดรับสมัคร (ตั้ง SELF_SIGNUP=on ใน Railway เพื่อเปิด)'} · ${d.payments_enabled ? 'ชำระออนไลน์เปิดอยู่' : 'ชำระออนไลน์ปิดอยู่ ลูกค้าจะเห็นให้ติดต่อ KSS เพื่อโอน'}</p>
    <div class="ss-flash">${flash}</div>
    <section class="admin-card">
      <h2>ราคาแพ็กเกจ (ลูกค้าที่สมัครเอง)</h2>
      <form class="inline-form ss-prices">
        <label class="field" style="margin:0"><span>รายเดือน (บาท)</span><input name="monthly" type="number" min="20" step="1" value="${esc(price(1))}" placeholder="ไม่เปิดขาย"></label>
        <label class="field" style="margin:0"><span>รายปี (บาท)</span><input name="yearly" type="number" min="20" step="1" value="${esc(price(12))}" placeholder="ไม่เปิดขาย"></label>
        <button type="submit" class="btn small primary">บันทึกราคา</button>
      </form>
      <p class="helper-text">เว้นว่าง = ไม่เปิดขายแพ็กเกจนั้น · ราคาใช้กับลิงก์ชำระใหม่เท่านั้น · ลูกค้าที่ KSS ดูแลเอง ยังออกลิงก์ชำระที่หน้าบริษัทตามเดิม</p>
    </section>
    <section class="admin-card">
      <h2>คำขอสมัคร</h2>
      <div class="ss-tabs">${tabs.map(([k, l]) => `<button type="button" class="btn small ${k === view.status ? 'primary' : 'ghost'}" data-s="${k}">${esc(l)}</button>`).join('')}</div>
      ${d.signups.length ? d.signups.map((s) => `
        <div class="ss-row" data-id="${s.id}">
          <div class="ss-main">
            <strong>${esc(s.company_name)}</strong> <span class="muted">· ${esc(fmtDateTime(s.created_at))}</span><br>
            ${esc(s.contact_name)} · ${esc(s.email)} · ${esc(s.phone)}<br>
            <span class="muted">${esc(s.branches ? `${s.branches} สาขา` : '')} · ${esc(FMH[s.uses_fmh] || '')}</span>
            ${s.note ? `<p class="ss-note">“${esc(s.note)}”</p>` : ''}
            ${s.status !== 'pending' ? `<p class="muted">${s.status === 'approved' ? 'อนุมัติแล้ว' : 'ไม่อนุมัติ'} โดย ${esc(s.decided_by_email || '-')} เมื่อ ${esc(fmtDateTime(s.decided_at))}${s.decision_note ? ` · ${esc(s.decision_note)}` : ''}</p>` : ''}
          </div>
          ${s.status === 'pending' ? `<div class="ss-actions">
            <input class="ss-note-input" placeholder="หมายเหตุ (ไม่บังคับ)" maxlength="255">
            <button type="button" class="btn small primary ss-approve">อนุมัติ เริ่มทดลอง ${d.trial_days} วัน</button>
            <button type="button" class="btn small ghost ss-reject">ไม่อนุมัติ</button>
          </div>` : ''}
        </div>`).join('') : '<p class="muted">ไม่มีรายการ</p>'}
    </section>
    <section class="admin-card">
      <h2>บริษัทที่ล็อกอยู่ (หมดทดลอง/หมดอายุ ไม่ได้ชำระ)</h2>
      ${d.locked.length ? `<div class="table-scroll"><table class="mini-table"><thead><tr><th>บริษัท</th><th>หมดอายุ</th><th class="num">ล็อกมาแล้ว (วัน)</th><th></th></tr></thead><tbody>${d.locked
        .map((c) => `<tr data-id="${c.id}"><td>${esc(c.name)} <span class="muted">${esc(c.company_code || '')}</span></td><td>${esc(ssDay(c.ends_at))}</td><td class="num">${c.locked_days}</td>
          <td>${c.data_purged_at ? 'ลบข้อมูลแล้ว' : c.purgeable ? '<button type="button" class="btn small danger ss-purge">ลบข้อมูล</button>' : `<span class="muted">ลบได้เมื่อครบ ${d.retention_days} วัน</span>`}</td></tr>`)
        .join('')}</tbody></table></div>` : '<p class="muted">ไม่มี</p>'}
      <p class="helper-text">ลบข้อมูล = ลบข้อมูลที่ดึงจาก FMH ไฟล์ที่อัปโหลด และการตั้งค่า LINE ของบริษัทนั้น (บัญชีผู้ใช้และ Dashboard ยังอยู่) ระบบไม่ลบเอง ต้องกดที่นี่เท่านั้น</p>
    </section>`;
  const flashMsg = (html) => { main.querySelector('.ss-flash').innerHTML = html; main.scrollTop = 0; };
  main.querySelectorAll('.ss-tabs button').forEach((b) => b.addEventListener('click', () => renderSelfServeAdmin(main, { status: b.dataset.s })));
  main.querySelector('.ss-prices').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/api/admin/self-serve/prices', { method: 'PUT', body: JSON.stringify({ monthly: f.monthly.value, yearly: f.yearly.value }) });
      renderSelfServeAdmin(main, view, '<div class="ok-msg">บันทึกราคาแล้ว</div>');
    } catch (err) { flashMsg(`<div class="error-msg">${esc(err.message)}</div>`); }
  });
  // Two clicks instead of a confirm() dialog (the viewer may block dialogs).
  const twoStep = (btn, label, run) => btn.addEventListener('click', async () => {
    if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.dataset.orig = btn.textContent; btn.textContent = label; setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = btn.dataset.orig; } }, 4000); return; }
    btn.disabled = true;
    try { await run(); } catch (err) { flashMsg(`<div class="error-msg">${esc(err.message)}</div>`); btn.disabled = false; }
  });
  main.querySelectorAll('.ss-row').forEach((row) => {
    const id = row.dataset.id;
    const note = () => (row.querySelector('.ss-note-input') || {}).value || '';
    const a = row.querySelector('.ss-approve'), r = row.querySelector('.ss-reject');
    if (a) twoStep(a, 'กดอีกครั้งเพื่อยืนยันการอนุมัติ', async () => {
      const out = await api(`/api/admin/self-serve/signups/${id}/approve`, { method: 'POST', body: JSON.stringify({ note: note() }) });
      await renderAdminCompanyList();
      refreshSignupBadge();
      renderSelfServeAdmin(main, view, `<div class="ok-msg">อนุมัติแล้ว — สร้างบริษัทพร้อม Dashboard เริ่มต้น ทดลองใช้ถึง ${esc(ssDay(out.trial_ends_at))} แจ้งลูกค้าให้เข้าสู่ระบบด้วยอีเมลและรหัสผ่านที่ตั้งไว้</div>`);
    });
    if (r) twoStep(r, 'กดอีกครั้งเพื่อยืนยัน', async () => {
      await api(`/api/admin/self-serve/signups/${id}/reject`, { method: 'POST', body: JSON.stringify({ note: note() }) });
      refreshSignupBadge();
      renderSelfServeAdmin(main, view, '<div class="ok-msg">บันทึกว่าไม่อนุมัติแล้ว</div>');
    });
  });
  main.querySelectorAll('.ss-purge').forEach((btn) => twoStep(btn, 'ลบถาวร — กดอีกครั้งเพื่อยืนยัน', async () => {
    await api(`/api/admin/self-serve/companies/${btn.closest('tr').dataset.id}/purge`, { method: 'POST', body: '{}' });
    renderSelfServeAdmin(main, view, '<div class="ok-msg">ลบข้อมูลแล้ว</div>');
  }));
}
