const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

// The JWT only proves who you are; role and company are re-read from the
// database on every request, so a role change, a move between companies, a
// deleted account or a suspended company takes effect immediately instead of
// after the 12-hour session expires.
async function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.kss_session;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  try {
    const [[user]] = await pool.query(
      `SELECT u.id, u.email, u.display_name, u.role, u.company_id, c.status AS company_status
       FROM users u LEFT JOIN companies c ON c.id = u.company_id
       WHERE u.id = ?`,
      [payload.id]
    );
    if (!user) return res.status(401).json({ error: 'User no longer exists' });
    if (user.role !== 'kss_superadmin' && user.company_status === 'suspended') {
      return res.status(403).json({ error: 'บัญชีบริษัทนี้ถูกระงับการใช้งาน กรุณาติดต่อ KSS' });
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

const isSuperadmin = (user) => user && user.role === 'kss_superadmin';

function requireSuperadmin(req, res, next) {
  if (!isSuperadmin(req.user)) return res.status(403).json({ error: 'KSS staff access required' });
  next();
}

// company_admin of their own company, or KSS staff.
function requireCompanyAdmin(req, res, next) {
  if (!req.user || !['kss_superadmin', 'company_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { requireAuth, requireSuperadmin, requireCompanyAdmin, isSuperadmin };
