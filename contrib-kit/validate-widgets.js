#!/usr/bin/env node
// Checks a widget hand-over folder before it is sent to KSS.
//   node validate-widgets.js <folder>
// Needs Node 18+ and nothing else (fmh-file.js beside this script reads the
// sample exports). Exit code 0 = no errors (warnings may remain).
//
// The folder (see widget-contributor-brief.md, section 6):
//   templates.json  profiles.json  rows/<source>.json  computed/  samples/  README.md
const fs = require('fs');
const path = require('path');
const FmhFile = require('./fmh-file');

// ---- what the KSS Dashboard supports today (keep in step with the brief) ----
const CHART_TYPES = ['kpi', 'bar', 'line', 'table', 'sensitivity', 'menu_breakdown', 'donut', 'pareto', 'scatter', 'treemap', 'range', 'stack', 'panels', 'tabs_bar', 'heatmap'];
const CONFIG_KEYS = ['bar_label', 'bucket', 'bucket_toggle', 'caption', 'col_date', 'col_field', 'col_sort', 'col_totals', 'color', 'color_mode', 'columns', 'date_fields', 'default_pct', 'default_tab', 'derived', 'diverge_rel', 'empty_message', 'foot', 'format', 'group_by', 'group_by_field', 'label_extra', 'last', 'lower_is_better', 'mark', 'marker_label', 'max', 'metrics', 'min', 'page_filter', 'palette', 'panels', 'pivot', 'quadrant_labels', 'qx', 'qy', 'rank_by', 'row_field', 'row_filter', 'row_label', 'row_norm', 'row_rank', 'rows', 'scale', 'segments', 'series', 'series_by', 'size', 'sort', 'sort_by', 'sources', 'stacked', 'tabs', 'threshold', 'top_n', 'top_rows', 'value', 'x', 'x_format', 'x_label', 'x_share', 'y', 'y_format', 'y_label'];
const METRIC_OPS = ['sum', 'count', 'count_distinct', 'avg', 'min', 'max', 'div', 'ratio_pct', 'pct_change', 'diff', 'sum_where', 'count_where', 'count_distinct_where', 'floor0'];
const EXPR_OPS = ['add', 'sub', 'mul', 'div', 'pct_of', 'abs', 'max0', 'wilson_lb', 'party_short', 'clean_name', 'join', 'weekday'];
const PREDICATES = ['and', 'or', 'not', 'blank', 'present', 'in', 'differs', 'gt', 'gte', 'lt', 'lte', 'matches', 'within_days'];
const FORMATS = ['currency', 'number', 'pct', 'pct_signed', 'days', 'decimal1'];
const KNOWN_SOURCES = ['purchase-analysis', 'sales-analysis', 'menu-costing', 'cogs', 'cogs-trend', 'cogs-stat', 'cogs-low-margin', 'sales-by-branch', 'menu-usage-top', 'price-variance-top', 'price-comparison', 'price-avg-trend', 'po-status', 'stock-by-category', 'stock-flow', 'wastage-trend', 'wastage-top-products', 'wastage-top-branches', 'wastage-lines', 'branch-order-top', 'picking-trend', 'picking', 'avt-stat', 'product-variance', 'avt-theoretical-stat', 'avt-actual-stat', 'credit-unutilized-stat', 'credit-notes', 'stock-count', 'production', 'batch', 'pos-sales', 'ck-audit', 'ck-audit-recipe', 'ck-audit-upt'];
const PAGE_FILTERS = ['branch', 'supplier', 'customer'];

let errors = 0, warnings = 0;
const err = (where, msg) => { errors++; console.log(`  ✗ ${where}: ${msg}`); };
const warn = (where, msg) => { warnings++; console.log(`  ! ${where}: ${msg}`); };
const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { err(path.basename(p), `JSON อ่านไม่ได้ — ${e.message}`); return null; }
};
const hasThai = (s) => /[฀-๿]/.test(String(s || ''));

