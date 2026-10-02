#!/usr/bin/env node
// Reads FMH's own report catalog, then samples each report to learn its real
// fields — so widget design stops guessing.
//
// Context: our app wired up only four report sources (purchase_analysis,
// menu_and_ingredients, cogs, order_items_by_branch). The catalog at
// /v1/public/reports/catalog lists far more than that, including several that
// already compute things we were planning to build by hand — most importantly
// product_variance ("theoretical vs actual usage variance"), menu_ingredients
// ("ingredient consumption implied by menu sales") and purchase_price_history.
//
// Usage:  node scripts/discover-fmh-reports.js [companyId] [--all] [--key <report_key>]
//         railway run node scripts/discover-fmh-reports.js 1
//
//   (no flag)   list the whole catalog, then sample the reports we care about
//   --all       sample every report in the catalog, not just the shortlist
//   --key X     sample only report X, and print a full row so the grain is visible
//
// Read-only. Each sample asks for limit:1, so it spends about one row of the
// company's FMH quota per report sampled.
const pool = require('../db/pool');
const { getApiKey, FMH_BASE } = require('../lib/fmh');

const ROOT = FMH_BASE.replace(/\/catalog.*$/, '');
const WIRED = ['purchase_analysis', 'menu_and_ingredients', 'cogs', 'order_items_by_branch'];

// Reports worth sampling first, and why they matter to the central-kitchen chain.
const SHORTLIST = {
  product_variance: 'theoretical vs actual usage — คือ AvT ที่เราคิดว่าต้องคำนวณเอง',
  menu_ingredients: 'วัตถุดิบที่ถูกใช้จริงตามยอดขายเมนู — กระจายสูตรให้แล้ว',
  purchase_price_history: 'ราคาต่อหน่วยตามเวลา — ฐานของ control chart และความผันผวน',
  purchase_order_summary: 'หนึ่งแถวต่อ PO เทียบสั่งกับวางบิล — ฐานของ three-way match',
  product_costing: 'ที่มาของต้นทุนปัจจุบัน พร้อมประวัติรับของ',
  price_comparison: 'เทียบราคาสินค้าเดียวกันข้ามซัพพลายเออร์',
  production_history: 'รอบผลิตของครัวกลาง — ฐานของ yield',
  order_summary_report: 'จำนวนที่สั่งเทียบสต็อกคงเหลือ',
  grn_summary: 'ใบรับของ',
  invoice_summary: 'ใบแจ้งหนี้ซัพพลายเออร์',
  delivery_order_summary: 'ใบส่งของ',
  credit_note_summary: 'ใบลดหนี้',
  batch_tracing: 'ตามล็อตตั้งแต่รับถึงใช้ พร้อมวันหมดอายุ',
  picking: 'ไลน์ที่รอจัดของ',
  halal_certificate: 'ความครอบคลุมและวันหมดอายุของใบรับรองฮาลาล',
};

