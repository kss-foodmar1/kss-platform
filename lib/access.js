// Tenant-isolation helpers. Every route that touches company data goes
// through these, so "which company is this request allowed to act on" is
// decided in exactly one place.
const pool = require('../db/pool');

// Express 4 doesn't catch rejected promises from async handlers — without
// this, a thrown DB error becomes an unhandled rejection and kills the process.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const isSuperadmin = (user) => user && user.role === 'kss_superadmin';

// The company a request acts on. KSS staff pick one explicitly (company_id in
// query or body); everyone else is pinned to their own company and any
// company_id they send is ignored — so a client can never widen their scope.
function resolveCompanyId(req) {
  if (isSuperadmin(req.user)) {
    const raw = (req.query && req.query.company_id) ?? (req.body && req.body.company_id);
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
  }
  return req.user.company_id || null;
}

// Returns the dashboard if this user may see it, else null. Callers answer
// 404 either way, so a user can't probe whether another company's dashboard
// ids exist.
async function getDashboardForUser(user, dashboardId) {
  const [[d]] = await pool.query(
    `SELECT id, company_id, display_name, description, sort_order FROM dashboards WHERE id = ? AND active = TRUE`,
    [dashboardId]
  );
  if (!d) return null;
  if (isSuperadmin(user)) return d;
  if (!user.company_id || d.company_id !== user.company_id) return null;
  if (user.role === 'company_admin') return d;
  const [[granted]] = await pool.query(
    `SELECT 1 AS ok FROM user_dashboard_access WHERE user_id = ? AND dashboard_id = ?`,
    [user.id, d.id]
  );
  return granted ? d : null;
}

module.exports = { wrap, isSuperadmin, resolveCompanyId, getDashboardForUser };
