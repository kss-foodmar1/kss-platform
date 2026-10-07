// POS sales from an uploaded file (Foodstory and any POS without an API),
// costed with the company's FMH recipes.
//
// FMH knows what each dish should cost (menu_and_ingredients). The POS knows
// what was sold, for how much, on which day. Joined on the menu name, they
// give COGS and gross margin for restaurants whose POS FMH cannot read.
//
//   upload    the browser parses the export (public/pos-parse.js) and sends
//             daily totals per branch + menu; a new upload replaces the days
//             it covers, per branch, so a re-export of the same days is safe
//   matching  POS menu name → FMH recipe by name, ignoring case, spacing and
//             punctuation; anything else is mapped by hand once
//             (pos_menu_map) and remembered. A line marked "not a dish" (bag
//             fee, delivery charge) stays out of COGS % altogether.
//   output    the 'pos-sales' report source: rows written into the same cache
//             every FMH source uses, so widgets, the date picker, saved-data
//             mode and the Refresh button treat it like any other report.
//             Recomputed on upload, on mapping changes and after recipes sync —
//             it never calls FMH except to fetch recipes it does not have yet.
const pool = require('../db/pool');
const PosParse = require('../public/pos-parse');

const SOURCE = 'pos-sales';
const RECIPE_SOURCE = 'menu-costing';
const RECIPE_GROUPING = 'by_menu';
// The cache holds this many days back from the newest sale. Older days stay
// in the database and come back if a later upload moves the window.
const CACHE_DAYS = 120;
const MAX_UPLOAD_ROWS = 200000;

const fmhCache = () => require('./fmhCache'); // lazy: fmhCache requires this file

async function companyInfo(companyId) {
  const [[c]] = await pool.query(`SELECT id, fmh_api_key_enc, data_source FROM companies WHERE id = ?`, [companyId]);
  return c || null;
}

// ---------- recipes ----------
// Cost per serving of every FMH menu, from the cached recipe pull. The grouped
// pull is preferred (a handful of rows); the itemized one, if a recipe widget
// already keeps it, is summed instead of fetching again.
async function recipeCosts(companyId, { fetchIfMissing = true } = {}) {
  const { getCached, syncOne } = fmhCache();
  let cached = await getCached(companyId, RECIPE_SOURCE, RECIPE_GROUPING);
  let rows = cached && cached.data;
  if (!rows || !rows.length) {
    const itemized = await getCached(companyId, RECIPE_SOURCE, null);
    if (itemized && itemized.data.length) {
      const by = new Map();
      itemized.data.forEach((r) => {
        const name = r.menu_name;
        if (!name) return;
        const m = by.get(name) || { menu_name: name, menu_code: r.menu_code, menu_category: r.menu_category, total_cost: 0 };
        m.total_cost += Number(r.total_cost) || 0;
        by.set(name, m);
      });
      rows = [...by.values()];
      cached = itemized;
    }
  }
  if ((!rows || !rows.length) && fetchIfMissing) {
    const c = await companyInfo(companyId);
    if (c && (c.fmh_api_key_enc || c.data_source === 'demo')) {
      try {
        const got = await syncOne(companyId, RECIPE_SOURCE, RECIPE_GROUPING);
        rows = got.data;
        cached = { syncedAt: new Date() };
      } catch (err) {
        console.error(`POS: recipe pull failed for company ${companyId}:`, err.message);
      }
    }
  }
  const menus = new Map();
  (rows || []).forEach((r) => {
    if (!r.menu_name) return;
    const key = PosParse.menuKey(r.menu_name);
    if (!key || menus.has(key)) return;
    menus.set(key, {
      name: String(r.menu_name).replace(/\s+/g, ' ').trim(),
      code: r.menu_code || '',
      category: r.menu_category || '',
      cost: Math.round((Number(r.total_cost) || 0) * 10000) / 10000,
    });
  });
  return { menus, syncedAt: cached ? cached.syncedAt : null };
}

