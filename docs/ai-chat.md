# Dashboard explanations and AI chat

## อธิบาย (public/explain.js) — no AI
A button on every widget. Rules over the rows the widget is drawing (same range
and filters) produce the question it answers, what the numbers say and what to
do next. Runs in the browser; nothing is sent anywhere; costs nothing.

## ถาม AI (public/aichat.js, routes/ai.js, lib/aiChat.js) — Gemini
A chat button on dashboards. The browser sends the question plus a plain-text
summary of the page (each widget's อธิบาย lines, the range, the filters) — never
raw rows. The model is told to answer only from that summary.

| Env | Meaning |
|---|---|
| `GEMINI_API_KEY` | From Google AI Studio. Unset = no chat button anywhere. |
| `GEMINI_TIER` | `free` (default) or `paid`. **Free = demo-data companies only**: on Google's free tier, submitted content may be used to improve Google's products and read by human reviewers. Switch to `paid` (billing on the key's project) before real customers use it. |
| `GEMINI_MODEL` | Default `gemini-3.1-flash-lite`. |
| `AI_DAILY_LIMIT` | Questions per company per day, default 30 (`ai_usage` table counts them). |

Tests: `scripts/test-ai.js` against a fake Gemini (see the file header).

## Answer order, feedback and teaching (Oct 2026)
1. `public/helpfaq.js` — built-in FAQ (how to use the Dashboard, plain business meanings) + the page's own numbers + answers KSS taught (`ai_taught`). Free, in the browser.
2. Gemini — only when 1 cannot answer and AI is on for the company.
3. Neither: the question is logged as a `miss` (only for on-topic questions).
- 👍/👎 per answer → `ai_feedback` (a 👎 asks why: ไม่ตรงเรื่อง / ตัวเลขไม่ถูก / ไม่ครบ / อ่านไม่เข้าใจ). Emails and long digit runs are removed from the question before saving; an answer built from the customer's numbers is never stored (only FAQ answers are).
- KSS staff: Admin Console › "คำถามจากแชท" — see misses and 👎, teach an answer (one phrasing per line), mark handled. No code change needed.
