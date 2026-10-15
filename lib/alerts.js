// Alert widgets ("ตัวเตือน"). An analysis widget answers "what happened and
// why" over any range the user picks; an alert widget answers "what needs
// attention today" over a fixed window that suits the signal (yesterday vs the
// usual, or the last complete month for signals that only exist monthly).
//
// Each watcher reads report rows the app already caches and returns findings.
// Findings are kept in alert_events, so the same rows feed the dashboard
// widget (report source "watch-*") and the LINE digest (lib/line.js): the
// number in the LINE card is the number on the screen.
//
// A finding lasts while the watcher keeps finding it. sig is how bad it is
// now; LINE re-sends a finding only when sig changes (new, or worse).
const pool = require('../db/pool');

const DAY = 86400000;
// Asia/Bangkok calendar day, whatever the server's timezone.
const bkkToday = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round = (v, d = 0) => Math.round(v * 10 ** d) / 10 ** d;
const HISTORY_DAYS = 14;
const TH_MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const monthTh = (iso) => { const [y, m] = String(iso || '').split('-'); return m ? `${TH_MONTH[Number(m) - 1]} ${Number(y) + 543}` : String(iso || ''); };

// A cache built on an earlier Bangkok day.
const staleDay = (c) => !c.syncedAt || new Date(new Date(c.syncedAt).getTime() + 7 * 3600000).toISOString().slice(0, 10) < bkkToday();

async function companyInfo(companyId) {
  const [[c]] = await pool.query(`SELECT data_source FROM companies WHERE id = ?`, [companyId]);
  return c || {};
}
// Cached rows only. A demo company builds on demand; a real one never pulls
// from FMH here (quota) — the nightly sync fills the cache for alert widgets
// through the watcher source's `inputs`.
async function rowsOf(companyId, source) {
  const fc = require('./fmhCache');
  const c = await fc.getCached(companyId, source, null);
  const demo = (await companyInfo(companyId)).data_source === 'demo';
  // Generated demo data moves with the calendar: yesterday's cache has no "yesterday".
  if (c && c.data && c.data.length && !(demo && staleDay(c))) return c.data;
  if (demo) {
    try { return (await fc.syncOne(companyId, source, null)).data || []; } catch (err) { console.error(`alerts: ${source} build failed:`, err.message); }
  }
  return c ? c.data || [] : [];
}

// ---------- watchers ----------
// detect(companyId, settings, today) → { findings: [...], note }
// A finding: { key, sig, severity, impact, period, branch, subject, detail, change_pct }
const SKIP_STATUS = /CANCEL|REJECT|DRAFT|VOID/i;

