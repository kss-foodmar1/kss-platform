// Demo data: a believable restaurant group that answers every FMH report the
// app reads, so a company in demo mode (companies.data_source = 'demo') never
// calls FMH and never spends quota.
//
// One fictional business behind every report, so the numbers agree with each
// other: 5 branches + a central kitchen, ~30 products, 7 suppliers, 14 menus
// with recipes, ~90 days of history that moves with today's date.
// Everything is generated from a seed per day, so the same day always yields
// the same rows (incremental sync merges cleanly) and today's rows appear as
// the calendar moves.
//
// Built-in situations, so the exception widgets have something to find:
// short deliveries (one supplier much worse), over-billing with partly issued
// credit notes, late deliveries, price drift (shrimp and pork up, eggs down),
// a stale recipe cost, mixed units, odd and missing product codes, a resale
// item in no recipe, wastage, ingredient over-use at one branch, short picks,
// stock-count variances, production yield, ageing lots.
//
// All names are invented. No real company, supplier or client appears here.

// ---------- deterministic randomness ----------
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed) {
  let a = hash(String(seed));
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const round2 = (n) => Math.round(n * 100) / 100;

// ---------- calendar (Bangkok calendar days as YYYY-MM-DD) ----------
const todayIso = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
const toMs = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const addDays = (iso, n) => new Date(toMs(iso) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / 86400000);
const weekday = (iso) => new Date(toMs(iso)).getUTCDay(); // 0 Sun
const mondayOf = (iso) => addDays(iso, -((weekday(iso) + 6) % 7));
const HISTORY_DAYS = 89;

// ---------- the business ----------
const CK = 'ครัวกลาง';
const BRANCHES = ['สาขา สยาม', 'สาขา อโศก', 'สาขา ทองหล่อ', 'สาขา บางนา', 'สาขา รังสิต'];
const BRANCH_SIZE = { 'สาขา สยาม': 1.3, 'สาขา อโศก': 1.1, 'สาขา ทองหล่อ': 0.9, 'สาขา บางนา': 1.0, 'สาขา รังสิต': 0.8 };

const SUPPLIERS = {
  S1: { name: 'ทะเลสด ซัพพลาย', shortRate: 0.04, lateRate: 0.05, priceAdj: 1.0 },
  S2: { name: 'ชาวเล มาร์ท', shortRate: 0.22, lateRate: 0.4, priceAdj: 0.94 }, // cheaper but unreliable
  S3: { name: 'หมูดี ฟาร์ม', shortRate: 0.05, lateRate: 0.06, priceAdj: 1.0 },
  S4: { name: 'ไก่ทอง ฟาร์ม', shortRate: 0.03, lateRate: 0.04, priceAdj: 1.0 },
  S5: { name: 'ผักสวนครัว สด', shortRate: 0.09, lateRate: 0.15, priceAdj: 1.0 },
  S6: { name: 'แป้งและของแห้ง พลัส', shortRate: 0.02, lateRate: 0.03, priceAdj: 1.0 },
  S7: { name: 'เครื่องดื่มรวมมิตร', shortRate: 0.02, lateRate: 0.05, priceAdj: 1.0 },
};

// drift = total price move over the history (0.12 = +12%), vol = day-to-day noise
const PRODUCTS = [
  { code: 'SEA-001', name: 'กุ้งขาว', cat: 'อาหารทะเล', uom: 'kg', price: 320, sup: ['S1', 'S2'], drift: 0.12, vol: 0.02, perDay: 9 },
  { code: 'SEA-002', name: 'ปลาหมึก', cat: 'อาหารทะเล', uom: 'kg', price: 180, sup: ['S1'], drift: 0.04, vol: 0.02, perDay: 4 },
  { code: 'SEA-003', name: 'ปลากะพง', cat: 'อาหารทะเล', uom: 'kg', price: 260, sup: ['S1', 'S2'], drift: 0.02, vol: 0.02, perDay: 6 },
  { code: 'MEA-001', name: 'หมูสามชั้น', cat: 'เนื้อสัตว์', uom: 'kg', price: 175, sup: ['S3'], drift: 0.08, vol: 0.015, perDay: 7 },
  { code: 'MEA-002', name: 'หมูสับ', cat: 'เนื้อสัตว์', uom: 'kg', price: 140, sup: ['S3'], drift: 0.05, vol: 0.015, perDay: 10 },
  { code: 'MEA-003', name: 'สันคอหมู', cat: 'เนื้อสัตว์', uom: 'kg', price: 165, sup: ['S3'], drift: 0.03, vol: 0.015, perDay: 6 },
  { code: 'POU-001', name: 'อกไก่', cat: 'เนื้อสัตว์', uom: 'kg', price: 95, sup: ['S4'], drift: 0.0, vol: 0.01, perDay: 9 },
  { code: 'POU-002', name: 'น่องไก่', cat: 'เนื้อสัตว์', uom: 'kg', price: 85, sup: ['S4'], drift: 0.02, vol: 0.01, perDay: 8 },
  { code: 'POU-003', name: 'ไข่ไก่', cat: 'ไข่และนม', uom: 'ฟอง', price: 4.2, sup: ['S4', 'S6'], drift: -0.05, vol: 0.02, perDay: 180 },
  { code: 'VEG-001', name: 'กะเพรา', cat: 'ผักและสมุนไพร', uom: 'kg', price: 60, sup: ['S5'], drift: 0.0, vol: 0.06, perDay: 2.5 },
  { code: 'VEG-002', name: 'พริกขี้หนู', cat: 'ผักและสมุนไพร', uom: 'kg', price: 120, sup: ['S5'], drift: 0.15, vol: 0.09, perDay: 1.6 },
  { code: 'VEG-003', name: 'กระเทียม', cat: 'ผักและสมุนไพร', uom: 'kg', price: 90, sup: ['S5'], drift: 0.0, vol: 0.03, perDay: 2.2 },
  { code: 'VEG-004', name: 'มะนาว', cat: 'ผักและสมุนไพร', uom: 'ลูก', price: 3.5, sup: ['S5'], drift: 0.25, vol: 0.08, perDay: 160 },
  { code: 'VEG-005', name: 'ผักบุ้ง', cat: 'ผักและสมุนไพร', uom: 'kg', price: 35, sup: ['S5'], drift: 0.0, vol: 0.05, perDay: 6 },
  { code: 'VEG-006', name: 'หอมแดง', cat: 'ผักและสมุนไพร', uom: 'kg', price: 70, sup: ['S5'], drift: 0.03, vol: 0.04, perDay: 1.5 },
  { code: 'CH01', name: 'ผักชี', cat: 'ผักและสมุนไพร', uom: 'kg', price: 110, sup: ['S5'], drift: 0.0, vol: 0.06, perDay: 0.6 },
  { code: 'DRY-001', name: 'ข้าวหอมมะลิ', cat: 'ของแห้ง', uom: 'kg', price: 38, sup: ['S6'], drift: 0.0, vol: 0.005, perDay: 30 },
  { code: 'DRY-002', name: 'เส้นจันท์', cat: 'ของแห้ง', uom: 'kg', price: 55, sup: ['S6'], drift: 0.0, vol: 0.005, perDay: 8 },
  { code: 'DRY-003', name: 'น้ำมันพืช', cat: 'ของแห้ง', uom: 'ลิตร', price: 48, sup: ['S6'], drift: 0.06, vol: 0.01, perDay: 9, altUom: 'ขวด' },
  { code: 'DRY-004', name: 'น้ำปลา', cat: 'ซอสและเครื่องปรุง', uom: 'ขวด', price: 32, sup: ['S6'], drift: 0.0, vol: 0.005, perDay: 5 },
  { code: 'DRY-005', name: 'น้ำตาลปี๊บ', cat: 'ซอสและเครื่องปรุง', uom: 'kg', price: 45, sup: ['S6'], drift: 0.0, vol: 0.01, perDay: 3 },
  { code: '116', name: 'ซอสหอยนางรม', cat: 'ซอสและเครื่องปรุง', uom: 'ขวด', price: 42, sup: ['S6'], drift: 0.0, vol: 0.005, perDay: 3 },
  { code: 'DRY-006', name: 'กะทิ', cat: 'ของแห้ง', uom: 'กล่อง', price: 28, sup: ['S6'], drift: 0.04, vol: 0.01, perDay: 12 },
  { code: 'BEV-001', name: 'น้ำดื่ม', cat: 'เครื่องดื่ม', uom: 'แพ็ค', price: 55, sup: ['S7'], drift: 0.0, vol: 0.0, perDay: 10 },
  { code: 'BEV-002', name: 'โซดา', cat: 'เครื่องดื่ม', uom: 'แพ็ค', price: 70, sup: ['S7'], drift: 0.0, vol: 0.0, perDay: 6 },
  { code: 'BEV-003', name: 'ใบชาไทย', cat: 'เครื่องดื่ม', uom: 'kg', price: 220, sup: ['S7'], drift: 0.05, vol: 0.01, perDay: 1.2 },
  { code: 'BEV-004', name: 'นมข้นหวาน', cat: 'ไข่และนม', uom: 'กระป๋อง', price: 26, sup: ['S7'], drift: 0.0, vol: 0.005, perDay: 20 },
  { code: '', name: 'ถุงร้อนใส่อาหาร', cat: 'บรรจุภัณฑ์', uom: 'แพ็ค', price: 65, sup: ['S6'], drift: 0.0, vol: 0.0, perDay: 2 },
];
const BY_CODE = Object.fromEntries(PRODUCTS.filter((p) => p.code).map((p) => [p.code, p]));
const BY_NAME = Object.fromEntries(PRODUCTS.map((p) => [p.name, p]));

// Recipes in purchase units. recipePrice = what the recipe card was costed at
// (shrimp still at the old price → "stale recipe cost").
const MENUS = [
  { code: 'M01', name: 'กะเพราหมูสับไข่ดาว', cat: 'อาหารจานเดียว', price: 69, pop: 30, rec: [['หมูสับ', 0.12], ['กะเพรา', 0.02], ['พริกขี้หนู', 0.008], ['กระเทียม', 0.01], ['ข้าวหอมมะลิ', 0.15], ['ไข่ไก่', 1], ['น้ำมันพืช', 0.03]] },
  { code: 'M02', name: 'ข้าวผัดกุ้ง', cat: 'อาหารจานเดียว', price: 89, pop: 18, rec: [['กุ้งขาว', 0.09], ['ข้าวหอมมะลิ', 0.2], ['ไข่ไก่', 1], ['น้ำมันพืช', 0.02], ['กระเทียม', 0.008]] },
  { code: 'M03', name: 'ผัดไทยกุ้งสด', cat: 'อาหารจานเดียว', price: 99, pop: 20, rec: [['เส้นจันท์', 0.12], ['กุ้งขาว', 0.08], ['ไข่ไก่', 1], ['น้ำตาลปี๊บ', 0.02], ['น้ำปลา', 0.03], ['หอมแดง', 0.01]] },
  { code: 'M04', name: 'ต้มยำกุ้ง', cat: 'ต้มและแกง', price: 159, pop: 12, rec: [['กุ้งขาว', 0.18], ['มะนาว', 2], ['พริกขี้หนู', 0.01], ['น้ำปลา', 0.04], ['หอมแดง', 0.01]] },
  { code: 'M05', name: 'แกงเขียวหวานไก่', cat: 'ต้มและแกง', price: 89, pop: 11, rec: [['อกไก่', 0.12], ['กะทิ', 0.5], ['พริกขี้หนู', 0.005], ['น้ำปลา', 0.02], ['น้ำตาลปี๊บ', 0.01]] },
  { code: 'M06', name: 'ปลากะพงนึ่งมะนาว', cat: 'อาหารทะเล', price: 289, pop: 5, rec: [['ปลากะพง', 0.6], ['มะนาว', 4], ['กระเทียม', 0.03], ['พริกขี้หนู', 0.02], ['ผักชี', 0.01]] },
  { code: 'M07', name: 'ยำปลาหมึก', cat: 'อาหารทะเล', price: 119, pop: 7, rec: [['ปลาหมึก', 0.15], ['มะนาว', 2], ['พริกขี้หนู', 0.01], ['หอมแดง', 0.02], ['ผักชี', 0.01]] },
  { code: 'M08', name: 'หมูสามชั้นทอด', cat: 'ทอดและย่าง', price: 129, pop: 10, rec: [['หมูสามชั้น', 0.2], ['น้ำมันพืช', 0.06], ['กระเทียม', 0.01]] },
  { code: 'M09', name: 'คอหมูย่าง', cat: 'ทอดและย่าง', price: 139, pop: 12, rec: [['สันคอหมู', 0.2], ['น้ำตาลปี๊บ', 0.01], ['น้ำปลา', 0.02]] },
  { code: 'M10', name: 'ไก่ทอด', cat: 'ทอดและย่าง', price: 99, pop: 14, rec: [['น่องไก่', 0.25], ['น้ำมันพืช', 0.07]] },
  { code: 'M11', name: 'ข้าวมันไก่', cat: 'อาหารจานเดียว', price: 59, pop: 22, rec: [['อกไก่', 0.15], ['ข้าวหอมมะลิ', 0.15], ['กระเทียม', 0.01]] },
  { code: 'M12', name: 'ผัดผักบุ้งไฟแดง', cat: 'ผัด', price: 59, pop: 15, rec: [['ผักบุ้ง', 0.2], ['กระเทียม', 0.01], ['พริกขี้หนู', 0.005], ['ซอสหอยนางรม', 0.03]] },
  { code: 'M13', name: 'ชาไทยเย็น', cat: 'เครื่องดื่ม', price: 45, pop: 26, rec: [['ใบชาไทย', 0.015], ['นมข้นหวาน', 0.25], ['น้ำตาลปี๊บ', 0.01]] },
  { code: 'M14', name: 'น้ำมะนาวโซดา', cat: 'เครื่องดื่ม', price: 35, pop: 14, rec: [['มะนาว', 3], ['น้ำตาลปี๊บ', 0.02]] },
];
const YIELD_LOSS = { อาหารทะเล: 0.12, เนื้อสัตว์: 0.06, 'ผักและสมุนไพร': 0.1 };

// Price of a product on a day from a supplier: linear drift over the history
// plus daily noise; the second supplier sits at its own level.
function priceOn(p, supKey, iso, r) {
  const start = addDays(todayIso(), -HISTORY_DAYS);
  const t = Math.max(0, Math.min(1, daysBetween(start, iso) / HISTORY_DAYS));
  const base = p.price * (1 + p.drift * t) * SUPPLIERS[supKey].priceAdj;
  return round2(base * (1 + (r() - 0.5) * 2 * p.vol));
}
// Recipes were costed at the start-of-history price (stale for drifting items).
const recipeUnitCost = (p) => round2(p.price);

// ---------- daily generators (cached per day) ----------
const dayCache = new Map();
function memo(key, fn) {
  const today = todayIso();
  const k = today + '|' + key;
  if (!dayCache.has(k)) {
    if (dayCache.size > 4000) dayCache.clear();
    dayCache.set(k, fn());
  }
  return dayCache.get(k);
}

// Purchase lines ordered on `day`, with their state as of today.
function purchasesOn(day) {
  return memo('po|' + day, () => {
    const r = rng('po' + day);
    const today = todayIso();
    const age = daysBetween(day, today);
    const lines = [];
    const sunday = weekday(day) === 0;
    let poSeq = 0;
    Object.entries(SUPPLIERS).forEach(([sk, s]) => {
      // each supplier delivers on its own days
      const freq = { S1: 0.85, S2: 0.65, S3: 0.75, S4: 0.75, S5: 0.95, S6: 0.4, S7: 0.35 }[sk];
      if (sunday || r() > freq) return;
      const items = PRODUCTS.filter((p) => p.sup.includes(sk) && (p.sup.length === 1 || (sk === p.sup[0] ? r() < 0.7 : r() < 0.75)));
      if (!items.length) return;
      poSeq++;
      const branch = r() < 0.78 ? CK : pick(r, BRANCHES);
      const po = `PO${day.replace(/-/g, '').slice(2)}-${String(poSeq).padStart(2, '0')}`;
      const reqDate = addDays(day, 1);
      const late = r() < s.lateRate ? 1 + Math.floor(r() * (sk === 'S2' ? 4 : 2)) : 0;
      const grnDate = addDays(reqDate, late);
      const received = daysBetween(grnDate, today) >= 0 && age >= 1;
      const dispatched = received || age >= 1;
      const invLag = 2 + Math.floor(r() * 6);
      const neverInvoiced = r() < 0.04;
      const invoiced = received && !neverInvoiced && daysBetween(addDays(grnDate, invLag), today) >= 0;
      const inv = invoiced ? `INV-${po.slice(2)}` : '';
      const split = r() < 0.04;
      items.forEach((p, i) => {
        const lr = rng(`${po}|${i}`);
        const factor = sk === p.sup[0] ? 1 : 0.6;
        const qty = Math.max(1, Math.round((p.perDay * 2.25 * factor * (0.7 + lr() * 0.6)) * (p.uom === 'kg' || p.uom === 'ลิตร' ? 10 : 1)) / (p.uom === 'kg' || p.uom === 'ลิตร' ? 10 : 1));
        const price = priceOn(p, sk, day, lr);
        const short = lr() < s.shortRate;
        const grnQty = received ? round2(short ? qty * (0.6 + lr() * 0.3) : qty) : 0;
        const doQty = dispatched ? (received && lr() < 0.04 ? round2(grnQty + Math.max(0.5, qty * 0.1)) : received ? grnQty : qty) : 0;
        const overbill = invoiced && short && lr() < 0.55; // billed for the PO qty, not what arrived
        const invQty = invoiced ? (overbill ? qty : grnQty) : 0;
        const uom = p.altUom && lr() < 0.2 ? p.altUom : p.uom;
        const status = invoiced ? (daysBetween(addDays(grnDate, invLag), today) > 5 ? 'COMPLETED' : 'INVOICED') : received ? 'RECEIVED' : dispatched ? 'DISPATCHED' : 'APPROVED';
        const tax = (v) => round2(v * 0.07);
        const poTotal = round2(qty * price);
        const grnTotal = round2(grnQty * price);
        const invTotal = round2(invQty * price);
        const cur = invoiced ? [invQty, invTotal] : received ? [grnQty, grnTotal] : [qty, poTotal];
        lines.push({
          product_name: p.name, product_code: p.code, product_tags: '', category_name: p.cat,
          supplier: s.name, branch, department: 'ครัว', po_number: po, order_tags: '',
          issued_date: day, order_date: day, requested_delivery_date: reqDate,
          order_status: status, split_order_status: split ? 'SPLIT' : '',
          do_date: dispatched ? (received ? grnDate : addDays(day, 1)) : '', do_number: dispatched ? `DO-${po.slice(2)}` : '',
          grn_date: received ? grnDate : '', grn_number: received ? `GRN-${po.slice(2)}` : '',
          invoice_date: invoiced ? addDays(grnDate, invLag) : '', invoice_number: inv,
          supplier_invoice_date: invoiced ? addDays(grnDate, invLag) : '', supplier_invoice_number: invoiced ? `SI${hash(po) % 90000 + 10000}` : '',
          uom, tax_rate: '7',
          po_qty: qty, po_price: price, po_tax: tax(poTotal), po_total: poTotal,
          do_quantity: doQty, do_price: price, do_tax: tax(doQty * price), do_total: round2(doQty * price),
          grn_quantity: grnQty, grn_price: received ? price : 0, grn_tax: tax(grnTotal), grn_total: grnTotal,
          invoice_quantity: invQty, invoice_price: invoiced ? price : 0, invoice_tax: tax(invTotal), invoice_total: invTotal,
          qty: cur[0], price, discount: 0, tax: tax(cur[1]), total: cur[1],
        });
      });
    });
    return lines;
  });
}

// CK menu sales on a day, per branch.
function salesOn(day) {
  return memo('sales|' + day, () => {
    const r = rng('sales' + day);
    const wd = weekday(day);
    const dayFactor = wd === 5 || wd === 6 ? 1.3 : wd === 0 ? 1.15 : 1;
    const out = [];
    BRANCHES.forEach((b) => {
      MENUS.forEach((m) => {
        const mean = m.pop * BRANCH_SIZE[b] * dayFactor * 0.5;
        const q = Math.max(0, Math.round(mean * (0.7 + r() * 0.6)));
        if (q) out.push({ day, branch: b, menu: m, qty: q, price: m.price });
      });
    });
    return out;
  });
}

function menuCost(m) {
  let cost = 0;
  let yl = 0;
  m.rec.forEach(([n, q]) => {
    const p = BY_NAME[n];
    const c = q * recipeUnitCost(p);
    cost += c;
    yl += c * (YIELD_LOSS[p.cat] || 0);
  });
  return { cost: round2(cost), yieldLoss: round2(yl), total: round2(cost + yl) };
}

// Theoretical ingredient use from sales; actual adds over-use (Rangsit is
// heavy-handed with shrimp, everyone a little with chilli and oil).
const OVERUSE = { กุ้งขาว: { 'สาขา รังสิต': 0.14, _: 0.03 }, พริกขี้หนู: { _: 0.08 }, น้ำมันพืช: { _: 0.06 }, หมูสับ: { 'สาขา อโศก': 0.09, _: 0.02 }, ข้าวหอมมะลิ: { _: -0.03 }, มะนาว: { _: 0.05 } };
const overuseOf = (name, branch) => {
  const o = OVERUSE[name];
  if (!o) return 0.01;
  return o[branch] !== undefined ? o[branch] : o._;
};

function wastageOn(day) {
  return memo('waste|' + day, () => {
    const r = rng('waste' + day);
    const out = [];
    const candidates = ['กุ้งขาว', 'ผักบุ้ง', 'กะเพรา', 'มะนาว', 'ปลาหมึก', 'หมูสับ', 'ผักชี', 'ไข่ไก่'];
    const n = 1 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const name = pick(r, candidates);
      const p = BY_NAME[name];
      const branch = r() < 0.3 ? CK : pick(r, BRANCHES);
      const qty = p.uom === 'kg' ? round2(0.2 + r() * 1.5) : Math.ceil(2 + r() * 20);
      const unit = recipeUnitCost(p);
      out.push({
        wastage_date: day, product: name, branch, category: p.cat, quantity: qty, unit_cost: unit,
        wastage_value: round2(qty * unit), product_code: p.code, document_number: `WS-${day.replace(/-/g, '').slice(2)}-${i + 1}`,
        uom: p.uom, wastage_percentage: round2(2 + r() * 6), user_name: pick(r, ['สุดา', 'วิชัย', 'มาลี', 'ประเสริฐ']),
        department: 'ครัว', description: pick(r, ['เน่าเสีย', 'หมดอายุ', 'ตกหล่น', 'ตัดแต่งเกิน']), remark: '',
      });
    }
    return out;
  });
}

