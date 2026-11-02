// "นับตามวันที่ไหน" — which date column the page's date range filters on.
//
// FMH counts Sales Analysis and Purchase Analysis by ORDER DATE. The central
// kitchen widgets used to filter on the customer's requested delivery date, so
// a SO placed on 30 Sep and delivered on 1 Oct landed in October on the
// dashboard but in September in FMH (Oct 2026: 113 SO / ฿615,875 against FMH's
// 111 SO / ฿596,571). The default is now Order Date, the same as FMH; the user
// can pick another column and the choice is remembered per user.
//
// Shared by the browser (window.DateBasis) and Node tests (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DateBasis = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT = 'order_date';

  // key = the row field (same name the FMH API / export uses)
  const BASES = [
    { key: 'order_date', th: 'วันที่สั่ง', en: 'Order Date', note: 'FMH นับตามวันนี้' },
    { key: 'requested_delivery_date', th: 'วันที่ลูกค้าขอรับของ', en: 'Requested Delivery Date' },
    { key: 'do_date', th: 'วันที่ส่งจริง', en: 'DO Date' },
    { key: 'grn_date', th: 'วันที่รับของ', en: 'GRN Date' },
    { key: 'invoice_date', th: 'วันที่ออกใบแจ้งหนี้', en: 'Invoice Date' },
    { key: 'completed_date', th: 'วันที่ปิดใบสั่ง', en: 'Completed Date' },
  ];
  const KEYS = BASES.map((b) => b.key);
  const byKey = (k) => BASES.find((b) => b.key === k) || null;
  const label = (k) => {
    const b = byKey(k);
    return b ? `${b.th} (${b.en})` : String(k || '');
  };

  // Reports whose range can follow the chosen column (itemized pulls only).
  const SOURCES = ['sales-analysis', 'purchase-analysis'];
  const isBasisSource = (source, grouping) => SOURCES.includes(source) && !grouping;

  const normalize = (k) => (KEYS.includes(k) ? k : DEFAULT);

  // Which columns this set of rows actually fills in. order_date is always
  // offered; the others only when some row has a value, so a report that has
  // no Invoice Date column does not show a choice that would empty the page.
  function available(rowSets) {
    const found = new Set([DEFAULT]);
    (rowSets || []).forEach((rows) => {
      for (const r of rows || []) {
        KEYS.forEach((k) => { if (!found.has(k) && r[k]) found.add(k); });
        if (found.size === KEYS.length) return;
      }
    });
    return KEYS.filter((k) => found.has(k));
  }

  // The column to use for one report: the chosen one when its rows carry it,
  // else Order Date. `fellBack` lets the page say so.
  function fieldFor(choice, rows) {
    const want = normalize(choice);
    if (want === DEFAULT) return { field: DEFAULT, fellBack: false };
    const has = (rows || []).some((r) => r[want]);
    return has ? { field: want, fellBack: false } : { field: DEFAULT, fellBack: true };
  }

  // Rows that have no value in the chosen column (a SO not delivered yet has
  // no DO date): they leave the range, and the page counts them.
  const missing = (rows, field) => (rows || []).reduce((n, r) => n + (r[field] ? 0 : 1), 0);

  // A widget's config with its "date of the sale" swapped for the chosen column.
  //  - Sales Analysis: every mention of requested_delivery_date (the old
  //    default) and the label "เฉลี่ยต่อวันที่ส่ง".
  //  - Purchase Analysis: a single-field date_fields list, col_date and a
  //    weekday derived from order_date. A multi-field date_fields
  //    (PO vs GRN vs Invoice) is deliberate and stays as it is.
  function applyToConfig(cfg, source, field) {
    if (!cfg || !isBasisSource(source) || !KEYS.includes(field)) return cfg;
    const OLD = source === 'sales-analysis' ? 'requested_delivery_date' : 'order_date';
    const short = byKey(field) ? byKey(field).en : field;
    const swap = (v, key, parent) => {
      if (Array.isArray(v)) {
        if (key === 'date_fields' && v.length === 1) return v[0] === OLD || v[0] === 'requested_delivery_date' ? [field] : v;
        return v.map((x) => swap(x, key, parent));
      }
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x, k, v)]));
      if (typeof v !== 'string') return v;
      if (source === 'sales-analysis') {
        if (v === 'requested_delivery_date') return field;
        if (key === 'label' && v === 'เฉลี่ยต่อวันที่ส่ง') return `เฉลี่ยต่อวัน (${short})`;
        return v;
      }
      if (v === 'order_date' && (key === 'col_date' || (key === 'from' && parent && parent.op === 'weekday'))) return field;
      return v;
    };
    return swap(cfg, '', null);
  }

  return { DEFAULT, BASES, KEYS, SOURCES, isBasisSource, normalize, label, byKey, available, fieldFor, missing, applyToConfig };
});
