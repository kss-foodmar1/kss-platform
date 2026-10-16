// "อธิบาย" on a widget: what this chart is telling you right now, in plain
// Thai, worked out from the very rows the widget is drawing (same date range,
// same branch / supplier filters). No AI and nothing leaves the browser — the
// sentences are rules over the numbers, so they are instant, free, and never
// state a number the chart doesn't show.
//
//   explainWidget(widget, data) -> HTML
//     data: { rows, cfg } after a successful render, { empty: msg } when the
//     widget had nothing to show, or { panels: true } for multi-chart widgets.

// What to do with what the widget shows, by catalog category; a few widgets
// have their own (EXPLAIN_TIPS).
const EXPLAIN_CATEGORY_TIP = {
  Alerts: 'เรื่องในตารางนี้คือสิ่งที่ควรมีคนรับผิดชอบวันนี้ ระดับ “สูง” ก่อน แล้วไล่ตามผลกระทบเป็นเงิน',
  Purchasing: 'ถ้าตัวเลขขยับผิดจากปกติ ให้เปิดเอกสารใน FMH ดูรายบรรทัดว่ามาจากสินค้าหรือซัพพลายเออร์ไหน',
  'Line Checks': 'แต่ละบรรทัดคือเอกสารที่ควรมีคนตรวจ ส่งต่อให้ฝ่ายจัดซื้อหรือบัญชีพร้อมเลข PO / ใบแจ้งหนี้ได้เลย',
  'Supplier Quality': 'เจ้าที่อยู่บนสุดคือคนที่ควรคุยก่อน นำตัวเลขนี้ไปคุยเรื่องการส่งของหรือขอใบลดหนี้',
  'Price Change': 'ราคาที่ขึ้นต่อเนื่องควรเจรจา หรือหาเจ้าเปรียบเทียบ และอย่าลืมปรับต้นทุนในสูตรอาหารให้ตรงราคาจริง',
  'Cost Control': 'ถ้ากำไรลดลง ให้ดูว่ามาจากยอดขายที่ลดหรือต้นทุนที่ขึ้น แล้วไล่ต่อที่เมนูหรือวัตถุดิบตัวที่กระทบมากที่สุด',
  'Menu Costing': 'เมนูที่ต้นทุนสูงหรือกำไรต่ำคือตัวเลือกแรกในการปรับราคา ปรับสูตร หรือเปลี่ยนวัตถุดิบ',
  'Actual vs Theoretical': 'ส่วนที่ใช้เกินสูตรแต่ไม่มีของเสียบันทึกไว้ คือจุดที่ควรเข้าไปดูการเตรียมของหรือการนับสต็อก',
  'Cross-report': 'ช่องว่างระหว่างตัวเลขสองแหล่งมีได้หลายสาเหตุ ทั้งสูตรล้าหลัง หน่วยแปลงผิด ผลผลิตตัดแต่ง การนับสต็อก เดือนที่ยังไม่ปิด หรือของหายจริง ไล่ตรวจสาเหตุเหล่านี้ก่อน และดูแนวโน้มหลายเดือน ไม่ตัดสินจากเดือนเดียว',
  Sales: 'ใช้วางแผนกำลังผลิตและรอบส่งของ ลูกค้าหรือสินค้าที่ยอดตกผิดปกติควรมีคนโทรถาม',
  Branch: 'เทียบสาขาด้วยกันเสมอ สาขาที่ต่างจากเพื่อนมากคือสาขาที่ควรเข้าไปดูก่อน',
  Stock: 'ของเสียและส่วนต่างการนับคือกำไรที่หายไปตรง ๆ เริ่มแก้จากรายการบนสุด',
  'POS COGS': 'เมนูที่ขายดีแต่กำไรต่ำคือจุดที่ปรับราคาแล้วเห็นผลเร็วที่สุด',
  'Branch Audit': 'สาขาที่ซื้อจากครัวกลางน้อยเมื่อเทียบยอดขาย อาจซื้อของจากข้างนอก บันทึกไม่ครบ หรือเป็นสาขาเปิดใหม่ ปิดปรับปรุง เมนูเปลี่ยน หรือมีโปรโมชัน ตรวจเหตุผลเหล่านี้และดูหลายเดือนติดก่อนสรุปว่ามีปัญหา',
};
const EXPLAIN_TIPS = {
  ck_margin_trend: 'ถ้าเส้น GM จ่ายจริงถ่างออกจากเส้นตามสูตรเรื่อย ๆ ให้ไล่ตรวจสาเหตุก่อน: สูตรและราคาในสูตรล้าหลังไหม หน่วยแปลงถูกไหม ผลผลิตหลังตัดแต่ง การนับสต็อกรอบล่าสุด และของเสียที่ไม่ได้บันทึก',
  ck_margin_kpi: 'GM ตามสูตรบอกว่าเมนูออกแบบมาดีแค่ไหน GM จ่ายจริงบอกว่าครัวทำได้จริงแค่ไหน ส่วนต่างคือสิ่งที่ควบคุมได้',
  sq_scorecard: 'นำตารางนี้ไปคุยกับเจ้าที่ % ส่งขาดสูงและมูลค่าที่ขาดสูงก่อน ถ้า % สูงแต่มูลค่าน้อย ทีมครัวเหนื่อยแต่เงินไม่หาย',
  ita_overbilled: 'ยอดที่วางบิลเกินอาจเป็นเงินที่ควรทวงคืน แต่ก่อนทวงให้เช็กว่าของรอบนั้นรับเข้าระบบครบแล้วหรือยัง (GRN อาจยังไม่บันทึก) แล้วค่อยตรวจว่าได้ใบลดหนี้หรือยัง',
  pc_stale_recipe_cost: 'สูตรที่ยังใช้ราคาเก่าทำให้ food cost ในรายงานดูดีกว่าความจริง อัปเดตราคาในสูตรก่อนตัดสินเรื่องราคาขาย',
  pa_trend: 'PO กับ GRN ควรวิ่งใกล้กัน ถ้า Invoice ต่ำกว่า GRN มาก แปลว่าซัพพลายเออร์ยังวางบิลไม่ครบ ยอดค้างจ่ายจะตามมาทีหลัง',
  pa_kpis: 'GRN ต่ำกว่า PO คือของที่สั่งแต่ไม่ได้รับ ส่วน Invoice ต่ำกว่า GRN คือบิลที่ยังไม่มา ทั้งสองควรใกล้ศูนย์เมื่อปิดงานครบ',
  watch_po: 'PO ที่รับของแล้วแต่ยังไม่ปิด ทำให้ยอดซื้อและบัญชีค้าง ควรให้คนสั่งซื้อปิดหรือยกเลิกให้เรียบร้อย',
};