// Branches order from the CK (order items by branch / picking).
const CK_ITEMS = ['หมูสับ', 'อกไก่', 'กุ้งขาว', 'ข้าวหอมมะลิ', 'กะทิ', 'น้ำมันพืช', 'ไข่ไก่', 'ผักบุ้ง', 'น้ำปลา', 'นมข้นหวาน'];
function branchOrdersOn(day) {
  return memo('oibb|' + day, () => {
    const r = rng('oibb' + day);
    const out = [];
    if (weekday(day) === 0) return out;
    BRANCHES.forEach((b, bi) => {
      const items = CK_ITEMS.filter(() => r() < 0.6);
      items.forEach((name, i) => {
        const p = BY_NAME[name];
        const qty = Math.max(1, Math.round(p.perDay * BRANCH_SIZE[b] * (0.25 + r() * 0.3) * (p.uom === 'kg' ? 10 : 1)) / (p.uom === 'kg' ? 10 : 1));
        const short = r() < (b === 'สาขา รังสิต' ? 0.15 : 0.05);
        out.push({
          day, branch: b, product: name, product_code: p.code, uom: p.uom, category: p.cat, qty,
          picked: round2(short ? qty * (0.5 + r() * 0.4) : qty), order_number: `SO${day.replace(/-/g, '').slice(2)}-${bi + 1}`,
          picker: pick(r, ['สมชาย', 'อรุณี', 'ธนพล']), unitCost: recipeUnitCost(p), line: i,
        });
      });
    });
    return out;
  });
}

