// Serves report data. price_change is still MOCK data shaped exactly like
// the real FMH purchase_price_history catalog response.
//
// Every other report below is backed by real FMH data, but — unlike the
// early version of this file — NOT fetched live from FMH on every page view.
// FMH's monthly row quota gets burned fast once more than one person opens
// these tabs, so reports are synced into fmh_report_cache once a day (cron in
// server.js) plus on-demand via the /refresh endpoint below, and every GET
// here just reads that cache. See lib/fmhCache.js for the sync logic.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const pool = require('../db/pool');
const { getApiKey } = require('../lib/fmh');
const { FMH_REPORTS, getCached, syncOne } = require('../lib/fmhCache');

const router = express.Router();

// Per-report field to filter the cached (90-day) rows by, when the frontend
// sends ?start&end — lets the date-range picker still narrow results without
// any FMH call. Reports with no per-row date field (cogs is pre-aggregated by
// FMH server-side, menu_and_ingredients has no date_range support at all)
// just ignore start/end and return the full cached window.
const DATE_FIELDS = {
  'sales-by-branch': 'requested_delivery_date',
  'purchase-analysis': 'order_date',
};

// A manual refresh is allowed at most this often per report, so an "open to
// everyone" refresh button can't burn through the monthly quota the way
// unrestricted live-on-every-view calls did.
const REFRESH_COOLDOWN_MS = 30 * 60 * 1000;

function makeCachedReportHandler(cacheKey) {
  return async (req, res) => {
    try {
      const cached = await getCached(cacheKey);
      if (!cached) {
        // Distinguish "key not set up yet" from "just hasn't synced yet" so
        // the frontend can point the admin at the right fix.
        try {
          await getApiKey();
        } catch (err) {
          if (err.code === 'FMH_KEY_MISSING') {
            return res.status(409).json({ error: err.message, code: err.code });
          }
          throw err;
        }
        return res.status(409).json({
          error: 'ยังไม่มีข้อมูล sync — ระบบจะ sync รอบแรกให้อัตโนมัติเร็ว ๆ นี้ หรือกด Refresh ด่วนได้เลย',
          code: 'FMH_NOT_SYNCED',
        });
      }

      let data = cached.data;
      const dateField = DATE_FIELDS[cacheKey];
      const { start, end } = req.query;
      if (dateField && start && end) {
        data = data.filter((r) => {
          const d = r[dateField];
          return d && d >= start && d <= end;
        });
      }

      res.json({
        data,
        pagination: { limit: data.length, offset: 0, returned: data.length },
        meta: { mock: false, quota: cached.quota, synced_at: cached.syncedAt },
      });
    } catch (err) {
      console.error(`Serving cached FMH report "${cacheKey}" failed:`, err.message);
      res.status(500).json({ error: 'โหลดข้อมูลไม่สำเร็จ' });
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

// ---------- Real FMH-backed reports (served from the daily cache) ----------
// cogs: Central Kitchen COGS — menu sales/cost/margin across outlets.
router.get('/cogs', requireAuth, makeCachedReportHandler('cogs'));

// menu_and_ingredients: recipe (BOM) composition and implied cost per menu item.
router.get('/menu-costing', requireAuth, makeCachedReportHandler('menu-costing'));

// order_items_by_branch: outlet ordering patterns (used here as "Sales by Branch"
// — FMH has no province/geographic breakdown, only branch/department).
router.get('/sales-by-branch', requireAuth, makeCachedReportHandler('sales-by-branch'));

// purchase_analysis: PO/GRN/Invoice comparison.
router.get('/purchase-analysis', requireAuth, makeCachedReportHandler('purchase-analysis'));

// On-demand refresh — open to any logged-in user (not just admins), but only
// for a report whose dashboard tab they're actually allowed to see, and rate
// limited per report so it can't be used to burn through the monthly quota.
router.post('/:cacheKey/refresh', requireAuth, async (req, res) => {
  const { cacheKey } = req.params;
  const cfg = FMH_REPORTS[cacheKey];
  if (!cfg) return res.status(404).json({ error: 'ไม่รู้จักรายงานนี้' });

  if (req.user.role !== 'admin') {
    const [[access]] = await pool.query(
      `SELECT 1 FROM user_dashboard_access uda
       JOIN dashboards d ON d.id = uda.dashboard_id
       WHERE uda.user_id = ? AND d.dashboard_key = ?`,
      [req.user.id, cfg.dashboardKey]
    );
    if (!access) return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึง dashboard นี้' });
  }

  const [[row]] = await pool.query(`SELECT synced_at FROM fmh_report_cache WHERE cache_key = ?`, [cacheKey]);
  if (row) {
    const elapsedMs = Date.now() - new Date(row.synced_at).getTime();
    if (elapsedMs < REFRESH_COOLDOWN_MS) {
      const waitMin = Math.ceil((REFRESH_COOLDOWN_MS - elapsedMs) / 60000);
      return res.status(429).json({
        error: `เพิ่งอัปเดตไปเมื่อครู่ รออีก ${waitMin} นาทีถึงจะ refresh ใหม่ได้`,
        code: 'REFRESH_COOLDOWN',
        retry_after_seconds: Math.ceil((REFRESH_COOLDOWN_MS - elapsedMs) / 1000),
      });
    }
  }

  try {
    const { data, quota } = await syncOne(cacheKey);
    res.json({ ok: true, synced_at: new Date().toISOString(), rows: data.length, quota });
  } catch (err) {
    if (err.code === 'FMH_KEY_MISSING') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    console.error(`Manual refresh failed for "${cacheKey}":`, err.message);
    res.status(502).json({ error: `FMH API error: ${err.message}`, code: err.code || 'FMH_API_ERROR' });
  }
});

module.exports = router;
