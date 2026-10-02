// KSS Internal Admin Console API — KSS staff (kss_superadmin) only.
//
// Everything the team needs to onboard a client white-glove:
//   companies            create / edit / force-sync
//   dashboards           per-company pages: create / rename / reorder / delete
//   widgets              place catalog templates on a dashboard, override
//                        title/config, reorder, remove
//   widget templates     the Widget Catalog itself (CRUD)
//   fmh diagnostics      read-only probes against a client's FMH account, to
//                        settle what the API actually does rather than assume
// Users and the FMH key are handled by routes/users.js and routes/settings.js,
// which accept a company_id from KSS staff.
const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireSuperadmin } = require('../middleware/auth');
const { wrap } = require('../lib/access');
const { FMH_REPORTS, syncCompany, syncOne, getSyncStatus, getCached, pullsForWidget } = require('../lib/fmhCache');
const { CHART_TYPES, listWidgets } = require('../lib/widgetCatalog');
const probe = require('../lib/fmhProbe');

const router = express.Router();
router.use(requireAuth, requireSuperadmin);

const STATUSES = ['active', 'trial', 'suspended', 'demo'];
const TIERS = ['starter', 'growth', 'enterprise'];

const bad = (res, msg) => res.status(400).json({ error: msg });

function parseConfig(value) {
  if (value === undefined || value === null || value === '') return {};
  const obj = typeof value === 'string' ? JSON.parse(value) : value;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('config must be a JSON object');
  return obj;
}

async function companyExists(id) {
  const [[c]] = await pool.query(`SELECT id FROM companies WHERE id = ?`, [id]);
  return !!c;
}

// If a company has a key but no cached data for a source (e.g. a widget
// using a new source was just added), fetch it in the background.
async function warmSource(companyId, source, grouping = null) {
  const [[c]] = await pool.query(`SELECT fmh_api_key_enc FROM companies WHERE id = ?`, [companyId]);
  if (!c || !c.fmh_api_key_enc || !FMH_REPORTS[source]) return;
  if (await getCached(companyId, source, grouping)) return;
  const key = grouping ? `${source}|${grouping}` : source;
  syncOne(companyId, source, grouping).catch((err) => console.error(`Warm sync failed (${companyId}/${key}):`, err.message));
}

// ---------- meta ----------
router.get('/meta', (req, res) => {
  const sources = {};
  Object.entries(FMH_REPORTS).forEach(([k, v]) => (sources[k] = { label: v.label, date_field: v.dateField, groupings: v.groupings }));
  res.json({ report_sources: sources, chart_types: CHART_TYPES, statuses: STATUSES, tiers: TIERS });
});

