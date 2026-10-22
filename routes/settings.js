// Per-company FMH API key. The client's company_admin enters their own key
// here (white-glove onboarding: KSS sets up the account, the client supplies
// the key). KSS staff can do the same for any company via company_id.
// The key is encrypted at rest and never returned — only its status.
const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireCompanyAdmin } = require('../middleware/auth');
const { wrap, resolveCompanyId } = require('../lib/access');
const { encrypt, mask } = require('../lib/crypto');
const { syncCompany, estimatePulls, pullsUsedByCompany, HEAVY_EVERY_DAYS } = require('../lib/fmhCache');
const { withTrigger } = require('../lib/fmhUsage');

const router = express.Router();

// Real and sample data never mix in the cache, the saved copy or the error log.
async function toRealData(companyId) {
  await pool.query(`UPDATE companies SET data_source = 'fmh' WHERE id = ?`, [companyId]);
  for (const t of ['fmh_report_cache', 'fmh_cache_saved', 'fmh_sync_errors', 'alert_events']) {
    await pool.query(`DELETE FROM ${t} WHERE company_id = ?`, [companyId]);
  }
}

router.get(
  '/fmh-key',
  requireAuth,
  requireCompanyAdmin,
  wrap(async (req, res) => {
    const companyId = resolveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'company_id required' });
    const [[c]] = await pool.query(`SELECT fmh_api_key_enc, fmh_key_updated_at, auto_sync_mode, data_source FROM companies WHERE id = ?`, [companyId]);
    if (!c) return res.status(404).json({ error: 'Company not found' });
    res.json({
      configured: !!c.fmh_api_key_enc,
      updated_at: c.fmh_key_updated_at,
      auto_sync_mode: c.auto_sync_mode,
      auto_sync_plan: c.fmh_api_key_enc && c.data_source !== 'demo' ? await autoSyncPlan(companyId) : null,
    });
  })
);

// What each auto-fetch mode would cost this company, from what its reports returned
// last time: nightly rows with everything on, and with the big whole-table reports weekly.
async function autoSyncPlan(companyId) {
  const { items, quota } = await estimatePulls(companyId, await pullsUsedByCompany(companyId));
  const paid = items.filter((i) => !i.free);
  const sum = (list, f = (i) => i.est_rows || 0) => list.reduce((n, i) => n + f(i), 0);
  const heavy = paid.filter((i) => i.heavy);
  const nightlyAll = sum(paid);
  const nightlyLight = sum(paid.filter((i) => !i.heavy)) + sum(heavy, (i) => (i.est_rows || 0) / HEAVY_EVERY_DAYS);
  return {
    heavy: heavy.map((i) => ({ label: i.label, est_rows: i.est_rows })),
    unknown: paid.filter((i) => i.est_rows === null).length,
    per_month: { all: Math.round(nightlyAll * 30), light: Math.round(nightlyLight * 30) },
    quota,
  };
}

// Switch the automatic (1am) FMH pull for a company: all | light | off. The data source
// stays FMH in every mode; the 'ดึงข้อมูลใหม่' button always works.
router.put(
  '/auto-sync',
  requireAuth,
  requireCompanyAdmin,
  wrap(async (req, res) => {
    const companyId = resolveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'company_id required' });
    const mode = String((req.body && req.body.mode) || '');
    if (!['all', 'light', 'off'].includes(mode)) return res.status(400).json({ error: 'mode must be all, light or off' });
    const [result] = await pool.query(`UPDATE companies SET auto_sync_mode = ? WHERE id = ?`, [mode, companyId]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Company not found' });
    res.json({ ok: true, auto_sync_mode: mode });
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
    // A self-serve trial starts on demo data; its own key switches it to real
    // data (the two never mix in the cache).
    // A company that started on sample data (first-run) switches the same way;
    // KSS's own demo companies (status 'demo') never do.
    const [[co]] = await pool.query(`SELECT self_serve, status, data_source FROM companies WHERE id = ?`, [companyId]);
    if (co && co.data_source === 'demo' && (co.self_serve || co.status !== 'demo')) await toRealData(companyId);

    // Fill the cache right away in the background so dashboards have data
    // without waiting for the 1am sync.
    withTrigger('key_saved', () => syncCompany(companyId)).catch((err) => console.error('Post-key sync failed:', err.message));
    res.json({ ok: true, message: `บันทึกแล้ว — ${mask(apiKey)} · กำลังดึงข้อมูลครั้งแรก` });
  })
);