(async () => {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(dir)) { console.log('ใช้: node validate-widgets.js <โฟลเดอร์ส่งมอบ>'); process.exit(2); }
  const P = (...a) => path.join(dir, ...a);

  // ---------- rows ----------
  console.log('\n[rows/]');
  const fieldsOf = {}; // source -> Set
  if (fs.existsSync(P('rows'))) {
    fs.readdirSync(P('rows')).filter((f) => f.endsWith('.json')).forEach((f) => {
      const src = f.replace(/\.json$/, '');
      const rows = readJson(P('rows', f));
      if (!rows) return;
      if (!Array.isArray(rows) || !rows.length) return err(f, 'ต้องเป็น array ของแถว อย่างน้อย 1 แถว');
      if (rows.length < 10) warn(f, `มีแค่ ${rows.length} แถว — แนะนำ 10–30`);
      const keys = new Set();
      rows.forEach((r) => Object.keys(r || {}).forEach((k) => keys.add(k)));
      [...keys].filter((k) => !/^[a-z][a-z0-9_]*$/.test(k)).forEach((k) => err(f, `ชื่อ field "${k}" ต้องเป็น snake_case ตัวเล็ก`));
      fieldsOf[src] = keys;
      if (!KNOWN_SOURCES.includes(src)) warn(f, `"${src}" ยังไม่ใช่ report source ในระบบ — ต้องมี computed/ หรือ profile ที่สร้างแหล่งนี้`);
      console.log(`  ✓ ${src}: ${rows.length} แถว, ${keys.size} fields`);
    });
  } else warn('rows/', 'ไม่มีโฟลเดอร์ — ตรวจชื่อ field ใน template ไม่ได้');

  // ---------- templates ----------
  console.log('\n[templates.json]');
  const templates = fs.existsSync(P('templates.json')) ? readJson(P('templates.json')) : (err('templates.json', 'ไม่มีไฟล์'), null);
  if (templates && !Array.isArray(templates)) err('templates.json', 'ต้องเป็น array');
  const seen = new Set();
  (Array.isArray(templates) ? templates : []).forEach((t, i) => {
    const id = t && t.template_key ? t.template_key : `#${i}`;
    if (!t || typeof t !== 'object') return err(id, 'ไม่ใช่ object');
    ['template_key', 'name', 'description', 'category', 'report_source', 'chart_type', 'config'].forEach((k) => { if (t[k] === undefined || t[k] === '') err(id, `ขาด ${k}`); });
    if (t.template_key && !/^[a-z][a-z0-9_]{2,60}$/.test(t.template_key)) err(id, 'template_key ต้องเป็น snake_case');
    if (seen.has(t.template_key)) err(id, 'template_key ซ้ำ');
    seen.add(t.template_key);
    if (t.chart_type && !CHART_TYPES.includes(t.chart_type)) err(id, `chart_type "${t.chart_type}" ไม่มีในระบบ`);
    if (!hasThai(t.name)) warn(id, 'name ควรเป็นภาษาไทย');
    if (!hasThai(t.description)) warn(id, 'description ควรเป็นภาษาไทย');
    const c = t.config || {};
    Object.keys(c).filter((k) => !CONFIG_KEYS.includes(k)).forEach((k) => err(id, `config "${k}" ไม่มีในระบบ — อธิบายเป็นคำพูดใน README แทน`));
    if (c.format && !FORMATS.includes(c.format)) err(id, `format "${c.format}" ไม่มี`);
    if (c.page_filter) [].concat(c.page_filter).filter((f) => !PAGE_FILTERS.includes(f)).forEach((f) => err(id, `page_filter "${f}" ไม่รองรับ`));
    if (!c.empty_message) warn(id, 'ไม่มี empty_message (ข้อความเมื่อไม่มีข้อมูล)');

    // Fields this widget can see: the source's rows + derived + pivot output.
    const srcs = (c.sources || []).map((s) => s.source).concat(t.report_source || []);
    const avail = new Set();
    srcs.forEach((s) => (fieldsOf[s] || []).forEach((f) => avail.add(f)));
    (c.derived || []).forEach((d) => d && d.field && avail.add(d.field));
    if (c.pivot) {
      avail.add(c.pivot.key_field || 'key');
      (c.pivot.columns || []).forEach((col) => col.field && avail.add(col.field));
    }
    const known = srcs.some((s) => fieldsOf[s]);
    const need = (f, what) => {
      if (!f || typeof f !== 'string' || !known) return;
      if (!avail.has(f)) err(id, `${what} อ้าง field "${f}" ที่ไม่มีใน rows/${t.report_source}.json`);
    };

    const walk = (node, where) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach((n) => walk(n, where));
      if (node.op) {
        const ok = METRIC_OPS.includes(node.op) || EXPR_OPS.includes(node.op) || PREDICATES.includes(node.op);
        if (!ok) err(id, `${where}: op "${node.op}" ไม่มีในระบบ`);
      }
      ['field', 'from'].forEach((k) => typeof node[k] === 'string' && need(node[k], where));
      Object.entries(node).forEach(([k, v]) => { if (v && typeof v === 'object' && k !== 'values') walk(v, where); });
    };
    walk(c.value, 'value');
    walk(c.metrics, 'metrics');
    walk(c.series, 'series');
    walk(c.row_filter, 'row_filter');
    walk(c.row_rank, 'row_rank');
    (c.derived || []).forEach((d) => walk(d.expr, `derived.${d.field}`));
    [].concat(c.group_by || []).forEach((f) => need(f, 'group_by'));
    [].concat(c.date_fields || []).forEach((f) => need(f, 'date_fields'));
    ['series_by', 'row_field', 'col_field', 'col_date'].forEach((k) => need(c[k], k));
    (c.columns || []).forEach((col) => need(col && col.field, 'columns'));
    if (c.sort_by) need(c.sort_by.field, 'sort_by');
    if (c.page_filter) [].concat(c.page_filter).forEach((f) => { if (known && !avail.has(f)) warn(id, `page_filter "${f}" แต่แถวไม่มี field นี้ — widget จะไม่ถูกกรอง`); });
    if (t.chart_type === 'kpi' && !Array.isArray(c.metrics)) err(id, 'kpi ต้องมี metrics');
    if (t.chart_type === 'table' && !Array.isArray(c.columns)) err(id, 'table ต้องมี columns');
    if (t.chart_type === 'heatmap' && !(c.row_field && (c.col_field || c.col_date) && c.value)) err(id, 'heatmap ต้องมี row_field, col_field/col_date และ value');
    if (t.chart_type === 'line' && !(c.date_fields && (c.series || c.value))) err(id, 'line ต้องมี date_fields และ series หรือ value');
  });
  if (Array.isArray(templates)) console.log(`  ${templates.length} templates`);

  // ---------- profiles ----------
  console.log('\n[profiles.json]');
  let profiles = [];
  if (fs.existsSync(P('profiles.json'))) {
    const p = readJson(P('profiles.json'));
    profiles = Array.isArray(p) ? p : p ? Object.values(p) : [];
    profiles.forEach((pr, i) => {
      const id = pr.source || `#${i}`;
      ['source', 'name', 'docField', 'dateField', 'headers', 'required'].forEach((k) => { if (!pr[k]) err(id, `ขาด ${k}`); });
      const fields = new Set(Object.values(pr.headers || {}));
      (pr.required || []).forEach((f) => { if (!fields.has(f)) err(id, `required "${f}" ไม่มีใน headers`); });
      [pr.docField, pr.dateField].forEach((f) => f && !fields.has(f) && err(id, `"${f}" ไม่มีใน headers`));
      Object.keys(pr.headers || {}).filter((h) => h !== h.toLowerCase().replace(/[^a-z0-9]/g, '')).forEach((h) => err(id, `คีย์ header "${h}" ต้องเป็นตัวเล็กไม่มีช่องว่าง/สัญลักษณ์ (เช่น "sonumber")`));
    });
    console.log(`  ${profiles.length} profiles`);
  } else warn('profiles.json', 'ไม่มีไฟล์ — ถ้าไม่มีรายงานใหม่จากไฟล์ ข้ามได้');

  // ---------- samples ----------
  console.log('\n[samples/]');
  if (fs.existsSync(P('samples')) && profiles.length) {
    const norm = (h) => String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const f of fs.readdirSync(P('samples')).filter((x) => /\.(xlsx|csv)$/i.test(x))) {
      try {
        const buf = fs.readFileSync(P('samples', f));
        const table = buf[0] === 0x50 && buf[1] === 0x4b ? await FmhFile.readXlsx(buf) : FmhFile.readCsv(buf.toString('utf8'));
        let best = null;
        for (const pr of profiles) {
          for (let i = 0; i < Math.min(15, table.length); i++) {
            const hdr = (table[i] || []).map(norm);
            const cols = {};
            hdr.forEach((h, j) => { const fld = (pr.headers || {})[h]; if (fld && !(fld in cols)) cols[fld] = j; });
            const missing = (pr.required || []).filter((r) => !(r in cols));
            if (!best || missing.length < best.missing.length) best = { pr, i, cols, missing };
          }
        }
        if (!best || best.missing.length) { err(f, `ไม่มี profile ที่อ่านได้ — ขาด ${best ? best.missing.join(', ') : 'ทุกคอลัมน์'}`); continue; }
        const body = table.slice(best.i + 1).filter((r) => r && r.length);
        const order = FmhFile.guessDateOrder(body.slice(0, 500).map((r) => r[best.cols[best.pr.dateField]]));
        const dated = body.filter((r) => FmhFile.toIsoDate(r[best.cols[best.pr.dateField]], order));
        const unmapped = (table[best.i] || []).filter((h) => h && !(best.pr.headers || {})[norm(h)]);
        console.log(`  ✓ ${f} → ${best.pr.source}: ${dated.length}/${body.length} แถวมีวันที่ (${order})`);
        if (dated.length < body.length * 0.9) warn(f, `อ่านวันที่ได้แค่ ${dated.length} จาก ${body.length} แถว`);
        if (unmapped.length) warn(f, `คอลัมน์ที่ไม่ได้จับคู่: ${unmapped.join(', ')}`);
      } catch (e) {
        err(f, `อ่านไฟล์ไม่ได้ — ${e.message}`);
      }
    }
  } else warn('samples/', 'ไม่มีไฟล์ตัวอย่างหรือไม่มี profiles');

  // ---------- computed ----------
  if (fs.existsSync(P('computed'))) {
    console.log('\n[computed/]');
    fs.readdirSync(P('computed')).filter((f) => f.endsWith('.js')).forEach((f) => {
      const src = fs.readFileSync(P('computed', f), 'utf8');
      if (/\brequire\s*\(|\bimport\s/.test(src)) err(f, 'ห้าม require/import — ต้องเป็นฟังก์ชันล้วน');
      if (/fetch\s*\(|XMLHttpRequest|process\.env/.test(src)) err(f, 'ห้ามเรียกเครือข่ายหรืออ่าน env');
      if (!fs.existsSync(P('computed', f.replace(/\.js$/, '.md')))) warn(f, 'ไม่มีไฟล์ .md อธิบายพร้อมตัวอย่าง input → output');
      console.log(`  ${f} ตรวจแล้ว`);
    });
  }

  // ---------- privacy ----------
  console.log('\n[ข้อมูลส่วนบุคคล]');
  const scan = (p) => {
    if (!fs.existsSync(p)) return;
    fs.readdirSync(p).filter((f) => f.endsWith('.json')).forEach((f) => {
      const s = fs.readFileSync(path.join(p, f), 'utf8');
      if (/0[689]\d[- ]?\d{3}[- ]?\d{4}/.test(s)) warn(f, 'พบตัวเลขคล้ายเบอร์โทรศัพท์ — ตรวจว่าไม่ใช่ข้อมูลลูกค้า');
      if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(s)) warn(f, 'พบอีเมล — ตรวจว่าไม่ใช่ข้อมูลลูกค้า');
    });
  };
  scan(P('rows'));
  scan(dir);
  if (!fs.existsSync(P('README.md'))) warn('README.md', 'ไม่มีไฟล์ — อธิบายว่าแต่ละ widget ตอบคำถามอะไร');

  console.log(`\n${errors ? '✗' : '✓'} ${errors} errors, ${warnings} warnings`);
  process.exit(errors ? 1 : 0);
})();
