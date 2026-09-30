// Serves report data. For this demo, price_change is MOCK data shaped
// exactly like the real FMH purchase_price_history catalog response
// (verified live via Swagger UI on v10-core-be.foodmarkethub.com). Swapping
// this for the real FMH call later means replacing generateMockPriceChange()
// with an authenticated POST to
// https://v10-core-be.foodmarkethub.com/v1/public/reports/catalog/purchase_price_history
// — the response shape below already matches, so the frontend does not
// need to change.
const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const SUPPLIERS = [
  'ตลาดสี่มุมเมือง [Si Mum Mueang Market]',
  'ตลาดไท [Talaad Thai]',
  'บริษัท ซีพี ออลล์ จำกัด',
  'Makro Food Service',
];

const PRODUCTS = [
  { name: 'Plum Juice Soda', code: 'COK-001', uom: 'PACK (12CAN)', category: 'Beverage' },
  { name: 'Jasmine Rice 5kg', code: 'RIC-014', uom: 'BAG', category: 'Dry Goods' },
  { name: 'Chicken Breast', code: 'MEA-002', uom: 'KG', category: 'Meat' },
  { name: 'Palm Oil 1L', code: 'OIL-007', uom: 'BOTTLE', category: 'Cooking Oil' },
  { name: 'Fresh Milk 1L', code: 'DAI-003', uom: 'CARTON', category: 'Dairy' },
  { name: 'Soy Sauce 700ml', code: 'SAU-011', uom: 'BOTTLE', category: 'Condiment' },
];

function generateMockPriceChange({ startDate, endDate, supplierFilter, search }) {
  const rows = [];
  let seed = 42;
  const rand = () => {
    // deterministic pseudo-random so the demo looks the same every load
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  PRODUCTS.forEach((product, i) => {
    const supplier = SUPPLIERS[i % SUPPLIERS.length];
    if (supplierFilter && supplierFilter.length && !supplierFilter.includes(supplier)) return;
    if (search && !product.name.toLowerCase().includes(search.toLowerCase())) return;

    const basePrice = 50 + rand() * 200;
    const prevPrice = basePrice * (0.85 + rand() * 0.3);
    const variance = basePrice - prevPrice;
    const variancePct = (variance / prevPrice) * 100;

    rows.push({
      product: product.name,
      product_code: product.code,
      uom: product.uom,
      product_category: product.category,
      supplier,
      branch: i % 2 === 0 ? 'กรุงเทพ (BKK Branch)' : 'เชียงใหม่ (CNX Branch)',
      order_date: endDate,
      unit_price: Math.round(basePrice * 100) / 100,
      previous_unit_price: Math.round(prevPrice * 100) / 100,
      variance_amount: Math.round(variance * 100) / 100,
      variance: Math.round(variancePct * 100) / 100,
    });
  });

  return rows;
}

router.get('/price-change', requireAuth, async (req, res) => {
  const { start, end, supplier, search, sort_by, sort_dir } = req.query;

  const startDate = start || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const endDate = end || new Date().toISOString().slice(0, 10);
  const supplierFilter = supplier ? String(supplier).split(',') : null;

  let rows = generateMockPriceChange({ startDate, endDate, supplierFilter, search });

  if (sort_by && rows[0] && sort_by in rows[0]) {
    const dir = sort_dir === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      if (a[sort_by] < b[sort_by]) return -1 * dir;
      if (a[sort_by] > b[sort_by]) return 1 * dir;
      return 0;
    });
  }

  res.json({
    data: rows,
    pagination: { limit: rows.length, offset: 0, returned: rows.length },
    meta: { mock: true, note: 'Mock data — real FMH integration pending' },
  });
});

router.get('/price-change/suppliers', requireAuth, async (req, res) => {
  res.json({ suppliers: SUPPLIERS });
});

module.exports = router;