const PREP = [
  { name: 'น้ำพริกแกงเขียวหวาน', uom: 'kg', plan: 12, cost: 85, yieldMean: 0.95 },
  { name: 'หมูหมักกระเทียม', uom: 'kg', plan: 25, cost: 160, yieldMean: 0.9 },
  { name: 'ซอสผัดไทย', uom: 'ลิตร', plan: 15, cost: 48, yieldMean: 0.97 },
  { name: 'น้ำซุปต้มยำ', uom: 'ลิตร', plan: 30, cost: 35, yieldMean: 0.93 },
  { name: 'ไก่หมักทอด', uom: 'kg', plan: 20, cost: 98, yieldMean: 0.86 },
];
function productionOn(day) {
  return memo('prod|' + day, () => {
    const r = rng('prod' + day);
    if (weekday(day) === 0) return [];
    return PREP.filter(() => r() < 0.7).map((p, i) => {
      const planned = Math.round(p.plan * (0.8 + r() * 0.4));
      const y = Math.min(1.02, p.yieldMean + (r() - 0.5) * 0.08);
      const produced = round2(planned * y);
      const actualUnit = round2(p.cost / y);
      return {
        production_date: day, branch: CK, department: 'ครัวกลาง', document_number: `PD-${day.replace(/-/g, '').slice(2)}-${i + 1}`,
        batch_number: `B${day.replace(/-/g, '').slice(2)}${i + 1}`, product: p.name, planned_qty: planned, produced_qty: produced,
        uom: p.uom, yield_pct: round2(y * 100), planned_unit_cost: p.cost, actual_unit_cost: actualUnit, total_cost: round2(produced * actualUnit),
      };
    });
  });
}

