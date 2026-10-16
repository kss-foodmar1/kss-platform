// Day-to-day support loop between customers and KSS staff.
//
//   customer  POST /api/support            { kind, message, context }   report a problem from the page
//             GET  /api/support/mine       own company's requests and where each stands
//             GET  /api/support/widgets    widget names, for "already exists?" before a data wish
//             GET  /api/health             Settings › สถานะระบบ (company admin)
//   KSS       GET  /api/admin/ops/attention   companies that need looking after, worst first
//             GET  /api/admin/ops/support      ?status=open|doing|done&company_id=
//             PATCH /api/admin/ops/support/:id { status, note }
const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireSuperadmin, requireCompanyAdmin } = require('../middleware/auth');
const { wrap, resolveCompanyId } = require('../lib/access');
const { healthFor, issueScore, RANK } = require('../lib/health');

// wish: data the customer wants to see that no widget shows yet. feedback: anything else they think.
const KINDS = ['data', 'connect', 'howto', 'billing', 'other', 'wish', 'feedback'];
const STATUSES = ['open', 'doing', 'done'];
const DAILY_LIMIT = 8; // per user, so one stuck screen cannot flood the queue

const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, n);

// Customers sometimes paste a key or a card number into a free-text box. Anything
// that looks like a secret is replaced before it is stored.
function maskSecrets(text) {
  return String(text)
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[ซ่อน]')
    .replace(/[A-Za-z0-9_\-+\/=]{24,}/g, '[ซ่อน]');
}
const clean = (v, n) => maskSecrets(clip(v, n));
const RETENTION_MONTHS = 12;
async function purgeOld() {
  const [r] = await pool.query(`DELETE FROM support_requests WHERE status = 'done' AND COALESCE(handled_at, created_at) < (NOW() - INTERVAL ? MONTH)`, [RETENTION_MONTHS]);
  return r.affectedRows;
}

// Only these keys are kept, each clipped; nothing else the browser sends is stored.
function cleanContext(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [k, n] of [['page', 80], ['dashboard_name', 120], ['widget_title', 120], ['filters', 300], ['error', 300], ['date_range', 60], ['asked_ai', 300], ['suggested', 300]]) {
    if (c[k]) out[k] = clean(c[k], n);
  }
  if (Number.isInteger(Number(c.dashboard_id)) && Number(c.dashboard_id) > 0) out.dashboard_id = Number(c.dashboard_id);
  return out;
}

// ----- customer side -----
const customerRouter = express.Router();
customerRouter.use(requireAuth);

customerRouter.post(
  '/',
  wrap(async (req, res) => {
    if (!req.user.company_id) return res.status(400).json({ error: 'บัญชีทีม KSS แจ้งปัญหาผ่านช่องนี้ไม่ได้' });
    const b = req.body || {};
    const message = clean(b.message, 1000).trim();
    if (message.length < 5) return res.status(400).json({ error: 'บอกหน่อยว่าเกิดอะไรขึ้น (อย่างน้อย 5 ตัวอักษร)' });
    const kind = KINDS.includes(b.kind) ? b.kind : 'other';
    const [[today]] = await pool.query(
      `SELECT COUNT(*) AS n FROM support_requests WHERE user_id = ? AND created_at >= (NOW() - INTERVAL 1 DAY)`, [req.user.id]);
    if (today.n >= DAILY_LIMIT) return res.status(429).json({ error: 'วันนี้แจ้งครบจำนวนที่กำหนดแล้ว รอทีมงานตอบกลับก่อนนะ' });
    const [r] = await pool.query(
      `INSERT INTO support_requests (company_id, user_id, kind, message, context_json) VALUES (?, ?, ?, ?, ?)`,
      [req.user.company_id, req.user.id, kind, message, JSON.stringify(cleanContext(b.context))]
    );
    res.status(201).json({ ok: true, id: r.insertId });
  })
);

customerRouter.get(
  '/mine',
  wrap(async (req, res) => {
    if (!req.user.company_id) return res.json({ list: [] });
    // A company admin sees the whole company's requests; a viewer sees their own.
    const own = req.user.role === 'company_admin';
    const [rows] = await pool.query(
      `SELECT r.id, r.kind, r.message, r.status, r.note, r.created_at, r.handled_at, u.display_name AS who
         FROM support_requests r LEFT JOIN users u ON u.id = r.user_id
        WHERE r.company_id = ? ${own ? '' : 'AND r.user_id = ?'} ORDER BY r.created_at DESC LIMIT 20`,
      own ? [req.user.company_id] : [req.user.company_id, req.user.id]
    );
    res.json({ list: rows });
  })
);

