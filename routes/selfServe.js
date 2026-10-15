// Self-serve signup, trial and plan payment (lib/selfServe.js).
//
//   public   GET  /api/signup/config            { enabled, trial_days }
//            POST /api/signup                   the signup form
//   signed   GET  /api/subscription             state, prices, own payments
//            POST /api/subscription/checkout    { period_months: 1 | 12 } → pay link (company admin)
//   KSS      GET  /api/admin/self-serve         signups, prices, locked companies
//            POST /api/admin/self-serve/signups/:id/approve | /reject   { note }
//            PUT  /api/admin/self-serve/prices  { monthly, yearly } (baht; empty = not offered)
//            POST /api/admin/self-serve/companies/:id/purge
const express = require('express');
const { requireAuth, requireSuperadmin } = require('../middleware/auth');
const { wrap } = require('../lib/access');
const ss = require('../lib/selfServe');

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
  });
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
    prices: await ss.prices(), payments_enabled: require('../lib/omise').paymentsEnabled(),
    locked: await ss.lockedCompanies(),
  });
}));
adminRouter.post('/signups/:id/approve', send(async (req, res) => res.json(await ss.approve(Number(req.params.id), req.user.id, (req.body || {}).note))));
adminRouter.post('/signups/:id/reject', send(async (req, res) => { await ss.reject(Number(req.params.id), req.user.id, (req.body || {}).note); res.json({ ok: true }); }));
adminRouter.put('/prices', send(async (req, res) => {
  const { monthly, yearly } = req.body || {};
  try { res.json({ prices: await ss.setPrices({ monthly, yearly }, req.user.id) }); } catch (e) { res.status(400).json({ error: e.message }); }
}));
adminRouter.post('/companies/:id/purge', send(async (req, res) => { await ss.purge(Number(req.params.id)); res.json({ ok: true }); }));

module.exports = { publicRouter, subscriptionRouter, adminRouter };
