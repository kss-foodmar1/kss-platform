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
const { callReport } = require('../lib/fmh');

const router = express.Router();

// Shared handler for the 3 real-FMH reports below: builds a date_range filter
// from ?start&end (when the report supports one), calls FMH, and returns the
// same {data, pagination, meta} shape the frontend already expects.
function makeFmhReportHandler(reportKey, cardKey, { supportsDateRange = true } = {}) {
  return async (req, res) => {
    const { start, end } = req.query;
    const filters = {};
    if (supportsDateRange && start && end) {
      // Confirmed via FMH's own docs (llms.txt): {"filters":{"date_range":
      // {"start":"YYYY-MM-DD","end":"YYYY-MM-DD"}}} — NOT start_date/end_date.
      filters.date_range = { start, end };
    }
    try {
      const result = await callReport(reportKey, cardKey, { filters });
      res.json({
        data: result.data || [],
        pagination: result.pagination || { limit: 500, offset: 0, returned: (result.data || []).length },
        meta: { mock: false, quota: result.quota || null },
      });
    } catch (err) {
      if (err.code === 'FMH_KEY_MISSING') {
        return res.status(409).json({ error: err.message, code: err.code });
      }
      console.error(`FMH report ${reportKey} failed:`, err.message, err.details || '');
      res.status(502).json({ error: `FMH API error: ${err.message}`, code: err.code || 'FMH_API_ERROR' });
    }
  };
}

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

// ---------- Real FMH-backed reports ----------
// cogs: Central Kitchen COGS — menu sales/cost/margin across outlets.
router.get('/cogs', requireAuth, makeFmhReportHandler('cogs', 'cogs_table'));

// menu_and_ingredients: recipe (BOM) composition and implied cost per menu item.
// No date_range filter on this report per FMH's catalog.
router.get(
  '/menu-costing',
  requireAuth,
  makeFmhReportHandler('menu_and_ingredients', 'recipe_table', { supportsDateRange: false })
);

// order_items_by_branch: outlet ordering patterns (used here as "Sales by Branch"
// — FMH has no province/geographic breakdown, only branch/department).
router.get('/sales-by-branch', requireAuth, makeFmhReportHandler('order_items_by_branch', 'oibb_table'));

// purchase_analysis: PO/GRN/Invoice comparison — real FMH data (confirmed
// working via Swagger with no card_key needed for this report).
router.get('/purchase-analysis', requireAuth, makeFmhReportHandler('purchase_analysis', null));

module.exports = router;
