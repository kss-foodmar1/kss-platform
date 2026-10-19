// "ถาม AI" on a dashboard. Order of answering (cheapest first):
//   1. helpfaq.js — FAQ on using the Dashboard + the numbers on this page,
//      worked out in the browser (free, instant, nothing leaves the browser)
//   2. Gemini (routes/ai.js), only if on for this company — it gets a plain-text
//      summary of the page (explain.js lines, range, filters), never rows
//   3. neither can answer: say so, log it as a "miss" for KSS staff to teach.
// Every answer says which of these it came from and can be rated 👍/👎.
const aiChat = { dashboardId: null, status: null, history: new Map(), busy: false, taught: null };

const AI_SUGGEST = ['สรุปหน้านี้ให้หน่อย', 'มีอะไรผิดปกติบ้าง', 'ทำไมข้อมูลว่าง', 'เพิ่ม widget ยังไง'];
const AI_SOURCE = { data: 'คำนวณจากตัวเลขบนหน้านี้', faq: 'คู่มือการใช้งาน', find: 'ค้นจากคลัง Widget', ai: 'ตอบโดย AI (Google Gemini) · อาจคลาดเคลื่อน', none: '' };
const AI_REASONS = ['ไม่ตรงเรื่อง', 'ตัวเลขไม่ถูก', 'ไม่ครบ', 'อ่านไม่เข้าใจ'];
// A question about the data / Dashboard (worth a "miss" and a pointer to the
// widget library) as opposed to small talk or general knowledge.
const AI_ON_TOPIC = /widget|กราฟ|ตัวเลข|ข้อมูล|ยอด|ราคา|ต้นทุน|ซื้อ|ขาย|สาขา|ซัพพลายเออร์|สต็อก|กำไร|เมนู|ของเสีย|ครัว|สูตร|po|grn|invoice|dashboard|ตั้งค่า|แจ้งเตือน|line|pos|fmh/i;
const aiCanSettings = () => !!state.user && ['kss_superadmin', 'company_admin'].includes(state.user.role);

// The page as the chat sees it: header lines + each widget's "อธิบาย" facts.
function aiPageParts() {
  const v = state.currentView;
  if (!v || v.preview) return null;
  const head = [`Dashboard: ${v.dashboard.display_name}`];
  if (v.range && v.range.start) head.push(`ช่วงวันที่: ${v.range.start} ถึง ${v.range.end}`);
  const f = Object.entries(v.filters || {}).filter(([, val]) => val);
  if (f.length) head.push(`ตัวกรอง: ${f.map(([k, val]) => `${{ branch: 'สาขา', supplier: 'ซัพพลายเออร์', customer: 'ลูกค้า' }[k] || k} = ${val}`).join(', ')}`);
  const box = document.createElement('div');
  const widgets = (v.cards || []).map(({ widget }) => {
    box.innerHTML = explainWidget(widget, v.explainData && v.explainData.get(widget.id));
    // Facts only: the "what to do next" tips and long descriptions would
    // crowd out widgets on a big dashboard.
    const facts = [...box.querySelectorAll('.explain-list li')].map((e) => e.textContent.trim());
    return { id: widget.id, title: widget.title, facts };
  });
  return { head, widgets };
}

// For Gemini: the same thing as plain text.
function aiPageSummary() {
  const p = aiPageParts();
  if (!p) return '';
  const lines = [...p.head];
  p.widgets.forEach((w) => lines.push(`\n[${w.title}]`, ...w.facts.map((x) => '  - ' + x)));
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
         <div><b>ถาม AI</b><span class="ai-sub">ตอบจากตัวเลขบน Dashboard นี้และคู่มือการใช้งาน</span></div>
         <span class="ai-head-act">
           <button type="button" class="ai-misses" hidden>จัดการคำถาม</button>
           <button type="button" class="ai-close" aria-label="ปิด">✕</button>
         </span>
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
  const mi = el('ai-panel').querySelector('.ai-misses');
  mi.hidden = !(state.user && state.user.role === 'kss_superadmin');
  mi.addEventListener('click', () => { aiToggle(false); if (typeof openAdminView === 'function') openAdminView('ai-questions'); });
  el('ai-panel').querySelector('.ai-log').addEventListener('click', aiLogClick);
  el('ai-panel').querySelector('.ai-close').addEventListener('click', () => aiToggle(false));
  el('ai-panel').addEventListener('keydown', aiTrap);
  // On the document: re-rendering the log can drop focus out of the panel.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && el('ai-panel') && !el('ai-panel').hidden) aiToggle(false); });
  el('ai-panel').querySelector('.ai-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = el('ai-input');
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    aiSend(q);
  });
}

