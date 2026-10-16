// "อยากเห็นข้อมูลอะไรอีก" — what customers want to see, before it becomes a ticket.
//
// A data wish first looks for a widget that already answers it (the catalogue's
// names, descriptions and the library's one-line questions, scored in the
// browser: nothing is sent anywhere until the customer presses send). Only when
// nothing fits, or they still want something else, does it go to KSS as a
// support request of kind "wish" (routes/ops.js), with what the chat was asked
// and what was suggested attached, so KSS sees the gap rather than a guess.
const fb = { widgets: null, loading: null };

async function fbLoadWidgets() {
  if (fb.widgets) return fb.widgets;
  if (!fb.loading) fb.loading = api('/api/support/widgets').then((r) => (fb.widgets = r.list || [])).catch(() => (fb.widgets = []));
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

// The widgets most likely to answer `text`, best first: [{ t, score }].
// Score = share of the request's letter-triples found in the widget's words.
async function fbSuggest(text, n = 3) {
  const q = fbGrams(String(text || '').replace(FB_NOISE, ' '));
  if (q.size < 2) return [];
  const list = await fbLoadWidgets();
  const ask = (t) => (typeof LIB_QUESTIONS !== 'undefined' && LIB_QUESTIONS[t.template_key]) || '';
  return list
    .map((t) => {
      const doc = fbGrams([ask(t), t.name, t.description].join(' '));
      let hit = 0;
      q.forEach((g) => { if (doc.has(g)) hit++; });
      return { t, score: hit / q.size };
    })
    .filter((x) => x.score >= 0.45)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

// One line for a suggested widget: the question it answers when the library has one.
const fbWidgetLine = (t) => (typeof LIB_QUESTIONS !== 'undefined' && LIB_QUESTIONS[t.template_key]) || t.description || t.name;

// "Is there a widget for this?" Opens the library on that widget for someone who
// can add it; tells anyone else who can.
function fbOpenWidget(t) {
  if (typeof openLibrary === 'function' && (isSuper() || isCompanyAdmin())) {
    openLibrary({ dashboardId: state.activeDashboardId || null, templateId: t.id });
    return true;
  }
  return false;
}

// A "data wish" phrased as a question to the chat: "อยากเห็นยอดขายรายชั่วโมง", "มีรายงาน...ไหม"
const FB_WISH = /อยาก(จะ)?(เห็น|ได้|รู้|ดู)|ขอ(ดู|รายงาน|ข้อมูล|กราฟ)|มี(รายงาน|widget|กราฟ|ข้อมูล).*(ไหม|มั้ย|หรือเปล่า)|ดู.*ได้(ไหม|มั้ย)/i;
