// Older history from report files exported from FMH (the API serves ~90 days).
// KSS staff for any company; a company admin for their own company only.
//
//   GET    /api/fmh-files/companies/:id                     uploads + coverage per report
//   POST   /api/fmh-files/companies/:id/uploads             { source, filename } -> { upload_id }
//   POST   /api/fmh-files/companies/:id/uploads/:uid/rows   { rows: [...] }  (≤ 5,000 per call)
//   POST   /api/fmh-files/companies/:id/uploads/:uid/commit
//   DELETE /api/fmh-files/companies/:id/uploads/:uid
// The browser reads the file (public/fmh-file.js) and sends API-shaped rows in
// chunks; nothing is visible until commit, so a half-sent file never shows.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { wrap } = require('../lib/access');
const files = require('../lib/fmhFiles');
const pool = require('../db/pool');

const router = express.Router();

async function companyAccess(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'ไม่พบบริษัทนี้' });
  const u = req.user;
  const ok = u.role === 'kss_superadmin' || (u.role === 'company_admin' && u.company_id === id);
  if (!ok) return res.status(403).json({ error: 'ไม่มีสิทธิ์จัดการข้อมูลของบริษัทนี้' });
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

router.get('/companies/:id', send(async (req, res) => res.json(await files.overview(req.companyId))));

router.post(
  '/companies/:id/uploads',
  send(async (req, res) => {
    const { source, filename } = req.body || {};
    res.json(await files.begin(req.companyId, req.user.id, { source, filename }));
  })
);

router.post(
  '/companies/:id/uploads/:uid/rows',
  send(async (req, res) => {
    res.json(await files.addRows(req.companyId, Number(req.params.uid), (req.body || {}).rows));
  })
);

router.post(
  '/companies/:id/uploads/:uid/commit',
  send(async (req, res) => {
    const result = await files.commit(req.companyId, Number(req.params.uid));
    res.json({ ok: true, ...result, overview: await files.overview(req.companyId) });
  })
);

router.delete(
  '/companies/:id/uploads/:uid',
  send(async (req, res) => {
    const ok = await files.deleteUpload(req.companyId, Number(req.params.uid));
    if (!ok) return res.status(404).json({ error: 'ไม่พบไฟล์นี้' });
    res.json({ ok: true, overview: await files.overview(req.companyId) });
  })
);

module.exports = router;
