// Returns the tab structure (dashboards) and the reports inside each tab.
// Admins always see every active dashboard. Clients see only the dashboards
// an admin has granted them in user_dashboard_access (Manage Users) — so
// different clients can have a different number of tabs.
const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  let dashboards;
  if (req.user.role === 'admin') {
    [dashboards] = await pool.query(
      `SELECT id, dashboard_key, display_name, sort_order
       FROM dashboards WHERE active = TRUE ORDER BY sort_order, display_name`
    );
  } else {
    [dashboards] = await pool.query(
      `SELECT d.id, d.dashboard_key, d.display_name, d.sort_order
       FROM dashboards d
       JOIN user_dashboard_access uda ON uda.dashboard_id = d.id
       WHERE d.active = TRUE AND uda.user_id = ?
       ORDER BY d.sort_order, d.display_name`,
      [req.user.id]
    );
  }

  const [reports] = await pool.query(
    `SELECT id, dashboard_id, report_key, display_name, data_source, sort_order
     FROM reports WHERE active = TRUE ORDER BY sort_order, display_name`
  );

  const result = dashboards.map((d) => ({
    ...d,
    reports: reports.filter((r) => r.dashboard_id === d.id),
  }));

  res.json({ dashboards: result });
});

// Admin-only: every dashboard (active or not), for the Manage Users tab-access UI.
router.get('/admin/all', requireAuth, requireAdmin, async (req, res) => {
  const [dashboards] = await pool.query(
    `SELECT id, dashboard_key, display_name, sort_order, active
     FROM dashboards ORDER BY sort_order, display_name`
  );
  res.json({ dashboards });
});

module.exports = router;