// ---------- companies ----------
router.get(
  '/companies',
  wrap(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT c.id, c.name, c.status, c.plan_tier, c.fmh_key_updated_at, c.created_at,
              (c.fmh_api_key_enc IS NOT NULL) AS fmh_configured,
              (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id) AS user_count,
              (SELECT COUNT(*) FROM dashboards d WHERE d.company_id = c.id AND d.active = TRUE) AS dashboard_count,
              (SELECT MIN(synced_at) FROM fmh_report_cache f WHERE f.company_id = c.id) AS oldest_sync
       FROM companies c ORDER BY (c.status = 'demo'), c.name`
    );
    rows.forEach((r) => (r.fmh_configured = !!r.fmh_configured));
    res.json({ companies: rows });
  })
);

router.post(
  '/companies',
  wrap(async (req, res) => {
    const { name, status = 'active', plan_tier = 'starter' } = req.body || {};
    if (!name || !String(name).trim()) return bad(res, 'name is required');
    if (!STATUSES.includes(status) || !TIERS.includes(plan_tier)) return bad(res, 'invalid status or plan_tier');
    const [r] = await pool.query(`INSERT INTO companies (name, status, plan_tier) VALUES (?, ?, ?)`, [
      String(name).trim(),
      status,
      plan_tier,
    ]);
    res.status(201).json({ id: r.insertId });
  })
);

router.get(
  '/companies/:id',
  wrap(async (req, res) => {
    const [[c]] = await pool.query(
      `SELECT id, name, status, plan_tier, fmh_key_updated_at, created_at, (fmh_api_key_enc IS NOT NULL) AS fmh_configured
       FROM companies WHERE id = ?`,
      [req.params.id]
    );
    if (!c) return res.status(404).json({ error: 'Company not found' });
    c.fmh_configured = !!c.fmh_configured;
    res.json({ company: c, sync_status: await getSyncStatus(c.id) });
  })
);

router.patch(
  '/companies/:id',
  wrap(async (req, res) => {
    const { name, status, plan_tier } = req.body || {};
    if (status !== undefined && !STATUSES.includes(status)) return bad(res, 'invalid status');
    if (plan_tier !== undefined && !TIERS.includes(plan_tier)) return bad(res, 'invalid plan_tier');
    if (name !== undefined && !String(name).trim()) return bad(res, 'name cannot be empty');
    const [r] = await pool.query(
      `UPDATE companies SET name = COALESCE(?, name), status = COALESCE(?, status), plan_tier = COALESCE(?, plan_tier)
       WHERE id = ?`,
      [name !== undefined ? String(name).trim() : null, status ?? null, plan_tier ?? null, req.params.id]
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Company not found' });
    res.json({ ok: true });
  })
);

// Force a sync now (KSS staff bypass the 30-minute user refresh cooldown).
router.post(
  '/companies/:id/sync',
  wrap(async (req, res) => {
    if (!(await companyExists(req.params.id))) return res.status(404).json({ error: 'Company not found' });
    const results = await syncCompany(Number(req.params.id));
    res.json({ ok: true, results });
  })
);

// ---------- dashboards ----------
router.get(
  '/companies/:id/dashboards',
  wrap(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT d.id, d.display_name, d.description, d.sort_order, d.active,
              (SELECT COUNT(*) FROM dashboard_widgets w WHERE w.dashboard_id = d.id) AS widget_count
       FROM dashboards d WHERE d.company_id = ? ORDER BY d.sort_order, d.id`,
      [req.params.id]
    );
    res.json({ dashboards: rows });
  })
);