// Similarity of two names by shared character pairs (Dice). Thai has no
// spaces between words, so word-based matching would see one long word.
function similarity(a, b) {
  const grams = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = grams(a);
  const B = grams(b);
  let common = 0;
  A.forEach((n, g) => { common += Math.min(n, B.get(g) || 0); });
  const total = Math.max(1, a.length - 1 + (b.length - 1));
  return (2 * common) / total;
}

function suggestFor(key, menus) {
  let best = null;
  menus.forEach((m, k) => {
    const s = similarity(key, k);
    if (!best || s > best.score) best = { name: m.name, score: s };
  });
  // 0.7: keeps "ข้าวผัดกุ้งสด" → "ข้าวผัดกุ้ง", drops "ปลาหมึกไข่นึ่งมะนาว" → "ปลากะพงนึ่งมะนาว" (0.61).
  return best && best.score >= 0.7 ? best : null;
}

async function mappings(companyId) {
  const [rows] = await pool.query(
    `SELECT pos_key, pos_menu_name, fmh_menu_name, ignore_menu FROM pos_menu_map WHERE company_id = ?`,
    [companyId]
  );
  return new Map(rows.map((r) => [r.pos_key, r]));
}

// How one POS menu resolves: matched to a recipe, ignored (not a dish), or
// unmatched (sold, but no cost known).
function resolve(posName, menus, maps) {
  const key = PosParse.menuKey(posName);
  const m = maps.get(key);
  if (m && m.ignore_menu) return { status: 'ignored', via: 'manual' };
  if (m && m.fmh_menu_name) {
    const hit = menus.get(PosParse.menuKey(m.fmh_menu_name));
    if (hit) return { status: 'matched', via: 'manual', menu: hit };
    return { status: 'unmatched', via: 'manual', stale: m.fmh_menu_name };
  }
  const hit = menus.get(key);
  if (hit) return { status: 'matched', via: 'name', menu: hit };
  return { status: 'unmatched', via: null, suggestion: suggestFor(key, menus) };
}

// ---------- POS rows ----------
async function hasUploads(companyId) {
  const [[r]] = await pool.query(`SELECT COUNT(*) AS n FROM pos_sales_daily WHERE company_id = ?`, [companyId]);
  return r.n > 0;
}

// Daily POS lines for the cache window. A demo company with nothing uploaded
// gets the demo restaurant's POS file, so the widgets work in a demo.
async function salesLines(companyId, { allDays = false } = {}) {
  if (await hasUploads(companyId)) {
    const [[span]] = await pool.query(`SELECT MAX(sale_date) AS last FROM pos_sales_daily WHERE company_id = ?`, [companyId]);
    const last = span.last ? isoDay(span.last) : null;
    const from = allDays || !last ? '1900-01-01' : addDaysIso(last, -(CACHE_DAYS - 1));
    const [rows] = await pool.query(
      `SELECT sale_date, branch, menu_name, pos_code, pos_group, pos_category, pos_system, qty, net_sales, gross_sales, discount, line_count
       FROM pos_sales_daily WHERE company_id = ? AND sale_date >= ? ORDER BY sale_date, branch, menu_name`,
      [companyId, from]
    );
    return {
      demo: false,
      rows: rows.map((r) => ({
        sale_date: isoDay(r.sale_date), branch: r.branch, menu_name: r.menu_name, pos_code: r.pos_code,
        pos_group: r.pos_group, pos_category: r.pos_category, pos_system: r.pos_system, qty: Number(r.qty), net_sales: Number(r.net_sales),
        gross_sales: Number(r.gross_sales), discount: Number(r.discount), lines: r.line_count,
      })),
    };
  }
  const c = await companyInfo(companyId);
  if (c && c.data_source === 'demo') return { demo: true, rows: require('./demoData').posSalesRows() };
  return { demo: false, rows: [] };
}