// ---------- helpers over a date range ----------
function daysIn(range) {
  const today = todayIso();
  const first = addDays(today, -HISTORY_DAYS);
  let start = range && range.start ? range.start : addDays(today, -29);
  let end = range && range.end ? range.end : today;
  if (start < first) start = first;
  if (end > today) end = today;
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}
const flat = (days, fn) => days.flatMap(fn);
const sum = (rows, f) => round2(rows.reduce((a, r) => a + (Number(typeof f === 'function' ? f(r) : r[f]) || 0), 0));
function groupBy(rows, keyFn) {
  const m = new Map();
  rows.forEach((r) => {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  });
  return m;
}
// Buckets for chart cards. Daily within FMH's 90-day limit: the dashboard
// re-buckets by week or month itself, and a weekly bucket that starts on the
// last day of a month would otherwise drag that week's sales into the wrong
// month of the monthly CK charts.
function bucketsFor(days) {
  const weekly = days.length > 92;
  return { key: (d) => (weekly ? mondayOf(d) : d) };
}

// ---------- report cards ----------
function purchaseLines(days) {
  return flat(days, purchasesOn);
}

function cogsMenuRows(days, byBranch = true) {
  const sales = flat(days, salesOn);
  const g = groupBy(sales, (s) => (byBranch ? `${s.menu.code}|${s.branch}` : s.menu.code));
  return [...g.values()].map((rows) => {
    const m = rows[0].menu;
    const qty = rows.reduce((a, r) => a + r.qty, 0);
    const sales = qty * m.price;
    const c = menuCost(m);
    const totalCost = round2(qty * c.total);
    const gp = round2(sales - totalCost);
    return {
      menu_name: m.name, sku: m.code, branch_name: byBranch ? rows[0].branch : 'ทุกสาขา', category_name: m.cat,
      total_quantity: qty, average_selling_price: m.price, average_unit_cost: c.total, total_sales: round2(sales),
      total_yield_loss_cost: round2(qty * c.yieldLoss), total_cost: totalCost, gross_profit: gp,
      gross_markup_percentage: round2((gp / totalCost) * 100), cogs_percentage: round2((totalCost / sales) * 100),
      gross_profit_percentage: round2((gp / sales) * 100),
    };
  });
}

