// Client-facing dashboard API.
//
//   GET  /api/dashboards                  dashboards this user can see (tabs)
//   GET  /api/dashboards/:id              one dashboard + its widgets
//   GET  /api/dashboards/:id/data/:source cached data for one report source
//                                         (?group= for a server-side grouping)
//   POST /api/dashboards/:id/refresh      on-demand FMH re-sync of its sources
//   PUT  /api/dashboards/:id/widgets/:wid/prefs  this viewer's own table layout and pins
//
// Visibility: KSS staff see any company's dashboards (pass ?company_id=);
// company_admin sees all of their own company's; client sees only the ones
// granted to them. Data is only ever served from the per-company cache.
const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { wrap, isSuperadmin, resolveCompanyId, getDashboardForUser } = require('../lib/access');
const { FMH_REPORTS, getCached, getSaved, getSyncHealth, syncOne, cacheKeyFor, pullsForWidget, touchCompanyView } = require('../lib/fmhCache');
const { withTrigger } = require('../lib/fmhUsage');
const { listWidgets } = require('../lib/widgetCatalog');
const fmhFiles = require('../lib/fmhFiles');

const router = express.Router();

// Which (source, grouping) pulls the page fetches, and the pull aliases of
// each widget. Shared by a real dashboard and the library's one-widget preview.
function describeWidgets(widgets) {
  const sources = {};
  const describe = (p) => {
    const cfg = FMH_REPORTS[p.source];
    sources[cacheKeyFor(p.source, p.grouping)] = {
      source: p.source,
      grouping: p.grouping,
      label: cfg ? cfg.label : p.source,
      // Grouped rows are already aggregated over the window, so there is no
      // per-row date left for the range picker to filter on.
      date_field: p.grouping ? null : cfg ? cfg.rowDateField || cfg.dateField : null,
      date_is_bucket: !p.grouping && !!(cfg && cfg.rowDateIsBucket),
    };
  };
  widgets.forEach((w) => {
    const pulls = pullsForWidget(w.report_source, w.config);
    pulls.forEach(describe);
    // A widget reading a server-side grouping pulls from its own cache entry,
    // so the client fetches per (source, grouping), not per source. A pivot
    // widget reads several, and names them by the aliases its config gave.
    const own = pulls.find((p) => p.source === w.report_source) || pulls[0] || {};
    w.grouping = own.grouping || null;
    // Resolved from each declared source, not by indexing into `pulls` —
    // that list is de-duplicated, so two aliases on the same pull would have
    // shifted every alias after them onto the wrong data.
    w.pulls = (w.config.sources || []).length
      ? w.config.sources.map((sc) => {
          const c = FMH_REPORTS[sc.source];
          const g = c && sc.group_by && c.groupings.includes(sc.group_by) ? sc.group_by : null;
          // date_field: filter this alias on that row field for this widget only
          return { as: sc.as, key: cacheKeyFor(sc.source, g), ...(sc.date_field && !g ? { date_field: sc.date_field } : {}), ...(sc.where ? { where: sc.where, where_fallback: !!sc.where_fallback } : {}) };
        })
      : null;
  });
  return sources;
}


// A manual refresh is allowed at most this often per company + report source,
// so an "open to everyone" refresh button can't burn the monthly FMH quota.
const REFRESH_COOLDOWN_MS = 3 * 60 * 60 * 1000;

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

// ---------- one widget previewed in the Widget library ----------
// Company admins (own company) and KSS staff (?company_id=) only: the library
// is where widgets get added. Rows come from the company's own cache, so a
// demo company sees demo data and a real one sees its own.
async function previewFor(req) {
  if (!isSuperadmin(req.user) && req.user.role !== 'company_admin') return null;
  const companyId = resolveCompanyId(req);
  if (!companyId) return null;
  const [[t]] = await pool.query(
    `SELECT id, template_key, name, description, category, report_source, chart_type, default_config_json FROM widget_templates WHERE id = ? AND active = TRUE`,
    [req.params.tid]
  );
  if (!t) return null;
  let cfg = {};
  try { cfg = JSON.parse(t.default_config_json || '{}'); } catch { /* none */ }
  const widget = {
    id: `p${t.id}`, title: t.name, template_id: t.id, template_key: t.template_key, template_name: t.name,
    report_source: t.report_source, chart_type: t.chart_type, category: t.category, description: t.description,
    config: { ...cfg, size: 'full' }, config_overrides: {},
  };
  return { companyId, widget };
}

