// Company health: one honest answer to "is this company's setup working?".
//
// The same checks feed two screens, so KSS staff and the customer read the
// same facts:
//   - Admin home ("คิวงานที่ต้องดูแล"): every company, worst problem first
//   - Settings › สถานะระบบ: the customer's own company, with how to fix it
//
// state: ok | warn | bad | off   (off = not set up, which is fine unless the
// company needs it). `go` is a settings tab the customer can open to fix it.
const pool = require('../db/pool');

const STALE_SYNC_HOURS = 36; // the 1am sync missed a whole day
const POS_STALE_DAYS = 8;
const PLAN_WARN_DAYS = 14;
const LAPSED_STALE_DAYS = 30;
const LINE_QUOTA_WARN = 0.8;
const RANK = { bad: 3, warn: 2, ok: 1, off: 0 };

// FMH errors are raw text from the API or the network. Say what to do about it.
// Codes are matched as whole numbers (a PO number like 5012 is not an HTTP 501).
// A rejected key is not something the customer can fix alone: KSS is FMH's
// partner in Thailand, so the way out is "tell KSS" (go: 'support').
function explainFmhError(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[^a-z]+(api[^a-z]*)?key/.test(t)) {
    return { fix: 'FMH ไม่รับ API key นี้ (อาจหมดอายุหรือถูกเปลี่ยน) กด แจ้งทีมงาน ทีม KSS จะประสานกับ FMH และขอ key ใหม่ให้', go: 'support', kind: 'connect', ask: 'FMH ไม่รับ API key ของบริษัท ช่วยตรวจและขอ key ใหม่ให้หน่อย' };
  }
  if (/\b429\b|\bquota\b|rate[ _-]?limit|too many requests/.test(t)) return { fix: 'โควตาการดึงข้อมูลจาก FMH เดือนนี้ใกล้เต็ม ระบบจะดึงต่อเองเมื่อโควตาใหม่มา', go: null };
  if (/\btimeout\b|timed out|\beconn[a-z]*\b|\benotfound\b|network|fetch failed|\b5\d\d\b/.test(t)) return { fix: 'เชื่อม FMH ไม่ได้ชั่วคราว ระบบจะลองใหม่เองในรอบถัดไป ไม่ต้องทำอะไร', go: null };
  return { fix: 'ดึงข้อมูลล่าสุดจาก FMH ไม่สำเร็จ ระบบจะลองใหม่เอง ถ้ายังเป็นอยู่พรุ่งนี้ให้กด แจ้งทีมงาน', go: 'support', kind: 'connect', ask: 'ดึงข้อมูลจาก FMH ไม่สำเร็จ' };
}

const reportLabel = (key) => {
  try {
    const { FMH_REPORTS } = require('./fmhCache');
    const base = String(key).split('|')[0];
    return (FMH_REPORTS[base] && FMH_REPORTS[base].label) || base;
  } catch (e) { return String(key).split('|')[0]; }
};
const thaiStamp = (d) => new Date(d).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
// Days of silence before a POS upload counts as late, from this company's own rhythm.
function posLimitDays(uploads) {
  const days = uploads.slice(0, 7).map((u) => new Date(u.created_at).getTime() / 86400000);
  const gaps = [];
  for (let i = 0; i + 1 < days.length; i++) gaps.push(days[i] - days[i + 1]);
  gaps.sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 35; // one upload so far: assume monthly
  return Math.min(60, Math.max(POS_STALE_DAYS, Math.round(median * 1.5)));
}