function usageRows(days) {
  // theoretical vs actual per product × branch
  const sales = flat(days, salesOn);
  const use = new Map();
  sales.forEach((s) =>
    s.menu.rec.forEach(([name, q]) => {
      const k = `${name}|${s.branch}`;
      use.set(k, (use.get(k) || 0) + q * s.qty);
    })
  );
  return [...use.entries()].map(([k, theo]) => {
    const [name, branch] = k.split('|');
    const p = BY_NAME[name];
    const r = rng('use' + k + days[0]);
    const over = overuseOf(name, branch) + (r() - 0.5) * 0.01;
    const actual = theo * (1 + over);
    const unit = recipeUnitCost(p);
    const vq = round2(theo - actual);
    return {
      product: name, branch, department: 'ครัว', category: p.cat, uom: p.uom,
      theoretical_usage: round2(theo), actual_usage: round2(actual), variance_qty: vq,
      variance_pct: round2((vq / theo) * 100), variance_value: round2(vq * unit), sku: p.code,
    };
  });
}

function creditNotes(days) {
  const lines = purchaseLines(days).filter((l) => l.invoice_number && l.invoice_quantity > l.grn_quantity);
  return lines
    .filter((l) => rng('cn' + l.po_number + l.product_code)() < 0.6)
    .map((l, i) => {
      const r = rng('cnamt' + l.po_number + l.product_code);
      const over = round2((l.invoice_quantity - l.grn_quantity) * l.invoice_price);
      const amount = round2(over * (r() < 0.75 ? 1 : 0.5));
      const date = addDays(l.invoice_date, 3);
      return {
        branch_name: l.branch, department_name: 'ครัว', credit_note_number: `CN-${l.po_number.slice(2)}-${i}`,
        credit_note_amount: amount, credit_note_date: `${date} 10:00:00`, credit_note_reason: 'SHORT_DELIVERY',
        credit_note_reason_readable: 'ส่งของไม่ครบ', invoice_number: l.invoice_number, invoice_date: `${l.invoice_date} 09:00:00`,
        product_name: l.product_name, product_code: l.product_code, quantity: round2(l.invoice_quantity - l.grn_quantity),
        price: l.invoice_price, total: amount, do_quantity: l.do_quantity, do_price: l.do_price, do_total: l.do_total,
        invoice_quantity: l.invoice_quantity, invoice_price: l.invoice_price, invoice_total: l.invoice_total,
        supplier_name: l.supplier, status: r() < 0.55 ? 'UNUTILIZED' : 'UTILIZED', currency: 'THB', credit_note_pk: String(hash(l.po_number + i)),
        _date: date,
      };
    })
    .filter((c) => c._date <= todayIso())
    .map(({ _date, ...c }) => c);
}

