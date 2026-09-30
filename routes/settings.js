const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { encrypt, mask } = require('../lib/crypto');

const router = express.Router();

// GET status only — never returns the real key.
router.get('/fmh-key', requireAuth, requireAdmin, async (req, res) => {
  const [[row]] = await pool.query(
    `SELECT setting_value, updated_at FROM app_settings WHERE setting_key = 'fmh_api_key'`
  );
  if (!row) return res.json({ configured: false });
  res.json({ configured: true, updated_at: row.updated_at });
});

router.post('/fmh-key', requireAuth, requireAdmin, async (req, res) => {
  const { api_key } = req.body;
  if (!api_key || api_key.trim().length < 10) {
    return res.status(400).json({ error: 'API key looks too short' });
  }
  const encrypted = encrypt(api_key.trim());
  await pool.query(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES ('fmh_api_key', ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [encrypted]
  );
  res.json({ ok: true, message: `Saved — ${mask(api_key.trim())}` });
});

router.delete('/fmh-key', requireAuth, requireAdmin, async (req, res) => {
  await pool.query(`DELETE FROM app_settings WHERE setting_key = 'fmh_api_key'`);
  res.json({ ok: true });
});

module.exports = router;
