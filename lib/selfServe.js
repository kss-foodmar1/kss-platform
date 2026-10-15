// Self-serve: a restaurant signs up on the website, KSS approves, the company
// gets a free trial on demo data (it can enter its own FMH key any time), and
// its admin pays monthly or yearly in the app. Companies KSS onboards by hand
// are untouched: everything here applies only to companies.self_serve = 1.
//
//   signup → pending → (KSS) approve → trial company + company_admin
//   trial ends unpaid → locked: the app shows only the plan page; data kept
//   locked > RETENTION days → KSS may clear the data (a button, never automatic)
//
// Prices live in billing_prices (set in Admin Console), never in code.
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const billing = require('./billing');

const TRIAL_DAYS = () => Number(process.env.TRIAL_DAYS || 30);
const RETENTION_DAYS = () => Number(process.env.LOCK_RETENTION_DAYS || 60);
// A paid self-serve subscription gets a few days' grace before locking; a trial does not.
const PAID_GRACE_DAYS = () => Number(process.env.SELF_SERVE_GRACE_DAYS || 3);
const PERIODS = { 1: 'รายเดือน', 12: 'รายปี' };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Signup is on unless SELF_SIGNUP=off, and off on Railway production unless
// SELF_SIGNUP=on — the same launch switch pattern as online payment.
function signupEnabled() {
  const flag = String(process.env.SELF_SIGNUP || '').trim().toLowerCase();
  if (flag === 'on') return true;
  if (flag === 'off') return false;
  return String(process.env.RAILWAY_ENVIRONMENT_NAME || '').trim().toLowerCase() !== 'production';
}

const today = () => billing.todayBangkok();
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

// ---------- subscription state ----------
// { self_serve, state: 'trial'|'active'|'locked'|'managed', ends_at, days_left, locked_since }
function subscriptionOf(c, now = today()) {
  if (!c) return null;
  const ends = billing.dateStr(c.subscription_ends_at);
  if (!c.self_serve) return { self_serve: false, state: 'managed', ends_at: ends };
  const trial = c.status === 'trial';
  const lockFrom = ends ? addDays(ends, trial ? 1 : 1 + PAID_GRACE_DAYS()) : null;
  const locked = !!lockFrom && now >= lockFrom;
  return {
    self_serve: true,
    state: locked ? 'locked' : trial ? 'trial' : 'active',
    ends_at: ends,
    days_left: ends ? Math.max(0, daysBetween(now, ends)) : null,
    locked_since: locked ? lockFrom : null,
    in_grace: !trial && !!ends && now > ends && !locked,
    data_purged: !!c.data_purged_at,
    data_source: c.data_source,
  };
}
async function subscriptionFor(companyId) {
  if (!companyId) return null;
  const [[c]] = await pool.query(`SELECT status, subscription_ends_at, self_serve, data_purged_at, data_source FROM companies WHERE id = ?`, [companyId]);
  return subscriptionOf(c);
}

// ---------- prices ----------
async function prices() {
  const [rows] = await pool.query(`SELECT period_months, amount_satang FROM billing_prices WHERE period_months IN (1, 12)`);
  const by = Object.fromEntries(rows.map((r) => [r.period_months, r.amount_satang]));
  return [1, 12].map((m) => ({ period_months: m, label: PERIODS[m], amount_baht: by[m] ? by[m] / 100 : null }));
}
async function setPrices({ monthly, yearly }, userId) {
  for (const [m, v] of [[1, monthly], [12, yearly]]) {
    if (v === undefined || v === null || v === '') { await pool.query(`DELETE FROM billing_prices WHERE period_months = ?`, [m]); continue; }
    const satang = billing.bahtToSatang(v);
    await pool.query(
      `INSERT INTO billing_prices (period_months, amount_satang, updated_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE amount_satang = VALUES(amount_satang), updated_by = VALUES(updated_by)`,
      [m, satang, userId || null]
    );
  }
  return prices();
}

// ---------- signup ----------
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clip = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);

