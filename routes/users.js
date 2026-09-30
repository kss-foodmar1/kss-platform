// User management, scoped to one company.
//
// company_admin: manages users of their own company only.
// KSS staff:     manage any company's users (pass company_id), or the KSS
//                staff list itself (company_id = 'kss').
//
// Every write double-checks that the target user (and any dashboard being
// granted) belongs to the company in scope — that's what stops a company
// admin from touching another tenant's users or granting another tenant's
// dashboards.
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireAuth, requireCompanyAdmin } = require('../middleware/auth');
const { wrap, isSuperadmin, resolveCompanyId } = require('../lib/access');

const router = express.Router();

const COMPANY_ROLES = ['company_admin', 'client'];

// { kss: true } for the KSS staff list, { companyId } for a company, or null.
function resolveScope(req) {
  const raw = (req.query && req.query.company_id) ?? (req.body && req.body.company_id);
  if (isSuperadmin(req.user) && raw === 'kss') return { kss: true };
  const companyId = resolveCompanyId(req);
  return companyId ? { companyId } : null;
}

async function loadTargetUser(req, res) {
  const scope = resolveScope(req);
  if (!scope) {
    res.status(400).json({ error: 'company_id required' });
    return null;
  }
  const [[target]] = await pool.query(`SELECT id, role, company_id FROM users WHERE id = ?`, [req.params.id]);
  const inScope =
    target &&
    (scope.kss ? target.role === 'kss_superadmin' : target.company_id === scope.companyId && target.role !== 'kss_superadmin');
  if (!inScope) {
    res.status(404).json({ error: 'User not found' });
    return null;
  }
  return { target, scope };
}

router.get(
  '/',
  requireAuth,
  requireCompanyAdmin,
  wrap(async (req, res) => {
    const scope = resolveScope(req);
    if (!scope) return res.status(400).json({ error: 'company_id required' });
    const [rows] = scope.kss
      ? await pool.query(
          `SELECT id, email, display_name, role, must_change_password, created_at
           FROM users WHERE role = 'kss_superadmin' ORDER BY created_at DESC`
        )
      : await pool.query(
          `SELECT id, email, display_name, role, must_change_password, created_at
           FROM users WHERE company_id = ? AND role <> 'kss_superadmin' ORDER BY created_at DESC`,
          [scope.companyId]
        );
    res.json({ users: rows });
  })
);

// Create a user. A temporary password is required; they must change it on first login.
router.post(
  '/',
  requireAuth,
  requireCompanyAdmin,
  wrap(async (req, res) => {
    const scope = resolveScope(req);
    if (!scope) return res.status(400).json({ error: 'company_id required' });
    const { email, display_name, temp_password, role } = req.body || {};
    if (!email || !display_name || !temp_password) {
      return res.status(400).json({ error: 'email, display_name and temp_password are required' });
    }
    if (temp_password.length < 8) {
      return res.status(400).json({ error: 'Temporary password must be at least 8 characters' });
    }
    const [[existing]] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) return res.status(409).json({ error: 'A user with this email already exists' });

    const safeRole = scope.kss ? 'kss_superadmin' : COMPANY_ROLES.includes(role) ? role : 'client';
    const [result] = await pool.query(
      `INSERT INTO users (email, password_hash, display_name, role, company_id, must_change_password)
       VALUES (?, ?, ?, ?, ?, TRUE)`,
      [email, await bcrypt.hash(temp_password, 10), display_name, safeRole, scope.kss ? null : scope.companyId]
    );
    res.status(201).json({ id: result.insertId, email, display_name, role: safeRole });
  })
);

router.post(
  '/:id/reset-password',
  requireAuth,
  requireCompanyAdmin,
  wrap(async (req, res) => {
    const loaded = await loadTargetUser(req, res);
    if (!loaded) return;
    const { temp_password } = req.body || {};
    if (!temp_password || temp_password.length < 8) {
      return res.status(400).json({ error: 'Temporary password must be at least 8 characters' });
    }
    await pool.query(`UPDATE users SET password_hash = ?, must_change_password = TRUE WHERE id = ?`, [
      await bcrypt.hash(temp_password, 10),
      loaded.target.id,
    ]);
    res.json({ ok: true });
  })
);

// Switch a company user between company_admin and client.
router.patch(
  '/:id/role',
  requireAuth,
  requireCompanyAdmin,
  wrap(async (req, res) => {
    const loaded = await loadTargetUser(req, res);
    if (!loaded) return;
    const { role } = req.body || {};
    if (loaded.scope.kss || !COMPANY_ROLES.includes(role)) {
      return res.status(400).json({ error: 'role must be "company_admin" or "client"' });
    }
    if (loaded.target.id === req.user.id) return res.status(400).json({ error: 'Cannot change your own role' });
    await pool.query(`UPDATE users SET role = ? WHERE id = ?`, [role, loaded.target.id]);
    res.json({ ok: true, role });
  })
);

router.get(
  '/:id/dashboard-access',
  requireAuth,
  requireCompanyAdmin,
  wrap(async (req, res) => {
    const loaded = await loadTargetUser(req, res);
    if (!loaded) return;
    const [rows] = await pool.query(`SELECT dashboard_id FROM user_dashboard_access WHERE user_id = ?`, [loaded.target.id]);
    res.json({ dashboard_ids: rows.map((r) => r.dashboard_id) });
  })
);

// Replace which of the company's dashboards a user can see.
router.put(
  '/:id/dashboard-access',
  requireAuth,
  requireCompanyAdmin,
  wrap(async (req, res) => {
    const loaded = await loadTargetUser(req, res);
    if (!loaded) return;
    if (loaded.scope.kss) return res.status(400).json({ error: 'KSS staff see every dashboard' });
    const { dashboard_ids } = req.body || {};
    if (!Array.isArray(dashboard_ids)) return res.status(400).json({ error: 'dashboard_ids must be an array' });

    const ids = [...new Set(dashboard_ids.map(Number).filter(Number.isInteger))];
    if (ids.length) {
      const [own] = await pool.query(`SELECT id FROM dashboards WHERE company_id = ? AND id IN (?)`, [
        loaded.scope.companyId,
        ids,
      ]);
      if (own.length !== ids.length) {
        return res.status(400).json({ error: 'มี dashboard ที่ไม่ได้เป็นของบริษัทนี้' });
      }
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`DELETE FROM user_dashboard_access WHERE user_id = ?`, [loaded.target.id]);
      for (const dashboardId of ids) {
        await conn.query(`INSERT INTO user_dashboard_access (user_id, dashboard_id) VALUES (?, ?)`, [
          loaded.target.id,
          dashboardId,
        ]);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    res.json({ ok: true, dashboard_ids: ids });
  })
);

router.delete(
  '/:id',
  requireAuth,
  requireCompanyAdmin,
  wrap(async (req, res) => {
    const loaded = await loadTargetUser(req, res);
    if (!loaded) return;
    if (loaded.target.id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
    await pool.query('DELETE FROM users WHERE id = ?', [loaded.target.id]);
    res.json({ ok: true });
  })
);

module.exports = router;
