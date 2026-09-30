// Brings the database to the current multi-tenant, widget-based shape.
// Safe to re-run on every boot (it is — see the `start` script):
//
//   1. schema.sql — CREATE TABLE IF NOT EXISTS for every table (fresh DBs get
//      the final shape straight away; on existing DBs these are no-ops).
//   2. Upgrade steps for tables that pre-date multi-tenancy. Each step checks
//      information_schema first, so it only does anything the first time.
//      (MySQL 8 has no "ADD COLUMN IF NOT EXISTS", hence the checks.)
//   3. Sync the built-in Widget Catalog.
//   4. One-time legacy conversion: if the database has data from the old
//      single-tenant app, move all of it into a "Company #1" and turn the old
//      four fixed tabs into widget-based dashboards that look the same.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./pool');
const { syncCatalog, addTemplatesToDashboard, LEGACY_DASHBOARD_WIDGETS } = require('../lib/widgetCatalog');

const LEGACY_COMPANY_NAME = 'Company #1 (ข้อมูลเดิม)';

async function columnInfo(table, column) {
  const [[row]] = await pool.query(
    `SELECT COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return row || null;
}

async function primaryKeyColumns(table) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
     ORDER BY ORDINAL_POSITION`,
    [table]
  );
  return rows.map((r) => r.COLUMN_NAME);
}

async function runSchemaFile() {
  const raw = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  // Strip full-line comments first, so a comment sitting right before a
  // statement doesn't cause the whole statement to be dropped.
  const sql = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length);
  for (const stmt of statements) await pool.query(stmt);
  return statements.length;
}

async function upgradeUsers() {
  if (!(await columnInfo('users', 'company_id'))) {
    await pool.query(`ALTER TABLE users ADD COLUMN company_id INT NULL, ADD INDEX idx_users_company (company_id)`);
    console.log('  users: added company_id');
  }
  const role = await columnInfo('users', 'role');
  if (role && !role.COLUMN_TYPE.includes('kss_superadmin')) {
    // Widen first so both old and new values are legal, remap, then narrow.
    await pool.query(
      `ALTER TABLE users MODIFY role ENUM('admin','client','kss_superadmin','company_admin') NOT NULL DEFAULT 'client'`
    );
    await pool.query(`UPDATE users SET role = 'kss_superadmin', company_id = NULL WHERE role = 'admin'`);
    await pool.query(
      `ALTER TABLE users MODIFY role ENUM('kss_superadmin','company_admin','client') NOT NULL DEFAULT 'client'`
    );
    console.log('  users: roles upgraded (admin -> kss_superadmin)');
  }
}

async function upgradeDashboards() {
  if (!(await columnInfo('dashboards', 'company_id'))) {
    await pool.query(`ALTER TABLE dashboards ADD COLUMN company_id INT NULL, ADD INDEX idx_dashboards_company (company_id)`);
    console.log('  dashboards: added company_id');
  }
  if (!(await columnInfo('dashboards', 'description'))) {
    await pool.query(`ALTER TABLE dashboards ADD COLUMN description VARCHAR(500) NULL`);
  }
  if (!(await columnInfo('dashboards', 'created_at'))) {
    await pool.query(`ALTER TABLE dashboards ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
  }
  // The old global catalog had dashboard_key UNIQUE NOT NULL. Dashboards are
  // per-company now, so the key is legacy-only: drop its uniqueness and make
  // it optional (kept, not dropped, so the legacy conversion can read it).
  const key = await columnInfo('dashboards', 'dashboard_key');
  if (key) {
    const [idx] = await pool.query(
      `SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dashboards'
         AND COLUMN_NAME = 'dashboard_key' AND NON_UNIQUE = 0`
    );
    for (const { INDEX_NAME } of idx) {
      await pool.query(`ALTER TABLE dashboards DROP INDEX \`${INDEX_NAME}\``);
      console.log(`  dashboards: dropped unique index ${INDEX_NAME}`);
    }
    if (key.IS_NULLABLE === 'NO') {
      await pool.query(`ALTER TABLE dashboards MODIFY dashboard_key VARCHAR(50) NULL`);
    }
  }
}

