// "อยากเห็นข้อมูลอะไรอีก" — what customers want to see, before it becomes a ticket.
//
// A data wish first looks for a widget that already answers it (the catalogue's
// names, descriptions and the library's one-line questions, scored in the
// browser: nothing is sent anywhere until the customer presses send). Only when
// nothing fits, or they still want something else, does it go to KSS as a
// support request of kind "wish" (routes/ops.js), with what the chat was asked
// and what was suggested attached, so KSS sees the gap rather than a guess.
const fb = { widgets: null, loading: null, at: 0 };

// Kept half a minute: which dashboards show a widget changes when someone adds one.
async function fbLoadWidgets() {
  if (fb.widgets && Date.now() - fb.at < 30000) return fb.widgets;
  if (!fb.loading) {
    fb.loading = api('/api/support/widgets')
      .then((r) => { fb.at = Date.now(); return (fb.widgets = r.list || []); })
      .catch(() => (fb.widgets = fb.widgets || []))
      .finally(() => { fb.loading = null; });
  }
  return fb.loading;
}

// Words that say "I want" rather than what: they match everything.
const FB_NOISE = /อยาก(จะ)?|ขอ|ดู|เห็น|รู้|ได้|ไหม|มั้ย|หน่อย|ครับ|ค่ะ|คะ|นะ|ช่วย|ข้อมูล|รายงาน|dashboard|widget|มี|อะไร|บ้าง|แบบ|ที่|ของ|และ|หรือ|ให้|เรา|ผม|ฉัน|ดิฉัน|\s+/gi;
const fbGrams = (s) => {
  const t = String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const g = new Set();
  for (let i = 0; i + 3 <= t.length; i++) g.add(t.slice(i, i + 3));
  return g;
};

// What a request is about. A suggestion must share the request's subjects (most of
// them), so "ยอดขายรายชั่วโมง" never gets a kitchen-sales widget just because both
// say "ยอดขาย", and a subject no widget covers (table bookings) finds nothing.
const FB_TOPICS = [
  ['ของเสีย', 'ทิ้ง', 'เน่า'], ['ยอดขาย', 'ขายได้', 'ขายดี', 'sales'], ['ยอดซื้อ', 'สั่งซื้อ', 'ซื้อ', 'po'], ['ราคา'],
  ['สต็อก', 'คงคลัง', 'นับสต็อก', 'stock'], ['กำไร', 'ต้นทุน', 'มาร์จิ้น', 'cogs', 'food cost'], ['ซัพพลายเออร์', 'supplier'],
  ['สาขา', 'outlet'], ['เมนู', 'สูตร', 'จาน', 'menu'], ['บิล', 'ใบแจ้งหนี้', 'invoice', 'ใบลดหนี้'], ['ครัวกลาง'], ['pos'],
  ['ชั่วโมง', 'ช่วงเวลา'], ['จอง', 'โต๊ะ'], ['ลูกค้า'], ['ส่งของ', 'รับของ', 'ส่งขาด', 'ส่งช้า', 'ส่งไม่ครบ'], ['พนักงาน', 'ค่าแรง'],
];
const fbTopicsOf = (text) => {
  const t = String(text || '').toLowerCase();
  return FB_TOPICS.map((words, i) => (words.some((w) => t.includes(w)) ? i : -1)).filter((i) => i >= 0);
};

