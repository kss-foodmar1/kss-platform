// Reads a POS sales export (Foodstory "Sale by bill detail" and similar CSVs)
// into daily per-menu totals.
//
// Shared by the browser and the server: the browser parses the file and sends
// only the totals, so customer names and phone numbers in the export never
// leave the user's computer, and a month of bills becomes a few thousand rows
// instead of a 50 MB upload. The server runs the same normalisation again on
// what it receives (scripts/test-pos.js checks both against the sample file).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PosParse = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // RFC 4180: quoted fields may hold commas, quotes ("") and line breaks
  // (Foodstory's "หมายเหตุ" column does).
  function parseCsv(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = [];
    let row = [];
    let field = '';
    let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
        } else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
  }

  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const lower = (s) => clean(s).toLowerCase();

  // Column names by role, Foodstory's first. Matching ignores case and the
  // padding Foodstory puts in some headers ("ชื่อเมนู                     ").
  const COLUMNS = {
    date: ['วันที่ชำระเงิน', 'payment date', 'วันที่', 'date', 'sale date', 'business date'],
    branch: ['ชื่อสาขา', 'สาขา', 'branch', 'branch name', 'outlet', 'store'],
    menu: ['ชื่อเมนู', 'menu', 'menu name', 'item', 'item name', 'product', 'product name', 'ชื่อสินค้า'],
    code: ['รหัสเมนู', 'menu code', 'item code', 'sku', 'product code', 'รหัสสินค้า'],
    qty: ['จำนวน', 'qty', 'quantity'],
    net: ['ราคาสุทธิ', 'net', 'net sales', 'net amount', 'amount', 'total', 'ยอดสุทธิ'],
    gross: ['ยอดก่อนลด', 'gross', 'gross sales', 'subtotal'],
    discount: ['ส่วนลดสินค้า', 'discount', 'item discount'],
    group: ['กลุ่ม', 'group', 'menu group'],
    category: ['หมวดสินค้า', 'category', 'menu category', 'หมวด'],
  };

  function detectColumns(header) {
    const h = header.map(lower);
    const out = {};
    Object.entries(COLUMNS).forEach(([role, names]) => {
      for (const n of names) {
        const i = h.indexOf(n);
        if (i >= 0 && !Object.values(out).includes(i)) { out[role] = i; break; }
      }
    });
    const missing = ['date', 'menu', 'qty', 'net'].filter((r) => out[r] === undefined);
    const foodstory = ['วันที่ชำระเงิน', 'ชื่อเมนู', 'ราคาสุทธิ', 'หมายเลขใบเสร็จ / id'].every((n) => h.includes(n));
    return { columns: out, missing, format: foodstory ? 'foodstory' : 'generic' };
  }

  // DD/MM/YYYY (Thai exports), with or without a time; YYYY-MM-DD; a
  // Buddhist-era year (2568) becomes CE.
  function parseDate(v) {
    const s = clean(v);
    let d, m, y;
    let mt = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
    if (mt) { d = +mt[1]; m = +mt[2]; y = +mt[3]; }
    else if ((mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
    else return null;
    if (y < 100) y += 2000;
    if (y > 2400) y -= 543;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const check = new Date(iso + 'T00:00:00Z');
    return check.getUTCDate() === d ? iso : null;
  }

  const toNum = (v) => {
    const n = Number(String(v == null ? '' : v).replace(/[,฿\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  // Foodstory writes options onto the menu name: "Cappuccino - นมโอ๊ต x 1, -
  // คั่วเข้ม x 1,". The dish is the part before the first " - … x N," option,
  // so every way a Cappuccino was ordered counts as one Cappuccino.
  function baseMenuName(raw) {
    let s = clean(raw);
    const opt = s.search(/\s-\s.*\sx\s*\d+\s*,/);
    if (opt > 0) s = s.slice(0, opt);
    return clean(s);
  }

  // The key two menu names are compared on: case, spacing and punctuation
  // differences between POS and FMH do not make them different dishes.
  function menuKey(name) {
    return lower(name).normalize('NFC').replace(/[\s()[\]{}.,'"`/\\_\-–—:;!?*#&+]+/g, '');
  }

  // Daily totals per branch + menu. Rows that are not sales lines (the "รวม"
  // footer, blank menus, unreadable dates) are counted and skipped.
  function aggregate(text, opts = {}) {
    const table = parseCsv(text);
    if (table.length < 2) throw new Error('ไฟล์ไม่มีข้อมูลยอดขาย');
    const { columns: col, missing, format } = detectColumns(table[0]);
    if (missing.length) {
      throw new Error(`ไม่พบคอลัมน์ที่ต้องใช้: ${missing.map((m) => COLUMNS[m][0]).join(', ')}`);
    }
    const get = (r, role) => (col[role] === undefined ? '' : r[col[role]]);
    const groups = new Map();
    let skipped = 0;
    let lines = 0;
    for (let i = 1; i < table.length; i++) {
      const r = table[i];
      const menuRaw = clean(get(r, 'menu'));
      const date = parseDate(get(r, 'date'));
      if (!menuRaw || !date || /^(รวม|total|grand total)$/i.test(clean(r[0]) || clean(r[1]))) { skipped++; continue; }
      const branch = clean(get(r, 'branch')) || opts.defaultBranch || 'ไม่ระบุสาขา';
      const menu = baseMenuName(menuRaw);
      const code = clean(get(r, 'code'));
      const k = [date, branch, menu, code].join('\u0001');
      if (!groups.has(k)) {
        groups.set(k, {
          sale_date: date, branch, menu_name: menu, pos_code: code,
          pos_group: clean(get(r, 'group')), pos_category: clean(get(r, 'category')),
          qty: 0, net_sales: 0, gross_sales: 0, discount: 0, lines: 0,
        });
      }
      const g = groups.get(k);
      g.qty += toNum(get(r, 'qty'));
      g.net_sales += toNum(get(r, 'net'));
      g.gross_sales += col.gross === undefined ? toNum(get(r, 'net')) : toNum(get(r, 'gross'));
      g.discount += toNum(get(r, 'discount'));
      g.lines++;
      lines++;
    }
    const rows = [...groups.values()].map((g) => ({
      ...g,
      qty: round(g.qty, 3), net_sales: round(g.net_sales), gross_sales: round(g.gross_sales), discount: round(g.discount),
    }));
    if (!rows.length) throw new Error('ไม่พบรายการขายที่อ่านได้ในไฟล์ (ตรวจคอลัมน์วันที่ชำระเงินและชื่อเมนู)');
    const dates = rows.map((r) => r.sale_date).sort();
    return {
      format,
      rows,
      stats: {
        lines,
        skipped,
        menus: new Set(rows.map((r) => r.menu_name)).size,
        branches: [...new Set(rows.map((r) => r.branch))],
        date_from: dates[0],
        date_to: dates[dates.length - 1],
        net_sales: round(rows.reduce((s, r) => s + r.net_sales, 0)),
      },
    };
  }

  function round(n, dp = 2) {
    const f = 10 ** dp;
    return Math.round(n * f) / f;
  }

  // Bytes → text. Thai Excel saves CSVs as Windows-874 (TIS-620) more often
  // than UTF-8, so a file that is not valid UTF-8 is read as that.
  function decode(buffer) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch (e) {
      return new TextDecoder('windows-874').decode(buffer);
    }
  }

  return { parseCsv, detectColumns, parseDate, baseMenuName, menuKey, aggregate, decode, toNum, round };
});