router.get(
  '/preview/:tid',
  requireAuth,
  wrap(async (req, res) => {
    const p = await previewFor(req);
    if (!p) return res.status(404).json({ error: 'ไม่พบ widget นี้' });
    const widgets = [p.widget];
    const sources = describeWidgets(widgets);
    const [[co]] = await pool.query(`SELECT data_source FROM companies WHERE id = ?`, [p.companyId]);
    res.json({
      dashboard: { id: `preview-${p.widget.template_id}`, company_id: p.companyId, display_name: p.widget.title, data_source: co ? co.data_source : 'fmh', preview: true },
      widgets,
      sources,
    });
  })
);

router.get(
  '/preview/:tid/data/:source',
  requireAuth,
  wrap(async (req, res) => {
    const p = await previewFor(req);
    if (!p) return res.status(404).json({ error: 'ไม่พบ widget นี้' });
    await serveData(req, res, p.companyId, [p.widget]);
  })
);

// "เช้านี้ต้องทำ": open alerts of the dashboard's company, most urgent first,
// and who has taken each one. Anyone who can see the dashboard may take one.
router.get(
  '/:id/today',
  requireAuth,
  wrap(async (req, res) => {
    const dashboard = await getDashboardForUser(req.user, req.params.id);
    if (!dashboard) return res.status(404).json({ error: 'ไม่พบ dashboard นี้' });
    const t = await require('../lib/alerts').today(dashboard.company_id, req.user.home_branch || null);
    const [people] = await pool.query(`SELECT display_name FROM users WHERE company_id = ? ORDER BY display_name LIMIT 100`, [dashboard.company_id]).catch(() => [[]]);
    res.json({ ...t, people: people.map((p) => p.display_name).filter(Boolean) });
  })
);
router.post(
  '/:id/today/ack',
  requireAuth,
  wrap(async (req, res) => {
    const dashboard = await getDashboardForUser(req.user, req.params.id);
    if (!dashboard) return res.status(404).json({ error: 'ไม่พบ dashboard นี้' });
    const { watcher, finding_key: key, action, to } = req.body || {};
    if (!['ack', 'assign', 'clear'].includes(action)) return res.status(400).json({ error: 'action ไม่ถูกต้อง' });
    if (action === 'assign' && !String(to || '').trim()) return res.status(400).json({ error: 'ระบุชื่อผู้รับผิดชอบ' });
    if (!watcher || !key) return res.status(400).json({ error: 'ไม่พบรายการนี้' });
    await require('../lib/alerts').ack(dashboard.company_id, String(watcher), String(key), action, to, req.user);
    res.json({ ok: true });
  })
);

router.get(
  '/:id',
  requireAuth,
  wrap(async (req, res) => {
    const dashboard = await getDashboardForUser(req.user, req.params.id);
    if (!dashboard) return res.status(404).json({ error: 'ไม่พบ dashboard นี้' });
    const widgets = await listWidgets(dashboard.id);
    const sources = describeWidgets(widgets);
    // this viewer's own arrangement of each table (columns, order, pins)
    if (widgets.length) {
      const [prefs] = await pool.query(
        `SELECT widget_id, prefs_json FROM widget_user_prefs WHERE user_id = ? AND widget_id IN (?)`,
        [req.user.id, widgets.map((w) => w.id)]
      ).catch(() => [[]]);
      const byId = new Map(prefs.map((p) => [p.widget_id, p.prefs_json]));
      widgets.forEach((w) => { try { w.my_prefs = byId.has(w.id) ? JSON.parse(byId.get(w.id)) : null; } catch (e) { w.my_prefs = null; } });
    }
    const [[co]] = await pool.query(`SELECT data_source, onboarding_json FROM companies WHERE id = ?`, [dashboard.company_id]);
    // the first-run answers pick which findings lead the page (public/app.js renderInsights)
    let profile = null;
    try { profile = co && co.onboarding_json ? JSON.parse(co.onboarding_json) : null; } catch (e) { /* none */ }
    res.json({ dashboard: { ...dashboard, data_source: co ? co.data_source : 'fmh', profile }, widgets, sources });
  })
);

