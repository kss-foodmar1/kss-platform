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
const { codeFor, assignMissingCodes } = require('../lib/companyCode');
const { withTrigger, usageSummary } = require('../lib/fmhUsage');

const router = express.Router();

// KSS staff use everything here. A client's company_admin may use the few
// endpoints behind "manage my dashboards" (the composer and the widget
// picker) — and only for their own company. Everything else (companies,
// catalog editing, FMH diagnostics, sync, billing data) stays KSS-only.
const COMPANY_ADMIN_ROUTES = [
  ['GET', /^\/meta$/],
  ['GET', /^\/widget-templates$/],
  ['GET', /^\/companies\/(\d+)$/, 'company'],
  ['PATCH', /^\/companies\/(\d+)\/name$/, 'company'],
  ['GET', /^\/companies\/(\d+)\/dashboards$/, 'company'],
  ['POST', /^\/companies\/(\d+)\/dashboards$/, 'company'],
  ['PUT', /^\/companies\/(\d+)\/dashboard-order$/, 'company'],
  ['PATCH', /^\/dashboards\/(\d+)$/, 'dashboard'],
  ['DELETE', /^\/dashboards\/(\d+)$/, 'dashboard'],
  ['GET', /^\/dashboards\/(\d+)\/widgets$/, 'dashboard'],
  ['PUT', /^\/dashboards\/(\d+)\/layout$/, 'dashboard'],
  ['PUT', /^\/dashboards\/(\d+)\/arrange$/, 'dashboard'],
  // Widget library (public/library.js)
  ['GET', /^\/widget-packs$/],
  ['GET', /^\/companies\/(\d+)\/widget-usage$/, 'company'],
  ['POST', /^\/companies\/(\d+)\/library-add$/, 'company'],
  ['POST', /^\/companies\/(\d+)\/packs\/([a-z_]+)$/, 'company'],
  // "Start with a basic dashboard?" (lib/starter.js)
  ['GET', /^\/companies\/(\d+)\/starter-options$/, 'company'],
  ['POST', /^\/companies\/(\d+)\/dashboards\/\d+\/starter$/, 'company'],
  ['POST', /^\/companies\/(\d+)\/first-dashboard$/, 'company'],
];

