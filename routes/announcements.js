// "What's new" — the bell in the header.
//
//   GET    /api/announcements          posts this user may see + unread count
//   POST   /api/announcements/seen     mark everything up to now as read
//   GET    /api/announcements/admin    KSS: every post, including scheduled
//   POST   /api/announcements/admin    KSS: create
//   PUT    /api/announcements/admin/:id
//   DELETE /api/announcements/admin/:id
//
// A user who never opened the bell counts posts from 30 days before their
// account was made, so a new client sees recent news without a backlog.
const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireSuperadmin } = require('../middleware/auth');
const { wrap } = require('../lib/access');

const router = express.Router();

const isAdmin = (u) => u.role === 'kss_superadmin' || u.role === 'company_admin';
const parseKeys = (v) => {
  try {
    const k = JSON.parse(v || '[]');
    return Array.isArray(k) ? k.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

// Widget names for the keys a post mentions, so the bell can list them.
async function withWidgets(rows) {
  const keys = [...new Set(rows.flatMap((r) => parseKeys(r.template_keys)))];
  const [tpls] = keys.length
    ? await pool.query(`SELECT template_key, name, category FROM widget_templates WHERE template_key IN (?) AND active = TRUE`, [keys])
    : [[]];
  const byKey = new Map(tpls.map((t) => [t.template_key, t]));
  return rows.map((r) => ({
    id: r.id, title: r.title, body: r.body, title_en: r.title_en, body_en: r.body_en, audience: r.audience,
    published_at: r.published_at, created_at: r.created_at,
    template_keys: parseKeys(r.template_keys),
    widgets: parseKeys(r.template_keys).map((k) => byKey.get(k)).filter(Boolean).map((t) => ({ key: t.template_key, name: t.name })),
  }));
}

router.get(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    const audience = isAdmin(req.user) ? ['all', 'admins'] : ['all'];
    const [rows] = await pool.query(
      `SELECT * FROM announcements WHERE published_at <= NOW() AND audience IN (?) ORDER BY published_at DESC, id DESC LIMIT 20`,
      [audience]
    );
    const [[u]] = await pool.query(
      `SELECT COALESCE(announcements_seen_at, created_at - INTERVAL 30 DAY) AS since FROM users WHERE id = ?`,
      [req.user.id]
    );
    const since = u ? new Date(u.since).getTime() : 0;
    const items = (await withWidgets(rows)).map((r) => ({ ...r, unread: new Date(r.published_at).getTime() > since }));
    res.json({ items, unread: items.filter((i) => i.unread).length });
  })
);

router.post(
  '/seen',
  requireAuth,
  wrap(async (req, res) => {
    await pool.query(`UPDATE users SET announcements_seen_at = NOW() WHERE id = ?`, [req.user.id]);
    res.json({ ok: true });
  })
);

// ---------- KSS authoring ----------
function clean(body) {
  const s = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const title = s(body.title, 200);
  const text = s(body.body, 5000);
  if (!title || !text) return { error: 'ใส่หัวข้อและรายละเอียดก่อน' };
  const audience = body.audience === 'admins' ? 'admins' : 'all';
  const keys = Array.isArray(body.template_keys) ? body.template_keys.filter((k) => typeof k === 'string').slice(0, 50) : [];
  let at = body.published_at ? new Date(body.published_at) : new Date();
  if (Number.isNaN(at.getTime())) return { error: 'วันเวลาเผยแพร่ไม่ถูกต้อง' };
  return {
    row: [title, text, s(body.title_en, 200) || null, s(body.body_en, 5000) || null, audience, JSON.stringify(keys), at],
  };
}

const admin = express.Router();
admin.use(requireAuth, requireSuperadmin);
admin.get(
  '/',
  wrap(async (req, res) => {
    const [rows] = await pool.query(`SELECT * FROM announcements ORDER BY published_at DESC, id DESC`);
    res.json({ items: await withWidgets(rows) });
  })
);
admin.post(
  '/',
  wrap(async (req, res) => {
    const c = clean(req.body || {});
    if (c.error) return res.status(400).json({ error: c.error });
    const [r] = await pool.query(
      `INSERT INTO announcements (title, body, title_en, body_en, audience, template_keys, published_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [...c.row, req.user.id]
    );
    res.status(201).json({ id: r.insertId });
  })
);
admin.put(
  '/:id',
  wrap(async (req, res) => {
    const c = clean(req.body || {});
    if (c.error) return res.status(400).json({ error: c.error });
    const [r] = await pool.query(
      `UPDATE announcements SET title = ?, body = ?, title_en = ?, body_en = ?, audience = ?, template_keys = ?, published_at = ? WHERE id = ?`,
      [...c.row, req.params.id]
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'ไม่พบประกาศนี้' });
    res.json({ ok: true });
  })
);
admin.delete(
  '/:id',
  wrap(async (req, res) => {
    const [r] = await pool.query(`DELETE FROM announcements WHERE id = ?`, [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'ไม่พบประกาศนี้' });
    res.json({ ok: true });
  })
);
router.use('/admin', admin);

module.exports = router;
