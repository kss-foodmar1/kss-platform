// Billing routes (stage 1).
//   adminRouter    /api/admin/billing   KSS staff: issue payment requests, check, cancel, mark paid
//   publicRouter   /api/pay             customer's payment page (unguessable token, no login)
//   webhookRouter  /api/webhooks        Omise webhook (HMAC-signed)
const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireSuperadmin } = require('../middleware/auth');
const { wrap } = require('../lib/access');
const billing = require('../lib/billing');
const omise = require('../lib/omise');

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = (req.get('x-forwarded-proto') || req.protocol).split(',')[0];
  return `${proto}://${req.get('host')}`;
}

const adminRow = (p, req) => ({
  id: p.id, description: p.description, amount_satang: p.amount_satang, period_months: p.period_months,
  status: p.status, paid_at: p.paid_at, paid_via: p.paid_via, manual_note: p.manual_note,
  extended_from: billing.dateStr(p.extended_from), extended_to: billing.dateStr(p.extended_to),
  has_charge: !!p.charge_id, created_at: p.created_at,
  pay_url: `${baseUrl(req)}/pay/${p.token}`,
});

// ---------- admin ----------
const adminRouter = express.Router();
adminRouter.use(requireAuth, requireSuperadmin);

adminRouter.get('/status', (req, res) => {
  res.json({
    omise_mode: omise.mode(),
    webhook_secret_set: !!(process.env.OMISE_WEBHOOK_SECRET || process.env.omise_webhook_secret),
    enforce_expiry: billing.enforcing(),
    grace_days: billing.GRACE_DAYS(),
    webhook_url: `${baseUrl(req)}/api/webhooks/omise`,
  });
});

adminRouter.get('/companies/:id', wrap(async (req, res) => {
  const [[c]] = await pool.query(`SELECT id, name, status, suspended_reason, subscription_ends_at FROM companies WHERE id = ?`, [req.params.id]);
  if (!c) return bad(res, 'Company not found', 404);
  const [rows] = await pool.query(`SELECT * FROM payments WHERE company_id = ? ORDER BY id DESC`, [c.id]);
  res.json({
    subscription_ends_at: billing.dateStr(c.subscription_ends_at),
    status: c.status, suspended_reason: c.suspended_reason,
    payments: rows.map((p) => adminRow(p, req)),
  });
}));

adminRouter.post('/companies/:id/payments', wrap(async (req, res) => {
  const { description, amount_baht, period_months } = req.body || {};
  try {
    const { id } = await billing.createPayment({
      companyId: Number(req.params.id), description, amountBaht: amount_baht,
      periodMonths: period_months === undefined || period_months === '' ? 12 : Number(period_months),
      createdBy: req.user.id,
    });
    const [[p]] = await pool.query(`SELECT * FROM payments WHERE id = ?`, [id]);
    res.status(201).json({ payment: adminRow(p, req) });
  } catch (err) {
    bad(res, err.message);
  }
}));

adminRouter.post('/payments/:id/check', wrap(async (req, res) => {
  try {
    const p = await billing.refreshFromOmise(Number(req.params.id));
    if (!p) return bad(res, 'Payment not found', 404);
    res.json({ payment: adminRow(p, req) });
  } catch (err) {
    bad(res, err.message, 502);
  }
}));

adminRouter.post('/payments/:id/cancel', wrap(async (req, res) => {
  const [r] = await pool.query(`UPDATE payments SET status = 'cancelled' WHERE id = ? AND status = 'pending'`, [req.params.id]);
  if (!r.affectedRows) return bad(res, 'ยกเลิกได้เฉพาะรายการที่ยังรอชำระ', 409);
  res.json({ ok: true });
}));

adminRouter.post('/payments/:id/mark-paid', wrap(async (req, res) => {
  const note = String((req.body || {}).note || '').trim().slice(0, 255);
  if (!note) return bad(res, 'ระบุหมายเหตุ เช่น โอนเข้าบัญชีวันที่/เลขอ้างอิง');
  const done = await billing.settle(Number(req.params.id), { via: 'manual', note });
  if (!done) return bad(res, 'รายการนี้ไม่ได้อยู่ในสถานะรอชำระ', 409);
  res.json({ ok: true });
}));