router.post(
  '/companies/:id/dashboards',
  wrap(async (req, res) => {
    const companyId = Number(req.params.id);
    if (!(await companyExists(companyId))) return res.status(404).json({ error: 'Company not found' });
    const { display_name, description } = req.body || {};
    if (!display_name || !String(display_name).trim()) return bad(res, 'display_name is required');
    const [[{ next }]] = await pool.query(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM dashboards WHERE company_id = ?`,
      [companyId]
    );
    const [r] = await pool.query(
      `INSERT INTO dashboards (company_id, display_name, description, sort_order) VALUES (?, ?, ?, ?)`,
      [companyId, String(display_name).trim(), description || null, next]
    );
    res.status(201).json({ id: r.insertId });
  })
);

router.put(
  '/companies/:id/dashboard-order',
  wrap(async (req, res) => {
    const ids = (req.body && req.body.dashboard_ids) || [];
    if (!Array.isArray(ids)) return bad(res, 'dashboard_ids must be an array');
    for (let i = 0; i < ids.length; i++) {
      await pool.query(`UPDATE dashboards SET sort_order = ? WHERE id = ? AND company_id = ?`, [
        i + 1,
        ids[i],
        req.params.id,
      ]);
    }
    res.json({ ok: true });
  })
);

router.patch(
  '/dashboards/:id',
  wrap(async (req, res) => {
    const { display_name, description } = req.body || {};
    const fields = {};
    if (display_name !== undefined) {
      if (!String(display_name).trim()) return bad(res, 'display_name cannot be empty');
      fields.display_name = String(display_name).trim();
    }
    if (description !== undefined) fields.description = description ? String(description).trim() : null;
    if (!Object.keys(fields).length) return bad(res, 'nothing to update');
    const [r] = await pool.query(`UPDATE dashboards SET ? WHERE id = ?`, [fields, req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Dashboard not found' });
    res.json({ ok: true });
  })
);

router.delete(
  '/dashboards/:id',
  wrap(async (req, res) => {
    // dashboard_widgets and user_dashboard_access rows go with it (ON DELETE CASCADE).
    const [r] = await pool.query(`DELETE FROM dashboards WHERE id = ?`, [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Dashboard not found' });
    res.json({ ok: true });
  })
);

// ---------- widgets on a dashboard ----------
router.get(
  '/dashboards/:id/widgets',
  wrap(async (req, res) => {
    res.json({ widgets: await listWidgets(req.params.id) });
  })
);

router.post(
  '/dashboards/:id/widgets',
  wrap(async (req, res) => {
    const [[dash]] = await pool.query(`SELECT id, company_id FROM dashboards WHERE id = ?`, [req.params.id]);
    if (!dash) return res.status(404).json({ error: 'Dashboard not found' });
    const [[tpl]] = await pool.query(
      `SELECT id, report_source, default_config_json FROM widget_templates WHERE id = ? AND active = TRUE`,
      [req.body && req.body.template_id]
    );
    if (!tpl) return bad(res, 'Unknown or inactive widget template');
    const [[{ next }]] = await pool.query(
      `SELECT COALESCE(MAX(position), 0) + 1 AS next FROM dashboard_widgets WHERE dashboard_id = ?`,
      [dash.id]
    );
    const [r] = await pool.query(
      `INSERT INTO dashboard_widgets (dashboard_id, widget_template_id, position) VALUES (?, ?, ?)`,
      [dash.id, tpl.id, next]
    );
    // Warm exactly what this template reads: the grouping it asks for rather
    // than the itemized pull it would never look at, and every source if it is
    // a pivot widget.
    let cfg = {};
    try {
      cfg = JSON.parse(tpl.default_config_json || '{}');
    } catch {
      /* unreadable config just means itemized */
    }
    pullsForWidget(tpl.report_source, cfg).forEach((p) => warmSource(dash.company_id, p.source, p.grouping));
    res.status(201).json({ id: r.insertId });
  })
);

router.put(
  '/dashboards/:id/widget-order',
  wrap(async (req, res) => {
    const ids = (req.body && req.body.widget_ids) || [];
    if (!Array.isArray(ids)) return bad(res, 'widget_ids must be an array');
    for (let i = 0; i < ids.length; i++) {
      await pool.query(`UPDATE dashboard_widgets SET position = ? WHERE id = ? AND dashboard_id = ?`, [
        i + 1,
        ids[i],
        req.params.id,
      ]);
    }
    res.json({ ok: true });
  })
);

// Per-instance overrides: a custom title and/or config keys merged over the
// template default (e.g. {"top_n": 5, "size": "half"}).
router.patch(
  '/widgets/:id',
  wrap(async (req, res) => {
    const { title, config_overrides } = req.body || {};
    let overridesJson;
    try {
      const obj = parseConfig(config_overrides);
      overridesJson = Object.keys(obj).length ? JSON.stringify(obj) : null;
    } catch (e) {
      return bad(res, `config: ${e.message}`);
    }
    const [r] = await pool.query(`UPDATE dashboard_widgets SET title = ?, config_json = ? WHERE id = ?`, [
      title && String(title).trim() ? String(title).trim() : null,
      overridesJson,
      req.params.id,
    ]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Widget not found' });
    res.json({ ok: true });
  })
);

router.delete(
  '/widgets/:id',
  wrap(async (req, res) => {
    const [r] = await pool.query(`DELETE FROM dashboard_widgets WHERE id = ?`, [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Widget not found' });
    res.json({ ok: true });
  })
);

// ---------- widget catalog ----------
router.get(
  '/widget-templates',
  wrap(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT t.id, t.template_key, t.name, t.description, t.category, t.report_source, t.chart_type,
              t.default_config_json, t.tier_requirement, t.active, t.customized, t.sort_order,
              (SELECT COUNT(*) FROM dashboard_widgets w WHERE w.widget_template_id = t.id) AS usage_count
       FROM widget_templates t ORDER BY t.category, t.sort_order, t.id`
    );
    rows.forEach((r) => {
      r.active = !!r.active;
      r.customized = !!r.customized;
    });
    res.json({ templates: rows });
  })
);

