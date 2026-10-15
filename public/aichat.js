// "ถาม AI" on a dashboard (routes/ai.js). The question goes to the server
// together with a plain-text summary of the page: each widget's "อธิบาย" lines
// (explain.js), the date range and the filters. Rows never leave the browser.
const aiChat = { dashboardId: null, status: null, history: new Map(), busy: false };

const AI_SUGGEST = ['สรุป Dashboard นี้ให้หน่อย', 'วันนี้มีอะไรต้องรีบดู', 'ตัวเลขไหนผิดปกติที่สุด'];

function aiPageSummary() {
  const v = state.currentView;
  if (!v || v.preview) return '';
  const lines = [`Dashboard: ${v.dashboard.display_name}`];
  if (v.range && v.range.start) lines.push(`ช่วงวันที่: ${v.range.start} ถึง ${v.range.end}`);
  const f = Object.entries(v.filters || {}).filter(([, val]) => val);
  if (f.length) lines.push(`ตัวกรอง: ${f.map(([k, val]) => `${{ branch: 'สาขา', supplier: 'ซัพพลายเออร์', customer: 'ลูกค้า' }[k] || k} = ${val}`).join(', ')}`);
  const box = document.createElement('div');
  (v.cards || []).forEach(({ widget }) => {
    box.innerHTML = explainWidget(widget, v.explainData && v.explainData.get(widget.id));
    // Facts only: the "what to do next" tips and long descriptions would
    // crowd out widgets on a big dashboard.
    const facts = [...box.querySelectorAll('.explain-list li')].map((e) => '  - ' + e.textContent.trim());
    lines.push(`\n[${widget.title}]`, ...facts);
  });
  return lines.join('\n');
}

// The model writes light markdown: bold and bullets. Escape first, then
// allow just those two.
function aiFormat(text) {
  const out = [];
  let list = false;
  esc(text).split('\n').forEach((raw) => {
    const line = raw.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const m = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    if (m) {
      if (!list) { out.push('<ul>'); list = true; }
      out.push(`<li>${m[1]}</li>`);
      return;
    }
    if (list) { out.push('</ul>'); list = false; }
    if (line.trim()) out.push(`<p>${line}</p>`);
  });
  if (list) out.push('</ul>');
  return out.join('');
}

function aiEnsureDom() {
  if (el('ai-fab')) return;
  const host = el('dashboard-view');
  host.insertAdjacentHTML(
    'beforeend',
    `<button type="button" id="ai-fab" class="ai-fab" aria-expanded="false" aria-controls="ai-panel" hidden>
       <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M9 10h.01M12 10h.01M15 10h.01"/></svg>
       <span>ถาม AI</span>
     </button>
     <section id="ai-panel" class="ai-panel" role="dialog" aria-label="ถาม AI เกี่ยวกับ Dashboard นี้" hidden>
       <header class="ai-head">
         <div><b>ถาม AI</b><span class="ai-sub">ตอบจากตัวเลขบน Dashboard นี้</span></div>
         <button type="button" class="ai-close" aria-label="ปิด">✕</button>
       </header>
       <div class="ai-log" aria-live="polite"></div>
       <div class="ai-chips"></div>
       <form class="ai-form">
         <label class="sr-only" for="ai-input">คำถาม</label>
         <input id="ai-input" maxlength="500" autocomplete="off" placeholder="ถามเกี่ยวกับตัวเลขในหน้านี้...">
         <button type="submit" class="ai-send" aria-label="ส่ง"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
       </form>
       <p class="ai-note"></p>
     </section>`
  );
  el('ai-fab').addEventListener('click', () => aiToggle());
  el('ai-panel').querySelector('.ai-close').addEventListener('click', () => aiToggle(false));
  el('ai-panel').addEventListener('keydown', (e) => { if (e.key === 'Escape') { aiToggle(false); el('ai-fab').focus(); } });
  el('ai-panel').querySelector('.ai-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = el('ai-input');
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    aiSend(q);
  });
}

function aiToggle(open) {
  const panel = el('ai-panel');
  const show = open === undefined ? panel.hidden : open;
  panel.hidden = !show;
  el('ai-fab').setAttribute('aria-expanded', String(show));
  el('ai-fab').classList.toggle('on', show);
  if (show) { aiRender(); el('ai-input').focus(); }
}

function aiRender() {
  const panel = el('ai-panel');
  const msgs = aiChat.history.get(aiChat.dashboardId) || [];
  const log = panel.querySelector('.ai-log');
  log.innerHTML = msgs.length
    ? msgs.map((m) => `<div class="ai-msg ${m.role}${m.error ? ' err' : ''}">${m.role === 'model' && !m.error ? aiFormat(m.text) : esc(m.text)}</div>`).join('') +
      (aiChat.busy ? '<div class="ai-msg model typing" aria-label="กำลังคิด"><span></span><span></span><span></span></div>' : '')
    : '<p class="ai-empty">ถามเรื่องตัวเลขในหน้านี้ได้เลย เช่น ทำไมกำไรลดลง หรือซัพพลายเออร์รายไหนน่าห่วง</p>';
  log.scrollTop = log.scrollHeight;
  const chips = panel.querySelector('.ai-chips');
  chips.innerHTML = msgs.length ? '' : AI_SUGGEST.map((s) => `<button type="button" class="ai-chip">${esc(s)}</button>`).join('');
  chips.querySelectorAll('.ai-chip').forEach((b) => b.addEventListener('click', () => aiSend(b.textContent)));
  const st = aiChat.status || {};
  panel.querySelector('.ai-note').textContent = st.available
    ? `เหลือ ${st.remaining} คำถามวันนี้ · AI อาจผิดพลาดได้ ตรวจกับตัวเลขบนกราฟเสมอ`
    : '';
  panel.querySelector('.ai-send').disabled = aiChat.busy;
}

async function aiSend(question) {
  if (aiChat.busy) return;
  const id = aiChat.dashboardId;
  const msgs = aiChat.history.get(id) || [];
  aiChat.history.set(id, msgs);
  const history = msgs.filter((m) => !m.error).map((m) => ({ role: m.role, text: m.text }));
  msgs.push({ role: 'user', text: question });
  aiChat.busy = true;
  aiRender();
  try {
    const r = await api('/api/ai/chat', { method: 'POST', body: JSON.stringify({ dashboard_id: id, question, context: aiPageSummary(), history }) });
    msgs.push({ role: 'model', text: r.answer });
    if (aiChat.status) aiChat.status.remaining = r.remaining;
  } catch (err) {
    msgs.push({ role: 'model', text: err.message, error: true });
  } finally {
    aiChat.busy = false;
    if (aiChat.dashboardId === id && !el('ai-panel').hidden) aiRender();
  }
}

// Called when a dashboard opens.
async function aiAttach(dashboard) {
  aiEnsureDom();
  aiChat.dashboardId = dashboard.id;
  el('ai-fab').hidden = true;
  if (!el('ai-panel').hidden) aiRender();
  try {
    const st = await api(`/api/ai/status?dashboard_id=${dashboard.id}`);
    if (aiChat.dashboardId !== dashboard.id) return;
    aiChat.status = st;
    el('ai-fab').hidden = !st.available;
    if (!st.available) aiToggle(false);
    else if (!el('ai-panel').hidden) aiRender();
  } catch (e) {
    /* the chat is an extra; the dashboard works without it */
  }
}