function isoDay(v) {
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
}
function addDaysIso(iso, n) {
  return new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

const MATCH_LABEL = { matched: 'จับคู่สูตรแล้ว', unmatched: 'ยังไม่จับคู่', ignored: 'ไม่คิดต้นทุน' };

// The 'pos-sales' report rows. COGS is the recipe cost per serving today
// times the quantity sold — FMH keeps one current recipe cost, not its history.
function costRows(lines, menus, maps) {
  const memo = new Map();
  const res = (name) => {
    if (!memo.has(name)) memo.set(name, resolve(name, menus, maps));
    return memo.get(name);
  };
  return lines.map((l) => {
    const r = res(l.menu_name);
    const matched = r.status === 'matched';
    const unitCost = matched ? r.menu.cost : 0;
    const cogs = PosParse.round(unitCost * l.qty);
    const net = PosParse.round(l.net_sales);
    return {
      sale_date: l.sale_date,
      branch: l.branch,
      menu_name: l.menu_name,
      fmh_menu_name: matched ? r.menu.name : '',
      pos_category: l.pos_category || '',
      pos_group: l.pos_group || '',
      pos_system: l.pos_system || 'Foodstory',
      qty: l.qty,
      net_sales: net,
      discount: PosParse.round(l.discount || 0),
      unit_cost: PosParse.round(unitCost),
      cogs,
      matched_sales: matched ? net : 0,
      unmatched_sales: r.status === 'unmatched' ? net : 0,
      food_sales: r.status === 'ignored' ? 0 : net,
      gross_profit: matched ? PosParse.round(net - cogs) : 0,
      matched_qty: matched ? l.qty : 0,
      is_unmatched: r.status === 'unmatched' ? 1 : 0,
      match_status: MATCH_LABEL[r.status],
    };
  });
}

// Builds the report rows (null when the company has no POS sales at all).
async function buildRows(companyId) {
  const { rows: lines, demo } = await salesLines(companyId);
  if (!lines.length) return null;
  const { menus } = await recipeCosts(companyId);
  const maps = await mappings(companyId);
  const rows = costRows(lines, menus, maps);
  const dates = lines.map((l) => l.sale_date).sort();
  const food = rows.reduce((s, r) => s + r.food_sales, 0);
  const matched = rows.reduce((s, r) => s + r.matched_sales, 0);
  return {
    rows,
    meta: {
      pos: {
        demo,
        date_from: dates[0],
        date_to: dates[dates.length - 1],
        recipes: menus.size,
        coverage_pct: food ? Math.round((matched / food) * 1000) / 10 : null,
      },
    },
  };
}

// Recompute the cached report now (after an upload or a mapping change).
async function rebuild(companyId) {
  const { syncOne } = fmhCache();
  try {
    const out = await syncOne(companyId, SOURCE, null);
    await require('./ckAudit').rebuildIfShown(companyId);
    return out;
  } catch (err) {
    console.error(`POS rebuild failed for company ${companyId}:`, err.message);
    return null;
  }
}

// ---------- uploads ----------
function cleanRow(r) {
  const s = (v, max = 255) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  const date = PosParse.parseDate(r && r.sale_date);
  const menu = PosParse.baseMenuName(r && r.menu_name).slice(0, 255);
  if (!date || !menu) return null;
  return {
    sale_date: date,
    branch: s(r.branch) || 'ไม่ระบุสาขา',
    menu_name: menu,
    pos_code: s(r.pos_code, 64),
    pos_group: s(r.pos_group),
    pos_category: s(r.pos_category),
    qty: n(r.qty),
    net_sales: n(r.net_sales),
    gross_sales: n(r.gross_sales),
    discount: n(r.discount),
    lines: Math.max(1, Math.round(n(r.lines)) || 1),
  };
}

// A company's saved POS file layouts (pos_profiles).
async function listProfiles(companyId) {
  const [rows] = await pool.query(
    `SELECT id, name, columns_json, date_order, updated_at FROM pos_profiles WHERE company_id = ? ORDER BY name`,
    [companyId]
  );
  return rows.map((r) => ({ id: r.id, name: r.name, columns: JSON.parse(r.columns_json || '{}'), date_order: r.date_order, updated_at: r.updated_at }));
}

const cleanPosName = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 100);

