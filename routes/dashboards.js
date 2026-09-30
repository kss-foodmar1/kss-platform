// Returns the tab structure (dashboards) and the reports inside each tab.
// For this demo, every logged-in user sees every active dashboard/report —
// per-client entitlement (client_report_access) is a later addition noted
// in the handoff doc, not implemented here.
const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const [dashboards] = await pool.query(
    `SELECT id, dashboard_key, display_name, sort_order
     FROM dashboards WHERE active = TRUE ORDER BY sort_order, display_name`
  );
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

module.exports = router;
