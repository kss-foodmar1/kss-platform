// Subscription billing, stage 1: KSS issues a payment request for a company,
// the customer pays by PromptPay QR (Omise) or KSS marks a bank transfer paid,
// and paying extends companies.subscription_ends_at.
//
// Safety rules baked in:
//  - no price lives in code; the amount is typed per request
//  - a company with subscription_ends_at = NULL never expires (pilot clients)
//  - nothing is trusted from a webhook body: the charge is re-read from Omise
//    and its amount/metadata must match the payment row before it counts
//  - settling is idempotent (webhook + page poll + cron can all race safely)
const crypto = require('crypto');
const pool = require('../db/pool');
const omise = require('./omise');

const GRACE_DAYS = () => Number(process.env.BILLING_GRACE_DAYS ?? 14);
const enforcing = () => process.env.BILLING_ENFORCE === '1';

// ---------- dates (all Asia/Bangkok calendar days, as YYYY-MM-DD strings) ----------
function todayBangkok(now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(now);
}

function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const total = m - 1 + months;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, last))}`;
}

// New end date = max(today, current end) + period. Renewing early never loses
// the days already paid for; renewing late does not back-date.
function nextEnd(currentEnd, periodMonths, today = todayBangkok()) {
  const base = currentEnd && currentEnd > today ? currentEnd : today;
  return addMonths(base, periodMonths);
}

const dateStr = (v) => (v instanceof Date ? todayBangkok(v) : v ? String(v).slice(0, 10) : null);

// ---------- amounts ----------
function bahtToSatang(value) {
  const n = Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) throw new Error('จำนวนเงินต้องมากกว่า 0');
  const satang = Math.round(n * 100);
  if (satang < 2000) throw new Error('จำนวนเงินต่ำกว่า 20 บาท ซึ่ง PromptPay ผ่าน Omise รับไม่ได้');
  if (satang > 1000000000) throw new Error('จำนวนเงินสูงผิดปกติ');
  return satang;
}

// ---------- payment requests ----------
async function createPayment({ companyId, description, amountBaht, periodMonths = 12, createdBy = null }) {
  const desc = String(description || '').trim();
  if (!desc) throw new Error('ต้องระบุรายละเอียดรายการ');
  const months = Number(periodMonths);
  if (!Number.isInteger(months) || months < 1 || months > 60) throw new Error('ระยะเวลาต้องเป็นจำนวนเดือน 1–60');
  const satang = bahtToSatang(amountBaht);
  const [[c]] = await pool.query(`SELECT id FROM companies WHERE id = ?`, [companyId]);
  if (!c) throw new Error('ไม่พบบริษัท');
  const token = crypto.randomBytes(24).toString('hex');
  const [r] = await pool.query(
    `INSERT INTO payments (company_id, token, description, amount_satang, period_months, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
    [companyId, token, desc.slice(0, 255), satang, months, createdBy]
  );
  return { id: r.insertId, token };
}

// Mark paid + extend the company, once. Returns true only for the call that
// actually flipped pending -> paid.
async function settle(paymentId, { via, note = null }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[p]] = await conn.query(`SELECT * FROM payments WHERE id = ? FOR UPDATE`, [paymentId]);
    if (!p || p.status !== 'pending') {
      await conn.rollback();
      return false;
    }
    const [[c]] = await conn.query(`SELECT status, suspended_reason, subscription_ends_at FROM companies WHERE id = ? FOR UPDATE`, [p.company_id]);
    const from = dateStr(c.subscription_ends_at);
    const to = nextEnd(from, p.period_months);
    await conn.query(
      `UPDATE payments SET status = 'paid', paid_at = NOW(), paid_via = ?, manual_note = ?, extended_from = ?, extended_to = ? WHERE id = ?`,
      [via, note, from, to, paymentId]
    );
    // Paying turns a trial into a live account and lifts a *billing* suspension.
    // A suspension KSS applied by hand (suspended_reason NULL) is left alone.
    const reactivate = c.status === 'trial' || (c.status === 'suspended' && c.suspended_reason === 'billing');
    await conn.query(
      `UPDATE companies SET subscription_ends_at = ?${reactivate ? `, status = 'active', suspended_reason = NULL` : ''} WHERE id = ?`,
      [to, p.company_id]
    );
    await conn.commit();
    return true;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// A charge only counts if it is really paid, for exactly this payment's amount.
function chargeCounts(charge, payment) {
  return (
    charge &&
    charge.object === 'charge' &&
    charge.status === 'successful' &&
    charge.paid === true &&
    charge.currency && charge.currency.toLowerCase() === 'thb' &&
    Number(charge.amount) === Number(payment.amount_satang) &&
    String((charge.metadata || {}).kss_payment_id) === String(payment.id)
  );
}

