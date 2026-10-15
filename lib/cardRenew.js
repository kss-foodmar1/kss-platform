// Card auto-renew for self-serve companies, CARD_DISCOUNT_PCT (default 5%) off
// the plan price. The card is tokenised in the browser by Omise.js and kept
// at Omise as a customer; KSS stores only brand / last 4 / expiry.
//
//   start   first charge now (3-D Secure → redirect, then /pay/card-return)
//   renew   daily: charge the day before the plan ends; a charge the bank holds
//           for 3-D Secure waits for the cardholder (banner + link); a declined
//           card is retried on the next 2 days, then left to the lock + grace
//   change / cancel from the plan page
//
// Every charge goes through a payments row (pay_method 'card') and is settled
// by the same code as PromptPay (lib/billing.js), so a webhook, the return
// page and the cron can all race safely.
const pool = require('../db/pool');
const omise = require('./omise');
const billing = require('./billing');

const DISCOUNT = () => Number(process.env.CARD_DISCOUNT_PCT ?? 5);
const MAX_FAILURES = 3;
const PERIODS = { 1: 'รายเดือน', 12: 'รายปี' };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const today = () => billing.todayBangkok();
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

const enabled = () => omise.paymentsEnabled() && !!omise.publicKey();
const cardPriceBaht = (baht) => Math.round(baht * (1 - DISCOUNT() / 100));

async function planPrice(periodMonths) {
  const p = (await require('./selfServe').prices()).find((x) => x.period_months === Number(periodMonths));
  if (!p || !p.amount_baht) throw bad('ยังไม่ได้ตั้งราคาแพ็กเกจ กรุณาติดต่อทีม KSS', 409);
  return cardPriceBaht(p.amount_baht);
}

function cardOf(customer) {
  const cards = (customer && customer.cards && customer.cards.data) || [];
  const c = cards.find((x) => x.id === customer.default_card) || cards[cards.length - 1] || {};
  return {
    brand: c.brand || null,
    last4: c.last_digits || null,
    expiry: c.expiration_month && c.expiration_year ? `${String(c.expiration_month).padStart(2, '0')}/${c.expiration_year}` : null,
  };
}
async function saveCard(companyId, customerId, card, periodMonths, userId) {
  await pool.query(
    `INSERT INTO card_subscriptions (company_id, omise_customer_id, card_brand, card_last4, card_expiry, period_months, discount_pct, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE omise_customer_id = VALUES(omise_customer_id), card_brand = VALUES(card_brand), card_last4 = VALUES(card_last4),
       card_expiry = VALUES(card_expiry), period_months = COALESCE(VALUES(period_months), period_months), discount_pct = VALUES(discount_pct),
       failures = 0, last_error = NULL`,
    [companyId, customerId, card.brand, card.last4, card.expiry, periodMonths || 1, DISCOUNT(), userId || null]
  );
}
async function get(companyId) {
  const [[r]] = await pool.query(`SELECT * FROM card_subscriptions WHERE company_id = ?`, [companyId]);
  return r || null;
}
async function companyOf(companyId) {
  const [[c]] = await pool.query(`SELECT id, name, company_code, self_serve, subscription_ends_at FROM companies WHERE id = ?`, [companyId]);
  if (!c || !c.self_serve) throw bad('บริษัทนี้ชำระผ่านทีม KSS', 403);
  return c;
}

