// Client-facing dashboard API.
//
//   GET  /api/dashboards                  dashboards this user can see (tabs)
//   GET  /api/dashboards/:id              one dashboard + its widgets
//   GET  /api/dashboards/:id/data/:source cached data for one report source
//   POST /api/dashboards/:id/refresh      on-demand FMH re-sync of its sources
//
// Visibility: KSS staff see any company's dashboards (pass ?company_id=);
// company_admin sees all of their own company's; client sees only the ones
// granted to them. Data is only ever served from the per-company cache.
const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { wrap, isSuperadmin, resolveCompanyId, getDashboardForUser } = require('../lib/access');
const { FMH_REPORTS, getCached, syncOne } = require('../lib/fmhCache');
const { listWidgets } = require('../lib/widgetCatalog');

const router = express.Router();

// A manual refresh is allowed at most this often per company + report source,
// so an "open to everyone" refresh button can't burn the monthly FMH quota.
const REFRESH_COOLDOWN_MS = 30 * 60 * 1000;

router.get(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    const companyId = resolveCompanyId(req);
    if (!companyId) return res.json({ dashboards: [] });

    let dashboards;
    if (isSuperadmin(req.user) || req.user.role === 'company_admin') {
      [dashboards] = await pool.query(
        `SELECT id, display_name, description, sort_order FROM dashboards
         WHERE company_id = ? AND active = TRUE ORDER BY sort_order, id`,
        [companyId]
      );
    } else {
      [dashboards] = await pool.query(
        `SELECT d.id, d.display_name, d.description, d.sort_order
         FROM dashboards d JOIN user_dashboard_access uda ON uda.dashboard_id = d.id
         WHERE d.company_id = ? AND d.active = TRUE AND uda.user_id = ?
         ORDER BY d.sort_order, d.id`,
        [companyId, req.user.id]
      );
    }
    res.json({ dashboards });
  })
);

router.get(
  '/:id',
  requireAuth,
  wrap(async (req, res) => {
    const dashboard = await getDashboardForUser(req.user, req.params.id);
    if (!dashboard) return res.status(404).json({ error: 'ไม่พบ dashboard นี้' });
    const widgets = await listWidgets(dashboard.id);
    const sources = {};
    widgets.forEach((w) => {
      const cfg = FMH_REPORTS[w.report_source];
      sources[w.report_source] = { label: cfg ? cfg.label : w.report_source, date_field: cfg ? cfg.dateField : null };
    });
    res.json({ dashboard, widgets, sources });
  })
);

router.get(
  '/:id/data/:source',
  requireAuth,
  wrap(async (req, res) => {
    const dashboard = await getDashboardForUser(req.user, req.params.id);
    if (!dashboard) return res.status(404).json({ error: 'ไม่พบ dashboard นี้' });
    const { source } = req.params;
    // Only sources this dashboard actually shows — access to one dashboard
    // doesn't open up every report the company has cached.
    const [[used]] = await pool.query(
      `SELECT 1 AS ok FROM dashboard_widgets w JOIN widget_templates t ON t.id = w.widget_template_id
       WHERE w.dashboard_id = ? AND t.report_source = ? LIMIT 1`,
      [dashboard.id, source]
    );
    if (!used) return res.status(404).json({ error: 'dashboard นี้ไม่ได้ใช้รายงานนี้' });

    const cached = await getCached(dashboard.company_id, source);
    const cfg = FMH_REPORTS[source] || {};
    if (!cached) {
      const [[company]] = await pool.query(`SELECT fmh_api_key_enc FROM companies WHERE id = ?`, [dashboard.company_id]);
      return res.status(409).json({
        error: company && company.fmh_api_key_enc
          ? 'ยังไม่มีข้อมูล — ระบบจะ sync ให้ตอนตี 1 หรือกด Refresh ด่วนได้เลย'
          : 'ยังไม่ได้ตั้งค่า FMH API Key ของบริษัทนี้',
        code: company && company.fmh_api_key_enc ? 'FMH_NOT_SYNCED' : 'FMH_KEY_MISSING',
      });
    }
    res.json({
      data: cached.data,
      meta: { quota: cached.quota, synced_at: cached.syncedAt, date_field: cfg.dateField || null },
    });
  })
);

router.post(
  '/:id/refresh',
  requireAuth,
  wrap(async (req, res) => {
    const dashboard = await getDashboardForUser(req.user, req.params.id);
    if (!dashboard) return res.status(404).json({ error: 'ไม่พบ dashboard นี้' });

    const [[company]] = await pool.query(`SELECT fmh_api_key_enc FROM companies WHERE id = ?`, [dashboard.company_id]);
    if (!company || !company.fmh_api_key_enc) {
      return res.status(409).json({ error: 'ยังไม่ได้ตั้งค่า FMH API Key ของบริษัทนี้', code: 'FMH_KEY_MISSING' });
    }

    const [srcRows] = await pool.query(
      `SELECT DISTINCT t.report_source FROM dashboard_widgets w
       JOIN widget_templates t ON t.id = w.widget_template_id WHERE w.dashboard_id = ?`,
      [dashboard.id]
    );
    const sources = srcRows.map((r) => r.report_source).filter((s) => FMH_REPORTS[s]);

    const results = {};
    let refreshed = 0;
    let shortestWaitMs = Infinity;
    for (const source of sources) {
      const [[row]] = await pool.query(
        `SELECT synced_at FROM fmh_report_cache WHERE company_id = ? AND cache_key = ?`,
        [dashboard.company_id, source]
      );
      const elapsed = row ? Date.now() - new Date(row.synced_at).getTime() : Infinity;
      if (elapsed < REFRESH_COOLDOWN_MS) {
        shortestWaitMs = Math.min(shortestWaitMs, REFRESH_COOLDOWN_MS - elapsed);
        results[source] = { ok: false, skipped: true };
        continue;
      }
      try {
        const { data } = await syncOne(dashboard.company_id, source);
        results[source] = { ok: true, rows: data.length };
        refreshed++;
      } catch (err) {
        console.error(`Manual refresh failed (company ${dashboard.company_id}, ${source}):`, err.message);
        results[source] = { ok: false, error: err.message };
      }
    }

    if (!refreshed && shortestWaitMs !== Infinity && Object.values(results).every((r) => r.skipped)) {
      const waitMin = Math.ceil(shortestWaitMs / 60000);
      return res.status(429).json({
        error: `เพิ่งอัปเดตไปเมื่อครู่ รออีก ${waitMin} นาทีถึงจะ refresh ใหม่ได้`,
        code: 'REFRESH_COOLDOWN',
      });
    }
    const failed = Object.entries(results).filter(([, r]) => r.error);
    if (failed.length && !refreshed) {
      return res.status(502).json({ error: `FMH API error: ${failed[0][1].error}`, results });
    }
    res.json({ ok: true, results });
  })
);

module.exports = router;