const WATCHERS = {
  // Daily. Unit price on the latest order day vs the same product + supplier +
  // unit over the 90 days before. Different units are never compared.
  price: {
    key: 'price',
    source: 'watch-price',
    name: 'ราคาซื้อวัตถุดิบขึ้นผิดปกติ',
    cadence: 'รายวัน',
    defaults: { threshold: 10, min_impact: 300 },
    async detect(companyId, s, today) {
      const rows = (await rowsOf(companyId, 'purchase-analysis')).filter(
        (r) => r.order_date && num(r.qty) > 0 && num(r.price) > 0 && !SKIP_STATUS.test(r.order_status || '')
      );
      if (!rows.length) return { findings: [], note: 'ยังไม่มีข้อมูลใบสั่งซื้อ (FMH Purchase Analysis)' };
      // Each product's latest order day in the last 3 days (a supplier that
      // delivers every other day is still caught), against its own 90 days before.
      const yesterday = addDays(today, -1);
      const recentFrom = addDays(yesterday, -2);
      const lines = new Map();
      rows.forEach((r) => {
        const d = String(r.order_date).slice(0, 10);
        if (d > yesterday || d < addDays(recentFrom, -90)) return;
        const k = `${r.product_code || r.product_name}|${r.uom || ''}|${r.supplier || ''}`;
        if (!lines.has(k)) lines.set(k, []);
        lines.get(k).push({ r, d });
      });
      const groups = new Map();
      lines.forEach((ls, k) => {
        const day = ls.map((x) => x.d).filter((d) => d >= recentFrom).sort().pop();
        if (!day) return;
        const g = { r: null, day, cur: { q: 0, v: 0, branches: new Set() }, base: { q: 0, v: 0, n: 0 } };
        ls.forEach(({ r, d }) => {
          const q = num(r.qty), v = q * num(r.price);
          if (d === day) { g.cur.q += q; g.cur.v += v; g.cur.branches.add(r.branch || ''); g.r = r; }
          else if (d < day && d >= addDays(day, -90)) { g.base.q += q; g.base.v += v; g.base.n++; }
        });
        groups.set(k, g);
      });
      if (!groups.size) return { findings: [], note: 'ไม่มีใบสั่งซื้อในช่วง 3 วันล่าสุด' };
      const t = num(s.threshold) / 100, minImpact = num(s.min_impact);
      const findings = [];
      groups.forEach((g, k) => {
        if (!g.cur.q || g.base.n < 3 || !g.base.q) return;
        const cur = g.cur.v / g.cur.q, base = g.base.v / g.base.q;
        const change = cur / base - 1;
        const impact = (cur - base) * g.cur.q;
        if (change < t || impact < minImpact) return;
        const r = g.r;
        findings.push({
          key: k,
          sig: String(Math.floor((change * 100) / 5)), // re-send when it climbs another 5 points
          severity: change >= 0.25 || impact >= 5000 ? 'สูง' : 'กลาง',
          impact: round(impact),
          period: g.day,
          branch: [...g.cur.branches].filter(Boolean).join(', '),
          subject: `${r.product_name || r.product_code} · ${r.supplier || '-'}`,
          detail: `${round(cur, 2)} บาท/${r.uom || 'หน่วย'} (ปกติ ${round(base, 2)}) ซื้อ ${round(g.cur.q, 2)} ${r.uom || ''}`.trim(),
          change_pct: round(change * 100, 1),
        });
      });
      return { findings, note: '' };
    },
  },

  // Daily. FMH discipline: a PO should get its GRN soon after the delivery
  // date, and be closed (invoice → COMPLETED) soon after the GRN.
  po: {
    key: 'po',
    source: 'watch-po',
    name: 'PO ค้างไม่ปิด',
    cadence: 'รายวัน',
    digest: 'summary',
    defaults: { days: 7 },
    async detect(companyId, s, today) {
      const rows = await rowsOf(companyId, 'purchase-analysis');
      if (!rows.length) return { findings: [], note: 'ยังไม่มีข้อมูลใบสั่งซื้อ (FMH Purchase Analysis)' };
      return { findings: staleDocs(rows, { today, days: num(s.days) || 7, doc: 'po_number', done: 'grn', kind: 'PO' }), note: '' };
    },
  },

  // Daily. The CK's sales orders: a DO soon after the delivery date, then closed.
  so: {
    key: 'so',
    source: 'watch-so',
    name: 'SO ครัวกลางค้างไม่ปิด',
    cadence: 'รายวัน',
    digest: 'summary',
    defaults: { days: 7 },
    async detect(companyId, s, today) {
      const rows = await rowsOf(companyId, 'sales-analysis');
      if (!rows.length) return { findings: [], note: 'ยังไม่มีข้อมูลใบขายของครัวกลาง (FMH Sales Analysis)' };
      return { findings: staleDocs(rows, { today, days: num(s.days) || 7, doc: 'so_number', done: 'do', kind: 'SO' }), note: '' };
    },
  },

  // Monthly by nature: the branch purchase audit only means something over a
  // whole month. Same rule as the audit widgets ("ควรตรวจ").
  ck: {
    key: 'ck',
    source: 'watch-ck',
    name: 'สาขาซื้อจากครัวกลางน้อยผิดปกติ',
    cadence: 'รายเดือน',
    defaults: {},
    async detect(companyId) {
      const fc = require('./fmhCache');
      const ck = require('./ckAudit');
      let rows = null;
      const cached = await fc.getCached(companyId, 'ck-audit', null);
      const demo = (await companyInfo(companyId)).data_source === 'demo';
      if (cached && cached.data && cached.data.length && !(demo && staleDay(cached))) rows = cached.data;
      else { const b = await ck.buildFor(companyId, 'ck-audit'); rows = (b && b.rows) || []; }
      const latest = rows.filter((r) => r.is_latest);
      if (!latest.length) {
        let note = 'ต้องมียอดขาย POS และยอดขายจากครัวกลางใน FMH';
        try {
          const o = await ck.overview(companyId);
          note = !o.has_pos && !o.has_ck ? 'ยังไม่มีทั้งยอดขาย POS และยอดขายจากครัวกลาง'
            : !o.has_pos ? 'ยังไม่มียอดขาย POS (อัปโหลดไฟล์ POS ในหน้า Admin)'
            : !o.has_ck ? 'ยังไม่มียอดขายจากครัวกลาง (FMH Sales Analysis)'
            : 'ช่วงเวลาที่ POS กับครัวกลางทับกันยังไม่พอจะเทียบ';
        } catch (e) { /* keep the generic note */ }
        return { findings: [], note: `ยังไม่มีข้อมูลตรวจสาขา: ${note}` };
      }
      const findings = latest.filter((r) => r.status === 'ควรตรวจ').map((r) => ({
        key: r.branch,
        sig: `${r.month}|${r.low_streak}`,
        severity: r.low_streak >= 4 || (r.vs_median !== null && r.vs_median < 70) ? 'สูง' : 'กลาง',
        // What the branch would have bought from the CK at the median share.
        impact: round(Math.max(0, ((num(r.median_pct) - num(r.ck_pct)) / 100) * num(r.pos_sales))),
        period: monthTh(r.month),
        branch: r.branch,
        subject: r.branch,
        detail: `ซื้อจากครัวกลาง ${round(num(r.ck_pct), 1)}% ของยอดขาย (ค่ากลางสาขาอื่น ${round(num(r.median_pct), 1)}%) · ต่ำกว่าเกณฑ์ ${r.low_streak} เดือนติดต่อกัน`,
        change_pct: r.vs_median === null ? null : round(num(r.vs_median) - 100, 1),
      }));
      return { findings, note: '' };
    },
  },
};

