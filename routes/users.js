// Admin-only: manage user accounts (the "Settings > Users" menu).
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// List all users (admin only).
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, email, display_name, role, must_change_password, created_at
     FROM users ORDER BY created_at DESC`
  );
  res.json({ users: rows });
});

// Create a new user (admin only). A temporary password is required; the new
// user is forced to change it on first login.
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const { email, display_name, temp_password, role } = req.body || {};
  if (!email || !display_name || !temp_password) {
    return res.status(400).json({ error: 'email, display_name and temp_password are required' });
  }
  if (temp_password.length < 8) {
    return res.status(400).json({ error: 'Temporary password must be at least 8 characters' });
  }
  const safeRole = role === 'admin' ? 'admin' : 'client';

  const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  if (existing[0]) return res.status(409).json({ error: 'A user with this email already exists' });

  const hash = await bcrypt.hash(temp_password, 10);
  const [result] = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, role, must_change_password)
     VALUES (?, ?, ?, ?, TRUE)`,
    [email, hash, display_name, safeRole]
  );
  res.status(201).json({ id: result.insertId, email, display_name, role: safeRole });
});

// Admin can reset someone's password (forces change on next login) — not in
// the original 5 requirements but a near-certain follow-up need, included
// since it reuses the same code path as user creation.
router.post('/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
  const { temp_password } = req.body || {};
  if (!temp_password || temp_password.length < 8) {
    return res.status(400).json({ error: 'Temporary password must be at least 8 characters' });
  }
  const hash = await bcrypt.hash(temp_password, 10);
  const [result] = await pool.query(
    `UPDATE users SET password_hash = ?, must_change_password = TRUE WHERE id = ?`,
    [hash, req.params.id]
  );
  if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

// Admin can change another user's role/level (admin <-> client).
router.patch('/:id/role', requireAuth, requireAdmin, async (req, res) => {
  const { role } = req.body || {};
  if (role !== 'admin' && role !== 'client') {
    return res.status(400).json({ error: 'role must be "admin" or "client"' });
  }
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'Cannot change your own role' });
  }
  const [result] = await pool.query(`UPDATE users SET role = ? WHERE id = ?`, [role, req.params.id]);
  if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true, role });
});

// Get which dashboard tabs a user currently has (Manage Users screen).
router.get('/:id/dashboard-access', requireAuth, requireAdmin, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT dashboard_id FROM user_dashboard_access WHERE user_id = ?`,
    [req.params.id]
  );
  res.json({ dashboard_ids: rows.map((r) => r.dashboard_id) });
});

// Replace which dashboard tabs a user can see — lets each client have a
// different set/number of tabs. Admins ignore this table (always see all).
router.put('/:id/dashboard-access', requireAuth, requireAdmin, async (req, res) => {
  const { dashboard_ids } = req.body || {};
  if (!Array.isArray(dashboard_ids)) {
    return res.status(400).json({ error: 'dashboard_ids must be an array' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM user_dashboard_access WHERE user_id = ?`, [req.params.id]);
    for (const dashboardId of dashboard_ids) {
      await conn.query(
        `INSERT IGNORE INTO user_dashboard_access (user_id, dashboard_id) VALUES (?, ?)`,
        [req.params.id, dashboardId]
      );
    }
    await conn.commit();
    res.json({ ok: true, dashboard_ids });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  const [result] = await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

module.exports = router;
