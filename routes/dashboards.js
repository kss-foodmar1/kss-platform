// Client-facing dashboard API.
//
//   GET  /api/dashboards                  dashboards this user can see (tabs)
//   GET  /api/dashboards/:id              one dashboard + its widgets
//   GET  /api/dashboards/:id/data/:source cached data for one report source
//                                         (?group= for a server-side grouping)
//   POST /api/dashboards/:id/refresh      on-demand FMH re-sync of its sources
//
// Visibility: KSS staff see any company's dashboards (pass ?company_id=);
// company_admin sees all of their own company's; client sees only the ones
// granted to them. Data is only ever served from the per-company cache.
const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { wrap, isSuperadmin, resolveCompanyId, getDashboardForUser } = require('../lib/access');
const { FMH_REPORTS, getCached, syncOne, cacheKeyFor } = require('../lib/fmhCache');
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
      // A widget reading a server-side grouping pulls from its own cache entry,
      // so the client fetches per (source, grouping), not per source.
      const grouping = cfg && cfg.groupings.includes(w.config.group_by) ? w.config.group_by : null;
      w.grouping = grouping;
      sources[cacheKeyFor(w.report_source, grouping)] = {
        source: w.report_source,
        grouping,
        label: cfg ? cfg.label : w.report_source,
        // Grouped rows are already aggregated over the window, so there is no
        // per-row date left for the range picker to filter on.
        date_field: grouping ? null : cfg ? cfg.dateField : null,
      };
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
    const cfg = FMH_REPORTS[source] || {};
    const grouping = req.query.group && (cfg.groupings || []).includes(req.query.group) ? req.query.group : null;
    if (req.query.group && !grouping) return res.status(400).json({ error: 'ไม่รู้จักการจัดกลุ่มนี้' });

    // Only sources this dashboard actually shows — access to one dashboard
    // doesn't open up every report the company has cached.
    const [[used]] = await pool.query(
      `SELECT 1 AS ok FROM dashboard_widgets w JOIN widget_templates t ON t.id = w.widget_template_id
       WHERE w.dashboard_id = ? AND t.report_source = ? LIMIT 1`,
      [dashboard.id, source]
    );
    if (!used) return res.status(404).json({ error: 'dashboard นี้ไม่ได้ใช้รายงานนี้' });

    const cached = await getCached(dashboard.company_id, source, grouping);
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
      meta: {
        quota: cached.quota,
        synced_at: cached.syncedAt,
        grouping,
        date_field: grouping ? null : cfg.dateField || null,
      },
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

    const widgets = await listWidgets(dashboard.id);
    const pulls = new Map();
    widgets.forEach((w) => {
      const cfg = FMH_REPORTS[w.report_source];
      if (!cfg) return;
      const grouping = cfg.groupings.includes(w.config.group_by) ? w.config.group_by : null;
      pulls.set(cacheKeyFor(w.report_source, grouping), { source: w.report_source, grouping });
    });

    const results = {};
    let refreshed = 0;
    let shortestWaitMs = Infinity;
    for (const { source, grouping } of pulls.values()) {
      const key = cacheKeyFor(source, grouping);
      const [[row]] = await pool.query(
        `SELECT synced_at FROM fmh_report_cache WHERE company_id = ? AND cache_key = ?`,
        [dashboard.company_id, key]
      );
      const elapsed = row ? Date.now() - new Date(row.synced_at).getTime() : Infinity;
      if (elapsed < REFRESH_COOLDOWN_MS) {
        shortestWaitMs = Math.min(shortestWaitMs, REFRESH_COOLDOWN_MS - elapsed);
        results[key] = { ok: false, skipped: true };
        continue;
      }
      try {
        const { data } = await syncOne(dashboard.company_id, source, grouping);
        results[key] = { ok: true, rows: data.length };
        refreshed++;
      } catch (err) {
        console.error(`Manual refresh failed (company ${dashboard.company_id}, ${key}):`, err.message);
        results[key] = { ok: false, error: err.message };
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