// The widgets most likely to answer `text`, best first: [{ t, score }].
// Score = share of the request's letter-triples found in the widget's words,
// among widgets that share its subjects; ones far below the best are dropped.
async function fbSuggest(text, n = 3) {
  const q = fbGrams(String(text || '').replace(FB_NOISE, ' '));
  if (q.size < 2) return [];
  const topics = fbTopicsOf(text);
  const need = Math.max(1, Math.ceil(topics.length * 0.67));
  const ck = FB_TOPICS.findIndex((w) => w[0] === 'ครัวกลาง');
  const list = await fbLoadWidgets();
  const ask = (t) => (typeof LIB_QUESTIONS !== 'undefined' && LIB_QUESTIONS[t.template_key]) || '';
  const scored = list
    // FMH has nothing for it in this company, unless it is already on one of their dashboards
    .filter((t) => !t.empty || (t.on && t.on.length))
    .map((t) => {
      const words = [ask(t), t.name, t.description].join(' ');
      const own = fbTopicsOf(words);
      // a kitchen widget only when the request is about the kitchen
      if (own.includes(ck) && !topics.includes(ck)) return null;
      if (topics.length && topics.filter((i) => own.includes(i)).length < need) return null;
      const doc = fbGrams(words);
      let hit = 0;
      q.forEach((g) => { if (doc.has(g)) hit++; });
      // a widget already on one of their dashboards wins a close call: going to it beats adding another
      const mine = t.on && t.on.length ? 0.2 : 0;
      return { t, score: hit / q.size + mine, raw: hit / q.size };
    })
    .filter((x) => x && x.raw >= (x.score > x.raw ? 0.3 : 0.45))
    .sort((a, b) => b.score - a.score);
  const best = scored.length ? scored[0].score : 0;
  return scored.filter((x) => x.score >= best * 0.8).slice(0, n);
}

// One line for a suggested widget: the question it answers when the library has one.
const fbWidgetLine = (t) => (typeof LIB_QUESTIONS !== 'undefined' && LIB_QUESTIONS[t.template_key]) || t.description || t.name;

// ---------- already on a dashboard: go there instead of suggesting it ----------
// { here: true, widget } on the open dashboard, { dashboardId, name } on another one
// this person can open, or null.
function fbWhere(t) {
  const v = state.currentView;
  if (v && !v.preview) {
    const w = (v.widgets || []).find((x) => x.template_key === t.template_key);
    if (w) return { here: true, widget: w };
  }
  const d = (t.on || []).map((id) => (state.dashboards || []).find((x) => x.id === id)).find(Boolean);
  return d ? { dashboardId: d.id, name: d.display_name } : null;
}
const fbWhereLabel = (where) => (where.here ? 'อยู่บนหน้านี้แล้ว' : `อยู่ใน “${where.name}” แล้ว`);

// Brings the widget into view (switching dashboard first if needed) and gives it focus.
function fbGoTo(t) {
  const where = fbWhere(t);
  if (!where) return false;
  const show = (tries = 0) => {
    const v = state.currentView;
    const w = v && (v.widgets || []).find((x) => x.template_key === t.template_key);
    const card = w && document.querySelector(`.widget-card[data-wid="${w.id}"]`);
    if (!card) { if (tries < 40) setTimeout(() => show(tries + 1), 150); return; }
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    card.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
    if (!card.hasAttribute('tabindex')) card.tabIndex = -1;
    setTimeout(() => card.focus({ preventScroll: true }), still ? 0 : 350);
    card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 2200);
  };
  if (!where.here) goDashboard(where.dashboardId);
  show();
  return true;
}

// "Is there a widget for this?" Opens the library on that widget for someone who
// can add it; tells anyone else who can.
function fbOpenWidget(t) {
  if (typeof openLibrary === 'function' && (isSuper() || isCompanyAdmin())) {
    openLibrary({ dashboardId: state.activeDashboardId || null, templateId: t.id });
    fbDraftBar();
    return true;
  }
  return false;
}
// While a request typed in the form is waiting, a small bar offers the way back to it.
function fbDraftBar() {
  document.querySelectorAll('.fb-draftbar').forEach((x) => x.remove());
  if (!fbTakeDraft()) return;
  const bar = document.createElement('div');
  bar.className = 'fb-draftbar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'คำขอที่พิมพ์ไว้');
  bar.innerHTML = '<span>ถ้า widget นี้ยังไม่ใช่ คำขอที่พิมพ์ไว้ยังอยู่</span><button type="button" class="btn small primary">กลับไปส่งคำขอ</button><button type="button" class="btn small ghost" aria-label="ทิ้งคำขอที่พิมพ์ไว้">ทิ้ง</button>';
  document.body.appendChild(bar);
  const [back, drop] = bar.querySelectorAll('button');
  back.addEventListener('click', () => { bar.remove(); openSupportForm({}); });
  drop.addEventListener('click', () => { fbClearDraft(); bar.remove(); });
}

