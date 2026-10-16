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
function explainFmhError(text) {
  const t = String(text || '').toLowerCase();
  if (/401|403|unauthor|forbidden|invalid.*key|api.?key/.test(t)) return 'FMH ไม่รับ API key นี้ (อาจหมดอายุหรือถูกเปลี่ยน) ขอ key ใหม่จาก FMH แล้วใส่ที่ ตั้งค่า › การเชื่อมข้อมูล';
  if (/429|quota|rate|limit/.test(t)) return 'โควตาการดึงข้อมูลจาก FMH เดือนนี้ใกล้เต็ม ระบบจะดึงต่อเองเมื่อโควตาใหม่มา';
  if (/timeout|timed out|econn|enotfound|network|fetch failed|50\d/.test(t)) return 'เชื่อม FMH ไม่ได้ชั่วคราว ระบบจะลองใหม่เองในรอบถัดไป ไม่ต้องทำอะไร';
  return 'ดึงข้อมูลล่าสุดจาก FMH ไม่สำเร็จ ระบบจะลองใหม่เอง ถ้ายังเป็นอยู่พรุ่งนี้ให้กด แจ้งทีมงาน';
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
    `SELECT company_id, COUNT(*) AS n, MAX(failed_at) AS last_at, MIN(error_text) AS sample
       FROM fmh_sync_errors WHERE company_id IN (?) GROUP BY company_id`, [ids]);
  const [syncs] = await pool.query(
    `SELECT company_id, MAX(synced_at) AS last_sync, COUNT(*) AS reports FROM fmh_report_cache WHERE company_id IN (?) GROUP BY company_id`, [ids]);
  const [pos] = await pool.query(
    `SELECT company_id, MAX(date_to) AS last_day, MAX(created_at) AS last_upload FROM pos_uploads WHERE company_id IN (?) GROUP BY company_id`, [ids]);
  const [lines] = await pool.query(
    `SELECT company_id, enabled, group_id, quota_used, monthly_quota, quota_month, (access_token_enc IS NOT NULL) AS has_token
       FROM company_line WHERE company_id IN (?)`, [ids]);
  const [sup] = await pool.query(
    `SELECT company_id, COUNT(*) AS n FROM support_requests WHERE company_id IN (?) AND status <> 'done' GROUP BY company_id`, [ids]);
  const by = (rows) => new Map(rows.map((r) => [r.company_id, r]));
  const E = by(errs), S = by(syncs), P = by(pos), L = by(lines), U = by(sup);
  const month = new Date().toISOString().slice(0, 7);

  const out = new Map();
  for (const c of companies) {
    const checks = [];
    const demo = c.status === 'demo' || c.data_source === 'demo';

    // FMH
    const e = E.get(c.id), s = S.get(c.id);
    if (!c.has_key && !demo) {
      checks.push({ key: 'fmh', label: 'ข้อมูลจัดซื้อ (FMH)', state: 'off', detail: 'ยังไม่ได้ใส่ FMH API key', fix: 'ใส่ API key ที่ ตั้งค่า › การเชื่อมข้อมูล แล้วระบบจะดึงข้อมูลมาให้เอง', go: 'data' });
    } else if (e) {
      checks.push({ key: 'fmh', label: 'ข้อมูลจัดซื้อ (FMH)', state: 'bad', detail: `ดึงข้อมูลล่าสุดไม่สำเร็จ ${e.n} รายงาน`, fix: explainFmhError(e.sample), go: 'data', since: e.last_at, raw: String(e.sample || '').slice(0, 200) });
    } else if (s && s.last_sync && (Date.now() - new Date(s.last_sync).getTime()) / 3600000 > STALE_SYNC_HOURS && !demo) {
      checks.push({ key: 'fmh', label: 'ข้อมูลจัดซื้อ (FMH)', state: 'warn', detail: 'ข้อมูลไม่ได้อัปเดตเกิน 1 วัน', fix: 'กดปุ่ม รีเฟรช ที่ dashboard หรือรอรอบอัปเดตตอนตี 1', go: 'data', since: s.last_sync });
    } else if (!s && !demo) {
      checks.push({ key: 'fmh', label: 'ข้อมูลจัดซื้อ (FMH)', state: 'warn', detail: 'ใส่ key แล้วแต่ยังไม่มีข้อมูลที่ดึงมา', fix: 'รอสักครู่หลังใส่ key หรือเพิ่ม widget แล้วกดรีเฟรช', go: 'data' });
    } else {
      checks.push({ key: 'fmh', label: 'ข้อมูลจัดซื้อ (FMH)', state: 'ok', detail: demo ? 'ข้อมูลตัวอย่าง' : 'อัปเดตปกติ', since: s && s.last_sync });
    }

    // POS file uploads (Foodstory etc.) — optional, only warn once they use it
    const p = P.get(c.id);
    if (!p) {
      checks.push({ key: 'pos', label: 'ยอดขาย POS', state: 'off', detail: 'ยังไม่ได้อัปโหลดไฟล์ยอดขาย', fix: 'ถ้าต้องการดูยอดขายคู่กับต้นทุน อัปโหลดไฟล์จาก POS ที่ ตั้งค่า › การเชื่อมข้อมูล', go: 'data' });
    } else {
      const age = p.last_day ? Math.floor((Date.now() - new Date(p.last_day).getTime()) / 86400000) : null;
      checks.push(age != null && age > POS_STALE_DAYS
        ? { key: 'pos', label: 'ยอดขาย POS', state: 'warn', detail: `ยอดขายล่าสุดถึงวันที่ ${String(p.last_day).slice(0, 10)} (ห่างมา ${age} วัน)`, fix: 'อัปโหลดไฟล์ยอดขายรอบใหม่เพื่อให้ widget ยอดขายเป็นปัจจุบัน', go: 'data', since: p.last_upload }
        : { key: 'pos', label: 'ยอดขาย POS', state: 'ok', detail: `ยอดขายล่าสุดถึงวันที่ ${String(p.last_day).slice(0, 10)}`, since: p.last_upload });
    }

    // LINE
    const l = L.get(c.id);
    if (!l || !l.has_token) {
      checks.push({ key: 'line', label: 'แจ้งเตือนทาง LINE', state: 'off', detail: 'ยังไม่ได้ตั้งค่า LINE', fix: 'ตั้งที่ ตั้งค่า › ตัวเตือน & LINE ถ้าอยากให้ระบบส่งสรุปและเตือนเข้ากลุ่ม', go: 'alerts' });
    } else if (l.enabled && !l.group_id) {
      checks.push({ key: 'line', label: 'แจ้งเตือนทาง LINE', state: 'warn', detail: 'เปิดใช้แล้วแต่ยังไม่ได้เชิญบอทเข้ากลุ่ม', fix: 'เชิญบอทเข้ากลุ่ม LINE แล้วพิมพ์ข้อความ 1 ครั้งให้บอทจับกลุ่ม', go: 'alerts' });
    } else {
      const used = l.quota_month === month ? l.quota_used : 0;
      const ratio = l.monthly_quota ? used / l.monthly_quota : 0;
      checks.push(ratio >= 1
        ? { key: 'line', label: 'แจ้งเตือนทาง LINE', state: 'bad', detail: `โควตาข้อความเดือนนี้เต็มแล้ว (${used}/${l.monthly_quota})`, fix: 'ระบบหยุดส่งจนถึงต้นเดือนหน้า หรืออัปเกรดแพ็กเกจ LINE ของบริษัท', go: 'alerts' }
        : ratio >= LINE_QUOTA_WARN
          ? { key: 'line', label: 'แจ้งเตือนทาง LINE', state: 'warn', detail: `ใช้โควตาข้อความไปแล้ว ${used}/${l.monthly_quota}`, fix: 'ลดจำนวนหัวข้อที่ส่งสรุป หรือเพิ่มโควตา', go: 'alerts' }
          : { key: 'line', label: 'แจ้งเตือนทาง LINE', state: l.enabled ? 'ok' : 'off', detail: l.enabled ? `ส่งปกติ (ใช้ ${used}/${l.monthly_quota})` : 'ตั้งค่าไว้แต่ปิดอยู่' });
    }

    // Plan
    const left = daysUntil(c.subscription_ends_at);
    if (c.status === 'suspended') {
      checks.push({ key: 'plan', label: 'แพ็กเกจ', state: 'bad', detail: 'บัญชีถูกระงับ', fix: 'ต่ออายุที่ ตั้งค่า › แพ็กเกจและการชำระเงิน หรือแจ้งทีมงาน', go: 'plan' });
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

module.exports = { healthFor, explainFmhError, RANK };