// Documents (PO or SO) still not COMPLETED `days` after they should have
// moved: no GRN/DO `days` after the requested delivery date, or GRN/DO
// recorded `days` ago and still open. One finding per document.
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
function staleDocs(rows, { today, days, doc, done, kind }) {
  const docs = new Map();
  rows.forEach((r) => {
    const no = r[doc];
    if (!no || SKIP_STATUS.test(r.order_status || '')) return;
    if (!docs.has(no)) docs.set(no, []);
    docs.get(no).push(r);
  });
  const out = [];
  docs.forEach((ls, no) => {
    if (ls.every((r) => /COMPLETED/i.test(r.order_status || ''))) return;
    const r = ls[0];
    const step = done === 'grn' ? { num: 'grn_number', date: 'grn_date', label: 'GRN', verb: 'รับของ' } : { num: 'do_number', date: 'do_date', label: 'DO', verb: 'ส่งของ' };
    const stepDates = ls.map((x) => String(x[step.date] || '').slice(0, 10)).filter(Boolean).sort();
    const due = String(r.requested_delivery_date || r.order_date || '').slice(0, 10);
    let reason, since;
    if (!stepDates.length) { reason = `ยังไม่บันทึก${step.verb} (${step.label})`; since = due; }
    else { reason = kind === 'PO' ? `${step.verb}แล้ว ยังไม่ปิด PO (บัญชี/เจ้าหนี้ตรวจปิด)` : `${step.verb}แล้ว ยังไม่ปิด ${kind}`; since = stepDates[stepDates.length - 1]; }
    if (!since) return;
    const age = daysBetween(since, today);
    if (age < days) return;
    const value = ls.reduce((t, x) => t + num(x.total || x.po_total || x.so_total), 0);
    out.push({
      key: no,
      sig: `${reason.slice(0, 20)}|${Math.floor(age / 7)}`, // reminded again each week it stays open
      // วิกฤต: open two months, or a month and ≥ ฿10k. สูง: past twice the threshold or ≥ ฿10k.
      severity: age >= 60 || (age >= Math.max(30, days * 4) && value >= 10000) ? 'วิกฤต' : age >= days * 2 || value >= 10000 ? 'สูง' : 'กลาง',
      impact: round(value),
      age_days: age,
      period: since,
      branch: kind === 'PO' ? r.branch || '' : '',
      subject: kind === 'PO' ? `${no} · ${r.supplier || '-'}` : `${no} · ${r.customer || '-'}`,
      detail: `${reason} มา ${age} วัน`,
      change_pct: null,
    });
  });
  return out;
}
const ORDER = ['price', 'po', 'so', 'ck'];
const bySource = (source) => ORDER.map((k) => WATCHERS[k]).find((w) => w.source === source);