// Saves (or updates, by name) the column mapping a user just made, so the
// next file from that POS uploads without mapping again.
async function saveProfile(companyId, userId, profile) {
  const name = cleanPosName(profile && profile.name);
  if (!name) throw httpError(400, 'ตั้งชื่อ POS ก่อนบันทึกการจับคู่คอลัมน์');
  if (PosParse.BUILTIN.some((b) => b.name.toLowerCase() === name.toLowerCase())) {
    throw httpError(400, `ชื่อ "${name}" เป็นรูปแบบที่ระบบมีอยู่แล้ว ตั้งชื่ออื่น`);
  }
  const columns = {};
  const roles = new Set(PosParse.ROLES.map((r) => r.key));
  Object.entries((profile && profile.columns) || {}).forEach(([k, v]) => {
    if (roles.has(k) && typeof v === 'string' && v.trim()) columns[k] = v.replace(/\s+/g, ' ').trim().slice(0, 255);
  });
  const missing = PosParse.REQUIRED.filter((k) => !columns[k]);
  if (missing.length) throw httpError(400, 'ยังจับคู่คอลัมน์ที่ต้องใช้ไม่ครบ');
  const order = ['dmy', 'mdy', 'ymd'].includes(profile.date_order) ? profile.date_order : 'dmy';
  await pool.query(
    `INSERT INTO pos_profiles (company_id, name, columns_json, date_order, header_signature, created_by) VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE columns_json = VALUES(columns_json), date_order = VALUES(date_order), header_signature = VALUES(header_signature)`,
    [companyId, name, JSON.stringify(columns), order, String(profile.signature || '').slice(0, 4000), userId || null]
  );
  return name;
}

async function deleteProfile(companyId, profileId) {
  const [r] = await pool.query(`DELETE FROM pos_profiles WHERE id = ? AND company_id = ?`, [profileId, companyId]);
  return r.affectedRows > 0;
}

