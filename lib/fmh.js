// FMH (Food Market Hub) public Reports API client — per company.
// Each company (tenant) has its own FMH API key (companies.fmh_api_key_enc),
// and therefore its own FMH monthly row quota.
//
// Confirmed working host: v10-core-be.foodmarkethub.com (verified via Swagger UI,
// 2026-09-30, returns HTTP 200 with real data). Do NOT use core-canary.foodmarkethub.com
// — same-looking API, different host, returns 401 regardless of key validity.
// FMH_BASE_URL can override the host (only used for local testing against a mock).
const pool = require('../db/pool');
const { decrypt } = require('./crypto');
const { logUsage } = require('./fmhUsage');

const FMH_BASE = process.env.FMH_BASE_URL || 'https://v10-core-be.foodmarkethub.com/v1/public/reports';

async function getApiKey(companyId) {
  const [[row]] = await pool.query(`SELECT fmh_api_key_enc FROM companies WHERE id = ?`, [companyId]);
  if (!row || !row.fmh_api_key_enc) {
    const err = new Error('ยังไม่ได้ตั้งค่า FMH API Key ของบริษัทนี้');
    err.code = 'FMH_KEY_MISSING';
    throw err;
  }
  return decrypt(row.fmh_api_key_enc);
}

// reportKey: the catalog resource in the URL (e.g. 'cogs', 'menu_and_ingredients').
// cardKey: optional — which "card" of the report (e.g. cogs -> 'cogs_table').
// extra: { filters, limit, offset, ... } — all optional.
async function callReport(companyId, reportKey, cardKey, extra = {}) {
  const apiKey = await getApiKey(companyId);
  const body = { limit: 500, offset: 0, ...(cardKey ? { card_key: cardKey } : {}), ...extra };

  const res = await fetch(`${FMH_BASE}/catalog/${reportKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(json.message || json.error || `FMH API returned ${res.status}`);
    err.code = 'FMH_API_ERROR';
    err.status = res.status;
    err.details = json;
    throw err;
  }
  const label = `${reportKey}${cardKey ? '/' + cardKey : ''}${extra.group_by ? '|' + extra.group_by : ''}`;
  await logUsage(companyId, label, Array.isArray(json.data) ? json.data.length : 0);
  return json;
}

module.exports = { callReport, getApiKey, FMH_BASE };
