// The company code (KSS-0007): fixed for life, unlike the name, which a
// client's company admin can change. KSS staff search and quote by it.
const pool = require('../db/pool');

const codeFor = (id) => `KSS-${String(id).padStart(4, '0')}`;

// Gives every company that has no code yet its code (new companies, and any
// created by an older path). Safe to call any time.
async function assignMissingCodes(conn = pool) {
  await conn.query(`UPDATE companies SET company_code = CONCAT('KSS-', LPAD(id, 4, '0')) WHERE company_code IS NULL`);
}

module.exports = { codeFor, assignMissingCodes };