async function createSignup(body, ip) {
  if (!signupEnabled()) throw bad('ยังไม่เปิดรับสมัครออนไลน์ กรุณาติดต่อทีม KSS', 403);
  const b = body || {};
  if (b.website) throw bad('ส่งข้อมูลไม่สำเร็จ'); // honeypot: people don't fill a hidden field
  const company = clip(b.company_name, 120), contact = clip(b.contact_name, 120);
  const email = clip(b.email, 255).toLowerCase(), phone = clip(b.phone, 40);
  if (company.length < 2) throw bad('กรุณากรอกชื่อร้าน / บริษัท');
  if (contact.length < 2) throw bad('กรุณากรอกชื่อผู้ติดต่อ');
  if (!EMAIL.test(email)) throw bad('อีเมลไม่ถูกต้อง');
  if (phone.replace(/\D/g, '').length < 9) throw bad('เบอร์โทรไม่ถูกต้อง');
  if (String(b.password || '').length < 8) throw bad('รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร');
  if (!b.consent) throw bad('กรุณายืนยันการให้ข้อมูลเพื่อให้ทีม KSS ติดต่อกลับ');
  const [[u]] = await pool.query(`SELECT id FROM users WHERE email = ?`, [email]);
  if (u) throw bad('อีเมลนี้มีบัญชีอยู่แล้ว เข้าสู่ระบบได้เลย', 409);
  const [[p]] = await pool.query(`SELECT id FROM signup_requests WHERE email = ? AND status = 'pending'`, [email]);
  if (p) throw bad('อีเมลนี้ส่งคำขอไว้แล้ว รอทีม KSS ติดต่อกลับ', 409);
  const [[n]] = await pool.query(`SELECT COUNT(*) n FROM signup_requests WHERE ip = ? AND created_at > NOW() - INTERVAL 1 HOUR`, [ip || '']);
  if (n.n >= 5) throw bad('ส่งคำขอบ่อยเกินไป ลองใหม่ภายหลัง', 429);
  const uses = ['yes', 'no', 'unsure'].includes(b.uses_fmh) ? b.uses_fmh : 'unsure';
  const [r] = await pool.query(
    `INSERT INTO signup_requests (company_name, contact_name, email, phone, branches, uses_fmh, note, password_hash, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [company, contact, email, phone, clip(b.branches, 40) || null, uses, clip(b.note, 500) || null, await bcrypt.hash(String(b.password), 10), ip || null]
  );
  return { id: r.insertId };
}

// For the login screen: an email that has no account yet but a request.
async function signupStatusFor(email) {
  const [[s]] = await pool.query(
    `SELECT status, decision_note FROM signup_requests WHERE email = ? ORDER BY id DESC LIMIT 1`,
    [String(email || '').trim().toLowerCase()]
  );
  return s || null;
}

async function listSignups(status = 'pending') {
  const [rows] = await pool.query(
    `SELECT s.id, s.company_name, s.contact_name, s.email, s.phone, s.branches, s.uses_fmh, s.note, s.status,
            s.company_id, s.decided_at, s.decision_note, s.created_at, u.email AS decided_by_email
     FROM signup_requests s LEFT JOIN users u ON u.id = s.decided_by
     WHERE (? = 'all' OR s.status = ?) ORDER BY s.created_at DESC LIMIT 200`,
    [status, status]
  );
  return rows;
}
async function pendingCount() {
  const [[r]] = await pool.query(`SELECT COUNT(*) n FROM signup_requests WHERE status = 'pending'`);
  return r.n;
}

// The dashboard a new trial company starts with: purchasing (one FMH pull
// feeds every widget here, so a fresh key costs little quota) plus the
// daily alerts.
const STARTER = ['watch_price', 'watch_po', 'pa_kpis', 'pa_trend', 'pc_movers', 'pa_supplier_spend', 'branch_purchase_tabs'];

async function approve(id, userId, note) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[s]] = await conn.query(`SELECT * FROM signup_requests WHERE id = ? FOR UPDATE`, [id]);
    if (!s) throw bad('ไม่พบคำขอนี้', 404);
    if (s.status !== 'pending') throw bad('คำขอนี้ตัดสินไปแล้ว', 409);
    const [[u]] = await conn.query(`SELECT id FROM users WHERE email = ?`, [s.email]);
    if (u) throw bad('อีเมลนี้มีบัญชีอยู่แล้ว', 409);
    const ends = addDays(today(), TRIAL_DAYS());
    const [c] = await conn.query(
      `INSERT INTO companies (name, status, plan_tier, data_source, self_serve, subscription_ends_at) VALUES (?, 'trial', 'starter', 'demo', TRUE, ?)`,
      [s.company_name, ends]
    );
    const companyId = c.insertId;
    await require('./companyCode').assignMissingCodes(conn);
    await conn.query(
      `INSERT INTO users (email, password_hash, display_name, role, company_id, must_change_password) VALUES (?, ?, ?, 'company_admin', ?, FALSE)`,
      [s.email, s.password_hash, s.contact_name, companyId]
    );
    const [d] = await conn.query(`INSERT INTO dashboards (company_id, display_name, description, sort_order, active) VALUES (?, ?, ?, 1, TRUE)`, [
      companyId, 'ภาพรวมจัดซื้อ', 'ชุดเริ่มต้น: ตัวเตือนรายวัน และภาพรวมการจัดซื้อ — เพิ่ม/ลบ widget ได้ที่ ✎ จัดการ Dashboard',
    ]);
    await require('./widgetCatalog').addTemplatesToDashboard(conn, d.insertId, STARTER);
    await conn.query(
      `UPDATE signup_requests SET status = 'approved', company_id = ?, decided_by = ?, decided_at = NOW(), decision_note = ? WHERE id = ?`,
      [companyId, userId || null, clip(note, 255) || null, id]
    );
    await conn.commit();
    return { company_id: companyId, trial_ends_at: ends };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
async function reject(id, userId, note) {
  const [r] = await pool.query(
    `UPDATE signup_requests SET status = 'rejected', decided_by = ?, decided_at = NOW(), decision_note = ?, password_hash = '' WHERE id = ? AND status = 'pending'`,
    [userId || null, clip(note, 255) || null, id]
  );
  if (!r.affectedRows) throw bad('ไม่พบคำขอที่รออนุมัติ', 404);
}

// ---------- paying ----------
// A company admin picks monthly or yearly; the amount comes from billing_prices.
// An unpaid link for the same period from the last day is reused.
async function checkout(companyId, periodMonths, userId) {
  const m = Number(periodMonths);
  if (![1, 12].includes(m)) throw bad('เลือกแพ็กเกจรายเดือนหรือรายปี');
  const [[c]] = await pool.query(`SELECT self_serve FROM companies WHERE id = ?`, [companyId]);
  if (!c || !c.self_serve) throw bad('บริษัทนี้ชำระผ่านทีม KSS', 403);
  if (!require('./omise').paymentsEnabled()) throw bad('ยังเปิดชำระเงินออนไลน์ไม่ได้ กรุณาติดต่อทีม KSS เพื่อชำระโดยการโอน', 409);
  const price = (await prices()).find((p) => p.period_months === m);
  if (!price || !price.amount_baht) throw bad('ยังไม่ได้ตั้งราคาแพ็กเกจ กรุณาติดต่อทีม KSS', 409);
  const [[open]] = await pool.query(
    `SELECT token FROM payments WHERE company_id = ? AND status = 'pending' AND period_months = ? AND amount_satang = ? AND (pay_method IS NULL OR pay_method = 'promptpay') AND created_at > NOW() - INTERVAL 1 DAY ORDER BY id DESC LIMIT 1`,
    [companyId, m, Math.round(price.amount_baht * 100)]
  );
  if (open) return { token: open.token, reused: true };
  const p = await billing.createPayment({ companyId, description: `KSS Dashboard แพ็กเกจ${PERIODS[m]}`, amountBaht: price.amount_baht, periodMonths: m, createdBy: userId });
  return { token: p.token, reused: false };
}
async function paymentsOf(companyId) {
  const [rows] = await pool.query(
    `SELECT id, description, amount_satang, period_months, status, paid_at, paid_via, extended_to, created_at, token, pay_method, authorize_uri
     FROM payments WHERE company_id = ? ORDER BY id DESC LIMIT 20`,
    [companyId]
  );
  return rows.map((p) => ({
    id: p.id, description: p.description, amount_baht: p.amount_satang / 100, period_months: p.period_months, status: p.status,
    paid_at: p.paid_at, paid_via: p.paid_via, extended_to: billing.dateStr(p.extended_to), created_at: p.created_at,
    pay_method: p.pay_method || 'promptpay',
    // A pending card charge is finished at the bank's 3-D Secure page.
    pay_path: p.status !== 'pending' ? null : p.pay_method === 'card' ? p.authorize_uri || null : `/pay/${p.token}`,
  }));
}

// ---------- locked too long: KSS clears the data (never automatic) ----------
async function lockedCompanies() {
  const [rows] = await pool.query(
    `SELECT id, company_code, name, status, subscription_ends_at, self_serve, data_purged_at, data_source FROM companies WHERE self_serve = TRUE`
  );
  const now = today();
  return rows
    .map((c) => ({ c, s: subscriptionOf(c, now) }))
    .filter(({ s }) => s.state === 'locked')
    .map(({ c, s }) => ({
      id: c.id, company_code: c.company_code, name: c.name, ends_at: s.ends_at, locked_since: s.locked_since,
      locked_days: daysBetween(s.locked_since, now), purgeable: daysBetween(s.locked_since, now) >= RETENTION_DAYS() && !c.data_purged_at,
      data_purged_at: c.data_purged_at,
    }));
}
const PURGE_TABLES = ['fmh_report_cache', 'fmh_cache_saved', 'fmh_sync_errors', 'fmh_file_rows', 'fmh_file_uploads', 'pos_sales_daily', 'pos_uploads', 'pos_menu_map', 'ck_branch_map', 'alert_events', 'company_line'];
async function purge(companyId) {
  const row = (await lockedCompanies()).find((x) => x.id === Number(companyId));
  if (!row) throw bad('บริษัทนี้ไม่ได้อยู่ในสถานะล็อก', 409);
  if (!row.purgeable) throw bad(`ลบได้เมื่อล็อกครบ ${RETENTION_DAYS()} วัน (ตอนนี้ ${row.locked_days} วัน)`, 409);
  for (const t of PURGE_TABLES) {
    try { await pool.query(`DELETE FROM ${t} WHERE company_id = ?`, [companyId]); } catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e; }
  }
  await pool.query(`UPDATE companies SET fmh_api_key_enc = NULL, fmh_key_updated_at = NULL, data_purged_at = NOW() WHERE id = ?`, [companyId]);
}

module.exports = {
  TRIAL_DAYS, RETENTION_DAYS, signupEnabled, subscriptionOf, subscriptionFor, prices, setPrices,
  createSignup, signupStatusFor, listSignups, pendingCount, approve, reject, checkout, paymentsOf, lockedCompanies, purge, STARTER,
};
