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
     VALUES (?, 'price_change', 'Price Change Report', 'FMH', 1, TRUE)
     ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,
    [dash.id]
  );

  console.log('Seed complete.');
  console.log(`Admin login: admin@kinsupplyandservice.com / ${adminPassword}`);
  console.log(`Demo login:  demo@kinsupplyandservice.com / ${demoPassword} (must change password on first login)`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
