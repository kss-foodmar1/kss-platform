// Reads a POS sales export into daily per-menu totals.
//
// Every POS names its columns differently, so reading a file is two steps:
// a *profile* says which column holds the sale date, the menu, the quantity
// and the net sales, then aggregate() turns the rows into the one shape the
// POS COGS widgets read. Profiles come from three places:
//   - built in (Foodstory), detected from the file's headers
//   - saved by a company for its own POS, the first time it maps the columns
//     by hand (stored on the server, pos_profiles)
//   - a best guess from common column names, used to pre-fill that mapping
//
// Shared by the browser and the server: the browser parses the file and sends
// only the totals, so customer names and phone numbers in the export never
// leave the user's computer, and a month of bills becomes a few thousand rows
// instead of a 50 MB upload. The server re-checks what it receives.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PosParse = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Comma, semicolon or tab: whichever splits the first lines most evenly.
  function detectDelimiter(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
    let best = ',';
    let bestScore = -1;
    [',', ';', '\t', '|'].forEach((d) => {
      const counts = lines.map((l) => l.split(d).length - 1);
      const max = Math.max(0, ...counts);
      const score = max ? counts.filter((c) => c === max).length * max : 0;
      if (score > bestScore) { bestScore = score; best = d; }
    });
    return best;
  }

  // RFC 4180: quoted fields may hold the delimiter, quotes ("") and line
  // breaks (Foodstory's "หมายเหตุ" column does).
  function parseCsv(text, delim) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const d = delim || detectDelimiter(text);
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
      else if (c === d) { row.push(field); field = ''; }
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

  // The header row: some exports put a report title and a date line above it,
  // so take the first row that is about as wide as the table.
  function readTable(text) {
    const all = parseCsv(text);
    if (!all.length) return { header: [], rows: [] };
    const width = Math.max(...all.slice(0, 30).map((r) => r.filter((v) => clean(v)).length));
    let h = all.findIndex((r) => r.filter((v) => clean(v)).length >= Math.max(2, Math.ceil(width * 0.6)));
    if (h < 0) h = 0;
    return { header: all[h].map(clean), rows: all.slice(h + 1) };
  }

  // What the widgets need from a file. `required` must be mapped to upload.
  const ROLES = [
    { key: 'date', label: 'วันที่ขาย', required: true },
    { key: 'menu', label: 'ชื่อเมนู', required: true },
    { key: 'qty', label: 'จำนวน', required: true },
    { key: 'net', label: 'ยอดขายสุทธิ (หลังส่วนลด)', required: true },
    { key: 'branch', label: 'สาขา' },
    { key: 'code', label: 'รหัสเมนู' },
    { key: 'gross', label: 'ยอดก่อนส่วนลด' },
    { key: 'discount', label: 'ส่วนลด' },
    { key: 'category', label: 'หมวดเมนู' },
    { key: 'group', label: 'กลุ่มเมนู' },
  ];
  const REQUIRED = ROLES.filter((r) => r.required).map((r) => r.key);

  // Common column names by role, used for the best-guess pre-fill.
  const GUESS = {
    date: ['วันที่ชำระเงิน', 'payment date', 'วันที่ขาย', 'วันที่', 'date', 'sale date', 'business date', 'order date', 'bill date', 'transaction date'],
    branch: ['ชื่อสาขา', 'สาขา', 'branch', 'branch name', 'outlet', 'store', 'shop'],
    menu: ['ชื่อเมนู', 'เมนู', 'menu', 'menu name', 'item', 'item name', 'product', 'product name', 'ชื่อสินค้า', 'สินค้า', 'รายการ'],
    code: ['รหัสเมนู', 'menu code', 'item code', 'sku', 'product code', 'รหัสสินค้า', 'barcode'],
    qty: ['จำนวน', 'qty', 'quantity', 'จำนวนขาย', 'units'],
    net: ['ราคาสุทธิ', 'ยอดสุทธิ', 'ยอดขายสุทธิ', 'net', 'net sales', 'net amount', 'net total', 'amount', 'total', 'ยอดขาย', 'sales'],
    gross: ['ยอดก่อนลด', 'gross', 'gross sales', 'subtotal', 'ยอดก่อนส่วนลด'],
    discount: ['ส่วนลดสินค้า', 'ส่วนลด', 'discount', 'item discount'],
    group: ['กลุ่ม', 'group', 'menu group'],
    category: ['หมวดสินค้า', 'หมวด', 'category', 'menu category'],
  };

  function guessColumns(header) {
    const h = header.map(lower);
    const out = {};
    const used = new Set();
    Object.entries(GUESS).forEach(([role, names]) => {
      for (const n of names) {
        const i = h.indexOf(n);
        if (i >= 0 && !used.has(i)) { out[role] = header[i]; used.add(i); break; }
      }
    });
    return out;
  }

  // Built-in profiles. `detect` = headers that must all be present.
  const BUILTIN = [
    {
      id: 'foodstory',
      name: 'Foodstory',
      detect: ['วันที่ชำระเงิน', 'ชื่อเมนู', 'ราคาสุทธิ', 'หมายเลขใบเสร็จ / ID'],
      columns: {
        date: 'วันที่ชำระเงิน', branch: 'ชื่อสาขา', menu: 'ชื่อเมนู', code: 'รหัสเมนู', qty: 'จำนวน', net: 'ราคาสุทธิ',
        gross: 'ยอดก่อนลด', discount: 'ส่วนลดสินค้า', group: 'กลุ่ม', category: 'หมวดสินค้า',
      },
      date_order: 'dmy',
    },
  ];

  // A profile fits a file when every column it maps exists in the header.
  function profileFits(profile, header) {
    const h = new Set(header.map(lower));
    const need = profile.detect || REQUIRED.map((k) => profile.columns[k]).filter(Boolean);
    return need.length > 0 && need.every((n) => h.has(lower(n))) && REQUIRED.every((k) => profile.columns[k] && h.has(lower(profile.columns[k])));
  }
  function detectProfile(header, saved = []) {
    return [...saved, ...BUILTIN].find((p) => profileFits(p, header)) || null;
  }
  const signature = (header) => header.map(lower).filter(Boolean).join('|');

  // Dates: DD/MM/YYYY (Thai default), MM/DD/YYYY, YYYY-MM-DD, with or without a
  // time; Excel serial day numbers; a Buddhist-era year (2568) becomes CE.
  function parseDate(v, order = 'dmy') {
    const s = clean(v);
    let d, m, y, mt;
    if ((mt = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
    else if ((mt = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/))) {
      if (order === 'mdy') { m = +mt[1]; d = +mt[2]; } else { d = +mt[1]; m = +mt[2]; }
      y = +mt[3];
    } else if (/^\d{5}(\.\d+)?$/.test(s)) {
      const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 86400000);
      return dt.toISOString().slice(0, 10);
    } else return null;
    if (y < 100) y += 2000;
    if (y > 2400) y -= 543;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return new Date(iso + 'T00:00:00Z').getUTCDate() === d ? iso : null;
  }

  // Which order a column of dates is written in: a first part above 12 can
  // only be a day, a second part above 12 only a day.
  function guessDateOrder(values) {
    let dmy = 0;
    let mdy = 0;
    values.forEach((v) => {
      const mt = clean(v).match(/^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/);
      if (!mt) return;
      if (+mt[1] > 12) dmy++;
      if (+mt[2] > 12) mdy++;
    });
    return mdy > dmy ? 'mdy' : 'dmy';
  }

  const toNum = (v) => {
    const s = String(v == null ? '' : v).replace(/[,฿\s]/g, '');
    const neg = /^\(.*\)$/.test(s);
    const n = Number(s.replace(/[()]/g, ''));
    return Number.isFinite(n) ? (neg ? -n : n) : 0;
  };

  // Foodstory writes options onto the menu name: "Cappuccino - นมโอ๊ต x 1, -
  // คั่วเข้ม x 1,". The dish is the part before the first " - … x N," option.
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

  // Everything the mapping screen needs to show about a file.
  function inspect(text, saved = []) {
    const { header, rows } = readTable(text);
    if (!header.length || !rows.length) throw new Error('ไฟล์ไม่มีข้อมูลยอดขาย');
    const profile = detectProfile(header, saved);
    const guess = profile ? { ...profile.columns } : guessColumns(header);
    // No date column by name: take the first column whose values read as dates.
    if (!guess.date) {
      const i = header.findIndex((h, c) => {
        const vals = rows.slice(0, 20).map((r) => r[c]).filter((v) => clean(v));
        return vals.length && vals.every((v) => /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(clean(v)));
      });
      if (i >= 0) guess.date = header[i];
    }
    const dateCol = header.findIndex((h) => lower(h) === lower(guess.date || ''));
    return {
      header,
      sample: rows.slice(0, 5),
      row_count: rows.length,
      profile,
      guess,
      date_order: profile ? profile.date_order || 'dmy' : guessDateOrder(dateCol >= 0 ? rows.slice(0, 200).map((r) => r[dateCol]) : []),
      signature: signature(header),
    };
  }

  // Daily totals per branch + menu. opts.columns maps role → header name (a
  // profile's columns); without it the built-in profile or the best guess is
  // used. Rows that are not sales lines (a "รวม" footer, blank menus,
  // unreadable dates) are counted and skipped.
  function aggregate(text, opts = {}) {
    const { header, rows: body } = readTable(text);
    if (!header.length || !body.length) throw new Error('ไฟล์ไม่มีข้อมูลยอดขาย');
    const builtin = !opts.columns && detectProfile(header);
    const columns = opts.columns || (builtin ? builtin.columns : guessColumns(header));
    const h = header.map(lower);
    const col = {};
    Object.entries(columns).forEach(([role, name]) => {
      const i = name ? h.indexOf(lower(name)) : -1;
      if (i >= 0) col[role] = i;
    });
    const missing = REQUIRED.filter((r) => col[r] === undefined);
    if (missing.length) {
      throw new Error(`ไม่พบคอลัมน์ที่ต้องใช้: ${missing.map((m) => ROLES.find((x) => x.key === m).label).join(', ')}`);
    }
    const order = opts.dateOrder || (builtin && builtin.date_order) || 'dmy';
    const get = (r, role) => (col[role] === undefined ? '' : r[col[role]]);
    const groups = new Map();
    let skipped = 0;
    let lines = 0;
    for (const r of body) {
      const menuRaw = clean(get(r, 'menu'));
      const date = parseDate(get(r, 'date'), order);
      const first = clean(r[0]) || clean(r[1]);
      if (!menuRaw || !date || /^(รวม|ยอดรวม|total|grand total|sum)$/i.test(first)) { skipped++; continue; }
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
      const net = toNum(get(r, 'net'));
      g.qty += toNum(get(r, 'qty'));
      g.net_sales += net;
      g.gross_sales += col.gross === undefined ? net : toNum(get(r, 'gross'));
      g.discount += toNum(get(r, 'discount'));
      g.lines++;
      lines++;
    }
    const rows = [...groups.values()].map((g) => ({
      ...g,
      qty: round(g.qty, 3), net_sales: round(g.net_sales), gross_sales: round(g.gross_sales), discount: round(g.discount),
    }));
    if (!rows.length) throw new Error('ไม่พบรายการขายที่อ่านได้ในไฟล์ (ตรวจคอลัมน์วันที่และชื่อเมนู)');
    const dates = rows.map((r) => r.sale_date).sort();
    return {
      format: builtin ? builtin.id : opts.profileId || 'custom',
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

  return {
    ROLES, REQUIRED, BUILTIN, parseCsv, readTable, detectDelimiter, guessColumns, detectProfile, profileFits, signature,
    parseDate, guessDateOrder, baseMenuName, menuKey, inspect, aggregate, decode, toNum, round,
  };
});
