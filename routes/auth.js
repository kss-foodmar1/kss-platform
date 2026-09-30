const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 1000 * 60 * 60 * 12, // 12 hours
};

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  const token = jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      display_name: user.display_name,
    },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );

  res.cookie('kss_session', token, COOKIE_OPTS);
  res.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      display_name: user.display_name,
      must_change_password: !!user.must_change_password,
    },
  });
});

router.post('/logout', (req, res) => {
  res.clearCookie('kss_session');
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, email, display_name, role, must_change_password FROM users WHERE id = ?',
    [req.user.id]
  );
  if (!rows[0]) return res.status(401).json({ error: 'User no longer exists' });
  res.json({ user: rows[0] });
});

// Any logged-in user can change their own password.
router.post('/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'User not found' });

  // Skip the current-password check only on forced first-login changes.
  if (!user.must_change_password) {
    if (!current_password) {
      return res.status(400).json({ error: 'Current password required' });
    }
    const ok = await bcrypt.compare(current_password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const newHash = await bcrypt.hash(new_password, 10);
  await pool.query(
    'UPDATE users SET password_hash = ?, must_change_password = FALSE WHERE id = ?',
    [newHash, req.user.id]
  );
  res.json({ ok: true });
});

module.exports = router;
