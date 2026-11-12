// Ready-made date ranges for the dashboard's range picker (a dropdown).
// Weeks run Monday to Sunday. `today` is a local YYYY-MM-DD string.
// Shared by the browser (window.RangePresets) and Node tests (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RangePresets = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const PRESETS = [
    { key: 'd7', th: '7 วันก่อน', en: 'Last 7 days' },
    { key: 'd30', th: '30 วัน', en: 'Last 30 days' },
    { key: 'this_week', th: 'สัปดาห์นี้', en: 'This week' },
    { key: 'last_week', th: 'สัปดาห์ที่แล้ว', en: 'Last week' },
    { key: 'this_month', th: 'เดือนนี้', en: 'This month' },
    { key: 'last_month', th: 'เดือนที่แล้ว', en: 'Last month' },
    { key: 'this_year', th: 'ปีนี้', en: 'This year', needsHistory: true },
    { key: 'd365', th: '1 ปี', en: 'Last 12 months', needsHistory: true },
  ];
  // Marketing plans ahead: a month, a quarter or the budget year, whole (not "up to today"),
  // and the months still to come. Offered only on a page of marketing widgets.
  const PLAN = [
    { key: 'plan_this_month', th: 'เดือนนี้ (ทั้งเดือน)', en: 'This month (whole)' },
    { key: 'plan_next_month', th: 'เดือนหน้า', en: 'Next month' },
    { key: 'plan_this_quarter', th: 'ไตรมาสนี้', en: 'This quarter' },
    { key: 'plan_next_quarter', th: 'ไตรมาสหน้า', en: 'Next quarter' },
    { key: 'plan_6m', th: '6 เดือนข้างหน้า', en: 'Next 6 months' },
    { key: 'plan_12m', th: '12 เดือนข้างหน้า', en: 'Next 12 months' },
    { key: 'plan_this_year', th: 'ปีนี้ (ทั้งปี)', en: 'This year (whole)' },
    { key: 'last_month', th: 'เดือนที่แล้ว', en: 'Last month' },
  ];
  const PLAN_DEFAULT = 'plan_this_month';
  const DEFAULT = 'd30';
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

  // { start, end } for a preset, or null for an unknown key.
  function compute(key, today) {
    const t = parse(today);
    const monday = addDays(t, -((t.getDay() + 6) % 7));
    switch (key) {
      case 'd7': return { start: iso(addDays(t, -7)), end: today };
      case 'd30': return { start: iso(addDays(t, -30)), end: today };
      case 'd365': return { start: iso(addDays(t, -365)), end: today };
      case 'this_week': return { start: iso(monday), end: today };
      case 'last_week': return { start: iso(addDays(monday, -7)), end: iso(addDays(monday, -1)) };
      case 'this_month': return { start: iso(new Date(t.getFullYear(), t.getMonth(), 1)), end: today };
      case 'last_month': return { start: iso(new Date(t.getFullYear(), t.getMonth() - 1, 1)), end: iso(new Date(t.getFullYear(), t.getMonth(), 0)) };
      case 'this_year': return { start: `${t.getFullYear()}-01-01`, end: today };
      case 'plan_this_month': return { start: iso(new Date(t.getFullYear(), t.getMonth(), 1)), end: iso(new Date(t.getFullYear(), t.getMonth() + 1, 0)) };
      case 'plan_next_month': return { start: iso(new Date(t.getFullYear(), t.getMonth() + 1, 1)), end: iso(new Date(t.getFullYear(), t.getMonth() + 2, 0)) };
      case 'plan_this_quarter': { const q = Math.floor(t.getMonth() / 3) * 3; return { start: iso(new Date(t.getFullYear(), q, 1)), end: iso(new Date(t.getFullYear(), q + 3, 0)) }; }
      case 'plan_next_quarter': { const q = Math.floor(t.getMonth() / 3) * 3 + 3; return { start: iso(new Date(t.getFullYear(), q, 1)), end: iso(new Date(t.getFullYear(), q + 3, 0)) }; }
      case 'plan_6m': return { start: iso(new Date(t.getFullYear(), t.getMonth(), 1)), end: iso(new Date(t.getFullYear(), t.getMonth() + 6, 0)) };
      case 'plan_12m': return { start: iso(new Date(t.getFullYear(), t.getMonth(), 1)), end: iso(new Date(t.getFullYear(), t.getMonth() + 12, 0)) };
      case 'plan_this_year': return { start: `${t.getFullYear()}-01-01`, end: `${t.getFullYear()}-12-31` };
      default: return null;
    }
  }

  // Which presets to offer: the year-long ones only where uploaded files can reach back that far.
  const available = (hasHistory, plan) => (plan ? PLAN : PRESETS.filter((p) => hasHistory || !p.needsHistory));
  const label = (key, lang) => {
    const p = PRESETS.concat(PLAN).find((x) => x.key === key);
    return p ? (lang === 'en' ? p.en : p.th) : '';
  };
  // The preset whose range is exactly [start, end], for showing a custom pick as custom.
  const match = (start, end, today) => (PRESETS.concat(PLAN).find((p) => { const r = compute(p.key, today); return r && r.start === start && r.end === end; }) || {}).key || null;

  return { PRESETS, PLAN, DEFAULT, PLAN_DEFAULT, compute, available, label, match };
});
