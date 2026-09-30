// Seeds one admin account, one demo client account, and the dashboard/report
// catalog for the demo. Safe to re-run (uses INSERT ... ON DUPLICATE KEY).
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./pool');

async function main() {
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';
  const demoPassword = process.env.SEED_DEMO_PASSWORD || 'DemoPass123!';

  const adminHash = await bcrypt.hash(adminPassword, 10);
  const demoHash = await bcrypt.hash(demoPassword, 10);

  await pool.query(
    `INSERT INTO users (email, password_hash, display_name, role, must_change_password)
     VALUES (?, ?, ?, 'admin', FALSE)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
    ['admin@kinsupplyandservice.com', adminHash, 'KSS Admin']
  );

  await pool.query(
    `INSERT INTO users (email, password_hash, display_name, role, must_change_password)
     VALUES (?, ?, ?, 'client', TRUE)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
    ['demo@kinsupplyandservice.com', demoHash, 'Demo Client']
  );

  await pool.query(
    `INSERT INTO dashboards (dashboard_key, display_name, sort_order, active)
     VALUES ('purchase_analysis', 'Purchase Analysis', 1, TRUE)
     ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`
  );

  const [[dash]] = await pool.query(
    `SELECT id FROM dashboards WHERE dashboard_key = 'purchase_analysis'`
  );

  await pool.query(
    `INSERT INTO reports (dashboard_id, report_key, display_name, data_source, sort_order, active)
     VALUES (?, 'purchase-analysis-visual', 'PO / GRN / Invoice Dashboard', 'FMH', 1, TRUE)
     ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,
    [dash.id]
  );

  // Three new dashboards, each backed by a real FMH catalog report (needs the
  // FMH API key set in Settings — see lib/fmh.js).
  const newDashboards = [
    { key: 'cogs', name: 'COGS Analysis', reportKey: 'cogs', reportName: 'Central Kitchen COGS' },
    { key: 'menu_costing', name: 'Menu Costing Analysis', reportKey: 'menu-ingredient-impact', reportName: 'Ingredient Cost Impact & Price Sensitivity' },
    { key: 'sales_by_branch', name: 'Sales by Branch', reportKey: 'sales-by-branch', reportName: 'Order Items by Branch' },
  ];

  for (let i = 0; i < newDashboards.length; i++) {
    const d = newDashboards[i];
    await pool.query(
      `INSERT INTO dashboards (dashboard_key, display_name, sort_order, active)
       VALUES (?, ?, ?, TRUE)
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,
      [d.key, d.name, i + 2]
    );
    const [[row]] = await pool.query(`SELECT id FROM dashboards WHERE dashboard_key = ?`, [d.key]);
    await pool.query(
      `INSERT INTO reports (dashboard_id, report_key, display_name, data_source, sort_order, active)
       VALUES (?, ?, ?, 'FMH', 1, TRUE)
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,
      [row.id, d.reportKey, d.reportName]
    );
  }

  // Cleanup: an earlier seed created a 'menu-costing' report (raw ingredient
  // table). It's been replaced by 'cogs-visual' (KPI dashboard) — remove the
  // stale row so it doesn't show up twice under the same dashboard tab.
  await pool.query(`DELETE FROM reports WHERE report_key = 'menu-costing'`);

  // Cleanup: the original mock 'price_change' report has been replaced by
  // 'purchase-analysis-visual' (real FMH purchase_analysis data) — remove the
  // stale row so it doesn't show up twice under the Purchase Analysis tab.
  await pool.query(`DELETE FROM reports WHERE report_key = 'price_change'`);

  // Cleanup: Menu Costing Analysis moved from 'cogs-visual' (blocked by an
  // FMH-side sync issue on the cogs report) to 'menu-ingredient-impact'
  // (menu_and_ingredients report — ingredient cost impact & price sensitivity).
  await pool.query(`DELETE FROM reports WHERE report_key = 'cogs-visual'`);

  console.log('Seed complete.');
  console.log(`Admin login: admin@kinsupplyandservice.com / ${adminPassword}`);
  console.log(`Demo login:  demo@kinsupplyandservice.com / ${demoPassword} (must change password on first login)`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
