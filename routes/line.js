// LINE bot settings (KSS staff, or the company's own admin) and the public
// webhook LINE calls.
//
//   GET    /api/line/companies/:id            settings (secrets never returned)
//   PUT    /api/line/companies/:id            { channel_secret, access_token, enabled }
//   POST   /api/line/companies/:id/test       plain test message to the bound group
//   POST   /api/line/companies/:id/send       { force } send the branch alert now
//   DELETE /api/line/companies/:id/group      unbind the group
//   POST   /api/webhooks/line/:key            LINE → us (HMAC-signed)
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { wrap } = require('../lib/access');
const pool = require('../db/pool');
const line = require('../lib/line');

const router = express.Router();
function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = (req.get('x-forwarded-proto') || req.protocol).split(',')[0];
  return `${proto}://${req.get('host')}`;
}
async function companyAccess(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'ไม่พบบริษัทนี้' });
  const u = req.user;
  if (!(u.role === 'kss_superadmin' || (u.role === 'company_admin' && u.company_id === id))) return res.status(403).json({ error: 'ไม่มีสิทธิ์ตั้งค่า LINE ของบริษัทนี้' });
  const [[c]] = await pool.query(`SELECT id FROM companies WHERE id = ?`, [id]);
  if (!c) return res.status(404).json({ error: 'ไม่พบบริษัทนี้' });
  req.companyId = id;
  next();
}
const send = (fn) => wrap(async (req, res) => {
  try { await fn(req, res); } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); throw err; }
});

router.use(requireAuth);
router.get('/companies/:id', companyAccess, send(async (req, res) => res.json(await line.publicView(req.companyId, baseUrl(req)))));
router.put('/companies/:id', companyAccess, send(async (req, res) => {
  const { channel_secret, access_token, enabled } = req.body || {};
  await line.save(req.companyId, { channel_secret, access_token, enabled: typeof enabled === 'boolean' ? enabled : undefined });
  res.json(await line.publicView(req.companyId, baseUrl(req)));
}));
router.post('/companies/:id/test', companyAccess, send(async (req, res) => { await line.sendTest(req.companyId); res.json({ ok: true }); }));
router.post('/companies/:id/send', companyAccess, send(async (req, res) => res.json(await line.sendAlert(req.companyId, { force: !!(req.body && req.body.force), base: baseUrl(req) }))));
router.delete('/companies/:id/group', companyAccess, send(async (req, res) => { await line.unbindGroup(req.companyId); res.json(await line.publicView(req.companyId, baseUrl(req))); }));

// Mounted before the Omise webhook router, without auth: LINE signs the body.
const webhookRouter = express.Router();
webhookRouter.post('/:key', wrap(async (req, res) => {
  const code = await line.handleWebhook(req.params.key, req.rawBody, req.get('x-line-signature'), req.body);
  res.status(code).json({ ok: code === 200 });
}));

module.exports = { router, webhookRouter };