function stockCounts(days) {
  const out = [];
  days.filter((d) => weekday(d) === 1).forEach((d) => {
    [CK, ...BRANCHES].forEach((b) => {
      const r = rng('count' + d + b);
      ['กุ้งขาว', 'หมูสับ', 'อกไก่', 'ข้าวหอมมะลิ', 'น้ำมันพืช', 'ไข่ไก่', 'กะทิ', 'มะนาว'].forEach((name, i) => {
        if (r() < 0.35) return;
        const p = BY_NAME[name];
        const sys = p.uom === 'kg' || p.uom === 'ลิตร' ? round2(5 + r() * 40) : Math.round(20 + r() * 300);
        const drift = name === 'กุ้งขาว' && b === 'สาขา รังสิต' ? -0.12 : (r() - 0.6) * 0.06;
        const counted = p.uom === 'kg' || p.uom === 'ลิตร' ? round2(sys * (1 + drift)) : Math.round(sys * (1 + drift));
        const unit = recipeUnitCost(p);
        out.push({
          count_date: d, branch: b, product: name, counted_by: pick(r, ['สุดา', 'วิชัย', 'มาลี']), system_quantity: sys,
          counted_quantity: counted, variance_qty: round2(counted - sys), variance_value: round2((counted - sys) * unit),
          document_number: `SC-${d.replace(/-/g, '').slice(2)}-${i}`, item_code: p.code, category: p.cat, department: 'ครัว',
          uom: p.uom, unit_cost: unit, count_value: round2(counted * unit),
        });
      });
    });
  });
  return out;
}

function batches(days) {
  const today = todayIso();
  return purchaseLines(days)
    .filter((l) => l.grn_number && ['อาหารทะเล', 'เนื้อสัตว์', 'ของแห้ง', 'ไข่และนม'].includes(l.category_name))
    .map((l) => {
      const p = BY_CODE[l.product_code] || BY_NAME[l.product_name];
      const shelf = { อาหารทะเล: 4, เนื้อสัตว์: 6, ของแห้ง: 180, ไข่และนม: 21 }[l.category_name] || 30;
      const age = daysBetween(l.grn_date, today);
      const r = rng('batch' + l.po_number + l.product_code);
      const usedShare = Math.min(1, age / (shelf * (0.6 + r() * 0.5)));
      const remaining = round2(l.grn_quantity * (1 - usedShare));
      return {
        batch_number: `LOT-${l.po_number.slice(2)}-${(p && p.code) || 'X'}`, product: l.product_name, supplier: l.supplier,
        received_date: l.grn_date, expiry_date: addDays(l.grn_date, shelf), received_qty: l.grn_quantity, remaining_qty: Math.max(0, remaining),
        branch: l.branch, status: remaining > 0 ? 'ACTIVE' : 'DEPLETED', source_channel: 'GRN', uom: l.uom, sku: l.product_code, po_number: l.po_number,
      };
    });
}