async function adminAccess(req, res, next) {
  if (req.user.role === 'kss_superadmin') return next();
  if (req.user.role !== 'company_admin' || !req.user.company_id) return res.status(403).json({ error: 'KSS staff access required' });
  const rule = COMPANY_ADMIN_ROUTES.find(([m, re]) => m === req.method && re.test(req.path));
  if (!rule) return res.status(403).json({ error: 'KSS staff access required' });
  const id = Number((req.path.match(rule[1]) || [])[1]);
  try {
    if (rule[2] === 'company' && id !== req.user.company_id) return res.status(403).json({ error: 'ไม่มีสิทธิ์จัดการบริษัทนี้' });
    if (rule[2] === 'dashboard') {
      const [[d]] = await pool.query(`SELECT company_id FROM dashboards WHERE id = ?`, [id]);
      if (!d || d.company_id !== req.user.company_id) return res.status(404).json({ error: 'ไม่พบ dashboard นี้' });
    }
    next();
  } catch (err) {
    next(err);
  }
}
router.use(requireAuth, adminAccess);
const isKss = (req) => req.user.role === 'kss_superadmin';

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
  const [[c]] = await pool.query(`SELECT fmh_api_key_enc, data_source, auto_sync FROM companies WHERE id = ?`, [companyId]);
  if (!c || (!c.fmh_api_key_enc && c.data_source !== 'demo') || !FMH_REPORTS[source]) return;
  if (c.data_source !== 'demo' && !c.auto_sync) return; // auto-fetch is off: the Refresh button pulls it
  if (await getCached(companyId, source, grouping)) return;
  const key = grouping ? `${source}|${grouping}` : source;
  withTrigger('warm', () => syncOne(companyId, source, grouping)).catch((err) => console.error(`Warm sync failed (${companyId}/${key}):`, err.message));
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
      `SELECT c.id, c.company_code, c.name, c.status, c.plan_tier, c.fmh_key_updated_at, c.created_at,
              (SELECT GROUP_CONCAT(DISTINCT h.old_name ORDER BY h.changed_at DESC SEPARATOR ' | ') FROM company_name_history h WHERE h.company_id = c.id) AS former_names,
              (c.fmh_api_key_enc IS NOT NULL OR c.data_source = 'demo') AS fmh_configured, c.data_source,
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
    await assignMissingCodes();
    res.status(201).json({ id: r.insertId, company_code: codeFor(r.insertId) });
  })
);

router.get(
  '/companies/:id',
  wrap(async (req, res) => {
    const [[c]] = await pool.query(
      `SELECT id, company_code, name, status, plan_tier, data_source, self_serve, fmh_key_updated_at, created_at, (fmh_api_key_enc IS NOT NULL OR data_source = 'demo') AS fmh_configured
       FROM companies WHERE id = ?`,
      [req.params.id]
    );
    if (!c) return res.status(404).json({ error: 'Company not found' });
    c.fmh_configured = !!c.fmh_configured;
    const [history] = await pool.query(
      `SELECT h.old_name, h.new_name, h.changed_at, u.email AS changed_by_email, u.role AS changed_by_role
       FROM company_name_history h LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.company_id = ? ORDER BY h.changed_at DESC, h.id DESC LIMIT 20`,
      [c.id]
    );
    c.name_history = history;
    res.json({ company: c, sync_status: await getSyncStatus(c.id) });
  })
);

router.patch(
  '/companies/:id',
  wrap(async (req, res) => {
    const { name, status, plan_tier, data_source, self_serve } = req.body || {};
    if (data_source !== undefined && !['fmh', 'demo'].includes(data_source)) return bad(res, 'invalid data_source');
    if (status !== undefined && !STATUSES.includes(status)) return bad(res, 'invalid status');
    if (plan_tier !== undefined && !TIERS.includes(plan_tier)) return bad(res, 'invalid plan_tier');
    // Same launch switch as online signup/payment: on Railway production it stays
    // shut until SELF_SIGNUP=on, so no company can be moved to in-app payment early.
    if ((self_serve === true || self_serve === 1 || self_serve === '1') && !require('../lib/selfServe').signupEnabled()) {
      return res.status(403).json({ error: 'ยังไม่เปิดให้ลูกค้าชำระเองในแอปบน production (ตั้ง SELF_SIGNUP=on เมื่อพร้อมเปิด)' });
    }
    if (name !== undefined && !String(name).trim()) return bad(res, 'name cannot be empty');
    if (!(await companyExists(req.params.id))) return res.status(404).json({ error: 'Company not found' });
    if (name !== undefined) {
      const err = await renameCompany(Number(req.params.id), name, req.user.id);
      if (err) return bad(res, err);
    }
    await pool.query(
      `UPDATE companies SET status = COALESCE(?, status), plan_tier = COALESCE(?, plan_tier) WHERE id = ?`,
      [status ?? null, plan_tier ?? null, req.params.id]
    );
    // Self-serve: the company's admin sees the plan page and pays in the app
    // (lib/selfServe.js). Switching on with no end date starts a trial today.
    if (self_serve !== undefined) {
      const on = self_serve === true || self_serve === 1 || self_serve === '1';
      const [[c]] = await pool.query(`SELECT self_serve, subscription_ends_at FROM companies WHERE id = ?`, [req.params.id]);
      if (!!c.self_serve !== on) {
        await pool.query(`UPDATE companies SET self_serve = ? WHERE id = ?`, [on ? 1 : 0, req.params.id]);
        if (on && !c.subscription_ends_at) {
          const ss = require('../lib/selfServe');
          const end = new Date(Date.now() + 7 * 3600e3 + ss.TRIAL_DAYS() * 86400e3).toISOString().slice(0, 10);
          await pool.query(`UPDATE companies SET subscription_ends_at = ?, status = IF(status = 'active', 'trial', status) WHERE id = ?`, [end, req.params.id]);
        }
      }
    }
    if (data_source !== undefined) {
      const [[c]] = await pool.query(`SELECT data_source FROM companies WHERE id = ?`, [req.params.id]);
      if (c.data_source !== data_source) {
        // Switching between real and demo data: never let the two mix in the
        // cache, the saved copy or the error log, then refill in the background.
        await pool.query(`UPDATE companies SET data_source = ? WHERE id = ?`, [data_source, req.params.id]);
        for (const t of ['fmh_report_cache', 'fmh_cache_saved', 'fmh_sync_errors']) {
          await pool.query(`DELETE FROM ${t} WHERE company_id = ?`, [req.params.id]);
        }
        withTrigger('admin', () => syncCompany(Number(req.params.id))).catch((e) => console.error('Sync after data source switch failed:', e.message));
      }
    }
    res.json({ ok: true });
  })
);

// A client's company admin may rename their own company (KSS staff too).
// Every rename is kept in company_name_history, and the company code never
// changes, so KSS can always tell which client it is.
async function renameCompany(companyId, rawName, userId) {
  const name = String(rawName || '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 120) return 'ชื่อบริษัทต้องยาว 2–120 ตัวอักษร';
  const [[c]] = await pool.query(`SELECT name FROM companies WHERE id = ?`, [companyId]);
  if (!c || c.name === name) return null;
  await pool.query(`UPDATE companies SET name = ? WHERE id = ?`, [name, companyId]);
  await pool.query(
    `INSERT INTO company_name_history (company_id, old_name, new_name, changed_by) VALUES (?, ?, ?, ?)`,
    [companyId, c.name, name, userId || null]
  );
  return null;
}

router.patch(
  '/companies/:id/name',
  wrap(async (req, res) => {
    if (!(await companyExists(req.params.id))) return res.status(404).json({ error: 'Company not found' });
    const err = await renameCompany(Number(req.params.id), req.body && req.body.name, req.user.id);
    if (err) return bad(res, err);
    const [[c]] = await pool.query(`SELECT id, company_code, name FROM companies WHERE id = ?`, [req.params.id]);
    res.json({ ok: true, company: c });
  })
);

// Force a sync now (KSS staff bypass the 30-minute user refresh cooldown).
router.post(
  '/companies/:id/sync',
  wrap(async (req, res) => {
    if (!(await companyExists(req.params.id))) return res.status(404).json({ error: 'Company not found' });
    const full = !!(req.body && req.body.full);
    const results = await withTrigger('admin', () => syncCompany(Number(req.params.id), null, { full }));
    res.json({ ok: true, results });
  })
);

// Where this company's FMH row quota went over the last 30 days.
router.get(
  '/companies/:id/fmh-usage',
  wrap(async (req, res) => {
    if (!(await companyExists(req.params.id))) return res.status(404).json({ error: 'Company not found' });
    res.json(await usageSummary(Number(req.params.id), 30));
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

// Drag-and-drop arrange on the dashboard itself: order, width and height only.
//   items: [{ id, size: 'third'|'half'|'full', rows: 1|2|3 }] in display order.
// Other per-widget settings (title, filters) are kept as they are.
router.put(
  '/dashboards/:id/arrange',
  wrap(async (req, res) => {
    const items = (req.body && req.body.items) || [];
    if (!Array.isArray(items) || !items.length) return bad(res, 'items must be a non-empty array');
    const [rows] = await pool.query(`SELECT id, config_json FROM dashboard_widgets WHERE dashboard_id = ?`, [req.params.id]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const it of items) {
      if (!byId.has(Number(it.id))) return bad(res, `widget ${it.id} is not on this dashboard`);
      if (!['third', 'half', 'full'].includes(it.size)) return bad(res, 'size must be third, half or full');
      if (![1, 2, 3].includes(Number(it.rows))) return bad(res, 'rows must be 1, 2 or 3');
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        let cfg = {};
        const raw = byId.get(Number(it.id)).config_json;
        try { cfg = raw && typeof raw === 'object' ? { ...raw } : JSON.parse(raw || '{}') || {}; } catch (e) { cfg = {}; }
        cfg.size = it.size;
        if (Number(it.rows) === 1) delete cfg.rows; else cfg.rows = Number(it.rows);
        await conn.query(`UPDATE dashboard_widgets SET config_json = ?, position = ? WHERE id = ?`, [JSON.stringify(cfg), i + 1, Number(it.id)]);
      }
      // Widgets not listed keep their place after the listed ones.
      const listed = new Set(items.map((it) => Number(it.id)));
      let pos = items.length;
      for (const r of rows) if (!listed.has(r.id)) await conn.query(`UPDATE dashboard_widgets SET position = ? WHERE id = ?`, [++pos, r.id]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    res.json({ ok: true });
  })
);

// Save a whole dashboard layout from the widget picker in one go:
//   items: [{ id } | { template_id }, + title, config_overrides] in display order.
// Existing widgets not listed are removed, listed ones updated, new ones added,
// all inside one transaction so a half-saved dashboard can't happen.
router.put(
  '/dashboards/:id/layout',
  wrap(async (req, res) => {
    const [[dash]] = await pool.query(`SELECT id, company_id FROM dashboards WHERE id = ?`, [req.params.id]);
    if (!dash) return res.status(404).json({ error: 'Dashboard not found' });
    const items = (req.body && req.body.items) || [];
    if (!Array.isArray(items)) return bad(res, 'items must be an array');

    const [existing] = await pool.query(`SELECT id FROM dashboard_widgets WHERE dashboard_id = ?`, [dash.id]);
    const existingIds = new Set(existing.map((r) => r.id));
    const prepared = [];
    for (const it of items) {
      let overridesJson;
      try {
        const obj = parseConfig(it.config_overrides);
        overridesJson = Object.keys(obj).length ? JSON.stringify(obj) : null;
      } catch (e) {
        return bad(res, `config: ${e.message}`);
      }
      const title = it.title && String(it.title).trim() ? String(it.title).trim().slice(0, 255) : null;
      if (it.id) {
        if (!existingIds.has(Number(it.id))) return bad(res, `widget ${it.id} is not on this dashboard`);
        prepared.push({ id: Number(it.id), title, overridesJson });
      } else {
        const [[tpl]] = await pool.query(
          `SELECT id, report_source, default_config_json FROM widget_templates WHERE id = ? AND active = TRUE`,
          [it.template_id]
        );
        if (!tpl) return bad(res, 'Unknown or inactive widget template');
        prepared.push({ tpl, title, overridesJson });
      }
    }

    const conn = await pool.getConnection();
    const added = [];
    try {
      await conn.beginTransaction();
      const keep = new Set(prepared.filter((p) => p.id).map((p) => p.id));
      for (const id of existingIds) if (!keep.has(id)) await conn.query(`DELETE FROM dashboard_widgets WHERE id = ?`, [id]);
      for (let i = 0; i < prepared.length; i++) {
        const p = prepared[i];
        if (p.id) {
          await conn.query(`UPDATE dashboard_widgets SET title = ?, config_json = ?, position = ? WHERE id = ?`, [p.title, p.overridesJson, i + 1, p.id]);
        } else {
          await conn.query(
            `INSERT INTO dashboard_widgets (dashboard_id, widget_template_id, title, config_json, position) VALUES (?, ?, ?, ?, ?)`,
            [dash.id, p.tpl.id, p.title, p.overridesJson, i + 1]
          );
          added.push(p);
        }
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    // Same warm-up as adding one widget: fetch only what new widgets read.
    added.forEach((p) => {
      let cfg = {};
      try {
        cfg = { ...JSON.parse(p.tpl.default_config_json || '{}'), ...JSON.parse(p.overridesJson || '{}') };
      } catch {
        /* itemized */
      }
      pullsForWidget(p.tpl.report_source, cfg).forEach((x) => warmSource(dash.company_id, x.source, x.grouping));
    });
    res.json({ ok: true, widgets: await listWidgets(dash.id) });
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

// ---------- widget library: pick a widget first, then where it goes ----------
const SIZES = ['full', 'half', 'third'];

async function templateFor(id) {
  const [[tpl]] = await pool.query(
    `SELECT id, name, report_source, default_config_json FROM widget_templates WHERE id = ? AND active = TRUE`,
    [id]
  );
  return tpl || null;
}

// Appends one template to one dashboard and warms what it reads.
async function appendWidget(companyId, dashboardId, tpl, overrides) {
  const [[{ next }]] = await pool.query(
    `SELECT COALESCE(MAX(position), 0) + 1 AS next FROM dashboard_widgets WHERE dashboard_id = ?`,
    [dashboardId]
  );
  await pool.query(
    `INSERT INTO dashboard_widgets (dashboard_id, widget_template_id, config_json, position) VALUES (?, ?, ?, ?)`,
    [dashboardId, tpl.id, overrides && Object.keys(overrides).length ? JSON.stringify(overrides) : null, next]
  );
  let cfg = {};
  try {
    cfg = { ...JSON.parse(tpl.default_config_json || '{}'), ...(overrides || {}) };
  } catch {
    /* itemized */
  }
  pullsForWidget(tpl.report_source, cfg).forEach((p) => warmSource(companyId, p.source, p.grouping));
}

async function createDashboard(companyId, name, description = null) {
  const [[{ next }]] = await pool.query(
    `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM dashboards WHERE company_id = ?`,
    [companyId]
  );
  const [r] = await pool.query(
    `INSERT INTO dashboards (company_id, display_name, description, sort_order) VALUES (?, ?, ?, ?)`,
    [companyId, String(name).trim().slice(0, 255), description, next]
  );
  return r.insertId;
}

router.get('/widget-packs', (req, res) => res.json({ packs: require('../lib/widgetPacks').PACKS }));

// Which of this company's dashboards each template is already on.
router.get(
  '/companies/:id/widget-usage',
  wrap(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT DISTINCT w.widget_template_id AS template_id, d.id AS dashboard_id
       FROM dashboard_widgets w JOIN dashboards d ON d.id = w.dashboard_id
       WHERE d.company_id = ?`,
      [req.params.id]
    );
    res.json({ usage: rows });
  })
);