// One viewer's arrangement of one table widget: { order, hidden, pins, pin_cats, pinned_only }.
// Anyone who can see the dashboard may arrange it for themselves; it changes nothing for others.
const strList = (v, max) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length <= 200).slice(0, max) : []);
router.put(
  '/:id/widgets/:wid/prefs',
  requireAuth,
  wrap(async (req, res) => {
    const dashboard = await getDashboardForUser(req.user, req.params.id);
    if (!dashboard) return res.status(404).json({ error: 'ไม่พบ dashboard นี้' });
    const [[w]] = await pool.query(`SELECT id FROM dashboard_widgets WHERE id = ? AND dashboard_id = ?`, [req.params.wid, dashboard.id]);
    if (!w) return res.status(404).json({ error: 'ไม่พบ widget นี้' });
    const p = (req.body && req.body.prefs) || {};
    if (p === null || req.body.reset) {
      await pool.query(`DELETE FROM widget_user_prefs WHERE user_id = ? AND widget_id = ?`, [req.user.id, w.id]);
      return res.json({ ok: true, prefs: null });
    }
    const clean = {
      order: strList(p.order, 60),
      hidden: strList(p.hidden, 60),
      pins: strList(p.pins, 500),
      pin_cats: strList(p.pin_cats, 100),
      pinned_only: !!p.pinned_only,
      branch: typeof p.branch === 'string' ? p.branch.slice(0, 200) : '',
    };
    await pool.query(
      `INSERT INTO widget_user_prefs (user_id, widget_id, prefs_json) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE prefs_json = VALUES(prefs_json)`,
      [req.user.id, w.id, JSON.stringify(clean)]
    );
    res.json({ ok: true, prefs: clean });
  })
);

// Cached rows of one report for a page: a dashboard, or one widget previewed
// in the library. Never spends FMH quota: only demo data, uploaded files and
// computed reports are built on view.
async function serveData(req, res, companyId, widgets) {
  const { source } = req.params;
  const cfg = FMH_REPORTS[source] || {};
  const grouping = req.query.group && (cfg.groupings || []).includes(req.query.group) ? req.query.group : null;
  if (req.query.group && !grouping) return res.status(400).json({ error: 'ไม่รู้จักการจัดกลุ่มนี้' });

  // Only sources this dashboard actually shows — access to one dashboard
  // doesn't open up every report the company has cached. A pivot widget's
  // second source counts as shown, which a check against report_source alone
  // would have missed, so the allowed set is built the same way the sync
  // builds its pull list.
  const allowed = new Set();
  widgets.forEach((w) => pullsForWidget(w.report_source, w.config).forEach((p) => allowed.add(p.source)));
  if (!allowed.has(source)) return res.status(404).json({ error: 'dashboard นี้ไม่ได้ใช้รายงานนี้' });
  // KSS staff browsing a company don't count as the company using it.
  const view = isSuperadmin(req.user) ? { catchingUp: false } : await touchCompanyView(companyId);

  // ?saved=1: the last pull that had rows ("use saved data" for demos). Falls
  // back to the live cache for a report that has never been saved.
  const health = await getSyncHealth(companyId, source, grouping);
  const wantSaved = req.query.saved === '1';
  const saved = wantSaved ? await getSaved(companyId, source, grouping) : null;
  let cached = saved || (await getCached(companyId, source, grouping));
  // A computed report costs nothing to build, so build it on first view
  // rather than waiting for the nightly run (demo POS file, new widget).
  // Demo companies run on generated data: build a missing report on first
  // view instead of waiting for a sync (a widget just added, say).
  if (!cached && !cfg.local) {
    const [[co]] = await pool.query(`SELECT data_source FROM companies WHERE id = ?`, [companyId]);
    if (co && co.data_source === 'demo') {
      await syncOne(companyId, source, grouping).catch((err) => console.error(`Demo build failed (${companyId}/${source}):`, err.message));
      cached = await getCached(companyId, source, grouping);
    }
  }
  // Demo data moves with the calendar: a pull built before today (Bangkok) is rebuilt on view,
  // so a demo never shows yesterday's "today". Costs no quota.
  if (cached && !cfg.local && cached.syncedAt && !wantSaved) {
    // "Built before Bangkok midnight", asked of the DB so synced_at and NOW() share its clock
    // whatever time zone Node or MySQL run in.
    const sinceMidnight = Math.floor(((Date.now() + 7 * 3600000) % 86400000) / 1000);
    const [[st]] = await pool.query(
      `SELECT c.data_source, (r.synced_at < NOW() - INTERVAL ? SECOND) AS stale FROM companies c JOIN fmh_report_cache r ON r.company_id = c.id AND r.cache_key = ? WHERE c.id = ?`,
      [sinceMidnight, cacheKeyFor(source, grouping), companyId]);
    if (st && st.data_source === 'demo' && Number(st.stale)) {
      {
        await syncOne(companyId, source, grouping, { full: true }).catch((err) => console.error(`Demo refresh failed (${companyId}/${source}):`, err.message));
        cached = (wantSaved && (await getSaved(companyId, source, grouping))) || (await getCached(companyId, source, grouping));
      }
    }
  }
  // A company whose history comes from uploaded FMH files can have data
  // before (or without) any API sync: build it from the files.
  if (!cached && !grouping && !wantSaved && (await fmhFiles.hasFiles(companyId, source))) {
    await fmhFiles.rebuild(companyId, source).catch((err) => console.error(`File history build failed (${companyId}/${source}):`, err.message));
    cached = await getCached(companyId, source, null);
  }
  // An alert widget's findings are about today: last night's build is
  // rebuilt once the day has turned (cheap — it reads cached reports).
  if (cached && !wantSaved && cfg.localBuild === 'alerts') {
    const w = cached.quota && cached.quota.watch;
    if (!w || w.evaluated_on !== require('../lib/alerts').bkkToday()) cached = null;
  }
  if (!cached && cfg.local) {
    await syncOne(companyId, source, null).catch((err) => console.error(`Local build failed (${companyId}/${source}):`, err.message));
    cached = await getCached(companyId, source, null);
  }
  if (!cached && cfg.local) {
    return res.status(409).json({
      error: 'ยังไม่มีไฟล์ยอดขาย POS — ผู้ดูแลของบริษัทอัปโหลดได้ที่ ✎ จัดการ Dashboard → ยอดขาย POS',
      code: 'POS_NO_UPLOAD',
      health,
    });
  }
  if (!cached) {
    const [[company]] = await pool.query(`SELECT fmh_api_key_enc, data_source FROM companies WHERE id = ?`, [companyId]);
    const connected = company && (company.fmh_api_key_enc || company.data_source === 'demo');
    return res.status(409).json({
      error: connected
        ? 'ยังไม่มีข้อมูล — ระบบจะ sync ให้ตอนตี 1 หรือกด Refresh ด่วนได้เลย'
        : 'ยังไม่ได้ตั้งค่า FMH API Key ของบริษัทนี้',
      code: connected ? 'FMH_NOT_SYNCED' : 'FMH_KEY_MISSING',
      health,
    });
  }
  res.json({
    data: cached.data,
    meta: {
      quota: cached.quota,
      synced_at: cached.syncedAt,
      from_saved: !!saved,
      health,
      grouping,
      catching_up: view.catchingUp || undefined,
      date_field: grouping ? null : cfg.dateField || null,
      // Where uploaded FMH files fill in before the API window.
      history: (cached.quota && cached.quota.history) || null,
    },
  });
}

