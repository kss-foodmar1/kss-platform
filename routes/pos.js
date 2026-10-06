// POS sales files (Foodstory and other POS without an API) — upload, menu
// matching to FMH recipes. KSS staff for any company; a company admin for
// their own company only. The computed report is served like any other
// source by routes/dashboards.js ('pos-sales').
//
//   GET    /api/pos/companies/:id                 uploads, menus + match status
//   POST   /api/pos/companies/:id/uploads         { filename, format, rows }
//   DELETE /api/pos/companies/:id/uploads/:uid
//   PUT    /api/pos/companies/:id/map             { pos_menu_name, fmh_menu_name, ignore }
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { wrap } = require('../lib/access');
const pos = require('../lib/posSales');
const pool = require('../db/pool');

const router = express.Router();

async function companyAccess(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'ไม่พบบริษัทนี้' });
  const u = req.user;
  const ok = u.role === 'kss_superadmin' || (u.role === 'company_admin' && u.company_id === id);
  if (!ok) return res.status(403).json({ error: 'ไม่มีสิทธิ์จัดการข้อมูลยอดขายของบริษัทนี้' });
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
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  });

router.use('/companies/:id', requireAuth, wrap(companyAccess));

router.get('/companies/:id', send(async (req, res) => res.json(await pos.overview(req.companyId))));

router.post(
  '/companies/:id/uploads',
  send(async (req, res) => {
    const { filename, format, rows } = req.body || {};
    const result = await pos.importUpload(req.companyId, req.user.id, { filename, format, rows });
    res.json({ ok: true, ...result, overview: await pos.overview(req.companyId) });
  })
);

router.delete(
  '/companies/:id/uploads/:uid',
  send(async (req, res) => {
    const ok = await pos.deleteUpload(req.companyId, Number(req.params.uid));
    if (!ok) return res.status(404).json({ error: 'ไม่พบไฟล์นี้' });
    res.json({ ok: true, overview: await pos.overview(req.companyId) });
  })
);

router.put(
  '/companies/:id/map',
  send(async (req, res) => {
    const { pos_menu_name, fmh_menu_name, ignore } = req.body || {};
    await pos.setMapping(req.companyId, { pos_menu_name, fmh_menu_name: fmh_menu_name || null, ignore: !!ignore });
    res.json({ ok: true, overview: await pos.overview(req.companyId) });
  })
);

module.exports = router;
