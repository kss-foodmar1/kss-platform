// Per-company FMH API key. The client's company_admin enters their own key
// here (white-glove onboarding: KSS sets up the account, the client supplies
// the key). KSS staff can do the same for any company via company_id.
// The key is encrypted at rest and never returned — only its status.
const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireCompanyAdmin } = require('../middleware/auth');
const { wrap, resolveCompanyId } = require('../lib/access');
const { encrypt, mask } = require('../lib/crypto');
const { syncCompany } = require('../lib/fmhCache');
const { withTrigger } = require('../lib/fmhUsage');

const router = express.Router();

router.get(
  '/fmh-key',
  requireAuth,
  requireCompanyAdmin,
  wrap(async (req, res) => {
    const companyId = resolveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'company_id required' });
    const [[c]] = await pool.query(`SELECT fmh_api_key_enc, fmh_key_updated_at FROM companies WHERE id = ?`, [companyId]);
    if (!c) return res.status(404).json({ error: 'Company not found' });
    res.json({ configured: !!c.fmh_api_key_enc, updated_at: c.fmh_key_updated_at });
  })
);

router.post(
  '/fmh-key',
  requireAuth,
  requireCompanyAdmin,
  wrap(async (req, res) => {
    const companyId = resolveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'company_id required' });
    const apiKey = String((req.body && req.body.api_key) || '').trim();
    if (apiKey.length < 10) return res.status(400).json({ error: 'API key looks too short' });

    const [result] = await pool.query(
      `UPDATE companies SET fmh_api_key_enc = ?, fmh_key_updated_at = NOW() WHERE id = ?`,
      [encrypt(apiKey), companyId]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Company not found' });

    // Fill the cache right away in the background so dashboards have data
    // without waiting for the 1am sync.
    withTrigger('key_saved', () => syncCompany(companyId)).catch((err) => console.error('Post-key sync failed:', err.message));
    res.json({ ok: true, message: `บันทึกแล้ว — ${mask(apiKey)} · กำลังดึงข้อมูลครั้งแรก` });
  })
);

router.delete(
  '/fmh-key',
  requireAuth,
  requireCompanyAdmin,
  wrap(async (req, res) => {
    const companyId = resolveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'company_id required' });
    await pool.query(`UPDATE companies SET fmh_api_key_enc = NULL, fmh_key_updated_at = NULL WHERE id = ?`, [companyId]);
    res.json({ ok: true });
  })
);

module.exports = router;