adminRouter.put('/companies/:id/subscription', wrap(async (req, res) => {
  const v = (req.body || {}).subscription_ends_at;
  try {
    await billing.setSubscriptionEnd(Number(req.params.id), v ? String(v) : null);
    res.json({ ok: true });
  } catch (err) {
    bad(res, err.message);
  }
}));

// ---------- public pay page API ----------
const publicRouter = express.Router();

// Tiny per-IP limiter for the one endpoint that can create charges at Omise.
const hits = new Map();
function limited(req) {
  const now = Date.now();
  const key = req.ip;
  const list = (hits.get(key) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(key, list);
  return list.length > 20;
}

async function loadByToken(token) {
  if (!/^[a-f0-9]{48}$/.test(String(token))) return null;
  const [[p]] = await pool.query(
    `SELECT p.*, c.name AS company_name FROM payments p JOIN companies c ON c.id = p.company_id WHERE p.token = ?`, [token]
  );
  return p || null;
}

const qrLive = (p) => p.status === 'pending' && p.qr_url && (!p.charge_expires_at || new Date(p.charge_expires_at) > new Date());
const publicView = (p) => ({
  company_name: p.company_name, description: p.description, amount_satang: p.amount_satang,
  period_months: p.period_months, status: p.status, paid_at: p.paid_at,
  extended_to: billing.dateStr(p.extended_to),
  qr_url: qrLive(p) ? p.qr_url : null,
  qr_expires_at: qrLive(p) ? p.charge_expires_at : null,
});

publicRouter.get('/:token', wrap(async (req, res) => {
  let p = await loadByToken(req.params.token);
  if (!p) return bad(res, 'ไม่พบรายการชำระเงิน', 404);
  if (p.status === 'pending' && p.charge_id) {
    try { p = { ...p, ...(await billing.refreshFromOmise(p.id)) }; } catch (e) { /* show last known state */ }
  }
  res.set('Cache-Control', 'no-store');
  res.json(publicView(p));
}));

publicRouter.post('/:token/qr', wrap(async (req, res) => {
  if (limited(req)) return bad(res, 'ลองใหม่อีกครั้งในอีกสักครู่', 429);
  const p = await loadByToken(req.params.token);
  if (!p) return bad(res, 'ไม่พบรายการชำระเงิน', 404);
  if (p.status === 'cancelled') return bad(res, 'รายการนี้ถูกยกเลิกแล้ว กรุณาติดต่อ KSS', 410);
  try {
    const after = await billing.ensureQr(p.id);
    res.set('Cache-Control', 'no-store');
    res.json(publicView({ ...p, ...after }));
  } catch (err) {
    console.error('QR creation failed:', err.message);
    bad(res, 'สร้าง QR ไม่สำเร็จ กรุณาลองใหม่หรือติดต่อ KSS', 502);
  }
}));

// ---------- Omise webhook ----------
const webhookRouter = express.Router();
webhookRouter.post('/omise', wrap(async (req, res) => {
  const ok = omise.verifyWebhookSignature(req.rawBody, req.get('Omise-Signature'), req.get('Omise-Signature-Timestamp'));
  if (!ok) return res.status(401).json({ error: 'bad signature' });
  const ev = req.body || {};
  // The Omise account may carry charges from other systems; anything that is
  // not one of ours is acknowledged and ignored.
  if (ev.key === 'charge.complete' && ev.data && ev.data.id) {
    try {
      await billing.handleChargeEvent(ev.data.id);
    } catch (err) {
      // Not acknowledged -> cron reconcile picks it up anyway.
      console.error('Omise webhook handling failed:', err.message);
      return res.status(500).json({ error: 'retry' });
    }
  }
  res.json({ ok: true });
}));

module.exports = { adminRouter, publicRouter, webhookRouter };