// One card charge for one payments row. Returns { status: 'paid'|'pending'|'failed', authorize_uri, message }.
async function chargeFor(companyId, sub, periodMonths, { baseUrl, userId, why }) {
  const baht = await planPrice(periodMonths);
  const p = await billing.createPayment({
    companyId, amountBaht: baht, periodMonths,
    description: `KSS Dashboard แพ็กเกจ${PERIODS[periodMonths]} · บัตรตัดอัตโนมัติ (ลด ${DISCOUNT()}%)${why ? ` · ${why}` : ''}`,
    createdBy: userId || null,
  });
  await pool.query(`UPDATE payments SET pay_method = 'card' WHERE id = ?`, [p.id]);
  let charge;
  try {
    charge = await omise.createCardCharge({
      customerId: sub.omise_customer_id,
      amountSatang: Math.round(baht * 100),
      description: `KSS Dashboard ${PERIODS[periodMonths]}`,
      metadata: { kss_payment_id: String(p.id), kss_company_id: String(companyId) },
      returnUri: `${baseUrl}/pay/card-return/${p.token}`,
    });
  } catch (err) {
    await pool.query(`UPDATE payments SET status = 'cancelled' WHERE id = ?`, [p.id]);
    return { status: 'failed', message: err.message, paymentId: p.id };
  }
  await pool.query(`UPDATE payments SET charge_id = ?, authorize_uri = ? WHERE id = ?`, [charge.id, charge.authorize_uri || null, p.id]);
  if (charge.status === 'successful') {
    const after = await billing.refreshFromOmise(p.id);
    return { status: after.status === 'paid' ? 'paid' : 'pending', paymentId: p.id, extended_to: billing.dateStr(after.extended_to) };
  }
  if (charge.status === 'pending' && charge.authorize_uri) return { status: 'pending', authorize_uri: charge.authorize_uri, paymentId: p.id };
  await pool.query(`UPDATE payments SET status = 'cancelled' WHERE id = ?`, [p.id]);
  return { status: 'failed', message: charge.failure_message || charge.failure_code || 'บัตรถูกปฏิเสธ', paymentId: p.id };
}

// ---------- from the plan page ----------
async function start(companyId, { periodMonths, token, userId, email, baseUrl }) {
  if (!enabled()) throw bad('ยังเปิดชำระด้วยบัตรไม่ได้ กรุณาติดต่อทีม KSS', 409);
  const m = Number(periodMonths);
  if (![1, 12].includes(m)) throw bad('เลือกแพ็กเกจรายเดือนหรือรายปี');
  if (!/^tokn_/.test(String(token || ''))) throw bad('ข้อมูลบัตรไม่ครบ ลองกรอกใหม่');
  const c = await companyOf(companyId);
  await planPrice(m); // fail early if the plan is not on sale
  const existing = await get(companyId);
  let customer;
  if (existing) customer = await omise.updateCustomerCard(existing.omise_customer_id, token);
  else customer = await omise.createCustomer({ email, description: `${c.company_code || ''} ${c.name}`.trim(), cardToken: token, metadata: { kss_company_id: String(companyId) } });
  await saveCard(companyId, customer.id, cardOf(customer), m, userId);
  const sub = await get(companyId);
  const r = await chargeFor(companyId, sub, m, { baseUrl, userId });
  if (r.status === 'failed') throw bad(`ตัดบัตรไม่สำเร็จ: ${r.message}`, 402);
  return r;
}

async function changeCard(companyId, token) {
  if (!enabled()) throw bad('ยังเปิดชำระด้วยบัตรไม่ได้', 409);
  const sub = await get(companyId);
  if (!sub) throw bad('ยังไม่ได้ผูกบัตร', 404);
  if (!/^tokn_/.test(String(token || ''))) throw bad('ข้อมูลบัตรไม่ครบ ลองกรอกใหม่');
  const customer = await omise.updateCustomerCard(sub.omise_customer_id, token);
  await saveCard(companyId, customer.id, cardOf(customer), sub.period_months);
  return status(companyId);
}

async function setActive(companyId, on, periodMonths) {
  const sub = await get(companyId);
  if (!sub) throw bad('ยังไม่ได้ผูกบัตร', 404);
  const m = [1, 12].includes(Number(periodMonths)) ? Number(periodMonths) : sub.period_months;
  await pool.query(`UPDATE card_subscriptions SET active = ?, period_months = ?, failures = 0, last_error = NULL WHERE company_id = ?`, [on ? 1 : 0, m, companyId]);
  return status(companyId);
}