const xNum = (v) => Number(v) || 0;
const xFmt = (v, f) => fmtValue(v, f);
const xPct = (a, b) => (b ? (a / b) * 100 : null);
const xChange = (from, to) => (from ? ((to - from) / Math.abs(from)) * 100 : null);
const xSigned = (p) => `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
const xb = (s) => `<b>${esc(s)}</b>`;

function explainItems(rows, cfg) {
  const groups = groupRows(rows, rowFields(cfg));
  return [...groups]
    .map(([name, rs]) => ({ name: String(name), value: evalMetric(cfg.value, rs) }))
    .filter((i) => Number.isFinite(i.value));
}

function explainRanking(rows, cfg, out) {
  const items = explainItems(rows, cfg);
  if (!items.length) return;
  const f = cfg.format;
  const asc = cfg.sort === 'asc';
  items.sort((a, b) => (asc ? a.value - b.value : Math.abs(b.value) - Math.abs(a.value)));
  const top = items[0];
  const allPositive = items.every((i) => i.value >= 0);
  const total = items.reduce((a, i) => a + i.value, 0);
  const isRate = f === 'pct' || f === 'pct_signed' || f === 'decimal1';
  const signed = f === 'pct_signed' || cfg.sort === 'abs_desc' || items.some((i) => i.value < 0);
  // Only totals have shares: an average or a rate per item doesn't add up.
  const additive = ['sum', 'count', 'count_distinct', 'sum_where', 'count_where'].includes(cfg.value && cfg.value.op);
  out.push(`${asc ? 'ต่ำสุด' : signed ? 'ต่างมากที่สุด' : 'สูงสุด'}คือ ${xb(top.name)} ที่ ${xb(xFmt(top.value, f))}${items.length > 1 ? ` จากทั้งหมด ${items.length} รายการ` : ''}`);
  if (!isRate && additive && allPositive && total > 0 && items.length > 2) {
    const share = xPct(top.value, total);
    const top3 = xPct(items.slice(0, 3).reduce((a, i) => a + i.value, 0), total);
    out.push(`${esc(top.name)} คิดเป็น ${share.toFixed(0)}% ของทั้งหมด และ 3 อันดับแรกรวมกัน ${top3.toFixed(0)}%${top3 >= 60 ? ' — ไม่กี่รายการเป็นส่วนใหญ่ของทั้งหมด' : ''}`);
  }
  if (items.length > 3) {
    const sorted = items.map((i) => i.value).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median > 0 && !asc && !signed && top.value / median >= 2) out.push(`อันดับหนึ่งสูงกว่าค่ากลางของกลุ่ม (${esc(xFmt(median, f))}) ประมาณ ${(top.value / median).toFixed(1)} เท่า`);
  }
  if (cfg.threshold != null) {
    const lowerIsBetter = cfg.lower_is_better !== false;
    const miss = items.filter((i) => (lowerIsBetter ? i.value > cfg.threshold : i.value < cfg.threshold));
    out.push(miss.length ? `${miss.length} รายการ${lowerIsBetter ? 'เกิน' : 'ต่ำกว่า'}เป้า ${esc(xFmt(cfg.threshold, f))}: ${miss.slice(0, 3).map((i) => esc(i.name)).join(', ')}${miss.length > 3 ? ' …' : ''}` : `ทุกรายการอยู่ในเป้า ${esc(xFmt(cfg.threshold, f))}`);
  }
  if (items.some((i) => i.value < 0) && items.some((i) => i.value > 0)) {
    out.push('มีทั้งค่าบวกและค่าลบ: ค่าลบหมายถึงทิศทางตรงข้าม (เช่น ราคาลดลง หรือได้ของมากกว่าที่สั่ง)');
  }
}

function explainLine(rows, cfg, out, range) {
  const bucket = cfg.bucket || 'week';
  const buckets = new Map();
  rows.forEach((r) => {
    const raw = pick(r, cfg.date_fields || []);
    const k = raw ? bucketKey(raw, bucket) : null;
    if (!k) return;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  });
  let keys = [...buckets.keys()].sort();
  // The current week / month is still filling up: comparing it would read as
  // a drop that isn't there. Compare up to the last complete period instead.
  let partial = null;
  if (keys.length > 2 && keys[keys.length - 1] === bucketKey(todayIso(), bucket) && bucket !== 'day') {
    partial = keys[keys.length - 1];
    keys = keys.slice(0, -1);
  }
  // Likewise a first period the date range cuts into (range from Wednesday).
  let cutFirst = null;
  const start = range && range.start;
  if (keys.length > 2 && start && bucket !== 'day' && bucketKey(start, bucket) === keys[0] && start !== keys[0]) {
    cutFirst = keys[0];
    keys = keys.slice(1);
  }
  if (keys.length < 2) {
    out.push('มีข้อมูลช่วงเดียว ยังดูแนวโน้มไม่ได้ ลองเลือกช่วงวันที่ให้ยาวขึ้น');
    return;
  }
  let series = cfg.series || [];
  if (cfg.series_by) {
    const totals = new Map();
    rows.forEach((r) => { const k = String(pick(r, cfg.series_by) ?? 'ไม่ระบุ'); totals.set(k, (totals.get(k) || 0) + evalMetric(cfg.value, [r])); });
    series = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => ({
      label: k,
      value: { op: 'sum_where', field: cfg.value.field, where: { op: 'in', field: cfg.series_by, values: [k] } },
    }));
  }
  const first = keys[0], last = keys[keys.length - 1];
  const unit = { day: 'วัน', week: 'สัปดาห์', month: 'เดือน' }[bucket] || 'ช่วง';
  const fmtOf = (s) => s.format || cfg.format || (/%/.test(s.label || '') ? 'pct' : 'number');
  const lines = series.slice(0, 3).map((s) => {
    const vals = keys.map((k) => evalMetric(s.value, buckets.get(k)));
    const a = vals[0], b = vals[vals.length - 1];
    const f = fmtOf(s);
    const peakAt = vals.indexOf(Math.max(...vals));
    let move;
    if (f === 'pct' || f === 'pct_signed') {
      const d = b - a;
      move = Math.abs(d) < 0.5 ? 'ทรงตัว' : `${d > 0 ? 'เพิ่มขึ้น' : 'ลดลง'} ${Math.abs(d).toFixed(1)} จุด`;
    } else {
      const c = xChange(a, b);
      move = c === null ? 'เริ่มจากศูนย์' : Math.abs(c) < 3 ? 'ทรงตัว' : `${c > 0 ? 'เพิ่มขึ้น' : 'ลดลง'} ${Math.abs(c).toFixed(0)}%`;
    }
    out.push(`${xb(s.label || 'ค่า')}: ${esc(xFmt(a, f))} (${esc(bucketLabel(first, bucket))}) → ${esc(xFmt(b, f))} (${esc(bucketLabel(last, bucket))}) ${move}${vals.length > 2 && peakAt !== vals.length - 1 && peakAt !== 0 ? ` · สูงสุดที่${unit} ${esc(bucketLabel(keys[peakAt], bucket))}` : ''}`);
    return { label: s.label, vals, f };
  });
  if (lines.length === 2 && lines[0].f === lines[1].f) {
    const gap0 = lines[0].vals[0] - lines[1].vals[0];
    const gap1 = lines[0].vals[lines[0].vals.length - 1] - lines[1].vals[lines[1].vals.length - 1];
    const pts = lines[0].f === 'pct' || lines[0].f === 'pct_signed';
    const fmtGap = (g) => (pts ? `${Math.abs(g).toFixed(1)} จุด` : xFmt(Math.abs(g), lines[0].f));
    const widened = Math.abs(gap1) - Math.abs(gap0);
    out.push(`ช่องว่างระหว่าง ${esc(lines[0].label)} กับ ${esc(lines[1].label)}: ${esc(fmtGap(gap0))} → ${esc(fmtGap(gap1))} ${Math.abs(widened) < (pts ? 0.5 : Math.abs(gap0) * 0.05) ? '(พอ ๆ เดิม)' : widened > 0 ? '(กว้างขึ้น)' : '(แคบลง)'}`);
  }
  if (cutFirst) out.push(`${unit}แรก (${esc(bucketLabel(cutFirst, bucket))}) มีข้อมูลไม่เต็ม${unit}ตามช่วงวันที่ที่เลือก จึงเริ่มเทียบจาก${unit}ถัดไป`);
  if (partial) out.push(`${unit}ล่าสุด (${esc(bucketLabel(partial, bucket))}) ยังไม่ครบ จึงเทียบถึง${unit}ก่อนหน้า`);
  if (keys.length <= 2 && bucket === 'month') out.push('มีแค่ 2 เดือน ตัวเลขรายเดือนแกว่งได้มาก ดูสามเดือนขึ้นไปก่อนสรุป');
}

function explainKpi(rows, cfg, out, widget) {
  (cfg.metrics || []).forEach((m) => {
    const v = evalMetric(m.value, rows);
    let note = '';
    // A rule of thumb, not a standard: it only fits the PO / GRN / invoice gaps.
    if (m.format === 'pct_signed' && Math.abs(v) >= 5 && widget && widget.template_key === 'pa_kpis') note = ' — ห่างเกิน 5% (หลักทั่วไป ปรับตามธุรกิจของคุณ) ควรไล่ดูรายการที่ทำให้ต่าง';
    out.push(`${esc(m.label)}: ${xb(xFmt(v, m.format))}${note}`);
  });
}

function explainTable(rows, cfg, out, widget) {
  out.push(`มี ${xb(rows.length.toLocaleString('th-TH'))} รายการในช่วงที่เลือก`);
  const cols = cfg.columns || [];
  if (String(widget.template_key || '').startsWith('watch_')) {
    const high = rows.filter((r) => /สูง|วิกฤต/.test(String(r.severity || ''))).length;
    const impact = rows.reduce((a, r) => a + xNum(r.impact), 0);
    if (high) out.push(`ระดับ “สูง” ${xb(high)} เรื่อง — เริ่มจากกลุ่มนี้`);
    if (impact) out.push(`ผลกระทบรวมประมาณ ${xb(xFmt(impact, 'currency'))}`);
    return;
  }
  const money = cols.filter((c) => c.format === 'currency');
  if (money.length) {
    const c = cfg.sort_by && money.find((m) => m.field === cfg.sort_by.field) ? money.find((m) => m.field === cfg.sort_by.field) : money[0];
    const total = rows.reduce((a, r) => a + xNum(r[c.field]), 0);
    const topRow = rows.slice().sort((a, b) => xNum(b[c.field]) - xNum(a[c.field]))[0];
    const nameCol = cols.find((x) => !x.format) || cols[0];
    out.push(`${esc(c.label || c.field)} รวม ${xb(xFmt(total, 'currency'))}`);
    if (topRow && nameCol) out.push(`สูงสุดคือ ${xb(String(topRow[nameCol.field] ?? '-'))} ที่ ${xb(xFmt(topRow[c.field], 'currency'))}${total ? ` (${(xPct(xNum(topRow[c.field]), total) || 0).toFixed(0)}% ของทั้งหมด)` : ''}`);
  }
}

function explainHeatmap(rows, cfg, out) {
  const rowKey = (r) => String(pick(r, cfg.row_field) ?? 'ไม่ระบุ');
  const colKey = cfg.col_date ? (r) => { const raw = pick(r, cfg.col_date); return raw ? bucketKey(raw, cfg.bucket || 'day') : null; } : (r) => String(pick(r, cfg.col_field) ?? 'ไม่ระบุ');
  const cells = new Map();
  const byRow = new Map();
  rows.forEach((r) => {
    const rk = rowKey(r), ck = colKey(r);
    if (ck === null) return;
    const k = rk + '\u0001' + ck;
    (cells.get(k) || cells.set(k, []).get(k)).push(r);
    (byRow.get(rk) || byRow.set(rk, []).get(rk)).push(r);
  });
  let best = null;
  cells.forEach((rs, k) => { const v = evalMetric(cfg.value, rs); if (!best || v > best.v) best = { k, v }; });
  if (best) {
    const [rk, ck] = best.k.split('\u0001');
    const colLabel = cfg.col_date ? bucketLabel(ck, cfg.bucket || 'day') : ck;
    out.push(`ช่องที่เข้มที่สุดคือ ${xb(rk)} × ${xb(colLabel)} ที่ ${xb(xFmt(best.v, cfg.format))}`);
  }
  const rowTotals = [...byRow].map(([k, rs]) => [k, evalMetric(cfg.row_rank || cfg.value, rs)]).sort((a, b) => b[1] - a[1]);
  if (rowTotals.length > 1) out.push(`แถวที่รวมสูงสุดคือ ${xb(rowTotals[0][0])} จาก ${rowTotals.length} แถว`);
}

function explainPareto(rows, cfg, out) {
  const items = explainItems(rows, cfg).filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  if (!items.length) return;
  const total = items.reduce((a, i) => a + i.value, 0);
  let run = 0, n80 = 0;
  for (const i of items) { run += i.value; n80++; if (run / total >= 0.8) break; }
  out.push(`${xb(n80)} จาก ${items.length} รายการสร้าง 80% ของทั้งหมด${n80 / items.length <= 0.3 ? ' — ไม่กี่รายการแบกทั้งกลุ่ม ดูแลกลุ่มนี้ให้ดีก่อน' : ''}`);
  out.push(`อันดับหนึ่งคือ ${xb(items[0].name)} ที่ ${xb(xFmt(items[0].value, cfg.format))}`);
}

function explainWidget(widget, data) {
  const cfg = (data && data.cfg) || widget.config || {};
  const q = (typeof LIB_QUESTIONS !== 'undefined' && LIB_QUESTIONS[widget.template_key]) || '';
  const out = [];
  if (data && data.rows && data.rows.length) {
    const t = widget.chart_type;
    try {
      if (t === 'kpi') explainKpi(data.rows, cfg, out, widget);
      else if (t === 'line') explainLine(data.rows, cfg, out, data.range);
      else if (t === 'table') explainTable(data.rows, cfg, out, widget);
      else if (t === 'heatmap') explainHeatmap(data.rows, cfg, out);
      else if (t === 'pareto') explainPareto(data.rows, cfg, out);
      else if (cfg.value) explainRanking(data.rows, cfg, out);
    } catch (err) {
      console.error('explain failed', widget, err);
    }
    if (!out.length) out.push(`มี ${data.rows.length.toLocaleString('th-TH')} รายการในช่วงที่เลือก`);
  } else if (data && data.panels) {
    out.push('widget นี้รวมหลายกราฟในใบเดียว อ่านทีละช่องตามหัวข้อของแต่ละกราฟ');
  } else {
    out.push(esc((data && data.empty) || 'ยังไม่มีข้อมูลในช่วงที่เลือก'));
  }
  const tip = EXPLAIN_TIPS[widget.template_key] || EXPLAIN_CATEGORY_TIP[widget.category] || '';
  return `
    ${q ? `<p class="explain-q">${esc(q)}</p>` : ''}
    ${widget.description ? `<p class="explain-why">${esc(widget.description)}</p>` : ''}
    <ul class="explain-list">${out.map((s) => `<li>${s}</li>`).join('')}</ul>
    ${tip ? `<p class="explain-tip"><b>ควรทำอะไรต่อ:</b> ${esc(tip)}</p>` : ''}
    <p class="explain-foot">สรุปจากตัวเลขบนหน้าจอ ตามช่วงวันที่และตัวกรองที่เลือกอยู่</p>`;
}