// { template_id, dashboard_ids: [..], new_dashboard_name?, size? }
// A dashboard that already has the widget is left alone (reported as "had").
router.post(
  '/companies/:id/library-add',
  wrap(async (req, res) => {
    const companyId = Number(req.params.id);
    if (!(await companyExists(companyId))) return res.status(404).json({ error: 'Company not found' });
    const body = req.body || {};
    const tpl = await templateFor(body.template_id);
    if (!tpl) return bad(res, 'ไม่พบ widget นี้');
    const ids = [...new Set((Array.isArray(body.dashboard_ids) ? body.dashboard_ids : []).map(Number).filter(Boolean))];
    const newName = body.new_dashboard_name && String(body.new_dashboard_name).trim();
    if (!ids.length && !newName) return bad(res, 'เลือก dashboard อย่างน้อยหนึ่งอัน');
    const [own] = ids.length
      ? await pool.query(`SELECT id, display_name FROM dashboards WHERE company_id = ? AND id IN (?)`, [companyId, ids])
      : [[]];
    if (own.length !== ids.length) return res.status(404).json({ error: 'ไม่พบ dashboard ที่เลือก' });
    const overrides = SIZES.includes(body.size) ? { size: body.size } : {};
    const added = [];
    const had = [];
    for (const d of own) {
      const [[exists]] = await pool.query(
        `SELECT 1 AS ok FROM dashboard_widgets WHERE dashboard_id = ? AND widget_template_id = ? LIMIT 1`,
        [d.id, tpl.id]
      );
      if (exists) { had.push({ id: d.id, display_name: d.display_name }); continue; }
      await appendWidget(companyId, d.id, tpl, overrides);
      added.push({ id: d.id, display_name: d.display_name });
    }
    if (newName) {
      const id = await createDashboard(companyId, newName);
      await appendWidget(companyId, id, tpl, overrides);
      added.push({ id, display_name: newName, created: true });
    }
    res.json({ added, had });
  })
);

