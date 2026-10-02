// Read-only probes against a company's FMH account.
//
// These exist because the app was built against assumptions about the API that
// turned out to be wrong, and the only way to settle such questions is to ask
// FMH with that company's own key. Every probe is a GET or a report read; none
// of them writes anything.
//
// Quota: report reads cost rows from the company's monthly quota, so each probe
// uses server-side group_by where it can (a dozen grouped rows instead of
// thousands of itemized ones) and reports the quota figures FMH returns.
const { getApiKey, FMH_BASE } = require('./fmh');

const ROOT = FMH_BASE.replace(/\/catalog.*$/, '');

// Statuses that represent spend the company actually committed to. The rest —
// PENDING (not yet approved), CANCELLED, REJECTED, NOT_APPROVED — are requests
// that never became purchases, so counting them overstates spend.
const COMMITTED_STATUSES = ['APPROVED', 'IN_PROCESS', 'DISPATCHED', 'RECEIVED', 'INVOICED', 'COMPLETED'];
const ALL_STATUSES = ['PENDING', ...COMMITTED_STATUSES, 'CANCELLED', 'REJECTED', 'NOT_APPROVED'];

async function raw(path, apiKey, body) {
  const started = Date.now();
  const res = await fetch(ROOT + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
  return {
    ok: res.ok,
    status: res.status,
    ms: Date.now() - started,
    json,
    deprecation: res.headers.get('deprecation'),
    sunset: res.headers.get('sunset'),
    apiVersion: res.headers.get('x-api-version'),
  };
}

const rowsOf = (j) => (Array.isArray(j?.data) ? j.data : null);
const sumField = (rows, keys) => {
  const k = keys.find((key) => rows.some((r) => typeof r[key] === 'number'));
  if (!k) return null;
  return { field: k, total: rows.reduce((a, r) => a + (Number(r[k]) || 0), 0) };
};

// ---------------------------------------------------------------------------
// Probe 1 — does leaving `statuses` out include cancelled and rejected orders?
//
// Compares the same window with no status filter against committed-only. If the
// totals differ, the dashboard has been counting orders that never happened.
// ---------------------------------------------------------------------------
async function probeStatuses(companyId, { reportKey, cardKey, groupBy, days = 30 } = {}) {
  const apiKey = await getApiKey(companyId);
  const end = new Date();
  const start = new Date(Date.now() - days * 86400000);
  const range = { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };

  const call = (statuses) =>
    raw(`/catalog/${reportKey}`, apiKey, {
      card_key: cardKey,
      ...(groupBy ? { group_by: groupBy } : {}),
      limit: 1000,
      offset: 0,
      filters: { date_range: range, ...(statuses ? { statuses } : {}) },
    });

  const [noFilter, committed] = await Promise.all([call(null), call(COMMITTED_STATUSES)]);
  const out = { reportKey, cardKey, groupBy, window: range, quota: noFilter.json?.quota || null };

  if (!noFilter.ok || !committed.ok) {
    out.error = `ไม่ส่งผ่าน — ไม่กรอง: HTTP ${noFilter.status}, กรองแล้ว: HTTP ${committed.status}`;
    out.detail = String(
      (!noFilter.ok ? noFilter.json?.message || noFilter.json?.error : committed.json?.message || committed.json?.error) || ''
    ).slice(0, 300);
    return out;
  }

  const a = rowsOf(noFilter.json) || [];
  const b = rowsOf(committed.json) || [];
  const moneyKeys = ['total_spend', 'total_value', 'total', 'po_total', 'invoice_total', 'grn_total'];
  const qtyKeys = ['total_qty', 'total_quantity', 'quantity', 'qty', 'order_count'];
  const am = sumField(a, moneyKeys), bm = sumField(b, moneyKeys);
  const aq = sumField(a, qtyKeys), bq = sumField(b, qtyKeys);

  out.noFilter = { rows: a.length, money: am, qty: aq };
  out.committed = { rows: b.length, money: bm, qty: bq };
  out.statusesAccepted = true;

  if (am && bm && am.total > 0) {
    const diff = am.total - bm.total;
    out.verdict = Math.abs(diff) < 0.5
      ? 'ตรงกัน — การไม่ส่งตัวกรองสถานะให้ผลเท่ากับกรองเฉพาะใบที่ยืนยันแล้ว'
      : `ต่างกัน ${diff.toLocaleString('th-TH', { maximumFractionDigits: 0 })} (${((diff / am.total) * 100).toFixed(1)}% ของยอดที่ไม่กรอง) — ตัวเลขที่ dashboard แสดงอยู่รวมใบที่ไม่ได้เป็นการซื้อจริง`;
    out.overstatedBy = diff;
    out.overstatedPct = (diff / am.total) * 100;
  } else {
    out.verdict = 'เรียกผ่านทั้งสองครั้ง แต่หาฟิลด์มูลค่าเพื่อเทียบไม่เจอ — ดูแถวตัวอย่างประกอบ';
    out.sampleRow = a[0] || null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Probe 2 — which shape does the date_range filter actually accept?
//
// The catalog says date_range binds to start_date/end_date and offers a choice
// of which date column to filter on, but the app has always sent {start, end}.
// Only FMH can say which forms it takes, and whether the column choice works.
// ---------------------------------------------------------------------------
async function probeDateFilter(companyId, { reportKey = 'purchase_analysis', cardKey = 'purchase_analysis_table' } = {}) {
  const apiKey = await getApiKey(companyId);
  const end = new Date(), start = new Date(Date.now() - 14 * 86400000);
  const s = start.toISOString().slice(0, 10), e = end.toISOString().slice(0, 10);

  const shapes = [
    { name: 'ที่แอปใช้อยู่: {start, end}', filters: { date_range: { start: s, end: e } } },
    { name: 'ตาม catalog: {start_date, end_date}', filters: { date_range: { start_date: s, end_date: e } } },
    { name: 'เลือกฟิลด์วันที่: + field grn_date', filters: { date_range: { start: s, end: e, field: 'grn_date' } } },
    { name: 'ช่วงกว้างเกิน 90 วัน (ควรถูกปฏิเสธ)', filters: { date_range: { start: '2020-01-01', end: e } } },
  ];
  const results = [];
  for (const sh of shapes) {
    const r = await raw(`/catalog/${reportKey}`, apiKey, { card_key: cardKey, group_by: 'branch', limit: 50, offset: 0, filters: sh.filters });
    results.push({
      name: sh.name,
      ok: r.ok,
      status: r.status,
      rows: rowsOf(r.json)?.length ?? null,
      message: String(r.json?.message || r.json?.error || '').slice(0, 160),
    });
  }
  return { reportKey, results };
}

// ---------------------------------------------------------------------------
// Probe 3 — does server-side group_by work, and how much quota does it save?
//
// This is the one that decides how the sync should be built: grouping on FMH's
// side returns a handful of rows where itemized returns thousands.
// ---------------------------------------------------------------------------
async function probeGroupBy(companyId, { reportKey = 'purchase_analysis', cardKey = 'purchase_analysis_table', groups = ['itemized', 'branch', 'supplier', 'category', 'product'], days = 30 } = {}) {
  const apiKey = await getApiKey(companyId);
  const end = new Date(), start = new Date(Date.now() - days * 86400000);
  const range = { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  const out = [];
  for (const g of groups) {
    const r = await raw(`/catalog/${reportKey}`, apiKey, {
      card_key: cardKey, group_by: g, limit: 1000, offset: 0,
      filters: { date_range: range, statuses: COMMITTED_STATUSES },
    });
    const rows = rowsOf(r.json);
    out.push({
      group: g,
      ok: r.ok,
      status: r.status,
      rows: rows?.length ?? null,
      fields: rows?.[0] ? Object.keys(rows[0]) : [],
      ms: r.ms,
      message: r.ok ? '' : String(r.json?.message || r.json?.error || '').slice(0, 160),
    });
  }
  const itemized = out.find((o) => o.group === 'itemized');
  const grouped = out.filter((o) => o.group !== 'itemized' && o.rows != null);
  return {
    reportKey,
    window: range,
    results: out,
    saving:
      itemized?.rows && grouped.length
        ? `itemized คืน ${itemized.rows} แถว ขณะที่จัดกลุ่มคืน ${grouped.map((g) => `${g.group} ${g.rows}`).join(' · ')} แถว`
        : null,
  };
}

// ---------------------------------------------------------------------------
// Probe 4 — do two reports actually share a product code?
//
// purchase_analysis and sales_analysis carry 39 of the same 45 field names,
// product_code and uom among them, which makes a transaction-level join look
// free. Matching field NAMES says nothing about matching VALUES, though: if one
// side holds supplier SKUs and the other holds internal codes, a join silently
// returns almost nothing and every cross-report widget quietly under-reports.
//
// Both sides are read with group_by: product, so this costs one row per product
// rather than one per order line.
// ---------------------------------------------------------------------------
const JOIN_PAIRS = [
  { name: 'ซื้อ ↔ ขาย', a: { key: 'purchase_analysis', card: 'purchase_analysis_table', group: 'product' },
    b: { key: 'sales_analysis', card: 'sales_analysis_table', group: 'product' }, field: 'product_code' },
  { name: 'ซื้อ ↔ สาขาเบิก', a: { key: 'purchase_analysis', card: 'purchase_analysis_table', group: 'product' },
    b: { key: 'order_items_by_branch', card: 'oibb_table', group: 'product' }, field: 'product_code' },
  { name: 'ซื้อ ↔ สูตร (รหัสวัตถุดิบ)', a: { key: 'purchase_analysis', card: 'purchase_analysis_table', group: 'product' },
    b: { key: 'menu_and_ingredients', card: 'recipe_table', group: 'by_ingredient', noDateRange: true },
    field: 'product_code', bField: 'ingredient_code', bLabel: 'ingredient_name' },
];

const normCode = (v) => String(v ?? '').trim().toUpperCase();

async function probeJoinKeys(companyId, { days = 30 } = {}) {
  const apiKey = await getApiKey(companyId);
  const end = new Date(), start = new Date(Date.now() - days * 86400000);
  const range = { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };

  const fetchCodes = async (side, field, labelField) => {
    const body = { card_key: side.card, group_by: side.group, limit: 1000, offset: 0 };
    // menu_and_ingredients is the one report in the catalog with no date_range
    // filter — it describes recipes, which have no transaction date — and
    // sending one is rejected outright.
    if (!side.noDateRange) body.filters = { date_range: range };
    const r = await raw(`/catalog/${side.key}`, apiKey, body);
    if (!r.ok) return { error: `HTTP ${r.status} ${String(r.json?.message || r.json?.error || '').slice(0, 140)}` };
    const rows = rowsOf(r.json) || [];
    const present = rows.length ? Object.keys(rows[0]) : [];
    const byCode = new Map();
    rows.forEach((x) => {
      const c = normCode(x[field]);
      if (!c) return;
      const label = labelField && x[labelField] ? x[labelField] : x.product || x.ingredient || x.ingredient_name || '';
      if (!byCode.has(c)) byCode.set(c, String(label));
    });
    return { rows: rows.length, field, hasField: present.includes(field), fields: present, byCode };
  };

  const out = [];
  for (const pair of JOIN_PAIRS) {
    const A = await fetchCodes(pair.a, pair.field, pair.aLabel);
    const B = await fetchCodes(pair.b, pair.bField || pair.field, pair.bLabel);
    const entry = { name: pair.name, a: pair.a.key, b: pair.b.key, field: pair.field, bField: pair.bField || pair.field };
    if (A.error || B.error) {
      entry.error = A.error || B.error;
      out.push(entry);
      continue;
    }
    entry.aRows = A.rows; entry.bRows = B.rows;
    entry.aHasField = A.hasField; entry.bHasField = B.hasField;
    entry.aFields = A.fields; entry.bFields = B.fields;
    const SA = new Set(A.byCode.keys()), SB = new Set(B.byCode.keys());
    entry.aCodes = SA.size; entry.bCodes = SB.size;
    if (!SA.size || !SB.size) {
      entry.verdict = 'ฝั่งใดฝั่งหนึ่งไม่มีรหัสให้เทียบในช่วงนี้ — อาจไม่มีข้อมูล หรือรายงานนี้ไม่มีฟิลด์รหัส';
      out.push(entry);
      continue;
    }
    // Share of the SMALLER side that is found on the other: the number that
    // decides whether a join is usable.
    const smallIsA = SA.size <= SB.size;
    const small = smallIsA ? SA : SB, big = smallIsA ? SB : SA;
    const labels = smallIsA ? A.byCode : B.byCode;
    entry.smallSide = smallIsA ? pair.a.key : pair.b.key;
    let hit = 0; const missed = [];
    small.forEach((c) => {
      if (big.has(c)) hit++;
      else if (missed.length < 6) missed.push({ code: c, name: labels.get(c) || '' });
    });
    entry.matched = hit;
    entry.pct = Math.round((hit / small.size) * 100);
    entry.missed = missed;
    // Whether the two sides share a code NAMESPACE is a different question from
    // whether every code appears on both. One exact match proves the namespace;
    // the remainder are items that only exist on one side — in a central
    // kitchen, anything the kitchen produces is sold but never purchased.
    entry.sharesNamespace = hit > 0;
    entry.verdict = hit === 0
      ? 'ไม่มีรหัสตรงกันเลย — สองฝั่งใช้รหัสคนละชุด ยังใช้เป็นคีย์เชื่อมไม่ได้'
      : entry.pct >= 95
        ? 'ใช้เป็นคีย์เชื่อมได้ รหัสตรงกันเกือบทั้งหมด'
        : 'ใช้รหัสชุดเดียวกัน แต่มีบางรายการอยู่ฝั่งเดียว ซึ่งปกติสำหรับครัวกลาง เพราะของที่ผลิตเองจะถูกขายแต่ไม่เคยถูกซื้อ ดูรายชื่อข้างล่างว่าใช่ของผลิตเองหรือไม่';
    out.push(entry);
  }
  return { window: range, pairs: out };
}

// ---------------------------------------------------------------------------
// Probe 5 — the catalog itself, plus the API version and any deprecation notice
// ---------------------------------------------------------------------------
async function probeCatalog(companyId) {
  const apiKey = await getApiKey(companyId);
  const r = await raw('/catalog', apiKey, null);
  const reports = Array.isArray(r.json?.reports) ? r.json.reports : [];
  return {
    ok: r.ok,
    status: r.status,
    apiVersion: r.apiVersion,
    deprecation: r.deprecation,
    sunset: r.sunset,
    dateSemantics: r.json?.date_semantics || null,
    count: reports.length,
    reports: reports.map((x) => ({
      key: x.key,
      name: x.name,
      scope: x.scope,
      defaultCard: x.default_card,
      cards: (x.cards || []).length,
      groupBy: (x.cards || []).flatMap((c) => (c.group_by ? c.group_by.options.map((o) => o.key) : [])).filter((v, i, a) => a.indexOf(v) === i),
      hasStatuses: (x.filters || []).some((f) => f.key === 'statuses'),
    })),
  };
}

module.exports = { probeStatuses, probeDateFilter, probeGroupBy, probeJoinKeys, probeCatalog, COMMITTED_STATUSES, ALL_STATUSES };