const daysUntil = (d) => {
  if (!d) return null;
  const end = new Date(d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((end - today) / 86400000);
};

// Health for many companies with a handful of grouped queries (150 companies
// must not mean 750 round trips). Returns Map(companyId -> { company, checks, level, openSupport }).
async function healthFor(companyIds = null) {
  const where = companyIds ? 'WHERE c.id IN (?)' : '';
  const args = companyIds ? [companyIds.length ? companyIds : [0]] : [];
  const [companies] = await pool.query(
    `SELECT c.id, c.company_code, c.name, c.status, c.plan_tier, c.data_source, c.self_serve, c.subscription_ends_at,
            (c.fmh_api_key_enc IS NOT NULL) AS has_key
       FROM companies c ${where}`,
    args
  );
  const ids = companies.map((c) => c.id);
  if (!ids.length) return new Map();
  const [errs] = await pool.query(
    `SELECT e.company_id, COUNT(*) AS n, MAX(e.failed_at) AS last_at,
            SUBSTRING_INDEX(GROUP_CONCAT(e.error_text ORDER BY e.failed_at DESC SEPARATOR '\n'), '\n', 1) AS sample
       FROM fmh_sync_errors e WHERE e.company_id IN (?) GROUP BY e.company_id`, [ids]);
  const [syncs] = await pool.query(
    `SELECT c.company_id, c.cache_key AS oldest_key, c.synced_at AS oldest_sync, n.reports
       FROM fmh_report_cache c
       JOIN (SELECT company_id, MIN(synced_at) AS m, COUNT(*) AS reports FROM fmh_report_cache WHERE company_id IN (?) GROUP BY company_id) n
         ON n.company_id = c.company_id AND n.m = c.synced_at`, [ids]);
  const [pos] = await pool.query(
    `SELECT company_id, date_to, created_at FROM pos_uploads WHERE company_id IN (?) ORDER BY company_id, created_at DESC`, [ids]);
  const [lines] = await pool.query(
    `SELECT company_id, enabled, group_id, quota_used, monthly_quota, quota_month, members, (access_token_enc IS NOT NULL) AS has_token
       FROM company_line WHERE company_id IN (?)`, [ids]);
  const [sup] = await pool.query(
    `SELECT company_id, COUNT(*) AS n FROM support_requests WHERE company_id IN (?) AND status <> 'done' GROUP BY company_id`, [ids]);
  const by = (rows) => new Map(rows.map((r) => [r.company_id, r]));
  const E = by(errs), S = by(syncs), L = by(lines), U = by(sup);
  const P = new Map(); // company -> uploads, newest first
  for (const r of pos) (P.get(r.company_id) || P.set(r.company_id, []).get(r.company_id)).push(r);
  const { quotaView } = require('./line');

  const out = new Map();
  for (const c of companies) {
    const checks = [];
    const demo = c.status === 'demo' || c.data_source === 'demo';

    // FMH
    const e = E.get(c.id), s = S.get(c.id);
    if (!c.has_key && !demo) {
      checks.push({ key: 'fmh', label: 'ข้อมูลจัดซื้อ (FMH)', state: 'off', detail: 'ยังไม่ได้ใส่ FMH API key', fix: 'ใส่ API key ที่ ตั้งค่า › การเชื่อมข้อมูล แล้วระบบจะดึงข้อมูลมาให้เอง', go: 'data' });
    } else if (e) {
      const ex = explainFmhError(e.sample);
      checks.push({ key: 'fmh', label: 'ข้อมูลจัดซื้อ (FMH)', state: 'bad', detail: `ดึงข้อมูลล่าสุดไม่สำเร็จ ${e.n} รายงาน`, fix: ex.fix, go: ex.go || 'data', kind: ex.kind, ask: ex.ask, since: e.last_at, raw: String(e.sample || '').slice(0, 200) });
    } else if (s && !demo && (Date.now() - new Date(s.oldest_sync).getTime()) / 3600000 > STALE_SYNC_HOURS) {
      // The oldest report decides: one fresh report must not hide a stuck one.
      checks.push({ key: 'fmh', label: 'ข้อมูลจัดซื้อ (FMH)', state: 'warn', detail: `รายงาน "${reportLabel(s.oldest_key)}" อัปเดตล่าสุดเมื่อ ${thaiStamp(s.oldest_sync)}`, fix: 'กดปุ่ม รีเฟรช ที่ dashboard หรือรอรอบอัปเดตตอนตี 1 ถ้าวันพรุ่งนี้ยังเก่าอยู่ให้กด แจ้งทีมงาน', go: 'data', since: s.oldest_sync });
    } else if (!s && !demo) {
      checks.push({ key: 'fmh', label: 'ข้อมูลจัดซื้อ (FMH)', state: 'warn', detail: 'ใส่ key แล้วแต่ยังไม่มีข้อมูลที่ดึงมา', fix: 'รอสักครู่หลังใส่ key หรือเพิ่ม widget แล้วกดรีเฟรช', go: 'data' });
    } else {
      checks.push({ key: 'fmh', label: 'ข้อมูลจัดซื้อ (FMH)', state: 'ok', detail: demo ? 'ข้อมูลตัวอย่าง' : 'อัปเดตปกติ', since: s && s.oldest_sync });
    }

    // POS file uploads (Foodstory etc.) — optional, only warn once they use it.
    // How late is "late" depends on how often this company uploads: a weekly
    // uploader is late after ~10 days, a month-end uploader is not late at day 9.
    const ups = P.get(c.id);
    if (!ups) {
      checks.push({ key: 'pos', label: 'ยอดขาย POS', state: 'off', detail: 'ยังไม่ได้อัปโหลดไฟล์ยอดขาย', fix: 'ถ้าต้องการดูยอดขายคู่กับต้นทุน อัปโหลดไฟล์จาก POS ที่ ตั้งค่า › การเชื่อมข้อมูล', go: 'data' });
    } else {
      const lastDay = ups.map((u) => u.date_to).filter(Boolean).sort().pop();
      const age = lastDay ? Math.max(0, Math.floor((Date.now() - new Date(lastDay).getTime()) / 86400000)) : null;
      const limit = posLimitDays(ups);
      const when = lastDay ? String(lastDay).slice(0, 10) : '-';
      checks.push(age != null && age > limit
        ? { key: 'pos', label: 'ยอดขาย POS', state: 'warn', detail: `ยอดขายล่าสุดถึงวันที่ ${when} (ห่างมา ${age} วัน)`, fix: 'อัปโหลดไฟล์ยอดขายรอบใหม่เพื่อให้ widget ยอดขายและต้นทุนเป็นปัจจุบัน', go: 'data', since: ups[0].created_at }
        : { key: 'pos', label: 'ยอดขาย POS', state: 'ok', detail: `ยอดขายล่าสุดถึงวันที่ ${when}`, since: ups[0].created_at });
    }

    // LINE (month and limit come from lib/line.js so both always agree)
    const l = L.get(c.id);
    if (!l || !l.has_token) {
      checks.push({ key: 'line', label: 'แจ้งเตือนทาง LINE', state: 'off', detail: 'ยังไม่ได้ตั้งค่า LINE', fix: 'ตั้งที่ ตั้งค่า › ตัวเตือน & LINE ถ้าอยากให้ระบบส่งสรุปและเตือนเข้ากลุ่ม', go: 'alerts' });
    } else if (l.enabled && !l.group_id) {
      checks.push({ key: 'line', label: 'แจ้งเตือนทาง LINE', state: 'warn', detail: 'เปิดใช้แล้วแต่ยังไม่ได้เชิญบอทเข้ากลุ่ม', fix: 'เชิญบอทเข้ากลุ่ม LINE แล้วพิมพ์ข้อความ 1 ครั้งให้บอทจับกลุ่ม', go: 'alerts' });
    } else {
      const q = quotaView(l);
      checks.push(q.full
        ? { key: 'line', label: 'แจ้งเตือนทาง LINE', state: 'bad', detail: `โควตาข้อความเดือนนี้เต็มแล้ว (${q.used}/${q.limit})`, fix: 'ตอนนี้ระบบหยุดส่งทั้งสรุปรายวันและตัวเตือน (เช่น ราคาขึ้น, PO ค้าง) จนถึงต้นเดือนหน้า หรือเพิ่มโควตา LINE ของบริษัท', go: 'alerts' }
        : q.warn
          ? { key: 'line', label: 'แจ้งเตือนทาง LINE', state: 'warn', detail: `ใช้โควตาข้อความไปแล้ว ${q.used}/${q.limit}`, fix: 'ลดจำนวนหัวข้อที่ส่งสรุป หรือเพิ่มโควตา ไม่เช่นนั้นตัวเตือนจะหยุดส่งก่อนสิ้นเดือน', go: 'alerts' }
          : { key: 'line', label: 'แจ้งเตือนทาง LINE', state: l.enabled ? 'ok' : 'off', detail: l.enabled ? `ส่งปกติ (ใช้ ${q.used}/${q.limit})` : 'ตั้งค่าไว้แต่ปิดอยู่' });
    }

    // Plan
    const left = daysUntil(c.subscription_ends_at);
    if (c.status === 'suspended') {
      checks.push({ key: 'plan', label: 'แพ็กเกจ', state: 'warn', detail: 'บัญชีถูกระงับ', fix: 'ต่ออายุที่ ตั้งค่า › แพ็กเกจและการชำระเงิน หรือแจ้งทีมงาน', go: 'plan' });
    } else if (left != null && left < 0) {
      // Just lapsed is a renewal to chase; lapsed for a month or more is a lost
      // customer, which should not bury the companies that are still using it.
      const stale = -left > LAPSED_STALE_DAYS;
      checks.push({ key: 'plan', label: 'แพ็กเกจ', state: stale ? 'warn' : 'bad', detail: stale ? `หมดอายุนานแล้ว (${-left} วัน)` : `หมดอายุมาแล้ว ${-left} วัน`, fix: 'ต่ออายุที่ ตั้งค่า › แพ็กเกจและการชำระเงิน', go: 'plan' });
    } else if (left != null && left <= PLAN_WARN_DAYS) {
      checks.push({ key: 'plan', label: 'แพ็กเกจ', state: 'warn', detail: `จะหมดอายุในอีก ${left} วัน`, fix: 'ต่ออายุล่วงหน้าที่ ตั้งค่า › แพ็กเกจและการชำระเงิน', go: 'plan' });
    } else {
      checks.push({ key: 'plan', label: 'แพ็กเกจ', state: 'ok', detail: left == null ? 'ไม่มีวันหมดอายุ' : `ใช้ได้อีก ${left} วัน` });
    }

    // Worst state of the checks that matter (off never raises the level).
    let level = 'ok';
    for (const k of checks) if (RANK[k.state] > RANK[level]) level = k.state;
    out.set(c.id, { company: c, checks, level, open_support: (U.get(c.id) || {}).n || 0 });
  }
  return out;
}

// How urgent an issue is, for ordering the KSS queue: a customer who cannot see
// their data comes before a renewal, which comes before housekeeping.
const WEIGHT = { fmh: 100, plan: 80, line: 60, pos: 30 };
const issueScore = (c) => (WEIGHT[c.key] || 20) + (c.state === 'bad' ? 1000 : 0);

module.exports = { healthFor, explainFmhError, issueScore, RANK };