// One click: a new dashboard made from a ready-made pack.
router.post(
  '/companies/:id/packs/:key',
  wrap(async (req, res) => {
    const companyId = Number(req.params.id);
    if (!(await companyExists(companyId))) return res.status(404).json({ error: 'Company not found' });
    const pack = require('../lib/widgetPacks').PACKS.find((p) => p.key === req.params.key);
    if (!pack) return res.status(404).json({ error: 'ไม่พบชุดนี้' });
    const [tpls] = await pool.query(
      `SELECT id, template_key, report_source, default_config_json FROM widget_templates WHERE active = TRUE AND template_key IN (?)`,
      [pack.templates]
    );
    const byKey = new Map(tpls.map((t) => [t.template_key, t]));
    const name = (req.body && req.body.name && String(req.body.name).trim()) || pack.title;
    const id = await createDashboard(companyId, name, pack.description);
    let n = 0;
    for (const k of pack.templates) {
      if (!byKey.has(k)) continue;
      await appendWidget(companyId, id, byKey.get(k), {});
      n++;
    }
    res.status(201).json({ id, display_name: name, widgets: n });
  })
);

// What the first admin answered in the first-run questions, kept on the company.
async function saveProfile(companyId, raw) {
  const p = require('../lib/starter').cleanProfile(raw);
  if (!p.setup && !p.role && !p.goals.length) return;
  const [[before]] = await pool.query(`SELECT data_source, onboarding_json FROM companies WHERE id = ?`, [companyId]);
  await pool.query(`UPDATE companies SET onboarding_json = ? WHERE id = ?`, [JSON.stringify(p), companyId]);
  require('../lib/fmhCache').forgetShape(companyId);
  // A sample is shaped by the answers (lib/demoData.js shapeRows): rebuild it if the shape changed.
  let old = null;
  try { old = before && before.onboarding_json ? JSON.parse(before.onboarding_json) : null; } catch (e) { /* none */ }
  if (before && before.data_source === 'demo' && (!old || old.setup !== p.setup)) {
    for (const t of ['fmh_report_cache', 'fmh_cache_saved', 'alert_events']) await pool.query(`DELETE FROM ${t} WHERE company_id = ?`, [companyId]);
  }
}