// The widget catalogue in brief, for "is there already a widget for this?" before a
// data wish becomes a ticket (public/feedback.js scores it in the browser). Names and
// descriptions only; anyone signed in may read it.
customerRouter.get(
  '/widgets',
  wrap(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT id, template_key, name, description, category FROM widget_templates WHERE active = TRUE ORDER BY sort_order, id`
    );
    res.json({ list: rows });
  })
);

const healthRouter = express.Router();
healthRouter.get(
  '/',
  requireAuth,
  requireCompanyAdmin,
  wrap(async (req, res) => {
    const id = resolveCompanyId(req);
    if (!id) return res.status(400).json({ error: 'company_id required' });
    const h = (await healthFor([id])).get(id);
    if (!h) return res.status(404).json({ error: 'ไม่พบบริษัทนี้' });
    // The raw FMH error text is for KSS staff; the customer gets the plain-language fix.
    const checks = req.user.role === 'kss_superadmin' ? h.checks : h.checks.map(({ raw, ...rest }) => rest);
    res.json({ level: h.level, checks, open_support: h.open_support });
  })
);

// ----- KSS side -----
const adminRouter = express.Router();
adminRouter.use(requireAuth, requireSuperadmin);

adminRouter.get(
  '/attention',
  wrap(async (req, res) => {
    const all = await healthFor();
    const queue = [];
    const totals = { bad: 0, warn: 0, ok: 0 };
    for (const h of all.values()) {
      if (h.company.status === 'demo') continue;
      totals[h.level === 'off' ? 'ok' : h.level]++;
      const issues = h.checks.filter((c) => c.state === 'bad' || c.state === 'warn');
      if (!issues.length && !h.open_support) continue;
      queue.push({
        company_id: h.company.id, name: h.company.name, code: h.company.company_code, status: h.company.status,
        level: h.level, issues: issues.sort((a, b) => issueScore(b) - issueScore(a)), open_support: h.open_support,
        score: Math.max(0, ...issues.map(issueScore)) + h.open_support * 5,
      });
    }
    queue.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'th'));
    const [[sg]] = await pool.query(`SELECT COUNT(*) AS n FROM signup_requests WHERE status = 'pending'`);
    const [[ms]] = await pool.query(`SELECT COUNT(DISTINCT question) AS n FROM ai_feedback WHERE kind IN ('miss','down') AND status = 'open' AND created_at >= (NOW() - INTERVAL 30 DAY)`);
    const [[sp]] = await pool.query(`SELECT COUNT(*) AS n, SUM(status = 'open') AS fresh FROM support_requests WHERE status <> 'done'`);
    res.json({
      totals, queue,
      inbox: { signups: sg.n, chat_misses: ms.n, support: sp.n || 0, support_new: Number(sp.fresh) || 0 },
    });
  })
);

adminRouter.get(
  '/support',
  wrap(async (req, res) => {
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    const cid = Number(req.query.company_id) || null;
    const where = [], args = [];
    if (status) { where.push('r.status = ?'); args.push(status); } else { where.push(`r.status <> 'done'`); }
    if (cid) { where.push('r.company_id = ?'); args.push(cid); }
    // ?kind=ideas: data wishes and feedback only (what customers want next), apart from problems
    if (req.query.kind === 'ideas') where.push(`r.kind IN ('wish','feedback')`);
    else if (req.query.kind === 'problems') where.push(`r.kind NOT IN ('wish','feedback')`);
    const [rows] = await pool.query(
      `SELECT r.id, r.company_id, c.name AS company, r.kind, r.message, r.context_json, r.status, r.note, r.created_at, r.handled_at,
              u.display_name AS who, u.email AS who_email, h.display_name AS handler
         FROM support_requests r JOIN companies c ON c.id = r.company_id
         LEFT JOIN users u ON u.id = r.user_id LEFT JOIN users h ON h.id = r.handled_by
        WHERE ${where.join(' AND ')} ORDER BY (r.status = 'open') DESC, r.created_at DESC LIMIT 100`,
      args
    );
    rows.forEach((r) => { try { r.context = JSON.parse(r.context_json || '{}'); } catch (e) { r.context = {}; } delete r.context_json; });
    res.json({ list: rows });
  })
);

adminRouter.patch(
  '/support/:id',
  wrap(async (req, res) => {
    const b = req.body || {};
    const status = STATUSES.includes(b.status) ? b.status : null;
    if (!status) return res.status(400).json({ error: 'status ไม่ถูกต้อง' });
    const [r] = await pool.query(
      `UPDATE support_requests SET status = ?, note = ?, handled_by = ?, handled_at = NOW() WHERE id = ?`,
      [status, b.note == null ? null : clean(b.note, 500), req.user.id, req.params.id]
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'ไม่พบรายการ' });
    res.json({ ok: true });
  })
);

module.exports = { customerRouter, healthRouter, adminRouter, purgeOld };
