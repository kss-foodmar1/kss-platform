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
      const { text: answer, nodata } = await ai.ask({ question: q, context: String(b.context || ''), history: b.history });
      res.json({ answer, nodata, remaining: Math.max(0, av.remaining - 1) });
    } catch (err) {
      console.error('AI chat failed:', err.message);
      res.status(err.status || 502).json({ error: err.message });
    }
  })
);

// What reaches our database from a question is text a customer typed: strip
// emails and long digit runs (phone / ID / account numbers) first.
const scrub = (t) =>
  String(t || '')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[อีเมล]')
    .replace(/\d[\d\s-]{6,}\d/g, '[ตัวเลข]')
    .replace(/\s+/g, ' ')
    .trim();
const REASONS = ['ไม่ตรงเรื่อง', 'ตัวเลขไม่ถูก', 'ไม่ครบ', 'อ่านไม่เข้าใจ'];

// KSS staff: check the Gemini connection from the Console (never returns the key).
router.post('/selftest', (req, res, next) => (req.user.role === 'kss_superadmin' ? next() : res.status(403).json({ error: 'เฉพาะทีม KSS' })), wrap(async (req, res) => {
  res.json(await ai.selftest());
}));

// 👍/👎 on an answer, or a question the chat could not answer (kind=miss).
// Works with or without AI; anyone who can see the dashboard may send it.
// Only the question is kept: an answer built from the customer's numbers is
// not stored (a built-in FAQ answer is, so KSS can see which one missed).
router.post(
  '/feedback',
  wrap(async (req, res) => {
    const b = req.body || {};
    const d = await getDashboardForUser(req.user, b.dashboard_id);
    if (!d) return res.status(404).json({ error: 'ไม่พบ dashboard นี้' });
    const kind = ['up', 'down', 'miss'].includes(b.kind) ? b.kind : null;
    const question = scrub(b.question).slice(0, 500);
    if (!kind || !question) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    const source = ['data', 'faq', 'ai', 'none'].includes(b.source) ? b.source : '';
    const answer = source === 'faq' ? scrub(b.answer).slice(0, 600) : '';
    const reason = kind === 'down' && REASONS.includes(b.reason) ? b.reason : null;
    await pool.query(
      `INSERT INTO ai_feedback (company_id, user_id, dashboard_id, kind, source, question, answer, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [d.company_id, req.user.id || null, d.id, kind, source, question, answer, reason]
    );
    res.json({ ok: true });
  })
);

const staffOnly = (req, res, next) =>
  req.user.role === 'kss_superadmin' ? next() : res.status(403).json({ error: 'เฉพาะทีม KSS' });

// KSS staff: questions the chat could not answer, or answered badly.
//   ?days=14&status=open|done
router.get(
  '/misses',
  staffOnly,
  wrap(async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const status = req.query.status === 'done' ? 'done' : 'open';
    const [rows] = await pool.query(
      `SELECT f.question, f.kind, f.source, COUNT(*) AS n, MAX(f.created_at) AS last_at,
              MAX(f.answer) AS answer, GROUP_CONCAT(DISTINCT f.reason) AS reasons,
              GROUP_CONCAT(DISTINCT c.name SEPARATOR ', ') AS companies
         FROM ai_feedback f JOIN companies c ON c.id = f.company_id
        WHERE f.kind IN ('miss','down') AND f.status = ? AND f.created_at >= (NOW() - INTERVAL ? DAY)
        GROUP BY f.question, f.kind, f.source ORDER BY n DESC, last_at DESC LIMIT 100`,
      [status, days]
    );
    const [[t]] = await pool.query(
      `SELECT SUM(kind='up') AS up, SUM(kind='down') AS down, SUM(kind='miss') AS miss
         FROM ai_feedback WHERE created_at >= (NOW() - INTERVAL ? DAY)`,
      [days]
    );
    res.json({ days, status, list: rows, totals: { up: Number(t.up) || 0, down: Number(t.down) || 0, miss: Number(t.miss) || 0 } });
  })
);

// Mark a question handled (or open again): every row with that question.
router.post(
  '/misses/status',
  staffOnly,
  wrap(async (req, res) => {
    const q = String((req.body || {}).question || '').slice(0, 500);
    const status = (req.body || {}).status === 'open' ? 'open' : 'done';
    if (!q) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    await pool.query(`UPDATE ai_feedback SET status = ? WHERE question = ? AND kind IN ('miss','down')`, [status, q]);
    res.json({ ok: true });
  })
);

// Taught answers. Everyone signed in reads the active ones (the chat matches
// them like its built-in FAQ); only KSS staff change them.
router.get(
  '/taught',
  wrap(async (req, res) => {
    const staff = req.user.role === 'kss_superadmin';
    const [rows] = await pool.query(
      `SELECT id, phrases, answer, active FROM ai_taught ${staff ? '' : 'WHERE active = TRUE'} ORDER BY id DESC LIMIT 300`
    );
    res.json({ list: rows.map((r) => ({ id: r.id, phrases: r.phrases.split('\n').filter(Boolean), answer: r.answer, active: !!r.active })) });
  })
);
router.post(
  '/taught',
  staffOnly,
  wrap(async (req, res) => {
    const b = req.body || {};
    const phrases = (Array.isArray(b.phrases) ? b.phrases : String(b.phrases || '').split('\n'))
      .map((x) => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, 8);
    const answer = String(b.answer || '').trim().slice(0, 1500);
    if (!phrases.length || !answer) return res.status(400).json({ error: 'ใส่อย่างน้อย 1 คำถามและคำตอบ' });
    const active = b.active === false ? 0 : 1;
    // The same question twice would make two answers compete: refuse (edit the old one).
    const norm = (x) => String(x).toLowerCase().replace(/\s+/g, '');
    const [others] = await pool.query(`SELECT id, phrases FROM ai_taught WHERE id <> ?`, [Number(b.id) || 0]);
    const mine = new Set(phrases.map(norm));
    const dup = others.find((o) => o.phrases.split('\n').some((x) => mine.has(norm(x))));
    if (dup) return res.status(409).json({ error: 'มีคำถามนี้ที่สอนไว้แล้ว ให้กด “แก้” ที่รายการเดิมแทน', id: dup.id });
    if (b.id) {
      await pool.query(`UPDATE ai_taught SET phrases = ?, answer = ?, active = ? WHERE id = ?`, [phrases.join('\n'), answer, active, Number(b.id)]);
      return res.json({ ok: true, id: Number(b.id) });
    }
    const [r] = await pool.query(`INSERT INTO ai_taught (phrases, answer, active, created_by) VALUES (?, ?, ?, ?)`, [phrases.join('\n'), answer, active, req.user.id || null]);
    res.json({ ok: true, id: r.insertId });
  })
);
router.delete(
  '/taught/:id',
  staffOnly,
  wrap(async (req, res) => {
    await pool.query(`DELETE FROM ai_taught WHERE id = ?`, [Number(req.params.id)]);
    res.json({ ok: true });
  })
);

module.exports = router;
