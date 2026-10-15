// Dashboard AI chat (lib/aiChat.js).
//   GET  /api/ai/status?dashboard_id=   is the chat on for this dashboard's company
//   POST /api/ai/chat { dashboard_id, question, context, history }
// Anyone who can see the dashboard may ask about it.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { wrap, getDashboardForUser } = require('../lib/access');
const ai = require('../lib/aiChat');

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

module.exports = router;