async function status(companyId) {
  const sub = await get(companyId);
  if (!sub) return null;
  const [[c]] = await pool.query(`SELECT subscription_ends_at FROM companies WHERE id = ?`, [companyId]);
  const ends = billing.dateStr(c && c.subscription_ends_at);
  const [[pending]] = await pool.query(
    `SELECT authorize_uri FROM payments WHERE company_id = ? AND pay_method = 'card' AND status = 'pending' AND authorize_uri IS NOT NULL AND created_at > NOW() - INTERVAL 3 DAY ORDER BY id DESC LIMIT 1`,
    [companyId]
  );
  return {
    brand: sub.card_brand, last4: sub.card_last4, expiry: sub.card_expiry, period_months: sub.period_months,
    discount_pct: Number(sub.discount_pct), active: !!sub.active, failures: sub.failures, last_error: sub.last_error,
    next_charge_on: sub.active && ends ? addDays(ends, -1) : null,
    needs_authorization: pending ? pending.authorize_uri : null,
  };
}

// ---------- daily renewal ----------
// The day before the plan ends (or any day after, while unpaid), once a day,
// at most MAX_FAILURES declines in a row; a charge waiting for 3-D Secure is
// not doubled.
async function renewDue({ baseUrl = '', now = today() } = {}) {
  if (!enabled()) return { skipped: 'off' };
  // The bank's 3-D Secure page must be able to send the cardholder back.
  if (!/^https?:\/\//.test(baseUrl)) { console.error('Card renew skipped: set PUBLIC_BASE_URL'); return { skipped: 'no PUBLIC_BASE_URL' }; }
  const [subs] = await pool.query(
    `SELECT s.*, c.subscription_ends_at FROM card_subscriptions s JOIN companies c ON c.id = s.company_id
     WHERE s.active = TRUE AND c.self_serve = TRUE AND c.status <> 'suspended'
       AND c.subscription_ends_at IS NOT NULL AND c.subscription_ends_at <= ?
       AND (s.last_attempt_on IS NULL OR s.last_attempt_on < ?) AND s.failures < ?`,
    [addDays(now, 1), now, MAX_FAILURES]
  );
  const out = { charged: 0, pending: 0, failed: 0 };
  for (const sub of subs) {
    const [[waiting]] = await pool.query(
      `SELECT id FROM payments WHERE company_id = ? AND pay_method = 'card' AND status = 'pending' AND created_at > NOW() - INTERVAL 3 DAY LIMIT 1`,
      [sub.company_id]
    );
    if (waiting) continue;
    await pool.query(`UPDATE card_subscriptions SET last_attempt_on = ? WHERE company_id = ?`, [now, sub.company_id]);
    let r;
    try {
      r = await chargeFor(sub.company_id, sub, sub.period_months, { baseUrl, why: 'ต่ออายุอัตโนมัติ' });
    } catch (err) {
      r = { status: 'failed', message: err.message };
    }
    if (r.status === 'paid') out.charged++;
    else if (r.status === 'pending') out.pending++;
    else {
      out.failed++;
      await pool.query(`UPDATE card_subscriptions SET failures = failures + 1, last_error = ? WHERE company_id = ?`, [String(r.message || '').slice(0, 250), sub.company_id]);
    }
  }
  return out;
}

// The bank's 3-D Secure page sends the cardholder back here.
async function afterReturn(token) {
  const [[p]] = await pool.query(`SELECT id FROM payments WHERE token = ? AND pay_method = 'card'`, [String(token || '').slice(0, 64)]);
  if (!p) return null;
  const after = await billing.refreshFromOmise(p.id);
  // Declined at the bank's step: the charge is gone, so is this attempt.
  if (after && after.status === 'pending' && !after.charge_id) {
    await pool.query(`UPDATE payments SET status = 'cancelled' WHERE id = ?`, [p.id]);
    return 'failed';
  }
  return after && after.status;
}

module.exports = { DISCOUNT, enabled, cardPriceBaht, start, changeCard, setActive, status, renewDue, afterReturn, MAX_FAILURES };
