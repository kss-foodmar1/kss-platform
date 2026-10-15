// Dashboard AI chat (lib/aiChat.js).
//   GET  /api/ai/status?dashboard_id=   is the chat on for this dashboard's company
//   POST /api/ai/chat { dashboard_id, question, context, history }
// Anyone who can see the dashboard may ask about it.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { wrap, getDashboardForUser } = require('../lib/access');
const ai = require('../lib/aiChat');
const pool = require('../db/pool');

const router = express.Router();
router.use(requireAuth);

router.get(
  '/status',
  wrap(async (req, res) => {
    const d = await getDashboardForUser(req.user, req.query.dashboard_id);
    if (!d) return res.json({ available: false, reason: 'off' });
    res.json(await ai.availability(d.company_id));
  })
);

router.post(
  '/chat',
  wrap(async (req, res) => {
    const b = req.body || {};
    const d = await getDashboardForUser(req.user, b.dashboard_id);
    if (!d) return res.status(404).json({ error: 'ไม่พบ dashboard นี้' });
    const q = String(b.question || '').trim();
    if (!q) return res.status(400).json({ error: 'พิมพ์คำถามก่อน' });
    const av = await ai.availability(d.company_id);
    if (!av.available) return res.status(403).json({ error: 'ยังไม่ได้เปิดใช้ AI สำหรับบริษัทนี้', code: av.reason });
    if (!(await ai.take(d.company_id))) return res.status(429).json({ error: `วันนี้ถามครบ ${ai.LIMIT()} คำถามแล้ว พรุ่งนี้ถามต่อได้`, code: 'AI_DAILY_LIMIT' });
    try {
      const answer = await ai.ask({ question: q, context: String(b.context || ''), history: b.history });
      res.json({ answer, remaining: Math.max(0, av.remaining - 1) });
    } catch (err) {
      console.error('AI chat failed:', err.message);
      res.status(err.status || 502).json({ error: err.message });
    }
  })
);

// 👍/👎 on an answer, or a question the chat could not answer (kind=miss).
// Works with or without AI; anyone who can see the dashboard may send it.
router.post(
  '/feedback',
  wrap(async (req, res) => {
    const b = req.body || {};
    const d = await getDashboardForUser(req.user, b.dashboard_id);
    if (!d) return res.status(404).json({ error: 'ไม่พบ dashboard นี้' });
    const kind = ['up', 'down', 'miss'].includes(b.kind) ? b.kind : null;
    const question = String(b.question || '').trim().slice(0, 500);
    if (!kind || !question) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    const source = ['data', 'faq', 'ai', 'none'].includes(b.source) ? b.source : '';
    await pool.query(
      `INSERT INTO ai_feedback (company_id, user_id, dashboard_id, kind, source, question, answer) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [d.company_id, req.user.id || null, d.id, kind, source, question, String(b.answer || '').replace(/\s+/g, ' ').trim().slice(0, 600)]
    );
    res.json({ ok: true });
  })
);

// KSS staff: what people asked that the chat could not answer, or answered badly.
router.get(
  '/misses',
  wrap(async (req, res) => {
    if (req.user.role !== 'kss_superadmin') return res.status(403).json({ error: 'เฉพาะทีม KSS' });
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const [rows] = await pool.query(
      `SELECT question, kind, COUNT(*) AS n, MAX(created_at) AS last_at, MAX(answer) AS answer
         FROM ai_feedback
        WHERE kind IN ('miss','down') AND created_at >= (NOW() - INTERVAL ? DAY)
        GROUP BY question, kind ORDER BY n DESC, last_at DESC LIMIT 40`,
      [days]
    );
    const [[t]] = await pool.query(
      `SELECT SUM(kind='up') AS up, SUM(kind='down') AS down, SUM(kind='miss') AS miss
         FROM ai_feedback WHERE created_at >= (NOW() - INTERVAL ? DAY)`,
      [days]
    );
    res.json({ days, list: rows, totals: { up: Number(t.up) || 0, down: Number(t.down) || 0, miss: Number(t.miss) || 0 } });
  })
);

module.exports = router;