async function importUpload(companyId, userId, { filename, format, rows, pos_name, profile }) {
  if (!Array.isArray(rows) || !rows.length) throw httpError(400, 'ไฟล์ไม่มีรายการขาย');
  let posName = cleanPosName(pos_name) || (format === 'foodstory' ? 'Foodstory' : 'POS อื่น');
  if (profile) posName = await saveProfile(companyId, userId, profile);
  if (rows.length > MAX_UPLOAD_ROWS) throw httpError(400, `ไฟล์ใหญ่เกินไป (${rows.length.toLocaleString()} แถวหลังรวมยอดรายวัน) — แบ่งอัปโหลดทีละช่วงวัน`);
  // The same day + branch + menu may arrive twice if two rows only differed
  // in a field the browser does not group on; merge rather than duplicate.
  const merged = new Map();
  let bad = 0;
  rows.forEach((raw) => {
    const r = cleanRow(raw);
    if (!r) { bad++; return; }
    const k = [r.sale_date, r.branch, r.menu_name, r.pos_code].join('\u0001');
    const m = merged.get(k);
    if (!m) merged.set(k, r);
    else ['qty', 'net_sales', 'gross_sales', 'discount', 'lines'].forEach((f) => { m[f] += r[f]; });
  });
  const clean = [...merged.values()];
  if (!clean.length) throw httpError(400, 'อ่านวันที่หรือชื่อเมนูในไฟล์ไม่ได้เลย');
  const dates = clean.map((r) => r.sale_date).sort();
  const net = clean.reduce((s, r) => s + r.net_sales, 0);
  const lineCount = clean.reduce((s, r) => s + r.lines, 0);

  const conn = await pool.getConnection();
  let uploadId;
  let replacedDays = 0;
  try {
    await conn.beginTransaction();
    const [ins] = await conn.query(
      `INSERT INTO pos_uploads (company_id, filename, pos_format, pos_name, date_from, date_to, line_count, net_sales, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [companyId, String(filename || 'pos.csv').slice(0, 255), format === 'foodstory' ? 'foodstory' : 'custom', posName,
        dates[0], dates[dates.length - 1], lineCount, PosParse.round(net), userId || null]
    );
    uploadId = ins.insertId;
    // Replace what this file covers: the same days at the same branches.
    const byBranch = new Map();
    clean.forEach((r) => {
      if (!byBranch.has(r.branch)) byBranch.set(r.branch, new Set());
      byBranch.get(r.branch).add(r.sale_date);
    });
    for (const [branch, days] of byBranch) {
      const list = [...days];
      for (let i = 0; i < list.length; i += 500) {
        const chunk = list.slice(i, i + 500);
        const [del] = await conn.query(
          `DELETE FROM pos_sales_daily WHERE company_id = ? AND branch = ? AND sale_date IN (?) AND upload_id <> ?`,
          [companyId, branch, chunk, uploadId]
        );
        replacedDays += del.affectedRows ? 1 : 0;
      }
    }
    for (let i = 0; i < clean.length; i += 1000) {
      const chunk = clean.slice(i, i + 1000);
      await conn.query(
        `INSERT INTO pos_sales_daily
           (company_id, upload_id, sale_date, branch, menu_name, pos_code, pos_group, pos_category, pos_system, qty, net_sales, gross_sales, discount, line_count)
         VALUES ?`,
        [chunk.map((r) => [companyId, uploadId, r.sale_date, r.branch, r.menu_name, r.pos_code, r.pos_group, r.pos_category, posName,
          r.qty, PosParse.round(r.net_sales), PosParse.round(r.gross_sales), PosParse.round(r.discount), r.lines])]
      );
    }
    // An older upload whose every day was replaced has nothing left to show.
    await conn.query(
      `DELETE u FROM pos_uploads u
       LEFT JOIN pos_sales_daily d ON d.upload_id = u.id
       WHERE u.company_id = ? AND u.id <> ? AND d.id IS NULL`,
      [companyId, uploadId]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  await rebuild(companyId);
  return { upload_id: uploadId, pos_name: posName, rows: clean.length, skipped: bad, date_from: dates[0], date_to: dates[dates.length - 1], net_sales: PosParse.round(net), replaced: replacedDays > 0 };
}

async function deleteUpload(companyId, uploadId) {
  const [r] = await pool.query(`DELETE FROM pos_uploads WHERE id = ? AND company_id = ?`, [uploadId, companyId]);
  if (!r.affectedRows) return false;
  if (await hasUploads(companyId)) await rebuild(companyId);
  else {
    // Nothing left: drop the report so widgets say "no file yet" again
    // (a demo company falls back to its demo POS file).
    const c = await companyInfo(companyId);
    if (c && c.data_source === 'demo') await rebuild(companyId);
    else {
      await pool.query(`DELETE FROM fmh_report_cache WHERE company_id = ? AND cache_key = ?`, [companyId, SOURCE]);
      await pool.query(`DELETE FROM fmh_cache_saved WHERE company_id = ? AND cache_key = ?`, [companyId, SOURCE]);
    }
  }
  return true;
}

async function setMapping(companyId, { pos_menu_name, fmh_menu_name, ignore }) {
  const name = PosParse.baseMenuName(pos_menu_name);
  const key = PosParse.menuKey(name);
  if (!key) throw httpError(400, 'ไม่ระบุชื่อเมนู POS');
  if (!fmh_menu_name && !ignore) {
    await pool.query(`DELETE FROM pos_menu_map WHERE company_id = ? AND pos_key = ?`, [companyId, key]);
  } else {
    if (fmh_menu_name) {
      const { menus } = await recipeCosts(companyId, { fetchIfMissing: false });
      if (!menus.has(PosParse.menuKey(fmh_menu_name))) throw httpError(400, 'ไม่พบเมนูนี้ในสูตรของ FMH');
    }
    await pool.query(
      `INSERT INTO pos_menu_map (company_id, pos_key, pos_menu_name, fmh_menu_name, ignore_menu) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE pos_menu_name = VALUES(pos_menu_name), fmh_menu_name = VALUES(fmh_menu_name), ignore_menu = VALUES(ignore_menu)`,
      [companyId, key, name.slice(0, 255), ignore ? null : String(fmh_menu_name).slice(0, 255), !!ignore]
    );
  }
  await rebuild(companyId);
}

// Everything the upload + mapping screen shows.
async function overview(companyId) {
  const [uploads] = await pool.query(
    `SELECT u.id, u.filename, u.pos_format, u.pos_name, u.date_from, u.date_to, u.line_count, u.net_sales, u.created_at,
            us.email AS uploaded_by_email, COUNT(d.id) AS rows_active
     FROM pos_uploads u
     LEFT JOIN users us ON us.id = u.uploaded_by
     LEFT JOIN pos_sales_daily d ON d.upload_id = u.id
     WHERE u.company_id = ? GROUP BY u.id ORDER BY u.created_at DESC, u.id DESC LIMIT 50`,
    [companyId]
  );
  const { rows: lines, demo } = await salesLines(companyId, { allDays: true });
  const { menus, syncedAt } = await recipeCosts(companyId, { fetchIfMissing: false });
  const maps = await mappings(companyId);
  const byMenu = new Map();
  lines.forEach((l) => {
    const m = byMenu.get(l.menu_name) || { pos_menu_name: l.menu_name, pos_category: l.pos_category, qty: 0, net_sales: 0 };
    m.qty += l.qty;
    m.net_sales += l.net_sales;
    byMenu.set(l.menu_name, m);
  });
  let food = 0;
  let matched = 0;
  const list = [...byMenu.values()].map((m) => {
    const r = resolve(m.pos_menu_name, menus, maps);
    if (r.status !== 'ignored') food += m.net_sales;
    if (r.status === 'matched') matched += m.net_sales;
    return {
      ...m,
      qty: PosParse.round(m.qty, 3),
      net_sales: PosParse.round(m.net_sales),
      status: r.status,
      via: r.via,
      fmh_menu_name: r.menu ? r.menu.name : r.stale || null,
      unit_cost: r.menu ? r.menu.cost : null,
      suggestion: r.suggestion ? r.suggestion.name : null,
    };
  });
  const order = { unmatched: 0, matched: 1, ignored: 2 };
  list.sort((a, b) => order[a.status] - order[b.status] || b.net_sales - a.net_sales);
  const dates = lines.map((l) => l.sale_date).sort();
  return {
    demo_data: demo,
    profiles: await listProfiles(companyId),
    builtin_profiles: PosParse.BUILTIN.map((b) => ({ id: b.id, name: b.name })),
    uploads: uploads.map((u) => ({ ...u, date_from: u.date_from && isoDay(u.date_from), date_to: u.date_to && isoDay(u.date_to), net_sales: Number(u.net_sales) })),
    menus: list,
    fmh_menus: [...menus.values()].map((m) => ({ name: m.name, cost: m.cost, category: m.category })).sort((a, b) => a.name.localeCompare(b.name, 'th')),
    recipes_synced_at: syncedAt,
    summary: {
      date_from: dates[0] || null,
      date_to: dates[dates.length - 1] || null,
      net_sales: PosParse.round(lines.reduce((s, l) => s + l.net_sales, 0)),
      food_sales: PosParse.round(food),
      matched_sales: PosParse.round(matched),
      coverage_pct: food ? Math.round((matched / food) * 1000) / 10 : null,
      unmatched_menus: list.filter((m) => m.status === 'unmatched').length,
    },
  };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { SOURCE, salesLines, mappings, listProfiles, saveProfile, deleteProfile, buildRows, rebuild, importUpload, deleteUpload, setMapping, overview, recipeCosts, resolve, similarity, costRows, hasUploads };