// ---------- "Start with a basic dashboard?" ----------
router.get(
  '/companies/:id/starter-options',
  wrap(async (req, res) => {
    if (!(await companyExists(req.params.id))) return res.status(404).json({ error: 'Company not found' });
    const starter = require('../lib/starter');
    const opts = await starter.options(Number(req.params.id));
    // ?setup=&role=&goals=a,b ranks and filters by the first-run answers.
    const q = req.query;
    const profile = starter.cleanProfile({ setup: q.setup, role: q.role, goals: String(q.goals || '').split(',') });
    res.json({ options: starter.recommend(opts, profile), profile, choices: { setups: starter.SETUPS, setupInfo: starter.SETUP_INFO, roles: starter.ROLES, goals: starter.GOALS } });
  })
);

// Fills a dashboard with the ready widgets of one option ({ key }), after any
// widgets it already has; a widget already there is not added twice.
router.post(
  '/companies/:id/dashboards/:did/starter',
  wrap(async (req, res) => {
    const companyId = Number(req.params.id);
    const [[d]] = await pool.query(`SELECT id FROM dashboards WHERE id = ? AND company_id = ?`, [req.params.did, companyId]);
    if (!d) return res.status(404).json({ error: 'ไม่พบ dashboard นี้' });
    const tpls = await require('../lib/starter').readyTemplates(companyId, String((req.body && req.body.key) || 'basic'));
    if (!tpls) return bad(res, 'ไม่รู้จักชุดนี้');
    const [have] = await pool.query(`SELECT widget_template_id AS id FROM dashboard_widgets WHERE dashboard_id = ?`, [d.id]);
    const had = new Set(have.map((r) => r.id));
    let added = 0;
    for (const t of tpls) {
      if (had.has(t.id)) continue;
      await appendWidget(companyId, d.id, t, {});
      added++;
    }
    res.json({ added });
  })
);