const aiSheet = () => window.matchMedia('(max-width: 520px)').matches;
function aiToggle(open) {
  const panel = el('ai-panel');
  const show = open === undefined ? panel.hidden : open;
  const was = !panel.hidden;
  panel.hidden = !show;
  panel.setAttribute('aria-modal', String(show && aiSheet()));
  el('ai-fab').setAttribute('aria-expanded', String(show));
  el('ai-fab').classList.toggle('on', show);
  document.body.classList.toggle('ai-sheet-open', show && aiSheet());
  if (show) { aiRender(); el('ai-input').focus(); }
  else if (was) el('ai-fab').focus();
}

// On a phone the panel covers the screen: keep Tab inside it.
function aiTrap(e) {
  if (e.key !== 'Tab' || !aiSheet()) return;
  const f = [...el('ai-panel').querySelectorAll('button:not([hidden]):not(:disabled), input')].filter((n) => n.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function aiMsgHtml(m, i) {
  if (m.role === 'user') return `<div class="ai-msg user">${esc(m.text)}</div>`;
  if (m.error) return `<div class="ai-msg model err">${esc(m.text)}</div>`;
  const src = AI_SOURCE[m.source] || '';
  const go = (m.go || []).map((g) => `<button type="button" class="ai-go" data-go="${esc(g.act)}">${esc(g.label)} →</button>`).join('');
  let rate = '';
  if (m.source !== 'none') {
    if (m.rated) rate = `<span class="ai-thanks">${m.rated === 'up' ? 'ขอบคุณครับ' : 'รับทราบ จะนำไปปรับปรุง'}</span>`;
    else if (m.rating === 'down') {
      rate = `<div class="ai-why" role="group" aria-label="ไม่ตรงเรื่องอะไร"><span>ไม่ตรงเรื่องอะไร</span>${AI_REASONS.map((r) => `<button type="button" class="ai-reason" data-reason="${esc(r)}" data-i="${i}">${esc(r)}</button>`).join('')}<button type="button" class="ai-reason skip" data-reason="" data-i="${i}">ข้าม</button></div>`;
    } else {
      rate = `<span class="ai-rate" role="group" aria-label="ให้คะแนนคำตอบ">
         <button type="button" class="ai-thumb" data-rate="up" data-i="${i}" aria-label="ตอบตรง"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11v9H4v-9zM7 11l4-8c1.7 0 3 1.3 3 3v3h5.2a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 18 20H7"/></svg></button>
         <button type="button" class="ai-thumb" data-rate="down" data-i="${i}" aria-label="ตอบไม่ตรงหรือไม่ครบ"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(180deg)"><path d="M7 11v9H4v-9zM7 11l4-8c1.7 0 3 1.3 3 3v3h5.2a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 18 20H7"/></svg></button>
       </span>`;
    }
  }
  const meta = src || rate ? `<div class="ai-meta">${m.rating === 'down' && !m.rated ? '' : src ? `<span class="ai-src ${m.source}">${esc(src)}</span>` : ''}${rate}</div>` : '';
  const aiTag = m.source === 'ai' ? '<div class="ai-tag"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z"/></svg>AI สรุปให้ · ตรวจกับตัวเลขบนกราฟ</div>' : '';
  // Nobody could answer: let the person hand the question to KSS in one tap.
  const customer = m.q && state.user && state.user.company_id && state.user.role !== 'kss_superadmin';
  const team = customer && (m.source === 'none' || m.source === 'find')
    ? (m.wish || m.source === 'find'
      ? `<button type="button" class="ai-go primary-go" data-wish="${i}">ขอให้ทีม KSS ทำข้อมูลนี้ →</button>`
      : `<button type="button" class="ai-go" data-support="${i}">แจ้งทีมงานเรื่องนี้ →</button><button type="button" class="ai-go" data-wish="${i}">ขอให้มีข้อมูลนี้ →</button>`)
    : '';
  return `<div class="ai-msg model${m.source === 'ai' ? ' by-ai' : ''}">${aiTag}${aiFormat(m.text)}${go || team ? `<div class="ai-gos">${go}${team}</div>` : ''}${meta}</div>`;
}

function aiRender() {
  const panel = el('ai-panel');
  const msgs = aiChat.history.get(aiChat.dashboardId) || [];
  const log = panel.querySelector('.ai-log');
  log.innerHTML = msgs.length
    ? msgs.map(aiMsgHtml).join('') +
      (aiChat.busy ? '<div class="ai-msg model typing" aria-label="กำลังคิด"><span></span><span></span><span></span></div>' : '')
    : '<p class="ai-empty">ถามเรื่องตัวเลขในหน้านี้ หรือวิธีใช้ Dashboard ได้เลย เช่น “สรุปหน้านี้” หรือ “เพิ่ม widget ยังไง”</p>';
  log.scrollTop = log.scrollHeight;
  const chips = panel.querySelector('.ai-chips');
  chips.innerHTML = msgs.length ? '' : AI_SUGGEST.map((q) => `<button type="button" class="ai-chip">${esc(q)}</button>`).join('');
  chips.querySelectorAll('.ai-chip').forEach((b) => b.addEventListener('click', () => aiSend(b.textContent)));
  const st = aiChat.status || {};
  panel.querySelector('.ai-note').textContent = st.available
    ? `เหลือ ${st.remaining} คำถาม AI วันนี้ · คำตอบจากข้อมูลบนหน้าไม่นับโควตา · ตรวจกับตัวเลขบนกราฟเสมอ`
    : 'ตอบจากตัวเลขบนหน้านี้และคู่มือการใช้งาน · ตรวจกับตัวเลขบนกราฟเสมอ';
  panel.querySelector('.ai-send').disabled = aiChat.busy;
}

function aiGo(act) {
  aiToggle(false);
  if (act === 'library' && typeof openLibrary === 'function') openLibrary();
  else if (act.startsWith('goto:') && typeof fbGoTo === 'function') { const t = (fb.widgets || []).find((x) => x.template_key === act.slice(5)); if (t) fbGoTo(t); }
  else if (act.startsWith('widget:') && typeof openLibrary === 'function') openLibrary({ dashboardId: aiChat.dashboardId, templateId: Number(act.slice(7)) });
  else if (act.startsWith('settings:') && typeof openCompanySettings === 'function') openCompanySettings(act.slice(9));
}

function aiFeedback(kind, i, question, answer, source, reason) {
  const body = { dashboard_id: aiChat.dashboardId, kind, question, answer: answer || '', source: source || '', reason: reason || '' };
  api('/api/ai/feedback', { method: 'POST', body: JSON.stringify(body) }).catch(() => {});
}

function aiLogClick(e) {
  const msgs = aiChat.history.get(aiChat.dashboardId) || [];
  const g = e.target.closest('[data-go]');
  if (g) return aiGo(g.dataset.go);
  // "ask KSS to build this": a data wish with the question attached
  const wish = e.target.closest('[data-wish]');
  if (wish) {
    const m = msgs[Number(wish.dataset.wish)];
    aiToggle(false);
    return openSupportForm({ kind: 'wish', message: m ? m.q : '', context: { asked_ai: m ? m.q : '' } });
  }
  const sup = e.target.closest('[data-support]');
  if (sup) {
    const m = msgs[Number(sup.dataset.support)];
    aiToggle(false);
    return openSupportForm({ kind: 'howto', message: m ? m.q : '' });
  }
  const t = e.target.closest('[data-rate]');
  if (t) {
    const m = msgs[Number(t.dataset.i)];
    if (!m || m.rated) return;
    if (t.dataset.rate === 'up') { m.rated = 'up'; aiFeedback('up', 0, m.q, m.text, m.source); }
    else m.rating = 'down'; // ask why before sending
    return aiRender();
  }
  const r = e.target.closest('[data-reason]');
  if (r) {
    const m = msgs[Number(r.dataset.i)];
    if (!m || m.rated) return;
    m.rated = 'down';
    aiFeedback('down', 0, m.q, m.text, m.source, r.dataset.reason);
    aiRender();
  }
}

async function aiSend(question) {
  if (aiChat.busy) return;
  const id = aiChat.dashboardId;
  const msgs = aiChat.history.get(id) || [];
  aiChat.history.set(id, msgs);
  const history = msgs.filter((m) => !m.error && m.source !== 'none').map((m) => ({ role: m.role, text: m.text }));
  msgs.push({ role: 'user', text: question });
  // 1. FAQ + the page, in the browser.
  let local = null;
  try { local = helpAnswer(question, aiPageParts(), aiCanSettings(), aiChat.taught); } catch (e) { local = null; }
  // "อยากเห็น X": after the page and the guide had their go, look for a widget that shows it.
  if (!local && typeof FB_WISH !== 'undefined' && FB_WISH.test(question)) return aiFindWidget(question, msgs);
  if (local) {
    msgs.push({ role: 'model', text: local.text, source: local.source, go: local.go, q: question });
    return aiRender();
  }
  const st = aiChat.status || {};
  // 3. nobody can answer.
  const onTopic = AI_ON_TOPIC.test(question);
  if (!st.available) {
    msgs.push(onTopic
      ? {
          role: 'model', source: 'none', q: question,
          text: 'ผมยังตอบเรื่องนี้ไม่ได้ครับ ลองถามเรื่องตัวเลขที่อยู่บนหน้านี้ เช่น “สรุปหน้านี้” หรือถามวิธีใช้ เช่น “เพิ่ม widget ยังไง” ถ้าอยากรู้เรื่องที่หน้านี้ยังไม่มี ลองหา widget ที่ตอบเรื่องนั้นในคลัง Widget ผมจดคำถามนี้ไว้ให้ทีม KSS แล้ว',
          go: aiCanSettings() ? [{ label: 'เปิดคลัง Widget', act: 'library' }] : [],
        }
      : { role: 'model', source: 'none', q: question, text: 'ผมตอบได้เฉพาะเรื่องตัวเลขใน Dashboard และวิธีใช้ Dashboard ครับ', go: [] });
    if (onTopic) aiFeedback('miss', 0, question, '', 'none');
    return aiRender();
  }
  // 2. Gemini.
  aiChat.busy = true;
  aiRender();
  try {
    const r = await api('/api/ai/chat', { method: 'POST', body: JSON.stringify({ dashboard_id: id, question, context: aiPageSummary(), history }) });
    msgs.push({ role: 'model', text: r.answer, source: r.nodata ? 'none' : 'ai', q: question });
    if (r.nodata) aiFeedback('miss', 0, question, '', 'none');
    if (aiChat.status) aiChat.status.remaining = r.remaining;
  } catch (err) {
    msgs.push({ role: 'model', text: err.message, error: true });
  } finally {
    aiChat.busy = false;
    if (aiChat.dashboardId === id && !el('ai-panel').hidden) aiRender();
  }
}

// A data wish: suggest widgets that may already answer it; if none, offer to ask KSS.
async function aiFindWidget(question, msgs) {
  aiChat.busy = true;
  aiRender();
  let found = [];
  try { found = await fbSuggest(question); } catch (e) { found = []; }
  aiChat.busy = false;
  const canAdd = aiCanSettings();
  // already on one of their dashboards: say so and take them there, rather than suggest adding it
  const where = found.map((x) => fbWhere(x.t));
  const hereI = where.findIndex((w) => w && w.here);
  const haveI = hereI >= 0 ? hereI : where.findIndex(Boolean);
  if (haveI >= 0) {
    const t = found[haveI].t;
    msgs.push({
      role: 'model', source: 'find', q: question, wish: true,
      text: `${where[haveI].here ? 'มีอยู่บนหน้านี้แล้วครับ' : `มีอยู่ใน dashboard “${where[haveI].name}” แล้วครับ`}: **${t.name}** ${fbWidgetLine(t)}\nถ้ายังไม่ใช่ที่อยากเห็น ส่งคำขอให้ทีม KSS ได้`,
      go: [{ label: 'ไปที่ widget นี้', act: `goto:${t.template_key}` }],
    });
    aiRender();
    return;
  }
  msgs.push(found.length
    ? {
        role: 'model', source: 'find', q: question, wish: true,
        text: `widget ที่อาจใกล้เคียงครับ\n${found.map((x) => `- **${x.t.name}** ${fbWidgetLine(x.t)}${x.t.needs ? ` (${x.t.needs})` : ''}`).join('\n')}\n${canAdd ? 'กดดูแล้วเพิ่มลง dashboard ได้เลย' : 'ให้แอดมินของร้านเพิ่มให้ได้'} ถ้ายังไม่ใช่ที่อยากเห็น ส่งคำขอให้ทีม KSS ได้`,
        go: canAdd ? found.map((x) => ({ label: `ดู “${x.t.name}”`, act: `widget:${x.t.id}` })) : [],
      }
    : { role: 'model', source: 'none', q: question, wish: true, text: 'ยังไม่มี widget ที่แสดงข้อมูลนี้ครับ ส่งคำขอให้ทีม KSS ได้เลย ทีมงานจะตอบว่าทำได้ไหมและเมื่อไหร่', go: [] });
  if (!found.length) aiFeedback('miss', 0, question, '', 'none');
  aiRender();
}

// Called when a dashboard opens.
async function aiAttach(dashboard) {
  aiEnsureDom();
  aiChat.dashboardId = dashboard.id;
  // The chat is always there: FAQ and page answers need no AI.
  el('ai-fab').hidden = !!dashboard.preview;
  aiChat.status = null;
  if (!el('ai-panel').hidden) aiRender();
  if (!aiChat.taught) api('/api/ai/taught').then((r) => { aiChat.taught = r.list || []; }).catch(() => { aiChat.taught = []; });
  try {
    const st = await api(`/api/ai/status?dashboard_id=${dashboard.id}`);
    if (aiChat.dashboardId !== dashboard.id) return;
    aiChat.status = st;
    if (!el('ai-panel').hidden) aiRender();
  } catch (e) {
    /* the chat is an extra; the dashboard works without it */
  }
}
