#!/usr/bin/env node
// Reads what FMH actually returned (from fmh_report_cache) and answers the four
// questions that decide whether central-kitchen cross-report widgets can be built:
//
//   1. What fields does each report really have?  (our code never names most of them)
//   2. Is there a join key between purchase_analysis and order_items_by_branch,
//      and is it a code or only a free-text name?
//   3. Is there a unit-of-measure field, so quantity x unit_price means anything?
//   4. Do the branch-ordered products exist as recipes, i.e. are they produced
//      items that must be exploded, or pass-through items bought and shipped as-is?
//
// Usage:  node scripts/inspect-fmh-schema.js [companyId]
//         railway run node scripts/inspect-fmh-schema.js 1
//
// Read-only. Touches nothing but SELECTs on fmh_report_cache.
const pool = require('../db/pool');

const SOURCES = ['purchase-analysis', 'menu-costing', 'cogs', 'sales-by-branch'];
const SAMPLE_ROWS = 400; // rows scanned per source when profiling fields

const bar = (t) => `\n${'─'.repeat(74)}\n${t}\n${'─'.repeat(74)}`;
const trunc = (v, n = 28) => {
  const s = String(v);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// ---------- field profiling ----------
function profile(rows) {
  const keys = new Set();
  rows.slice(0, SAMPLE_ROWS).forEach((r) => Object.keys(r || {}).forEach((k) => keys.add(k)));
  return [...keys].map((k) => {
    const vals = rows.slice(0, SAMPLE_ROWS).map((r) => r?.[k]);
    const filled = vals.filter((v) => v !== null && v !== undefined && v !== '');
    const distinct = [...new Set(filled.map((v) => String(v)))];
    const numeric = filled.length > 0 && filled.every((v) => typeof v === 'number' || (!isNaN(Number(v)) && String(v).trim() !== ''));
    const dateish = filled.length > 0 && filled.every((v) => /^\d{4}-\d{2}-\d{2}/.test(String(v)));
    return {
      field: k,
      type: dateish ? 'date' : numeric ? 'number' : 'text',
      fillPct: Math.round((filled.length / Math.max(1, vals.length)) * 100),
      distinct: distinct.length,
      samples: distinct.slice(0, 3),
    };
  }).sort((a, b) => a.field.localeCompare(b.field));
}

// ---------- join testing ----------
const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

function distinctSet(rows, field) {
  const s = new Set();
  rows.forEach((r) => {
    const v = r?.[field];
    if (v !== null && v !== undefined && v !== '') s.add(norm(v));
  });
  return s;
}

// Overlap as a share of the SMALLER side: "of the values on the thinner side,
// how many are also present on the other?" That is the number that decides
// whether a join is usable, not raw intersection size.
function overlap(aRows, aField, bRows, bField) {
  const A = distinctSet(aRows, aField);
  const B = distinctSet(bRows, bField);
  if (!A.size || !B.size) return null;
  let hit = 0;
  const small = A.size <= B.size ? A : B;
  const big = A.size <= B.size ? B : A;
  const missed = [];
  small.forEach((v) => {
    if (big.has(v)) hit++;
    else if (missed.length < 4) missed.push(v);
  });
  return { a: A.size, b: B.size, hit, pct: Math.round((hit / small.size) * 100), missed };
}

function textFields(prof) {
  return prof.filter((p) => p.type === 'text' && p.distinct > 1).map((p) => p.field);
}

function testJoin(label, aName, aRows, aProf, bName, bRows, bProf) {
  console.log(bar(label));
  if (!aRows.length || !bRows.length) {
    console.log(`  ข้ามไป — ${!aRows.length ? aName : bName} ไม่มีข้อมูลใน cache`);
    return;
  }
  const results = [];
  textFields(aProf).forEach((af) => {
    textFields(bProf).forEach((bf) => {
      const o = overlap(aRows, af, bRows, bf);
      if (o && o.pct > 0) results.push({ af, bf, ...o });
    });
  });
  if (!results.length) {
    console.log('  ไม่พบคู่ฟิลด์ที่ค่าตรงกันเลย — ต้องขอฟิลด์รหัสร่วมจาก FMH');
    return;
  }
  results.sort((x, y) => y.pct - x.pct);
  console.log(`  ${aName.padEnd(22)} ${bName.padEnd(22)} ตรงกัน   ค่าไม่ซ้ำ`);
  results.slice(0, 8).forEach((r) => {
    const flag = r.pct >= 90 ? 'ใช้เป็นคีย์ได้' : r.pct >= 50 ? 'ตรงบางส่วน ต้องดู' : 'ตรงน้อย';
    console.log(`  ${r.af.padEnd(22)} ${r.bf.padEnd(22)} ${String(r.pct + '%').padStart(5)}   ${r.a}/${r.b}  ${flag}`);
  });
  const best = results[0];
  if (best.pct < 100 && best.missed.length) {
    console.log(`\n  ตัวอย่างค่าที่หาคู่ไม่เจอ (${best.af} ↔ ${best.bf}):`);
    best.missed.forEach((m) => console.log(`    · ${trunc(m, 50)}`));
  }
}

// ---------- unit of measure ----------
const UOM_HINT = /(uom|unit|measure|pack|size|หน่วย)/i;
function uomReport(name, prof) {
  const hits = prof.filter((p) => UOM_HINT.test(p.field) && p.field !== 'unit_price');
  if (!hits.length) {
    console.log(`  ${name.padEnd(22)} ไม่พบฟิลด์หน่วยนับ  ← quantity × unit_price จะเชื่อถือไม่ได้`);
  } else {
    hits.forEach((h) => console.log(`  ${name.padEnd(22)} ${h.field} (${h.distinct} ค่า: ${h.samples.map((s) => trunc(s, 12)).join(', ')})`));
  }
}

(async () => {
  const companyId = Number(process.argv[2] || 1);
  const [[co]] = await pool.query(`SELECT id, name FROM companies WHERE id = ?`, [companyId]);
  if (!co) {
    console.error(`ไม่พบบริษัท id=${companyId}. บริษัทที่มี:`);
    const [all] = await pool.query(`SELECT id, name FROM companies ORDER BY id`);
    all.forEach((c) => console.error(`  ${c.id}  ${c.name}`));
    process.exit(1);
  }
  console.log(`\nตรวจข้อมูล FMH ที่ cache ไว้ของบริษัท: ${co.name} (id ${co.id})`);

  const [cached] = await pool.query(
    `SELECT cache_key, data_json, synced_at FROM fmh_report_cache WHERE company_id = ?`,
    [companyId]
  );
  const data = {};
  const profs = {};
  SOURCES.forEach((s) => { data[s] = []; profs[s] = []; });

  cached.forEach((row) => {
    let rows = [];
    try { rows = JSON.parse(row.data_json) || []; } catch { rows = []; }
    data[row.cache_key] = rows;
  });

  // ---- 1. field inventory ----
  console.log(bar('1. ฟิลด์ที่ FMH ส่งกลับมาจริง'));
  SOURCES.forEach((s) => {
    const rows = data[s] || [];
    const meta = cached.find((c) => c.cache_key === s);
    console.log(`\n▸ ${s}  —  ${rows.length} แถว` + (meta ? `  (sync ล่าสุด ${meta.synced_at})` : '  (ยังไม่เคย sync)'));
    if (!rows.length) { console.log('  ไม่มีข้อมูลใน cache — เปิดแท็บนี้ใน dashboard หรือกด refresh ก่อน'); return; }
    profs[s] = profile(rows);
    console.log(`  ${'field'.padEnd(26)} ${'type'.padEnd(7)} ${'มีค่า'.padEnd(6)} ${'ไม่ซ้ำ'.padEnd(7)} ตัวอย่าง`);
    profs[s].forEach((p) => {
      console.log(`  ${p.field.padEnd(26)} ${p.type.padEnd(7)} ${String(p.fillPct + '%').padStart(5)} ${String(p.distinct).padStart(7)}  ${p.samples.map((v) => trunc(v)).join(' | ')}`);
    });
  });

  // ---- 2. join keys ----
  testJoin(
    '2a. คีย์เชื่อม: ซื้อเข้า ↔ สาขาเบิก  (ตัวตัดสินว่าทำ CK scope ได้ไหม)',
    'purchase_analysis', data['purchase-analysis'], profs['purchase-analysis'],
    'order_items_by_branch', data['sales-by-branch'], profs['sales-by-branch']
  );
  testJoin(
    '2b. คีย์เชื่อม: ซื้อเข้า ↔ สูตร  (ใช้ราคาซื้อล่าสุดมาคิดต้นทุนสูตร)',
    'purchase_analysis', data['purchase-analysis'], profs['purchase-analysis'],
    'recipe_table', data['menu-costing'], profs['menu-costing']
  );
  testJoin(
    '2c. คีย์เชื่อม: สาขาเบิก ↔ สูตร  (ของที่สาขาเบิกเป็นของผลิตเองหรือของผ่านทาง)',
    'order_items_by_branch', data['sales-by-branch'], profs['sales-by-branch'],
    'recipe_table', data['menu-costing'], profs['menu-costing']
  );
  testJoin(
    '2d. คีย์เชื่อม: สาขาเบิก ↔ COGS  (เชื่อมจำนวนเข้ากับเงิน)',
    'order_items_by_branch', data['sales-by-branch'], profs['sales-by-branch'],
    'cogs_table', data['cogs'], profs['cogs']
  );

  // ---- 3. unit of measure ----
  console.log(bar('3. หน่วยนับ — ถ้าไม่มี quantity × unit_price จะผิด'));
  SOURCES.forEach((s) => { if (profs[s].length) uomReport(s, profs[s]); });

  // ---- 4. period coverage ----
  console.log(bar('4. ช่วงวันที่ของแต่ละ report — ต้องทับกันถึงจะเทียบกันได้'));
  SOURCES.forEach((s) => {
    const rows = data[s] || [];
    if (!rows.length) return;
    profs[s].filter((p) => p.type === 'date').forEach((p) => {
      const ds = rows.map((r) => r[p.field]).filter(Boolean).map((v) => String(v).slice(0, 10)).sort();
      if (ds.length) console.log(`  ${s.padEnd(22)} ${p.field.padEnd(26)} ${ds[0]} → ${ds[ds.length - 1]}  (${ds.length} แถวมีวันที่)`);
    });
    if (!profs[s].some((p) => p.type === 'date')) {
      console.log(`  ${s.padEnd(22)} ไม่มีฟิลด์วันที่เลย  ← เทียบตามช่วงเวลาไม่ได้`);
    }
  });

  console.log(bar('สรุปสิ่งที่ต้องตัดสินใจ'));
  console.log(`  · ถ้า 2a มีคู่ที่ตรง ≥90% และเป็นรหัส ไม่ใช่ชื่อ → ทำ widget ข้าม report ของครัวกลางได้เลย`);
  console.log(`  · ถ้าตรงเฉพาะชื่อสินค้า → ทำได้แต่จะพังเงียบเมื่อชื่อพิมพ์ต่างกัน ควรขอรหัสร่วมจาก FMH`);
  console.log(`  · ถ้า 2c ตรงสูง แปลว่าของที่สาขาเบิกเป็นของผลิตเอง ต้องกระจายผ่านสูตรก่อนเทียบกับยอดซื้อ`);
  console.log(`  · ถ้าข้อ 3 ไม่พบหน่วยนับ ให้คิดเป็นมูลค่าอย่างเดียว อย่าคูณจำนวนกับราคา\n`);

  await pool.end();
})().catch(async (e) => {
  console.error('\nผิดพลาด:', e.message);
  try { await pool.end(); } catch {}
  process.exit(1);
});