// Every (report, card) → function(days, groupBy) returning rows.
const CARDS = {
  'purchase_analysis/purchase_analysis_table': (days, g) => {
    const lines = purchaseLines(days);
    if (!g) return lines;
    const key = { branch: 'branch', supplier: 'supplier', category: 'category_name', product: 'product_name' }[g];
    const outKey = { branch: 'branch', supplier: 'supplier', category: 'category_name', product: 'product_name' }[g];
    return [...groupBy(lines, (l) => l[key]).entries()].map(([k, rows]) => ({
      [outKey]: k, ...(g === 'product' ? { product_code: rows[0].product_code, uom: rows[0].uom } : {}),
      total_spend: sum(rows, 'po_total'), po_total: sum(rows, 'po_total'), grn_total: sum(rows, 'grn_total'),
      invoice_total: sum(rows, 'invoice_total'), qty: sum(rows, 'po_qty'), order_count: new Set(rows.map((r) => r.po_number)).size,
      line_count: rows.length,
    }));
  },
  'menu_and_ingredients/recipe_table': (days, g) => {
    const rows = [];
    MENUS.forEach((m) =>
      m.rec.forEach(([name, q]) => {
        const p = BY_NAME[name];
        const cost = round2(q * recipeUnitCost(p));
        const ylp = YIELD_LOSS[p.cat] || 0;
        rows.push({
          branch: CK, department: 'ครัวกลาง', menu_name: m.name, menu_code: m.code, menu_category: m.cat, ingredient_type: 'RAW',
          ingredient_name: name, ingredient_code: p.code, ingredient_category: p.cat, ingredient_qty: q, ingredient_uom: p.uom,
          yield_loss_pct: round2(ylp * 100), cost, yield_loss_cost: round2(cost * ylp), total_cost: round2(cost * (1 + ylp)),
        });
      })
    );
    if (g === 'by_menu') return [...groupBy(rows, (r) => r.menu_name).entries()].map(([k, rs]) => ({ menu_name: k, menu_code: rs[0].menu_code, menu_category: rs[0].menu_category, total_cost: sum(rs, 'total_cost'), ingredient_count: rs.length }));
    if (g === 'by_ingredient') return [...groupBy(rows, (r) => r.ingredient_name).entries()].map(([k, rs]) => ({ ingredient_name: k, ingredient_code: rs[0].ingredient_code, total_cost: sum(rs, 'total_cost'), menu_count: rs.length }));
    return rows;
  },
  'cogs/cogs_table': (days, g) => {
    if (g === 'menu') return cogsMenuRows(days, false);
    if (g === 'branch' || g === 'category' || g === 'period') {
      const rows = g === 'period' ? null : cogsMenuRows(days, true);
      if (g === 'period') {
        const b = bucketsFor(days);
        const sales = flat(days, salesOn);
        return [...groupBy(sales, (s) => b.key(s.day)).entries()].map(([k, ss]) => {
          const totalSales = sum(ss, (s) => s.qty * s.price);
          const totalCost = sum(ss, (s) => s.qty * menuCost(s.menu).total);
          return { period: k, total_sales: totalSales, total_cost: totalCost, gross_profit: round2(totalSales - totalCost), cogs_percentage: round2((totalCost / totalSales) * 100) };
        });
      }
      const key = g === 'branch' ? 'branch_name' : 'category_name';
      return [...groupBy(rows, (r) => r[key]).entries()].map(([k, rs]) => {
        const s = sum(rs, 'total_sales');
        const c = sum(rs, 'total_cost');
        return { [key]: k, total_quantity: sum(rs, 'total_quantity'), total_sales: s, total_cost: c, gross_profit: round2(s - c), cogs_percentage: round2((c / s) * 100), gross_profit_percentage: round2(((s - c) / s) * 100) };
      });
    }
    return cogsMenuRows(days, true);
  },
  'cogs/cogs_stat_total': (days) => {
    const rows = cogsMenuRows(days, false);
    const s = sum(rows, 'total_sales');
    const c = sum(rows, 'total_cost');
    return [{ total_cogs: c, total_sales: s, gross_profit: round2(s - c), cogs_percentage: round2((c / s) * 100) }];
  },
  'cogs/cogs_over_time': (days) => {
    const b = bucketsFor(days);
    const sales = flat(days, salesOn);
    return [...groupBy(sales, (s) => b.key(s.day)).entries()].sort().map(([k, ss]) => {
      const s = sum(ss, (x) => x.qty * x.price);
      const c = sum(ss, (x) => x.qty * menuCost(x.menu).total);
      return { period: k, cogs: c, sales: s, gross_profit: round2(s - c) };
    });
  },
  'cogs/cogs_low_margin_items': (days) =>
    cogsMenuRows(days, false)
      .sort((a, b) => a.gross_profit_percentage - b.gross_profit_percentage)
      .slice(0, 10)
      .map((r) => ({ menu_name: r.menu_name, gross_margin_percentage: r.gross_profit_percentage })),
  'menu_ingredients/menu_ingredients_top_ingredients': (days) => {
    const sales = flat(days, salesOn);
    const cost = new Map();
    sales.forEach((s) => s.menu.rec.forEach(([n, q]) => cost.set(n, (cost.get(n) || 0) + q * s.qty * recipeUnitCost(BY_NAME[n]))));
    return [...cost.entries()].map(([n, c]) => ({ ingredient: n, total_cost: round2(c) })).sort((a, b) => b.total_cost - a.total_cost).slice(0, 10);
  },
  'price_comparison/price_comparison_table': (days, g) => {
    const lines = purchaseLines(days).filter((l) => l.product_code);
    const rows = [...groupBy(lines, (l) => `${l.product_name}|${l.supplier}`).values()].map((ls) => {
      const sorted = [...ls].sort((a, b) => (a.order_date < b.order_date ? -1 : 1));
      const prices = ls.map((l) => l.price);
      return {
        product: ls[0].product_name, supplier: ls[0].supplier, avg_price: round2(prices.reduce((a, b) => a + b, 0) / prices.length),
        min_price: Math.min(...prices), max_price: Math.max(...prices), last_price: sorted[sorted.length - 1].price,
        purchase_count: ls.length, last_purchase_date: sorted[sorted.length - 1].order_date,
      };
    });
    if (g === 'product') {
      return [...groupBy(rows, (r) => r.product).entries()].map(([k, rs]) => ({
        product: k, min_price: Math.min(...rs.map((r) => r.min_price)), max_price: Math.max(...rs.map((r) => r.max_price)),
        avg_price: round2(rs.reduce((a, r) => a + r.avg_price * r.purchase_count, 0) / rs.reduce((a, r) => a + r.purchase_count, 0)),
        supplier_count: rs.length, purchase_count: rs.reduce((a, r) => a + r.purchase_count, 0),
      }));
    }
    return rows;
  },
  'price_comparison/price_variance_top_products': (days) =>
    CARDS['price_comparison/price_comparison_table'](days, 'product')
      .map((r) => ({ product: r.product, variance_pct: round2(((r.max_price - r.min_price) / r.min_price) * 100) }))
      .sort((a, b) => b.variance_pct - a.variance_pct)
      .slice(0, 10),
  'purchase_price_history/price_history_avg_price_over_time': (days) => {
    const b = bucketsFor(days);
    // a basket index: average of each product's price relative to its list price × 100
    return [...groupBy(purchaseLines(days).filter((l) => l.product_code), (l) => b.key(l.order_date)).entries()].sort().map(([k, ls]) => ({
      period: k,
      avg_price: round2(ls.reduce((a, l) => a + l.price, 0) / ls.length),
    }));
  },
  'purchase_order_history/po_history_orders_by_status': (days) => {
    const pos = new Map();
    purchaseLines(days).forEach((l) => pos.set(l.po_number, l.order_status));
    const counts = {};
    pos.forEach((s) => (counts[s] = (counts[s] || 0) + 1));
    counts.CANCELLED = Math.max(1, Math.round(pos.size * 0.02));
    return Object.entries(counts).map(([status, order_count]) => ({ status, order_count }));
  },
  'stock_balance/stock_balance_by_category': () => {
    const r = rng('stock' + todayIso());
    const base = { อาหารทะเล: 42000, เนื้อสัตว์: 38000, 'ผักและสมุนไพร': 9000, ของแห้ง: 61000, 'ซอสและเครื่องปรุง': 14000, ไข่และนม: 11000, เครื่องดื่ม: 18000, บรรจุภัณฑ์: 6000 };
    return Object.entries(base).map(([category, v]) => ({ category, total_stock_value: round2(v * (0.9 + r() * 0.2)) }));
  },
  'stock_card/stock_card_value_over_time': (days) => {
    const b = bucketsFor(days);
    return [...groupBy(purchaseLines(days), (l) => b.key(l.grn_date || l.order_date)).entries()].sort().map(([k, ls]) => {
      const inV = sum(ls, 'grn_total');
      const r = rng('out' + k);
      return { period: k, value_in: inV, value_out: round2(inV * (0.88 + r() * 0.1)) };
    });
  },
  'stock_wastage/wastage_over_time': (days) => {
    const b = bucketsFor(days);
    return [...groupBy(flat(days, wastageOn), (w) => b.key(w.wastage_date)).entries()].sort().map(([k, ws]) => ({ period: k, total_wastage_value: sum(ws, 'wastage_value') }));
  },
  'stock_wastage/wastage_top_products': (days) =>
    [...groupBy(flat(days, wastageOn), (w) => w.product).entries()].map(([k, ws]) => ({ product: k, total_wastage_value: sum(ws, 'wastage_value') })).sort((a, b) => b.total_wastage_value - a.total_wastage_value).slice(0, 10),
  'stock_wastage/wastage_top_outlets': (days) =>
    [...groupBy(flat(days, wastageOn), (w) => w.branch).entries()].map(([k, ws]) => ({ branch: k, total_wastage_value: sum(ws, 'wastage_value') })).sort((a, b) => b.total_wastage_value - a.total_wastage_value),
  'stock_wastage/wastage_table': (days) => flat(days, wastageOn),
  'order_items_by_branch/oibb_table': (days, g) => {
    const rows = flat(days, branchOrdersOn).map((o) => ({
      product: o.product, product_code: o.product_code, uom: o.uom, category: o.category, tags: '', branch: o.branch, ck_branch: CK,
      order_status: daysBetween(o.day, todayIso()) > 0 ? 'COMPLETED' : 'APPROVED', requested_delivery_date: o.day, quantity: o.qty,
    }));
    if (g === 'branch') return [...groupBy(rows, (r) => r.branch).entries()].map(([k, rs]) => ({ branch: k, total_quantity: sum(rs, 'quantity'), line_count: rs.length }));
    if (g === 'product') return [...groupBy(rows, (r) => r.product).entries()].map(([k, rs]) => ({ product: k, product_code: rs[0].product_code, uom: rs[0].uom, total_quantity: sum(rs, 'quantity') }));
    return rows;
  },
  'order_items_by_branch/oibb_top_branches': (days) =>
    [...groupBy(flat(days, branchOrdersOn), (o) => o.branch).entries()].map(([k, os]) => ({ branch: k, total_quantity: sum(os, 'qty') })).sort((a, b) => b.total_quantity - a.total_quantity),
  'picking/picking_over_time': (days) => {
    const b = bucketsFor(days);
    return [...groupBy(flat(days, branchOrdersOn), (o) => b.key(o.day)).entries()].sort().map(([k, os]) => ({ period: k, requested_qty: sum(os, 'qty'), picked_qty: sum(os, 'picked') }));
  },
  'picking/picking_table': (days, g) => {
    const rows = flat(days, branchOrdersOn).map((o) => ({
      issued_date: addDays(o.day, -1), order_number: o.order_number, branch: o.branch, department: 'ครัว', picker: o.picker,
      sku: o.product_code, product: o.product, category: o.category, uom: o.uom, requested_qty: o.qty, picked_qty: o.picked,
      delivery_date: o.day, order_status: 'COMPLETED', branch_code: `BR${BRANCHES.indexOf(o.branch) + 1}`, vendor_department: 'ครัวกลาง',
      requested_delivery_date: o.day, total_amount: round2(o.picked * o.unitCost), remarks: o.picked < o.qty ? 'ของไม่พอจัด' : '',
    }));
    if (g === 'branch' || g === 'picker') {
      return [...groupBy(rows, (r) => r[g]).entries()].map(([k, rs]) => {
        const req = sum(rs, 'requested_qty');
        const pk = sum(rs, 'picked_qty');
        return { [g]: k, requested_qty: req, picked_qty: pk, picked_pct: round2((pk / req) * 100), line_count: rs.length };
      });
    }
    return rows;
  },
  'product_variance/product_variance_table': (days) => usageRows(days),
  'product_variance/variance_stat_variance_value': (days) => [{ variance_value: sum(usageRows(days), 'variance_value') }],
  'product_variance/variance_stat_theoretical_usage_value': (days) => [{ theoretical_usage_value: sum(usageRows(days), (r) => r.theoretical_usage * recipeUnitCost(BY_NAME[r.product])) }],
  'product_variance/variance_stat_actual_usage_value': (days) => [{ actual_usage_value: sum(usageRows(days), (r) => r.actual_usage * recipeUnitCost(BY_NAME[r.product])) }],
  'credit_note_summary/credit_note_table': (days, g) => {
    const rows = creditNotes(days);
    if (g === 'supplier') return [...groupBy(rows, (r) => r.supplier_name).entries()].map(([k, rs]) => ({ supplier: k, total_amount: sum(rs, 'credit_note_amount'), credit_note_count: rs.length }));
    return rows;
  },
  'credit_note_summary/credit_note_stat_unutilized_amount': (days) => [{ unutilized_amount: sum(creditNotes(days).filter((c) => c.status === 'UNUTILIZED'), 'credit_note_amount') }],
  'stock_count/stock_count_table': (days, g) => {
    const rows = stockCounts(days);
    if (g === 'product' || g === 'branch') {
      return [...groupBy(rows, (r) => r[g]).entries()].map(([k, rs]) => ({ [g]: k, variance_value: sum(rs, 'variance_value'), variance_qty: sum(rs, 'variance_qty'), times_counted: rs.length }));
    }
    return rows;
  },
  'production_history/production_history_table': (days, g) => {
    const rows = flat(days, productionOn);
    if (g === 'product' || g === 'branch') {
      return [...groupBy(rows, (r) => r[g]).entries()].map(([k, rs]) => ({
        [g]: k, yield_pct: round2((sum(rs, 'produced_qty') / sum(rs, 'planned_qty')) * 100), production_count: rs.length,
        planned_qty: sum(rs, 'planned_qty'), produced_qty: sum(rs, 'produced_qty'),
      }));
    }
    return rows;
  },
  'batch_tracing/batch_tracing_table': (days, g) => {
    const rows = batches(days);
    if (g === 'product' || g === 'supplier') {
      return [...groupBy(rows, (r) => r[g]).entries()].map(([k, rs]) => ({ [g]: k, total_received_qty: sum(rs, 'received_qty'), total_remaining_qty: sum(rs, 'remaining_qty'), batch_count: rs.length }));
    }
    return rows;
  },
};

// The demo stand-in for lib/fmh.js callReport: same request body, same
// response shape ({ data }), no quota block (nothing is being spent).
function respond(reportKey, cardKey, body = {}) {
  const fn = CARDS[`${reportKey}/${cardKey}`];
  if (!fn) {
    const err = new Error(`Demo data has no ${reportKey}/${cardKey}`);
    err.code = 'DEMO_NO_CARD';
    throw err;
  }
  const range = (body.filters && body.filters.date_range) || null;
  let rows = fn(daysIn(range), body.group_by || null);
  // purchase / branch-order reports honour the status filter the app sends
  if (body.filters && Array.isArray(body.filters.statuses) && rows.length && 'order_status' in rows[0]) {
    rows = rows.filter((r) => body.filters.statuses.includes(r.order_status));
  }
  const offset = Number(body.offset) || 0;
  const limit = Number(body.limit) || 500;
  return { data: rows.slice(offset, offset + limit), demo: true };
}

module.exports = { respond, CARDS, _internals: { purchasesOn, salesOn, daysIn, todayIso, addDays } };