router.get(
  '/:id/data/:source',
  requireAuth,
  wrap(async (req, res) => {
    const dashboard = await getDashboardForUser(req.user, req.params.id);
    if (!dashboard) return res.status(404).json({ error: 'ไม่พบ dashboard นี้' });
    await serveData(req, res, dashboard.company_id, await listWidgets(dashboard.id));
  })
);

router.post(
  '/:id/refresh',
  requireAuth,
  wrap(async (req, res) => {
    const dashboard = await getDashboardForUser(req.user, req.params.id);
    if (!dashboard) return res.status(404).json({ error: 'ไม่พบ dashboard นี้' });

    const [[company]] = await pool.query(`SELECT fmh_api_key_enc, data_source FROM companies WHERE id = ?`, [dashboard.company_id]);
    if (!company || (!company.fmh_api_key_enc && company.data_source !== 'demo')) {
      return res.status(409).json({ error: 'ยังไม่ได้ตั้งค่า FMH API Key ของบริษัทนี้', code: 'FMH_KEY_MISSING' });
    }

    const widgets = await listWidgets(dashboard.id);
    const pulls = new Map();
    // Same list the sync uses: a widget that reads two reports (CK sales vs
    // purchases) needs both refreshed, not just the one named report_source.
    widgets.forEach((w) => {
      pullsForWidget(w.report_source, w.config).forEach((p) => pulls.set(cacheKeyFor(p.source, p.grouping), p));
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
      // A computed report (POS sales) costs no quota, so it has no cooldown.
      const local = !!(FMH_REPORTS[source] || {}).local;
      const elapsed = row && !local ? Date.now() - new Date(row.synced_at).getTime() : Infinity;
      if (elapsed < REFRESH_COOLDOWN_MS) {
        shortestWaitMs = Math.min(shortestWaitMs, REFRESH_COOLDOWN_MS - elapsed);
        results[key] = { ok: false, skipped: true };
        continue;
      }
      try {
        const { data } = await withTrigger('refresh', () => syncOne(dashboard.company_id, source, grouping));
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