async function upgradeCache() {
  if (!(await columnInfo('fmh_report_cache', 'company_id'))) {
    // 0 = "belongs to the legacy company", reassigned in convertLegacyData().
    await pool.query(`ALTER TABLE fmh_report_cache ADD COLUMN company_id INT NOT NULL DEFAULT 0 FIRST`);
    console.log('  fmh_report_cache: added company_id');
  }
  const pk = await primaryKeyColumns('fmh_report_cache');
  if (pk.join(',') !== 'company_id,cache_key') {
    await pool.query(`ALTER TABLE fmh_report_cache DROP PRIMARY KEY, ADD PRIMARY KEY (company_id, cache_key)`);
    console.log('  fmh_report_cache: primary key is now (company_id, cache_key)');
  }
}

async function convertLegacyData() {
  const [[{ orphanUsers }]] = await pool.query(
    `SELECT COUNT(*) AS orphanUsers FROM users WHERE role <> 'kss_superadmin' AND company_id IS NULL`
  );
  const [[{ orphanDashboards }]] = await pool.query(
    `SELECT COUNT(*) AS orphanDashboards FROM dashboards WHERE company_id IS NULL`
  );
  const [[{ orphanCache }]] = await pool.query(
    `SELECT COUNT(*) AS orphanCache FROM fmh_report_cache WHERE company_id = 0`
  );
  if (!orphanUsers && !orphanDashboards && !orphanCache) return;

  console.log('  Legacy single-tenant data found — moving it into a Company #1...');
  let [[company]] = await pool.query(`SELECT id FROM companies WHERE name = ?`, [LEGACY_COMPANY_NAME]);
  if (!company) {
    const [res] = await pool.query(`INSERT INTO companies (name, status) VALUES (?, 'active')`, [LEGACY_COMPANY_NAME]);
    company = { id: res.insertId };
  }
  const companyId = company.id;

  // The single platform-wide FMH key becomes Company #1's key.
  const [[setting]] = await pool.query(`SELECT setting_value, updated_at FROM app_settings WHERE setting_key = 'fmh_api_key'`);
  if (setting) {
    await pool.query(
      `UPDATE companies SET fmh_api_key_enc = ?, fmh_key_updated_at = ? WHERE id = ? AND fmh_api_key_enc IS NULL`,
      [setting.setting_value, setting.updated_at, companyId]
    );
    await pool.query(`DELETE FROM app_settings WHERE setting_key = 'fmh_api_key'`);
  }

  await pool.query(
    `UPDATE users SET company_id = ? WHERE role <> 'kss_superadmin' AND company_id IS NULL`,
    [companyId]
  );
  await pool.query(`UPDATE fmh_report_cache SET company_id = ? WHERE company_id = 0`, [companyId]);

  // Old fixed tabs -> this company's dashboards, each rebuilt from catalog
  // widgets that reproduce what the tab used to show. Their ids don't change,
  // so existing per-user tab access keeps working untouched.
  const hasKey = await columnInfo('dashboards', 'dashboard_key');
  const [legacy] = await pool.query(
    `SELECT id${hasKey ? ', dashboard_key' : ''} FROM dashboards WHERE company_id IS NULL`
  );
  for (const d of legacy) {
    await pool.query(`UPDATE dashboards SET company_id = ? WHERE id = ?`, [companyId, d.id]);
    const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM dashboard_widgets WHERE dashboard_id = ?`, [d.id]);
    const templateKeys = LEGACY_DASHBOARD_WIDGETS[d.dashboard_key];
    if (!n && templateKeys) await addTemplatesToDashboard(pool, d.id, templateKeys);
  }
  console.log(
    `  Company #1 (id ${companyId}): ${orphanUsers} users, ${legacy.length} dashboards, ${orphanCache} cached reports moved.`
  );
}

// The old `reports` table was the fixed tab -> report catalog (config only, no
// client data). It's fully replaced by dashboard_widgets, and its foreign key
// into dashboards would block deleting a converted dashboard — so drop it
// once every dashboard belongs to a company.
async function dropLegacyReportsTable() {
  const [[t]] = await pool.query(
    `SELECT 1 AS present FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reports'`
  );
  if (!t) return;
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM dashboards WHERE company_id IS NULL`);
  if (n) return;
  await pool.query(`DROP TABLE reports`);
  console.log('  dropped legacy reports table');
}

async function main() {
  const n = await runSchemaFile();
  console.log(`Schema: ${n} statement(s) applied.`);
  await upgradeUsers();
  await upgradeDashboards();
  await upgradeCache();
  await syncCatalog();
  await convertLegacyData();
  await dropLegacyReportsTable();
  console.log('Migration complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
