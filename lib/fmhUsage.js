// Where the FMH row quota goes: every report call is written to fmh_usage_log
// with the rows it returned and what triggered it (nightly sync, deploy,
// Refresh button, Admin sync, diagnostics...). The trigger travels with the
// async call chain, so callers just wrap their work in withTrigger().
const { AsyncLocalStorage } = require('async_hooks');
const pool = require('../db/pool');

const als = new AsyncLocalStorage();
const withTrigger = (trigger, fn, companyId = null) => als.run({ trigger, companyId }, fn);
const currentCompany = () => (als.getStore() || {}).companyId || null;
const currentTrigger = () => (als.getStore() || {}).trigger || 'other';

async function logUsage(companyId, pullKey, rows) {
  try {
    await pool.query(
      `INSERT INTO fmh_usage_log (company_id, pull_key, rows_fetched, trig) VALUES (?, ?, ?, ?)`,
      [companyId, String(pullKey).slice(0, 128), rows, currentTrigger()]
    );
  } catch (err) {
    console.error('FMH usage log failed:', err.message); // never block a sync on bookkeeping
  }
}

// Rows per pull and per trigger over the last `days` days.
async function usageSummary(companyId, days = 30) {
  const [byPull] = await pool.query(
    `SELECT pull_key, SUM(rows_fetched) AS rows_fetched, COUNT(*) AS calls
     FROM fmh_usage_log WHERE company_id = ? AND created_at > NOW() - INTERVAL ? DAY
     GROUP BY pull_key ORDER BY rows_fetched DESC`,
    [companyId, days]
  );
  const [byTrigger] = await pool.query(
    `SELECT trig, SUM(rows_fetched) AS rows_fetched, COUNT(*) AS calls
     FROM fmh_usage_log WHERE company_id = ? AND created_at > NOW() - INTERVAL ? DAY
     GROUP BY trig ORDER BY rows_fetched DESC`,
    [companyId, days]
  );
  const num = (rows) => rows.map((r) => ({ ...r, rows_fetched: Number(r.rows_fetched), calls: Number(r.calls) }));
  return { days, by_pull: num(byPull), by_trigger: num(byTrigger) };
}

module.exports = { withTrigger, currentTrigger, currentCompany, logUsage, usageSummary };