// ---------- settings (stored with the company's LINE settings) ----------
async function settings(companyId) {
  let saved = {};
  try {
    const [[r]] = await pool.query(`SELECT watch_json FROM company_line WHERE company_id = ?`, [companyId]);
    saved = r && r.watch_json ? JSON.parse(r.watch_json) : {};
  } catch (e) { saved = {}; }
  const out = {};
  ORDER.forEach((k) => {
    const w = WATCHERS[k];
    const s = saved[k] || {};
    out[k] = { line: s.line !== false, ...w.defaults };
    Object.keys(w.defaults).forEach((f) => { if (Number.isFinite(Number(s[f])) && Number(s[f]) >= 0) out[k][f] = Number(s[f]); });
  });
  return out;
}
async function saveSettings(companyId, patch) {
  await require('./line').ensure(companyId);
  const cur = await settings(companyId);
  ORDER.forEach((k) => {
    const p = (patch || {})[k];
    if (!p) return;
    if (typeof p.line === 'boolean') cur[k].line = p.line;
    Object.keys(WATCHERS[k].defaults).forEach((f) => { if (p[f] !== undefined && Number.isFinite(Number(p[f])) && Number(p[f]) >= 0) cur[k][f] = Number(p[f]); });
  });
  await pool.query(`UPDATE company_line SET watch_json = ? WHERE company_id = ?`, [JSON.stringify(cur), companyId]);
  return cur;
}

// ---------- evaluate + history ----------
// Runs one watcher and records what it found. Returns { findings, note }.
async function evaluate(companyId, key, today = bkkToday()) {
  const w = WATCHERS[key];
  const s = (await settings(companyId))[key];
  const { findings, note } = await w.detect(companyId, s, today);
  for (const f of findings) {
    await pool.query(
      `INSERT INTO alert_events (company_id, watcher, finding_key, first_seen, last_seen, severity, impact, payload_json, sig)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         sent_sig = IF(last_seen < DATE_SUB(VALUES(last_seen), INTERVAL 3 DAY), NULL, sent_sig),
         ack_status = IF(last_seen < DATE_SUB(VALUES(last_seen), INTERVAL 3 DAY), NULL, ack_status),
         first_seen = IF(last_seen < DATE_SUB(VALUES(last_seen), INTERVAL 3 DAY), VALUES(first_seen), first_seen),
         last_seen = VALUES(last_seen), severity = VALUES(severity), impact = VALUES(impact),
         payload_json = VALUES(payload_json), sig = VALUES(sig)`,
      [companyId, key, String(f.key).slice(0, 191), today, today, f.severity, f.impact || 0, JSON.stringify(f), String(f.sig).slice(0, 64)]
    );
  }
  await pool.query(`DELETE FROM alert_events WHERE company_id = ? AND watcher = ? AND last_seen < ?`, [companyId, key, addDays(today, -60)]);
  return { findings, note };
}