// A "data wish" phrased to the chat: "อยากเห็นยอดขายรายชั่วโมง", "มีรายงาน…ไหม".
// Only explicit wishes: "อยากรู้ว่าเดือนนี้ขายเท่าไหร่" is a question about the
// page and goes to the page's numbers first.
const FB_WISH = /อยาก(จะ)?(เห็น|ได้)|ขอ(ดู)?(รายงาน|กราฟ|widget)|มี(รายงาน|widget|กราฟ)\S*.*(ไหม|มั้ย|หรือเปล่า)/i;

// ---------- draft: the request survives a trip to the library ----------
const FB_DRAFT = 'kss_support_draft';
const fbSaveDraft = (d) => { try { sessionStorage.setItem(FB_DRAFT, JSON.stringify(d)); } catch (e) { /* none */ } };
const fbTakeDraft = () => { try { const d = JSON.parse(sessionStorage.getItem(FB_DRAFT) || 'null'); return d; } catch (e) { return null; } };
const fbClearDraft = () => { try { sessionStorage.removeItem(FB_DRAFT); } catch (e) { /* none */ } };

// ---------- "เรื่องที่แจ้งไว้": the customer's own requests and KSS's replies ----------
// For every customer user (a viewer cannot open Settings), from the bell or the form.
async function fbOpenMine(focusId) {
  const prev = document.activeElement;
  const root = document.createElement('div');
  root.className = 'modal-overlay';
  root.innerHTML = `<div class="modal-card ops-form" role="dialog" aria-modal="true" aria-labelledby="mine-title">
      <h2 id="mine-title">เรื่องที่แจ้งไว้</h2><div class="mine-body"><p class="muted">กำลังโหลด...</p></div>
      <div class="row-actions" style="margin-top:14px"><button type="button" class="btn primary mine-new">ขอข้อมูลเพิ่ม / แจ้งเรื่องใหม่</button><button type="button" class="btn ghost" data-close>ปิด</button></div>
    </div>`;
  document.body.appendChild(root);
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); if (prev && prev.focus) prev.focus(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  root.addEventListener('click', (e) => { if (e.target === root || e.target.closest('[data-close]')) close(); });
  root.querySelector('.mine-new').addEventListener('click', () => { close(); openSupportForm({ kind: 'wish' }); });
  root.querySelector('.mine-new').focus();
  try {
    const r = await api('/api/support/mine');
    root.querySelector('.mine-body').innerHTML = r.list.length
      ? `<ul class="ops-mine">${r.list.map((x) => `<li class="${x.reply_unseen ? 'mine-new-reply' : ''}" data-id="${x.id}" tabindex="-1"><div class="ops-sup-head"><span class="ops-kind">${esc(OPS_KIND[x.kind] || x.kind)}</span><span class="muted">${esc(x.who || '')} · ${esc(opsAgo(x.created_at))}</span><span class="ops-status ops-st-${x.status}">${esc(OPS_STATUS[x.status])}</span>${x.reply_unseen ? '<span class="notif-new">ตอบใหม่</span>' : ''}</div><p class="ops-msg">${esc(x.message)}</p>${x.note ? `<p class="ops-reply"><b>ทีม KSS ตอบ:</b> ${esc(x.note)}</p>` : ''}</li>`).join('')}</ul>`
      : '<p class="ops-empty">ยังไม่เคยแจ้งเรื่องหรือขอข้อมูล</p>';
    // opened from one reply in the bell: that one, in view and focused
    const li = focusId && root.querySelector(`li[data-id="${Number(focusId)}"]`);
    if (li) { li.classList.add('mine-focus'); li.scrollIntoView({ block: 'center' }); li.focus({ preventScroll: true }); }
    if (r.unseen) { api('/api/support/seen', { method: 'POST' }).catch(() => {}); if (typeof loadNotifications === 'function') setTimeout(loadNotifications, 300); }
  } catch (err) {
    root.querySelector('.mine-body').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
  }
}