// First run: a company with no dashboard yet gets one made from the chosen
// starter option in a single call, named after the option. { key } or { empty: true }.
router.post(
  '/companies/:id/first-dashboard',
  wrap(async (req, res) => {
    const companyId = Number(req.params.id);
    if (!(await companyExists(companyId))) return res.status(404).json({ error: 'Company not found' });
    const [[have]] = await pool.query(`SELECT id FROM dashboards WHERE company_id = ? ORDER BY sort_order, id LIMIT 1`, [companyId]);
    if (have) return res.json({ id: have.id, added: 0, existing: true });
    const starter = require('../lib/starter');
    if (req.body && req.body.empty) {
      await saveProfile(companyId, req.body && req.body.profile);
      return res.status(201).json({ id: await createDashboard(companyId, 'Dashboard ของฉัน'), added: 0 });
    }
    const key = String((req.body && req.body.key) || 'basic');
    const opt = starter.OPTIONS.find((o) => o.key === key);
    if (!opt) return bad(res, 'ไม่รู้จักชุดนี้');
    const tpls = await starter.readyTemplates(companyId, key);
    if (!tpls || !tpls.length) return bad(res, 'ชุดนี้ยังไม่มีข้อมูลพร้อมแสดง — เชื่อมข้อมูลก่อน หรือเริ่มจาก dashboard ว่าง');
    const id = await createDashboard(companyId, opt.title);
    for (const t of tpls) await appendWidget(companyId, id, t, {});
    await saveProfile(companyId, req.body && req.body.profile);
    res.status(201).json({ id, added: tpls.length });
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
      if (!isKss(req)) delete r.usage_count; // usage across all clients is KSS-only
    });
    res.json({ templates: isKss(req) ? rows : rows.filter((r) => r.active) });
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
  ck_sales: (id) => probe.probeCkSales(id),
  widget_fields: (id) => probe.probeWidgetFields(id),
  stock_balance: (id) => probe.probeStockBalance(id),
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
      const result = await withTrigger('probe', () => PROBES[name](companyId), companyId);
      res.json({ probe: name, company_id: companyId, result });
    } catch (err) {
      res.status(502).json({ error: `เรียก FMH ไม่สำเร็จ: ${err.message}` });
    }
  })
);

module.exports = router;
