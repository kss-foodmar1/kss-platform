// Dashboard AI chat ("ถาม AI"), Gemini over its REST API.
//
// What reaches the model is the page's own summary — dashboard name, range,
// filters and each widget's "อธิบาย" lines (public/explain.js) — never raw
// rows. The model answers only from that; the prompt says so.
//
// Env:
//   GEMINI_API_KEY   unset = the chat is off everywhere
//   GEMINI_TIER      free (default) | paid. On Google's free tier, content may
//                    be used to improve Google's products and read by human
//                    reviewers, so free is limited to demo-data companies.
//                    Set paid once the key is on a billed project.
//   GEMINI_MODEL     default gemini-3.1-flash-lite
//   AI_DAILY_LIMIT   questions per company per day (default 30)
//   GEMINI_BASE      API base (tests point it at a fake)
const pool = require('../db/pool');

const MODEL = () => process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const TIER = () => (String(process.env.GEMINI_TIER || 'free').toLowerCase() === 'paid' ? 'paid' : 'free');
const LIMIT = () => Math.max(1, Number(process.env.AI_DAILY_LIMIT) || 30);
const BASE = () => (process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
const MAX_CONTEXT = 20000; // characters of page summary (~20 widgets)
const MAX_QUESTION = 500;
const bkkDay = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);

const SYSTEM = `คุณคือผู้ช่วยอ่าน Dashboard ของ KSS สำหรับธุรกิจร้านอาหารและครัวกลางในไทย
กติกา:
- ตอบจาก "ข้อมูลบนหน้าจอ" ที่ให้มาเท่านั้น ห้ามเดาหรือแต่งตัวเลขที่ไม่มีในนั้น
- ถ้าคำถามต้องใช้ข้อมูลที่ไม่มีบนหน้าจอ ให้บอกตรง ๆ ว่าหน้านี้ยังไม่มีข้อมูลนั้น และแนะนำให้หา widget ที่ตอบเรื่องนั้นใน "คลัง Widget"
- ตอบเป็นภาษาไทย สั้น กระชับ ใช้ bullet ได้ ไม่เกิน 8 บรรทัด
- อ้างตัวเลขพร้อมหน่วยตามที่เห็นบนหน้าจอ และบอกว่ามาจาก widget ไหน
- ปิดท้ายด้วยสิ่งที่ควรทำต่อหนึ่งข้อ ถ้าเหมาะสม
- ไม่ให้คำแนะนำด้านกฎหมาย ภาษี หรือการลงทุน`;

async function companyOf(companyId) {
  const [[c]] = await pool.query(`SELECT id, data_source FROM companies WHERE id = ?`, [companyId]);
  return c || null;
}

// { available, reason } for this company now.
async function availability(companyId) {
  if (!process.env.GEMINI_API_KEY) return { available: false, reason: 'off' };
  const c = await companyOf(companyId);
  if (!c) return { available: false, reason: 'off' };
  if (TIER() === 'free' && c.data_source !== 'demo') return { available: false, reason: 'free_tier_demo_only' };
  const used = await usedToday(companyId);
  return { available: true, remaining: Math.max(0, LIMIT() - used), limit: LIMIT(), tier: TIER(), model: MODEL() };
}

async function usedToday(companyId) {
  const [[r]] = await pool.query(`SELECT questions FROM ai_usage WHERE company_id = ? AND day = ?`, [companyId, bkkDay()]);
  return r ? r.questions : 0;
}

// Counts the question first, so a burst can't run past the limit.
async function take(companyId) {
  await pool.query(
    `INSERT INTO ai_usage (company_id, day, questions) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE questions = questions + 1`,
    [companyId, bkkDay()]
  );
  return (await usedToday(companyId)) <= LIMIT();
}

const clip = (s, n) => String(s || '').slice(0, n);

async function ask({ question, context, history }) {
  const contents = [];
  (Array.isArray(history) ? history.slice(-6) : []).forEach((m) => {
    if (!m || !m.text) return;
    contents.push({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: clip(m.text, 1500) }] });
  });
  contents.push({
    role: 'user',
    parts: [{ text: `ข้อมูลบนหน้าจอ:\n${clip(context, MAX_CONTEXT)}\n\nคำถาม: ${clip(question, MAX_QUESTION)}` }],
  });
  const res = await fetch(`${BASE()}/models/${encodeURIComponent(MODEL())}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents,
      generationConfig: { temperature: 0.3, maxOutputTokens: 700 },
    }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (j.error && j.error.message) || `HTTP ${res.status}`;
    const err = new Error(res.status === 429 ? 'AI ถูกใช้ถี่เกินไป (โควตาของ Google) ลองใหม่อีกครู่' : `AI ตอบไม่ได้: ${msg}`);
    err.status = res.status === 429 ? 429 : 502;
    throw err;
  }
  const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  if (!text) throw Object.assign(new Error('AI ไม่ได้ตอบกลับ ลองถามใหม่อีกครั้ง'), { status: 502 });
  return text;
}

module.exports = { availability, take, ask, TIER, MODEL, LIMIT };