// Re-read the payment's charge from Omise and act on it. Safe to call as often
// as wanted (webhook, QR page poll, Admin "check", cron).
async function refreshFromOmise(paymentId) {
  const [[p]] = await pool.query(`SELECT * FROM payments WHERE id = ?`, [paymentId]);
  if (!p || p.status !== 'pending' || !p.charge_id) return p;
  const charge = await omise.getCharge(p.charge_id);
  if (chargeCounts(charge, p)) {
    await settle(p.id, { via: 'omise' });
  } else if (['failed', 'expired', 'reversed'].includes(charge.status)) {
    // Dead charge: free the slot so the next page visit issues a fresh QR.
    await pool.query(`UPDATE payments SET charge_id = NULL, qr_url = NULL, charge_expires_at = NULL WHERE id = ? AND charge_id = ?`, [p.id, p.charge_id]);
  }
  const [[after]] = await pool.query(`SELECT * FROM payments WHERE id = ?`, [paymentId]);
  return after;
}

// Make sure a pending payment has a live QR; returns the refreshed row.
async function ensureQr(paymentId) {
  let p = await refreshFromOmise(paymentId);
  if (p.status !== 'pending') return p;
  const live = p.charge_id && p.qr_url && (!p.charge_expires_at || new Date(p.charge_expires_at) > new Date());
  if (live) return p;
  const charge = await omise.createPromptPayCharge({
    amountSatang: p.amount_satang,
    description: p.description,
    metadata: { kss_payment_id: String(p.id), kss_company_id: String(p.company_id) },
  });
  const qr = charge.source && charge.source.scannable_code && charge.source.scannable_code.image && charge.source.scannable_code.image.download_uri;
  if (!qr) throw new Error('Omise ไม่ได้ส่ง QR กลับมา');
  const exp = charge.expires_at ? new Date(charge.expires_at) : null;
  // First writer wins; a concurrent request's extra (unpaid) charge is simply never shown.
  await pool.query(
    `UPDATE payments SET charge_id = ?, qr_url = ?, charge_expires_at = ? WHERE id = ? AND status = 'pending' AND (charge_id IS NULL OR charge_expires_at < NOW())`,
    [charge.id, qr, exp, p.id]
  );
  const [[after]] = await pool.query(`SELECT * FROM payments WHERE id = ?`, [paymentId]);
  return after;
}

// Webhook entry: only the charge id is taken from the body.
async function handleChargeEvent(chargeId) {
  const [[p]] = await pool.query(`SELECT id FROM payments WHERE charge_id = ? AND status = 'pending'`, [chargeId]);
  if (!p) return { matched: false };
  const after = await refreshFromOmise(p.id);
  return { matched: true, status: after.status };
}

async function reconcilePending() {
  const [rows] = await pool.query(
    `SELECT id FROM payments WHERE status = 'pending' AND charge_id IS NOT NULL AND created_at > NOW() - INTERVAL 3 DAY`
  );
  let paid = 0;
  for (const r of rows) {
    try {
      const p = await refreshFromOmise(r.id);
      if (p.status === 'paid') paid++;
    } catch (err) {
      console.error(`Reconcile payment ${r.id} failed:`, err.message);
    }
  }
  return { checked: rows.length, paid };
}

// Suspend companies whose paid period (plus grace) has ended. Only when
// BILLING_ENFORCE=1, and never a company with no end date, a demo or a trial.
async function enforceExpiry() {
  if (!enforcing()) return { enforced: false, suspended: 0 };
  const [r] = await pool.query(
    `UPDATE companies SET status = 'suspended', suspended_reason = 'billing'
     WHERE status = 'active' AND subscription_ends_at IS NOT NULL
       AND DATE_ADD(subscription_ends_at, INTERVAL ? DAY) < ?`,
    [GRACE_DAYS(), todayBangkok()]
  );
  return { enforced: true, suspended: r.affectedRows };
}

async function setSubscriptionEnd(companyId, isoDateOrNull) {
  if (isoDateOrNull !== null && !/^\d{4}-\d{2}-\d{2}$/.test(isoDateOrNull)) throw new Error('วันที่ต้องอยู่ในรูปแบบ YYYY-MM-DD');
  const [r] = await pool.query(`UPDATE companies SET subscription_ends_at = ? WHERE id = ?`, [isoDateOrNull, companyId]);
  if (!r.affectedRows) throw new Error('ไม่พบบริษัท');
}

module.exports = {
  todayBangkok, addMonths, nextEnd, bahtToSatang, chargeCounts, dateStr,
  createPayment, settle, refreshFromOmise, ensureQr, handleChargeEvent, reconcilePending,
  enforceExpiry, setSubscriptionEnd, GRACE_DAYS, enforcing,
};