function validateTemplate(body, { partial }) {
  const out = {};
  const { name, description, category, report_source, chart_type, default_config, tier_requirement, active } = body;
  if (!partial || name !== undefined) {
    if (!name || !String(name).trim()) throw new Error('name is required');
    out.name = String(name).trim();
  }
  if (description !== undefined) out.description = description || null;
  if (category !== undefined) out.category = String(category || 'General').trim() || 'General';
  if (!partial || report_source !== undefined) {
    if (!FMH_REPORTS[report_source]) throw new Error('unknown report_source');
    out.report_source = report_source;
  }
  if (!partial || chart_type !== undefined) {
    if (!CHART_TYPES.includes(chart_type)) throw new Error('unknown chart_type');
    out.chart_type = chart_type;
  }
  if (!partial || default_config !== undefined) out.default_config_json = JSON.stringify(parseConfig(default_config));
  if (tier_requirement !== undefined) {
    if (!TIERS.includes(tier_requirement)) throw new Error('invalid tier_requirement');
    out.tier_requirement = tier_requirement;
  }
  if (active !== undefined) out.active = !!active;
  return out;
}

router.post(
  '/widget-templates',
  wrap(async (req, res) => {
    let fields;
    try {
      fields = validateTemplate(req.body || {}, { partial: false });
    } catch (e) {
      return bad(res, e.message);
    }
    const key = `custom_${Date.now().toString(36)}`;
    const [r] = await pool.query(`INSERT INTO widget_templates SET ?, template_key = ?, customized = TRUE`, [fields, key]);
    res.status(201).json({ id: r.insertId, template_key: key });
  })
);

// Editing marks the template customized, so the boot-time catalog sync stops
// overwriting it with the built-in definition.
router.patch(
  '/widget-templates/:id',
  wrap(async (req, res) => {
    let fields;
    try {
      fields = validateTemplate(req.body || {}, { partial: true });
    } catch (e) {
      return bad(res, e.message);
    }
    if (!Object.keys(fields).length) return bad(res, 'nothing to update');
    const onlyActiveToggle = Object.keys(fields).length === 1 && 'active' in fields;
    const [r] = await pool.query(
      `UPDATE widget_templates SET ?${onlyActiveToggle ? '' : ', customized = TRUE'} WHERE id = ?`,
      [fields, req.params.id]
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Template not found' });
    res.json({ ok: true });
  })
);

// ---------- FMH diagnostics ----------
// Read-only probes. They cost a little of the company's FMH row quota, so each
// one is requested explicitly rather than run on page load.
const PROBES = {
  catalog: (id) => probe.probeCatalog(id),
  sources: (id) => probe.probeSources(id),
  statuses_purchase: (id) =>
    probe.probeStatuses(id, { reportKey: 'purchase_analysis', cardKey: 'purchase_analysis_table', groupBy: 'branch' }),
  statuses_orders: (id) =>
    probe.probeStatuses(id, { reportKey: 'order_items_by_branch', cardKey: 'oibb_table', groupBy: 'branch' }),
  join_keys: (id) => probe.probeJoinKeys(id),
  date_filter: (id) => probe.probeDateFilter(id),
  group_by: (id) => probe.probeGroupBy(id),
};

router.post(
  '/fmh-probe',
  wrap(async (req, res) => {
    const companyId = Number(req.body?.company_id);
    const name = String(req.body?.probe || '');
    if (!companyId) return bad(res, 'ต้องระบุ company_id');
    if (!PROBES[name]) return bad(res, `ไม่รู้จัก probe "${name}"`);
    const [[c]] = await pool.query(`SELECT fmh_api_key_enc FROM companies WHERE id = ?`, [companyId]);
    if (!c) return res.status(404).json({ error: 'ไม่พบบริษัทนี้' });
    if (!c.fmh_api_key_enc) return bad(res, 'บริษัทนี้ยังไม่ได้ตั้งค่า FMH API key');
    try {
      const result = await PROBES[name](companyId);
      res.json({ probe: name, company_id: companyId, result });
    } catch (err) {
      res.status(502).json({ error: `เรียก FMH ไม่สำเร็จ: ${err.message}` });
    }
  })
);

module.exports = router;
