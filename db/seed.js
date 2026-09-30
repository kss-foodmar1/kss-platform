// Runs on every boot, after db/migrate.js. Safe to re-run.
//
//   - KSS superadmin account (admin@kinsupplyandservice.com)
//   - "Demo Co": the sales-demo company (status 'demo', not billed). Sales
//     shows it by switching to it from the company picker. It gets two
//     showcase dashboards the first time only — after that the team curates
//     it in the Admin Console like any other company. Its FMH key (the FMH
//     demo account's key) is entered in the Admin Console, never in code.
//   - demo@kinsupplyandservice.com: a client login for Demo Co, created only if
//     that email doesn't exist yet (on production it already exists from the
//     single-tenant days and stays wherever the migration put it).
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./pool');
const { syncCatalog, addTemplatesToDashboard } = require('../lib/widgetCatalog');

const DEMO_COMPANY_NAME = 'Demo Co';

const DEMO_DASHBOARDS = [
  {
    name: 'ภาพรวมการจัดซื้อ',
    description: 'PO / GRN / Invoice — ส่วนต่าง, supplier และหมวดหมู่',
    templates: ['pa_kpis', 'pa_trend', 'pa_attention_products', 'pa_top_suppliers', 'pa_category_variance'],
  },
  {
    name: 'ต้นทุนเมนู',
    description: 'วัตถุดิบไหนคุมต้นทุน และผลกระทบถ้าราคาขยับ',
    templates: ['mc_kpis', 'mc_top_ingredients', 'mc_top_menus', 'mc_sensitivity', 'mc_menu_breakdown'],
  },
];

async function main() {
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';
  const demoPassword = process.env.SEED_DEMO_PASSWORD || 'DemoPass123!';

  await pool.query(
    `INSERT INTO users (email, password_hash, display_name, role, company_id, must_change_password)
     VALUES (?, ?, ?, 'kss_superadmin', NULL, FALSE)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
    ['admin@kinsupplyandservice.com', await bcrypt.hash(adminPassword, 10), 'KSS Admin']
  );

  await syncCatalog();

  let [[demoCo]] = await pool.query(`SELECT id FROM companies WHERE status = 'demo' ORDER BY id LIMIT 1`);
  if (!demoCo) {
    const [res] = await pool.query(
      `INSERT INTO companies (name, status, plan_tier) VALUES (?, 'demo', 'growth')`,
      [DEMO_COMPANY_NAME]
    );
    demoCo = { id: res.insertId };
    for (let i = 0; i < DEMO_DASHBOARDS.length; i++) {
      const d = DEMO_DASHBOARDS[i];
      const [dash] = await pool.query(
        `INSERT INTO dashboards (company_id, display_name, description, sort_order) VALUES (?, ?, ?, ?)`,
        [demoCo.id, d.name, d.description, i + 1]
      );
      await addTemplatesToDashboard(pool, dash.insertId, d.templates);
    }
    console.log(`Created ${DEMO_COMPANY_NAME} (id ${demoCo.id}) with ${DEMO_DASHBOARDS.length} showcase dashboards.`);
  }

  const [[existingDemoUser]] = await pool.query(`SELECT id FROM users WHERE email = 'demo@kinsupplyandservice.com'`);
  if (!existingDemoUser) {
    const [res] = await pool.query(
      `INSERT INTO users (email, password_hash, display_name, role, company_id, must_change_password)
       VALUES (?, ?, 'Demo Client', 'client', ?, TRUE)`,
      ['demo@kinsupplyandservice.com', await bcrypt.hash(demoPassword, 10), demoCo.id]
    );
    const [dashes] = await pool.query(`SELECT id FROM dashboards WHERE company_id = ?`, [demoCo.id]);
    for (const d of dashes) {
      await pool.query(`INSERT IGNORE INTO user_dashboard_access (user_id, dashboard_id) VALUES (?, ?)`, [res.insertId, d.id]);
    }
  }

  console.log('Seed complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
