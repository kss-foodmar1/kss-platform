// Self-serve signup, trial and plan payment (lib/selfServe.js).
//
//   public   GET  /api/signup/config            { enabled, trial_days }
//            POST /api/signup                   the signup form
//   signed   GET  /api/subscription             state, prices, own payments
//            POST /api/subscription/checkout    { period_months: 1 | 12 } → pay link (company admin)
//            POST /api/subscription/card/start  { period_months, token } card auto-renew, first charge now
//            POST /api/subscription/card/change { token }   new card for auto-renew
//            POST /api/subscription/card/auto   { on, period_months }   switch auto-renew
//   public   GET  /pay/card-return/:token       back from the bank's 3-D Secure page (server.js)
//   KSS      GET  /api/admin/self-serve         signups, prices, locked companies
//            POST /api/admin/self-serve/signups/:id/approve | /reject   { note }
//            PUT  /api/admin/self-serve/prices  { monthly, yearly } (baht; empty = not offered)
//            POST /api/admin/self-serve/companies/:id/purge
const express = require('express');
const { requireAuth, requireSuperadmin } = require('../middleware/auth');
const { wrap } = require('../lib/access');
const ss = require('../lib/selfServe');
const card = require('../lib/cardRenew');

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = (req.get('x-forwarded-proto') || req.protocol).split(',')[0];
  return `${proto}://${req.get('host')}`;
}

const send = (fn) => wrap(async (req, res) => {
  try { await fn(req, res); } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); throw err; }
});
const ipOf = (req) => String(req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim().slice(0, 64);

const publicRouter = express.Router();
publicRouter.get('/config', (req, res) => res.json({ enabled: ss.signupEnabled(), trial_days: ss.TRIAL_DAYS() }));
publicRouter.post('/', send(async (req, res) => { await ss.createSignup(req.body, ipOf(req)); res.status(201).json({ ok: true }); }));

const subscriptionRouter = express.Router();
subscriptionRouter.use(requireAuth);
subscriptionRouter.get('/', send(async (req, res) => {
  const companyId = req.user.company_id;
  if (!companyId) return res.json({ subscription: null });
  res.json({
    subscription: await ss.subscriptionFor(companyId),
    prices: await ss.prices(),
    payments_enabled: require('../lib/omise').paymentsEnabled(),
    payments: req.user.role === 'company_admin' ? await ss.paymentsOf(companyId) : [],
    card: {
      enabled: card.enabled(),
      public_key: card.enabled() ? require('../lib/omise').publicKey() : null,
      discount_pct: card.DISCOUNT(),
      status: req.user.role === 'company_admin' ? await card.status(companyId) : null,
    },
  });
}));
// Card auto-renew (lib/cardRenew.js). Only a token from Omise.js arrives here.
const adminOnly = (req, res, next) => (req.user.role === 'company_admin' ? next() : res.status(403).json({ error: 'ผู้ดูแลของบริษัทเท่านั้นที่จัดการการชำระเงินได้' }));
subscriptionRouter.post('/card/start', adminOnly, send(async (req, res) => {
  const { period_months, token } = req.body || {};
  res.json(await card.start(req.user.company_id, { periodMonths: period_months, token, userId: req.user.id, email: req.user.email, baseUrl: baseUrl(req) }));
}));
subscriptionRouter.post('/card/change', adminOnly, send(async (req, res) => res.json({ status: await card.changeCard(req.user.company_id, (req.body || {}).token) })));
subscriptionRouter.post('/card/auto', adminOnly, send(async (req, res) => {
  const { on, period_months } = req.body || {};
  res.json({ status: await card.setActive(req.user.company_id, !!on, period_months) });
}));
subscriptionRouter.post('/checkout', send(async (req, res) => {
  if (req.user.role !== 'company_admin') return res.status(403).json({ error: 'ผู้ดูแลของบริษัทเท่านั้นที่ชำระเงินได้' });
  const r = await ss.checkout(req.user.company_id, (req.body || {}).period_months, req.user.id);
  res.json({ pay_path: `/pay/${r.token}`, reused: r.reused });
}));

const adminRouter = express.Router();
adminRouter.use(requireAuth, requireSuperadmin);
adminRouter.get('/', send(async (req, res) => {
  const status = ['pending', 'approved', 'rejected', 'all'].includes(req.query.status) ? req.query.status : 'pending';
  res.json({
    enabled: ss.signupEnabled(), trial_days: ss.TRIAL_DAYS(), retention_days: ss.RETENTION_DAYS(),
    pending_count: await ss.pendingCount(), signups: await ss.listSignups(status),
    prices: await ss.prices(), payments_enabled: require('../lib/omise').paymentsEnabled(), payments_status: require('../lib/omise').paymentsStatus(),
    locked: await ss.lockedCompanies(),
  });
}));
adminRouter.post('/signups/:id/approve', send(async (req, res) => res.json(await ss.approve(Number(req.params.id), req.user.id, (req.body || {}).note))));
adminRouter.post('/signups/:id/reject', send(async (req, res) => { await ss.reject(Number(req.params.id), req.user.id, (req.body || {}).note); res.json({ ok: true }); }));
adminRouter.put('/prices', send(async (req, res) => {
  const { monthly, yearly } = req.body || {};
  try { res.json({ prices: await ss.setPrices({ monthly, yearly }, req.user.id) }); } catch (e) { res.status(400).json({ error: e.message }); }
}));
// Run today's card renewals now (the cron does this at 06:15).
adminRouter.post('/card-renew-now', send(async (req, res) => res.json(await card.renewDue({ baseUrl: baseUrl(req) }))));
adminRouter.post('/companies/:id/purge', send(async (req, res) => { await ss.purge(Number(req.params.id)); res.json({ ok: true }); }));

module.exports = { publicRouter, subscriptionRouter, adminRouter };
