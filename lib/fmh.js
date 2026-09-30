// FMH (Food Market Hub) public Reports API client.
// Confirmed working host: v10-core-be.foodmarkethub.com (verified via Swagger UI,
// 2026-09-30, returns HTTP 200 with real data). Do NOT use core-canary.foodmarkethub.com
// — same-looking API, different host, returns 401 regardless of key validity.
const pool = require('../db/pool');
const { decrypt } = require('./crypto');

const FMH_BASE = 'https://v10-core-be.foodmarkethub.com/v1/public/reports';

async function getApiKey() {
  const [[row]] = await pool.query(
    `SELECT setting_value FROM app_settings WHERE setting_key = 'fmh_api_key'`
  );
  if (!row) {
    const err = new Error('FMH API key not configured. Add it in Settings first.');
    err.code = 'FMH_KEY_MISSING';
    throw err;
  }
  return decrypt(row.setting_value);
}

// reportKey: the catalog resource in the URL (e.g. 'cogs', 'menu_and_ingredients').
// cardKey: required in the body — each catalog report is made of one or more
// "cards"; card_key picks which one (e.g. cogs -> 'cogs_table').
// extra: { filters, group_by, outlet_pks, order_by, limit, offset } — all optional.
// cardKey is optional — pass null/undefined to omit it (confirmed via Swagger
// that some report endpoints don't need it; the URL's report_key is enough).
async function callReport(reportKey, cardKey, extra = {}) {
  const apiKey = await getApiKey();
  const body = { limit: 500, offset: 0, ...(cardKey ? { card_key: cardKey } : {}), ...extra };

  const res = await fetch(`${FMH_BASE}/catalog/${reportKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
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

  return json;
}

module.exports = { callReport, getApiKey, FMH_BASE };