const SEV_RANK = { วิกฤต: 0, สูง: 1, กลาง: 2 };
function toRow(e, today) {
  const p = JSON.parse(e.payload_json || '{}');
  const last = typeof e.last_seen === 'string' ? e.last_seen.slice(0, 10) : isoOf(e.last_seen);
  const first = typeof e.first_seen === 'string' ? e.first_seen.slice(0, 10) : isoOf(e.first_seen);
  const active = last === today;
  return {
    watcher: e.watcher, finding_key: e.finding_key,
    status: !active ? 'จบแล้ว' : first === today ? 'ใหม่' : 'ต่อเนื่อง',
    is_active: active ? 1 : 0,
    severity: e.severity, impact: Number(e.impact) || 0,
    period: p.period || '', branch: p.branch || '', subject: p.subject || '', detail: p.detail || '',
    change_pct: p.change_pct === undefined ? null : p.change_pct,
    age_days: p.age_days === undefined ? null : p.age_days,
    first_seen: first, last_seen: last,
    line_sent: e.sent_sig && e.sent_sig === e.sig ? 'ส่งแล้ว' : '',
    handled: e.ack_status === 'assigned' ? `มอบหมาย: ${e.ack_to || '-'}` : e.ack_status === 'ack' ? `รับทราบ · ${e.ack_name || ''}`.trim() : '',
    // One sort key for the table: open first, then severity, then baht.
    rank: (active ? 4e12 : 0) + (e.severity === 'วิกฤต' ? 2e12 : e.severity === 'สูง' ? 1e12 : 0) + Math.min((Number(e.impact) || 0) * Math.max(1, Math.sqrt(p.age_days || 1)), 9e11),
    sig: e.sig, sent_sig: e.sent_sig,
  };
}
function isoOf(d) {
  if (!(d instanceof Date)) return String(d || '').slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
async function history(companyId, key, today = bkkToday()) {
  const [rows] = await pool.query(
    `SELECT * FROM alert_events WHERE company_id = ? AND watcher = ? AND last_seen >= ? ORDER BY last_seen DESC, impact DESC`,
    [companyId, key, addDays(today, -HISTORY_DAYS)]
  );
  return rows.map((e) => toRow(e, today)).sort((a, b) => b.is_active - a.is_active || (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || b.impact - a.impact);
}

// The widget source: evaluate, then show what is open now and the last 14 days.
async function buildFor(companyId, source) {
  const w = bySource(source);
  if (!w) return null;
  const today = bkkToday();
  const { note } = await evaluate(companyId, w.key, today);
  return { rows: await history(companyId, w.key, today), meta: { watch: { watcher: w.key, evaluated_on: today, note } } };
}

// Marks findings as sent with the sig they had.
async function markSent(companyId, rows) {
  for (const r of rows) {
    await pool.query(`UPDATE alert_events SET sent_sig = sig, sent_at = NOW() WHERE company_id = ? AND watcher = ? AND finding_key = ?`, [companyId, r.watcher, r.finding_key]);
  }
}

// "เช้านี้ต้องทำ": the open findings across every watcher, most urgent first.
const OWNER = { po: 'บัญชี/เจ้าหนี้', so: 'ครัวกลาง', price: 'จัดซื้อ', ck: 'ผู้จัดการสาขา' };
async function today(companyId, branch) {
  const day = bkkToday();
  const [rows] = await pool.query(`SELECT * FROM alert_events WHERE company_id = ? AND last_seen = ?`, [companyId, day]);
  const items = rows.map((e) => ({ ...toRow(e, day), ack_status: e.ack_status || null, owner: OWNER[e.watcher] || '', source: (WATCHERS[e.watcher] || {}).source || null }))
    .filter((r) => !branch || r.branch === branch)
    .sort((a, b) => b.rank - a.rank);
  return { day, items };
}
async function ack(companyId, watcher, findingKey, action, to, user) {
  if (user.home_branch) {
    const [[e]] = await pool.query(`SELECT payload_json FROM alert_events WHERE company_id = ? AND watcher = ? AND finding_key = ?`, [companyId, watcher, findingKey]);
    const b = e ? (JSON.parse(e.payload_json || '{}').branch || '') : '';
    if (b !== user.home_branch) throw Object.assign(new Error('รายการนี้ไม่ใช่ของสาขาคุณ'), { status: 403 });
  }
  if (action === 'clear') {
    await pool.query(`UPDATE alert_events SET ack_status = NULL, ack_to = NULL, ack_name = NULL, ack_at = NULL WHERE company_id = ? AND watcher = ? AND finding_key = ?`, [companyId, watcher, findingKey]);
  } else {
    await pool.query(
      `UPDATE alert_events SET ack_status = ?, ack_to = ?, ack_name = ?, ack_at = NOW() WHERE company_id = ? AND watcher = ? AND finding_key = ?`,
      [action === 'assign' ? 'assigned' : 'ack', action === 'assign' ? String(to || '').slice(0, 80) : null, String(user.display_name || user.email || '').slice(0, 120), companyId, watcher, findingKey]
    );
  }
}

// Real branch names of a company, from the cached purchase/sales rows (never pulls from FMH).
async function branchesOf(companyId) {
  const set = new Set();
  for (const src of ['purchase-analysis', 'sales-analysis']) {
    try { (await rowsOf(companyId, src)).forEach((r) => { const b = String((r && r.branch) || '').trim(); if (b) set.add(b); }); } catch (_) {}
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'th'));
}

module.exports = { branchesOf, today, ack, WATCHERS, ORDER, bySource, settings, saveSettings, evaluate, history, buildFor, markSent, bkkToday, addDays };
