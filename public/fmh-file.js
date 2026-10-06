// Reads a report exported from FMH (Excel .xlsx or CSV) and turns it into rows
// shaped exactly like the FMH API returns them, so every widget reads an
// uploaded month the same way it reads a synced one.
//
// Why: the FMH API only serves the last ~90 days. A user who wants six months
// or a full year downloads the older months from FMH themselves (one month per
// file is fine) and uploads them; the dashboard then shows API data for recent
// days and file data before that.
//
// Shared by the browser (window.FmhFile) and Node tests (require). No
// dependencies: .xlsx is a zip of XML, read with DecompressionStream.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FmhFile = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // ---------- report layouts ----------
  // Header text (case, spaces and punctuation ignored) -> API field name.
  // Checked against a real Sales Analysis export (Oct 2026). The purchase side
  // follows the same export layout with PO/Supplier in place of SO/Customer.
  const COMMON = {
    product: 'product_name', productname: 'product_name',
    productcode: 'product_code', code: 'product_code', sku: 'product_code',
    productcategory: 'category_name', category: 'category_name', categoryname: 'category_name',
    producttags: 'product_tags', ordertags: 'order_tags', orderremarks: 'order_remarks', remarks: 'order_remarks',
    issueddate: 'issued_date', orderdate: 'order_date', requesteddeliverydate: 'requested_delivery_date', deliverydate: 'requested_delivery_date',
    grndate: 'grn_date', dodate: 'do_date', completeddate: 'completed_date', invoicedate: 'invoice_date',
    supplierinvoicedate: 'supplier_invoice_date', supplierinvoicenumber: 'supplier_invoice_number',
    branchname: 'branch', branch: 'branch', outlet: 'branch', outletname: 'branch',
    department: 'department', departmentname: 'department',
    status: 'order_status', orderstatus: 'order_status',
    qty: 'qty', quantity: 'qty', uom: 'uom', unit: 'uom',
    donumber: 'do_number', doquantity: 'do_quantity', dototalvalue: 'do_total', dototal: 'do_total', doavgunitprice: 'do_price', doprice: 'do_price',
    grnnumber: 'grn_number', grnquantity: 'grn_quantity', grntotalvalue: 'grn_total', grntotal: 'grn_total', grnavgunitprice: 'grn_price', grnprice: 'grn_price',
    invoicenumber: 'invoice_number', invoicequantity: 'invoice_quantity', invoicetotalvalue: 'invoice_total', invoicetotal: 'invoice_total',
    invoiceavgunitprice: 'invoice_price', invoiceprice: 'invoice_price',
    fulfillmentvariance: 'fulfillment_variance', fulfilmentvariance: 'fulfillment_variance',
    totalavgunitprice: 'price', unitprice: 'price', price: 'price',
    discountamount: 'discount', discount: 'discount', taxrate: 'tax_rate', taxamount: 'tax', tax: 'tax',
    totalvalue: 'total', total: 'total', totalvalueexclusivetax: 'total_excl_tax',
  };
  const NUMBERS = new Set([
    'qty', 'price', 'discount', 'tax', 'total', 'total_excl_tax', 'fulfillment_variance',
    'so_qty', 'so_price', 'so_tax', 'so_total', 'po_qty', 'po_price', 'po_tax', 'po_total',
    'do_quantity', 'do_price', 'do_tax', 'do_total', 'grn_quantity', 'grn_price', 'grn_tax', 'grn_total',
    'invoice_quantity', 'invoice_price', 'invoice_tax', 'invoice_total',
  ]);
  const DATES = new Set(['issued_date', 'order_date', 'requested_delivery_date', 'grn_date', 'do_date', 'completed_date', 'invoice_date', 'supplier_invoice_date']);
  // Present (possibly empty) on every API row, so page filters treat file rows
  // the same as synced ones.
  const ALWAYS = ['branch', 'department', 'category_name', 'product_tags', 'order_tags'];

  const PROFILES = {
    'sales-analysis': {
      source: 'sales-analysis',
      name: 'Sales Analysis (ยอดขายครัวกลาง)',
      fmhMenu: 'Reports → Sales Analysis → Export',
      docField: 'so_number',
      dateField: 'order_date',
      partyField: 'customer',
      headers: {
        ...COMMON,
        customers: 'customer', customer: 'customer', customername: 'customer',
        sonumber: 'so_number', salesordernumber: 'so_number',
        soquantity: 'so_qty', soqty: 'so_qty', sototalvalue: 'so_total', sototal: 'so_total', soavgunitprice: 'so_price', soprice: 'so_price',
      },
      required: ['so_number', 'order_date', 'product_code', 'customer', 'total'],
    },
    'purchase-analysis': {
      source: 'purchase-analysis',
      name: 'Purchase Analysis (ยอดซื้อ)',
      fmhMenu: 'Reports → Purchase Analysis → Export',
      docField: 'po_number',
      dateField: 'order_date',
      partyField: 'supplier',
      headers: {
        ...COMMON,
        suppliers: 'supplier', supplier: 'supplier', suppliername: 'supplier',
        ponumber: 'po_number', purchaseordernumber: 'po_number',
        poquantity: 'po_qty', poqty: 'po_qty', pototalvalue: 'po_total', pototal: 'po_total', poavgunitprice: 'po_price', poprice: 'po_price',
      },
      required: ['po_number', 'order_date', 'product_code', 'supplier', 'total'],
    },
  };

  const FIELD_LABEL = {
    so_number: 'SO Number', po_number: 'PO Number', order_date: 'Order Date', product_code: 'Product Code',
    customer: 'Customers', supplier: 'Supplier', total: 'Total Value',
  };

  const norm = (h) => String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, '');

  function mapHeader(header, profile) {
    const cols = {};
    const unknown = [];
    header.forEach((h, i) => {
      const f = profile.headers[norm(h)];
      if (f && !(f in cols)) cols[f] = i;
      else if (String(h || '').trim() && !f) unknown.push(String(h).trim());
    });
    return { cols, unknown, missing: profile.required.filter((f) => !(f in cols)) };
  }

  // The profile whose required columns the header has, or null.
  function detect(header, wanted = null) {
    const list = wanted ? [PROFILES[wanted]].filter(Boolean) : Object.values(PROFILES);
    let best = null;
    list.forEach((p) => {
      const m = mapHeader(header, p);
      const score = p.required.length - m.missing.length;
      if (!best || score > best.score) best = { profile: p, score, ...m };
    });
    return best;
  }

  // ---------- values ----------
  function toNum(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v;
    let s = String(v).trim().replace(/[,฿\s]/g, '');
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    const n = Number(s);
    return Number.isFinite(n) ? (neg ? -n : n) : 0;
  }

  const pad = (n) => String(n).padStart(2, '0');
  function serialToIso(n) {
    const d = new Date(Math.round((Number(n) - 25569) * 86400000));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  // 'dmy' unless the values prove otherwise (a first part above 12 can only be a day).
  function guessDateOrder(values) {
    let dayFirst = 0, monthFirst = 0;
    values.forEach((v) => {
      const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(String(v || '').trim());
      if (!m) return;
      if (Number(m[1]) > 12) dayFirst++;
      if (Number(m[2]) > 12) monthFirst++;
    });
    return monthFirst > dayFirst ? 'mdy' : 'dmy';
  }
  function toIsoDate(v, order = 'dmy') {
    if (v == null || v === '') return '';
    if (typeof v === 'number' || /^\d{4,5}(\.\d+)?$/.test(String(v).trim())) {
      const n = Number(v);
      return n > 20000 && n < 80000 ? serialToIso(n) : '';
    }
    const s = String(v).trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    let y, mo, d;
    if (m) [y, mo, d] = [m[1], m[2], m[3]].map(Number);
    else {
      m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(s);
      if (!m) return '';
      const a = Number(m[1]), b = Number(m[2]);
      y = Number(m[3]);
      [d, mo] = order === 'mdy' ? [b, a] : [a, b];
      if (y < 100) y += 2000;
    }
    if (y > 2400) y -= 543; // Buddhist era
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    return `${y}-${pad(mo)}-${pad(d)}`;
  }

  // ---------- table -> API-shaped rows ----------
  // table: array of row arrays, header somewhere in the first rows.
  function toRows(table, { source = null } = {}) {
    let headerAt = -1;
    let found = null;
    for (let i = 0; i < Math.min(table.length, 15); i++) {
      const d = detect(table[i] || [], source);
      if (d && (!found || d.score > found.score)) { found = d; headerAt = i; }
      if (d && !d.missing.length) break;
    }
    if (!found || found.score < 2) {
      return { error: 'ไม่พบหัวคอลัมน์ของรายงาน FMH ในไฟล์นี้ — ใช้ไฟล์ที่กด Export จากหน้ารายงานของ FMH โดยตรง (อย่าแก้หัวคอลัมน์)' };
    }
    const { profile, cols, missing, unknown } = found;
    if (missing.length) {
      return {
        error: `ไฟล์นี้ดูเหมือน ${profile.name} แต่ขาดคอลัมน์ ${missing.map((f) => FIELD_LABEL[f] || f).join(', ')}`,
        profile: profile.source,
        missing,
      };
    }
    const body = table.slice(headerAt + 1);
    const dateCols = Object.entries(cols).filter(([f]) => DATES.has(f)).map(([, i]) => i);
    const order = guessDateOrder(body.slice(0, 2000).flatMap((r) => dateCols.map((i) => r[i])));

    const rows = [];
    let skipped = 0;
    const docs = new Set();
    let from = null, to = null, total = 0;
    body.forEach((r) => {
      if (!r || !r.length) return;
      const doc = String(r[cols[profile.docField]] ?? '').trim();
      const date = toIsoDate(r[cols[profile.dateField]], order);
      // Footer "Total" lines and blank rows carry no document number or date.
      if (!doc || !date) { if (r.some((v) => v !== null && v !== '')) skipped++; return; }
      const row = {};
      ALWAYS.forEach((f) => (row[f] = ''));
      Object.entries(cols).forEach(([f, i]) => {
        const v = r[i];
        if (NUMBERS.has(f)) row[f] = toNum(v);
        else if (DATES.has(f)) row[f] = toIsoDate(v, order);
        else row[f] = v == null ? '' : String(v).trim();
      });
      rows.push(row);
      docs.add(doc);
      total += row.total;
      if (!from || date < from) from = date;
      if (!to || date > to) to = date;
    });
    if (!rows.length) return { error: 'ไม่พบรายการในไฟล์ (มีแต่หัวคอลัมน์)', profile: profile.source };
    return {
      profile: profile.source,
      name: profile.name,
      docField: profile.docField,
      dateField: profile.dateField,
      dateOrder: order,
      rows,
      unknown,
      stats: { rows: rows.length, docs: docs.size, from, to, total: Math.round(total * 100) / 100, skipped, has_status: 'order_status' in cols },
    };
  }

  // ---------- xlsx ----------
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('เบราว์เซอร์นี้อ่านไฟล์ Excel ไม่ได้ — ใช้ Chrome, Edge หรือ Safari รุ่นใหม่ หรือ export เป็น CSV');
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(buf, wanted) {
    const b = new Uint8Array(buf);
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 66000); i--) {
      if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ไฟล์นี้ไม่ใช่ Excel (.xlsx)');
    const count = u16(b, eocd + 10);
    let p = u32(b, eocd + 16);
    const out = {};
    const dec = new TextDecoder('utf-8');
    for (let n = 0; n < count; n++) {
      if (u32(b, p) !== 0x02014b50) break;
      const method = u16(b, p + 10);
      const csize = u32(b, p + 20);
      const nameLen = u16(b, p + 28), extraLen = u16(b, p + 30), commentLen = u16(b, p + 32);
      const local = u32(b, p + 42);
      const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (!wanted(name)) continue;
      const start = local + 30 + u16(b, local + 26) + u16(b, local + 28);
      const raw = b.subarray(start, start + csize);
      const data = method === 0 ? raw : method === 8 ? await inflateRaw(raw) : null;
      if (data) out[name] = dec.decode(data);
    }
    return out;
  }

  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const unescapeXml = (s) =>
    s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) =>
      e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()]
    );
  const textOf = (xml) => {
    let s = '';
    const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let m;
    while ((m = re.exec(xml))) s += m[1];
    return unescapeXml(s);
  };
  const colIndex = (ref) => {
    let n = 0;
    for (const ch of ref) {
      const c = ch.charCodeAt(0);
      if (c < 65 || c > 90) break;
      n = n * 26 + (c - 64);
    }
    return n - 1;
  };

  async function readXlsx(buf) {
    const files = await unzip(buf, (n) => /^xl\/(sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)$/.test(n));
    const shared = [];
    if (files['xl/sharedStrings.xml']) {
      const re = /<si>([\s\S]*?)<\/si>/g;
      let m;
      while ((m = re.exec(files['xl/sharedStrings.xml']))) shared.push(textOf(m[1]));
    }
    // First sheet in workbook order, via its relationship id.
    let sheetPath = null;
    const wb = files['xl/workbook.xml'] || '';
    const rels = files['xl/_rels/workbook.xml.rels'] || '';
    const first = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb);
    if (first) {
      const rel = new RegExp(`<Relationship\\b[^>]*Id="${first[1]}"[^>]*Target="([^"]+)"`).exec(rels) ||
        new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${first[1]}"`).exec(rels);
      if (rel) sheetPath = 'xl/' + rel[1].replace(/^\/?xl\//, '').replace(/^\//, '');
    }
    if (!sheetPath || !files[sheetPath]) sheetPath = Object.keys(files).filter((n) => n.startsWith('xl/worksheets/')).sort()[0];
    const xml = files[sheetPath];
    if (!xml) throw new Error('ไม่พบชีตข้อมูลในไฟล์ Excel');

    const table = [];
    const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let rm;
    while ((rm = rowRe.exec(xml))) {
      const rAttr = /\br="(\d+)"/.exec(rm[1]);
      const rowIdx = rAttr ? Number(rAttr[1]) - 1 : table.length;
      const row = [];
      let cm;
      let auto = 0;
      cellRe.lastIndex = 0;
      while ((cm = cellRe.exec(rm[2]))) {
        const attrs = cm[1];
        const ref = /\br="([A-Z]+)\d+"/.exec(attrs);
        const ci = ref ? colIndex(ref[1]) : auto;
        auto = ci + 1;
        const t = (/\bt="([^"]+)"/.exec(attrs) || [])[1] || 'n';
        const inner = cm[2] || '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        let val = null;
        if (t === 's') val = v ? shared[Number(v[1])] ?? '' : '';
        else if (t === 'inlineStr') val = textOf(inner);
        else if (t === 'str' || t === 'e') val = v ? unescapeXml(v[1]) : '';
        else if (t === 'b') val = v ? v[1] === '1' : null;
        else val = v ? Number(v[1]) : null;
        row[ci] = val;
      }
      table[rowIdx] = row;
    }
    for (let i = 0; i < table.length; i++) if (!table[i]) table[i] = [];
    return table;
  }

  // ---------- csv ----------
  function readCsv(text) {
    text = text.replace(/^﻿/, '');
    const firstLine = text.slice(0, text.indexOf('\n') > 0 ? text.indexOf('\n') : text.length);
    const delim = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const out = [];
    let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); out.push(row); row = []; cur = '';
      } else cur += ch;
    }
    if (cur || row.length) { row.push(cur); out.push(row); }
    return out;
  }
  function decodeText(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { return new TextDecoder('windows-874').decode(buf); }
  }

  // ArrayBuffer + file name -> the result of toRows().
  async function read(buf, filename = '', opts = {}) {
    const b = new Uint8Array(buf);
    const isZip = b[0] === 0x50 && b[1] === 0x4b;
    if (!isZip && /\.xls$/i.test(filename)) {
      return { error: 'ไฟล์ .xls รุ่นเก่ายังไม่รองรับ — เปิดใน Excel แล้ว Save As เป็น .xlsx หรือ CSV' };
    }
    const table = isZip ? await readXlsx(buf) : readCsv(decodeText(buf));
    return toRows(table, opts);
  }

  return { PROFILES, NUMBERS, DATES, detect, mapHeader, toRows, toIsoDate, guessDateOrder, toNum, readXlsx, readCsv, read };
});
