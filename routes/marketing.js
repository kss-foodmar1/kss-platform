// Marketing budget vs actual — upload, list, delete, templates. KSS staff for
// any company; a company admin for their own company only. The computed report
// is served like any other source by routes/dashboards.js ('marketing').
//
//   GET    /api/marketing/template/:kind               budget | actual  (CSV, opens in Excel; horizontal by default,
//                                                        ?layout=list for one row per entry, ?from=YYYY-MM / ?month=YYYY-MM)
//   GET    /api/marketing/companies/:id                uploads + what is loaded
//   POST   /api/marketing/companies/:id/uploads        { kind, filename, table: [[cell,...],...] }
//   DELETE /api/marketing/companies/:id/uploads/:uid
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { wrap } = require('../lib/access');
const marketing = require('../lib/marketing');
const pool = require('../db/pool');

const router = express.Router();

async function companyAccess(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'ไม่พบบริษัทนี้' });
  const u = req.user;
  const ok = u.role === 'kss_superadmin' || (u.role === 'company_admin' && u.company_id === id);
  if (!ok) return res.status(403).json({ error: 'ไม่มีสิทธิ์จัดการข้อมูลการตลาดของบริษัทนี้' });
  const [[c]] = await pool.query(`SELECT id FROM companies WHERE id = ?`, [id]);
  if (!c) return res.status(404).json({ error: 'ไม่พบบริษัทนี้' });
  req.companyId = id;
  next();
}

const send = (fn) =>
  wrap(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message, details: err.details, overflow: err.overflow || 0 });
      throw err;
    }
  });

router.get('/template/:kind', requireAuth, (req, res) => {
  const t = marketing.templateCsv(req.params.kind, { layout: req.query.layout, from: req.query.from, month: req.query.month, granularity: req.query.granularity });
  if (!t) return res.status(404).json({ error: 'ไม่พบแม่แบบนี้' });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${t.filename}"`);
  res.send(t.body);
});

router.use('/companies/:id', requireAuth, wrap(companyAccess));

router.get('/companies/:id', send(async (req, res) => res.json(await marketing.overview(req.companyId))));

router.post(
  '/companies/:id/uploads',
  send(async (req, res) => {
    const { kind, filename, table, year, vat_included, dry_run } = req.body || {};
    const result = await marketing.importUpload(req.companyId, req.user.id, { kind, filename, table, year, vat_included, dry_run: dry_run === true });
    if (result.dry_run) return res.json({ ok: true, ...result });
    res.json({ ok: true, ...result, overview: await marketing.overview(req.companyId) });
  })
);

router.post(
  '/companies/:id/clear',
  send(async (req, res) => {
    const { kind, month, channel, dry_run } = req.body || {};
    const result = await marketing.clearData(req.companyId, { kind, month, channel, dry_run: dry_run === true });
    res.json({ ok: true, ...result, ...(result.dry_run ? {} : { overview: await marketing.overview(req.companyId) }) });
  })
);

router.post(
  '/companies/:id/copy-budget',
  send(async (req, res) => {
    const { from, to, dry_run } = req.body || {};
    const result = await marketing.copyBudget(req.companyId, req.user.id, { from, to, dry_run: dry_run === true });
    res.json({ ok: true, ...result, ...(result.dry_run ? {} : { overview: await marketing.overview(req.companyId) }) });
  })
);

router.delete(
  '/companies/:id/uploads/:uid',
  send(async (req, res) => {
    const ok = await marketing.deleteUpload(req.companyId, Number(req.params.uid));
    if (!ok) return res.status(404).json({ error: 'ไม่พบไฟล์นี้' });
    res.json({ ok: true, overview: await marketing.overview(req.companyId) });
  })
);

module.exports = router;