// First run: a company with nothing connected yet starts on sample data so the
// first look is real-looking numbers, not a blank page. Only ever from nothing:
// a key, a POS file or an existing dashboard keeps the company as it is.
router.post(
  '/start-sample',
  requireAuth,
  requireCompanyAdmin,
  wrap(async (req, res) => {
    const companyId = resolveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'company_id required' });
    const [[c]] = await pool.query(
      `SELECT data_source, fmh_api_key_enc IS NOT NULL AS has_key,
              (SELECT COUNT(*) FROM pos_uploads WHERE company_id = c.id) AS pos,
              (SELECT COUNT(*) FROM dashboards WHERE company_id = c.id) AS dash
       FROM companies c WHERE c.id = ?`,
      [companyId]
    );
    if (!c) return res.status(404).json({ error: 'Company not found' });
    if (c.data_source === 'demo') return res.json({ ok: true, switched: false, sample: true });
    if (c.has_key || Number(c.pos) || Number(c.dash)) return res.json({ ok: true, switched: false, sample: false });
    await pool.query(`UPDATE companies SET data_source = 'demo' WHERE id = ?`, [companyId]);
    for (const t of ['fmh_report_cache', 'fmh_cache_saved', 'fmh_sync_errors']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = ?`, [companyId]);
    }
    withTrigger('first_run', () => syncCompany(companyId)).catch((e) => console.error('Sample fill failed:', e.message));
    res.json({ ok: true, switched: true, sample: true });
  })
);

// "Ready for real data?" — only once something real is connected.
router.post(
  '/use-real-data',
  requireAuth,
  requireCompanyAdmin,
  wrap(async (req, res) => {
    const companyId = resolveCompanyId(req);
    if (!companyId) return res.status(400).json({ error: 'company_id required' });
    const [[c]] = await pool.query(
      `SELECT data_source, fmh_api_key_enc IS NOT NULL AS has_key, (SELECT COUNT(*) FROM pos_uploads WHERE company_id = c.id) AS pos FROM companies c WHERE c.id = ?`,
      [companyId]
    );
    if (!c) return res.status(404).json({ error: 'Company not found' });
    if (c.data_source !== 'demo') return res.json({ ok: true, switched: false });
    if (!c.has_key && !Number(c.pos)) {
      return res.status(400).json({ code: 'NO_DATA', error: 'ยังไม่ได้เชื่อมข้อมูลจริง — ใส่ FMH API Key หรืออัปโหลดไฟล์ POS ก่อน' });
    }
    // POS file only: sales will be real but everything that comes from FMH
    // (purchasing, cost, stock) stays empty — say so and let the admin decide.
    if (!c.has_key && !(req.body && req.body.force)) {
      return res.status(409).json({ code: 'POS_ONLY', error: 'ตอนนี้มีเฉพาะไฟล์ยอดขาย POS: ดูยอดขายได้ แต่ต้นทุนวัตถุดิบ กำไรต่อเมนู ยอดซื้อ และสต็อก (ข้อมูลจาก FMH) จะยังไม่ขึ้นจนกว่าจะใส่ FMH API Key — หน้า dashboard จึงดูโล่งกว่าปกติ ไม่ได้แปลว่าระบบเสีย' });
    }
    await toRealData(companyId);
    withTrigger('use_real', () => syncCompany(companyId)).catch((e) => console.error('Sync after switch failed:', e.message));
    res.json({ ok: true, switched: true });
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
