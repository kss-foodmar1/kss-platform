// Auto PAR Level (lib/parLevel.js): usage per ingredient × branch from POS ×
// recipes, checked against numbers worked out by hand. Pure — no DB, no server.
const par = require('../lib/parLevel');
let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };
const near = (a, b, e = 0.001) => Math.abs(a - b) <= e;

// 28 days ending Sun 2026-11-01 (2026-10-05 is a Monday, so Monday..Sunday x4).
const days = [];
for (let i = 0; i < 28; i++) days.push(new Date(Date.UTC(2026, 9, 5 + i)).toISOString().slice(0, 10));
const menus = new Map([
  ['ผัดกะเพรา', { name: 'ผัดกะเพรา' }],
  ['ต้มยำ', { name: 'ต้มยำ' }],
]);
const resolve = (name) => (menus.has(name) ? { status: 'matched', menu: menus.get(name) } : name === 'ค่าส่ง' ? { status: 'ignored' } : { status: 'unmatched' });
const recipeRows = [
  // กะเพรา: 0.2 kg pork (written in kg), 50 g basil with 20% yield loss
  { menu_name: 'ผัดกะเพรา', branch: 'HQ', ingredient_code: 'PORK', ingredient_name: 'หมูสับ', ingredient_category: 'Meat', ingredient_qty: 0.2, ingredient_uom: 'kg', yield_loss_pct: 0 },
  { menu_name: 'ผัดกะเพรา', branch: 'HQ', ingredient_code: 'BASIL', ingredient_name: 'กะเพรา', ingredient_category: 'Veg', ingredient_qty: 50, ingredient_uom: 'g', yield_loss_pct: 20 },
  // ต้มยำ: 100 g pork (in g), 1 piece lime
  { menu_name: 'ต้มยำ', branch: 'HQ', ingredient_code: 'PORK', ingredient_name: 'หมูสับ', ingredient_category: 'Meat', ingredient_qty: 100, ingredient_uom: 'g', yield_loss_pct: 0 },
  { menu_name: 'ต้มยำ', branch: 'HQ', ingredient_code: 'LIME', ingredient_name: 'มะนาว', ingredient_category: 'Veg', ingredient_qty: 1, ingredient_uom: 'PIECE', yield_loss_pct: 0 },
  // the same menu listed again for another branch must not double the usage
  { menu_name: 'ผัดกะเพรา', branch: 'OTHER', ingredient_code: 'PORK', ingredient_name: 'หมูสับ', ingredient_category: 'Meat', ingredient_qty: 0.2, ingredient_uom: 'kg', yield_loss_pct: 0 },
];
// Branch A: 10 กะเพรา + 4 ต้มยำ every day, but 20 กะเพรา on Saturdays and nothing on Sundays.
const posLines = [];
days.forEach((d) => {
  const wd = (new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7; // Mon 0 … Sun 6
  if (wd === 6) return; // closed Sunday
  posLines.push({ sale_date: d, branch: 'A', menu_name: 'ผัดกะเพรา', qty: wd === 5 ? 20 : 10, net_sales: 1000 });
  posLines.push({ sale_date: d, branch: 'A', menu_name: 'ต้มยำ', qty: 4, net_sales: 400 });
});
posLines.push({ sale_date: days[27], branch: 'A', menu_name: 'ค่าส่ง', qty: 1, net_sales: 50 });
posLines.push({ sale_date: days[3], branch: 'A', menu_name: 'เมนูไม่รู้จัก', qty: 3, net_sales: 300 });

// Order units from the purchase data: pork bought by the KG, basil by an unreadable "ถุง", lime by the piece.
const orderHints = new Map([
  ['PORK', { uom: 'KG', name: 'หมูสับ' }],
  ['BASIL', { uom: 'ถุง', name: 'ใบกะเพรา' }],
  ['LIME', { uom: 'PIECE', name: 'มะนาว' }],
]);
const out = par.compute({ posLines, recipeRows, resolve, orderHints });
const row = (code) => out.rows.find((r) => r.ingredient_code === code && r.branch === 'A');

// Per-week usage of pork: กะเพรา (10×5 weekdays + 20 Sat) = 70 servings × 200 g = 14,000 g;
// ต้มยำ 4 × 6 days = 24 servings × 100 g = 2,400 g → 16,400 g/week, 65,600 g in 28 days.
const pork = row('PORK');
check('pork in grams, kg and g lines add up (65,600 g over 28 days)', pork && near(pork.total_qty, 65600), JSON.stringify(pork));
check('pork average = 65,600 / 28 days (the closed Sundays count as zero)', pork && near(pork.avg_daily, 2342.857), pork && pork.avg_daily);
check('pork unit is g', pork && pork.uom === 'g');
// Peak weekday = Saturday: กะเพรา 20×200 + ต้มยำ 4×100 = 4,400 g
check('pork peak is Saturday at 4,400 g', pork && pork.peak_weekday === 6 && near(pork.peak_daily, 4400), pork && `${pork.peak_weekday} ${pork.peak_daily}`);
// Basil: 50 g × 1.2 yield = 60 g per serving; 70 servings/week × 4 weeks = 280 → 16,800 g
check('basil includes the 20% yield loss (16,800 g)', row('BASIL') && near(row('BASIL').total_qty, 16800), JSON.stringify(row('BASIL')));
check('pieces stay pieces: lime 24 × 4 = 96', row('LIME') && row('LIME').uom === 'PIECE' && near(row('LIME').total_qty, 96));
check('a menu repeated for another branch is not double counted', pork && pork.menus === 2);
check('one row per ingredient × branch', out.rows.length === 3, out.rows.length);
check('window is 28 days ending on the last sale', out.meta.par.from === days[0] && out.meta.par.to === days[27]);
check('unmatched menu counted, delivery fee ignored', out.meta.par.unmatched_menus === 1);
// matched 1000×24 + 400×24 = 33,600 of food 33,900 (the unmatched 300 is food; the fee is not)
check('coverage % = matched ÷ food sales', near(out.meta.par.coverage_pct, 99.1, 0.06), out.meta.par.coverage_pct);

check('pork order unit: 1 KG = 1,000 g', pork.order_uom === 'KG' && pork.order_ratio === 1000, JSON.stringify(pork));
check('basil order unit unknown (ถุง says nothing about size)', row('BASIL').order_uom === 'ถุง' && row('BASIL').order_ratio === null);
check('pieces ordered by the piece: ratio 1', row('LIME').order_ratio === 1);
check('no purchase data → no order unit', par.compute({ posLines, recipeRows, resolve }).rows[0].order_uom === null);
check('pack size in the product name (500 กรัม/แพ็ค) gives the ratio', par.orderUnitOf('PACK', 'กุ้ง 500 กรัม/แพ็ค', 'g') === 500);
check('BAG (5KG) read as 5,000 g, and not for a volume ingredient', par.orderUnitOf('BAG (5KG)', '', 'g') === 5000 && par.orderUnitOf('BAG (5KG)', '', 'ml') === null);
check('litres to ml', par.orderUnitOf('ขวด', 'น้ำมัน 1 ลิตร/ขวด', 'ml') === 1000);
// closed Sundays: 28 calendar days; 24 trading days + the last Sunday, which has one delivery-fee line (a POS line is a trading day)
check('days with no sales counted: 3 closed Sundays', pork.days === 28 && pork.sales_days === 25 && pork.missing_days === 3, JSON.stringify(pork));

// A branch that opened 7 days before the end is averaged over its own 7 days.
const young = par.compute({
  posLines: days.slice(21).map((d) => ({ sale_date: d, branch: 'B', menu_name: 'ต้มยำ', qty: 7, net_sales: 700 })).concat(posLines.slice(0, 2)),
  recipeRows, resolve,
});
const lime = young.rows.find((r) => r.branch === 'B' && r.ingredient_code === 'LIME');
check('new branch averaged over its own days (7 × 7 / 7 = 7 limes a day)', lime && lime.days === 7 && near(lime.avg_daily, 7), JSON.stringify(lime));

// Lead-time hints ride along when given.
const hinted = par.compute({ posLines, recipeRows, resolve, leadHints: new Map([['PORK', { days: 2, n: 9 }]]) });
check('observed lead time attached to the matching ingredient', hinted.rows.find((r) => r.ingredient_code === 'PORK').obs_lead_days === 2);
check('no sales at all → nothing to build', par.compute({ posLines: [], recipeRows, resolve }) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