const line = (t) => `\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (f) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : null; };

async function call(url, apiKey, body) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
  return { status: res.status, ok: res.ok, json };
}

// The catalog's exact shape is unknown, so pull report entries out generically:
// any object carrying something key-like plus a name/description or a card list.
function parseCatalog(json) {
  const out = new Map();
  const walk = (node, depth) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
    if (typeof node !== 'object') return;
    const key = node.key || node.report_key || node.id || node.slug || node.report;
    const cards = node.cards || node.card_keys || node.children;
    if (typeof key === 'string' && /^[a-z][a-z0-9_]{2,}$/.test(key) && (node.name || node.title || node.description || cards)) {
      const cardKeys = Array.isArray(cards)
        ? cards.map((c) => (typeof c === 'string' ? c : c?.key || c?.card_key || c?.id)).filter(Boolean)
        : [];
      out.set(key, { key, name: node.name || node.title || node.description || '', cards: cardKeys });
    }
    Object.values(node).forEach((v) => walk(v, depth + 1));
  };
  walk(json, 0);
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function rowsOf(json) {
  const r = json?.data || json?.rows || json?.result?.data;
  return Array.isArray(r) ? r : null;
}

function classify(fields) {
  const has = (re) => fields.some((f) => re.test(f));
  return {
    qty: has(/qty|quantity|units|pack/i),
    money: has(/total|value|amount|price|cost|sales|profit/i),
    date: has(/date|period|month|week/i),
    branch: has(/branch|outlet|location|store/i),
    codes: fields.filter((f) => /_code$|^code$|sku|_id$/i.test(f)),
  };
}

(async () => {
  const companyId = Number(process.argv[2]?.startsWith('--') ? 1 : process.argv[2] || 1);
  const only = arg('--key');
  const all = process.argv.includes('--all');

  const [[co]] = await pool.query(`SELECT id, name FROM companies WHERE id = ?`, [companyId]);
  if (!co) {
    console.error(`ไม่พบบริษัท id=${companyId}`);
    const [list] = await pool.query(`SELECT id, name FROM companies ORDER BY id`);
    list.forEach((c) => console.error(`  ${c.id}  ${c.name}`));
    process.exit(1);
  }
  const apiKey = await getApiKey(companyId);
  console.log(`\nสำรวจ FMH report catalog — บริษัท ${co.name} (id ${co.id})`);
  console.log(`host: ${ROOT}`);

  // ---- 1. the catalog ----
  console.log(line('1. รายงานทั้งหมดที่ FMH มี'));
  let reports = [];
  const cat = await call(`${ROOT}/catalog`, apiKey, null);
  if (cat.ok) {
    reports = parseCatalog(cat.json);
    console.log(`  พบ ${reports.length} รายงาน\n`);
    reports.forEach((r) => {
      const tag = WIRED.includes(r.key) ? ' ← ต่อไว้แล้ว' : SHORTLIST[r.key] ? ' ← น่าสนใจ' : '';
      console.log(`  ${r.key.padEnd(26)} ${r.name.slice(0, 44).padEnd(46)}${tag}`);
      if (r.cards.length) console.log(`  ${''.padEnd(26)} cards: ${r.cards.join(', ')}`);
    });
    const missing = Object.keys(SHORTLIST).filter((k) => !reports.find((r) => r.key === k));
    if (missing.length) console.log(`\n  (ชื่อที่คาดไว้แต่ไม่อยู่ใน catalog: ${missing.join(', ')})`);
  } else {
    console.log(`  เรียก /catalog ไม่สำเร็จ (${cat.status}) — ${JSON.stringify(cat.json).slice(0, 200)}`);
    reports = Object.keys(SHORTLIST).map((k) => ({ key: k, name: SHORTLIST[k], cards: [] }));
    console.log('  จะลองยิงตามชื่อที่คาดไว้แทน');
  }

  // ---- 2. sample ----
  const targets = only
    ? reports.filter((r) => r.key === only)
    : all
      ? reports
      : reports.filter((r) => SHORTLIST[r.key] && !WIRED.includes(r.key));

  console.log(line(`2. ฟิลด์จริงของแต่ละรายงาน (${targets.length} ตัว, ขอ limit 1)`));
  const found = [];
  for (const r of targets) {
    const bodies = r.cards.length
      ? [{ limit: 1, offset: 0, card_key: r.cards.find((c) => /table$/.test(c)) || r.cards[0] }, { limit: 1, offset: 0 }]
      : [{ limit: 1, offset: 0 }];
    let got = null;
    for (const body of bodies) {
      const res = await call(`${ROOT}/catalog/${r.key}`, apiKey, body);
      if (res.ok) { got = { res, body }; break; }
      if (!got) got = { res, body };
      await sleep(100);
    }
    const { res, body } = got;
    console.log(`\n▸ ${r.key}${body.card_key ? `  (card_key: ${body.card_key})` : ''}`);
    if (SHORTLIST[r.key]) console.log(`  ทำไมสนใจ: ${SHORTLIST[r.key]}`);
    if (!res.ok) {
      console.log(`  HTTP ${res.status} — ${String(res.json.message || res.json.error || JSON.stringify(res.json)).slice(0, 150)}`);
      await sleep(150);
      continue;
    }
    const rows = rowsOf(res.json);
    if (!rows) { console.log(`  ตอบ 200 แต่ไม่พบ data[] — ${JSON.stringify(res.json).slice(0, 180)}`); await sleep(150); continue; }
    if (!rows.length) { console.log('  ตอบ 200 แต่ data ว่าง — บัญชีนี้ไม่มีข้อมูลในรายงานนี้'); await sleep(150); continue; }
    const fields = Object.keys(rows[0]);
    const c = classify(fields);
    console.log(`  ฟิลด์ (${fields.length}): ${fields.join(', ')}`);
    console.log(`  จำนวน:${c.qty ? 'มี' : '—'}  เงิน:${c.money ? 'มี' : '—'}  วันที่:${c.date ? 'มี' : '—'}  สาขา:${c.branch ? 'มี' : '—'}  รหัสที่ join ได้: ${c.codes.join(', ') || '—'}`);
    if (c.qty && c.money && c.date) console.log('  ★ ครบจำนวน เงิน วันที่ — ใช้เทียบรายทรานแซกชันได้');
    if (only) console.log(`  ตัวอย่าง 1 แถว:\n${JSON.stringify(rows[0], null, 2).split('\n').map((l) => '    ' + l).join('\n')}`);
    found.push({ key: r.key, fields, c });
    await sleep(150);
  }

  // ---- 3. where the join keys line up ----
  console.log(line('3. รหัสที่ซ้ำกันข้ามรายงาน — ใช้เป็นคีย์เชื่อมได้'));
  const byCode = {};
  found.forEach((f) => f.c.codes.forEach((code) => { (byCode[code] ||= []).push(f.key); }));
  const shared = Object.entries(byCode).filter(([, v]) => v.length > 1);
  if (!shared.length) console.log('  ยังไม่เห็นรหัสที่ชื่อตรงกันข้ามรายงานจากตัวอย่างนี้');
  shared.forEach(([code, keys]) => console.log(`  ${code.padEnd(22)} ใช้ร่วมกันใน: ${keys.join(', ')}`));
  console.log('\n  หมายเหตุ: ชื่อฟิลด์ตรงกันไม่ได้แปลว่าค่าตรงกัน');
  console.log('  ให้รัน inspect-fmh-schema.js ต่อ เพื่อวัดว่าค่าจริงตรงกันกี่เปอร์เซ็นต์\n');

  await pool.end();
})().catch(async (e) => {
  console.error('\nผิดพลาด:', e.message);
  try { await pool.end(); } catch {}
  process.exit(1);
});
