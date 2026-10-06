const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { wrap } = require('../lib/access');

const router = express.Router();

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 1000 * 60 * 60 * 12, // 12 hours
};

async function publicUser(id) {
  const [[u]] = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.role, u.company_id, u.must_change_password, u.language,
            c.name AS company_name, c.company_code, c.status AS company_status
     FROM users u LEFT JOIN companies c ON c.id = u.company_id WHERE u.id = ?`,
    [id]
  );
  if (u) u.must_change_password = !!u.must_change_password;
  return u;
}

router.post(
  '/login',
  wrap(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const [[user]] = await pool.query('SELECT id, password_hash FROM users WHERE email = ?', [email]);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const profile = await publicUser(user.id);
    if (profile.role !== 'kss_superadmin' && profile.company_status === 'suspended') {
      return res.status(403).json({ error: 'บัญชีบริษัทนี้ถูกระงับการใช้งาน กรุณาติดต่อ KSS' });
    }

    // Only the user id goes in the token; role and company are re-read from
    // the database on every request (middleware/auth.js).
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '12h' });
    res.cookie('kss_session', token, COOKIE_OPTS);
    res.json({ ok: true, user: profile });
  })
);

router.post('/logout', (req, res) => {
  res.clearCookie('kss_session');
  res.json({ ok: true });
});

router.get(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    res.json({ user: await publicUser(req.user.id) });
  })
);

// Interface language is a per-user setting.
router.put(
  '/language',
  requireAuth,
  wrap(async (req, res) => {
    const language = (req.body || {}).language;
    if (!['th', 'en'].includes(language)) return res.status(400).json({ error: 'language must be th or en' });
    await pool.query(`UPDATE users SET language = ? WHERE id = ?`, [language, req.user.id]);
    res.json({ ok: true, language });
  })
);

// Any logged-in user can change their own password.
router.post(
  '/change-password',
  requireAuth,
  wrap(async (req, res) => {
    const { current_password, new_password } = req.body || {};
    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    const [[user]] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(401).json({ error: 'User not found' });

    // Skip the current-password check only on forced first-login changes.
    if (!user.must_change_password) {
      if (!current_password) return res.status(400).json({ error: 'Current password required' });
      if (!(await bcrypt.compare(current_password, user.password_hash))) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
    }
    await pool.query('UPDATE users SET password_hash = ?, must_change_password = FALSE WHERE id = ?', [
      await bcrypt.hash(new_password, 10),
      req.user.id,
    ]);
    res.json({ ok: true });
  })
);

module.exports = router;
