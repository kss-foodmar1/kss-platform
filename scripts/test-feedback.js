#!/usr/bin/env node
// "อยากเห็นข้อมูลอะไร": the widget suggester and the chat's wish detector (public/feedback.js).
// No DB, no browser: the catalogue comes from lib/widgetCatalog.js, the library's
// one-line questions from public/library.js.
const fs = require('fs');
const vm = require('vm');
const { BUILTIN_TEMPLATES } = require('../lib/widgetCatalog');

const libSrc = fs.readFileSync(__dirname + '/../public/library.js', 'utf8');
const m = libSrc.match(/const LIB_QUESTIONS = (\{[\s\S]*?\n\});/);
const ctx = { console, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
vm.createContext(ctx);
vm.runInContext(`var LIB_QUESTIONS = ${m ? m[1] : '{}'};`, ctx);
// A dashboard that already has some everyday widgets (the reviewer's case): having one must not
// push out a better match the shop does not have yet.
const ON = new Set(['pa_kpis', 'price_avg_trend', 'cogs_kpis', 'cogs_margin_by_branch', 'pc_movers']);
ctx.api = async () => ({ list: BUILTIN_TEMPLATES.map((t, i) => ({ id: i + 1, template_key: t.template_key, name: t.name, description: t.description, category: t.category, on: ON.has(t.template_key) ? [{ wid: 900 + i, did: 1, title: null }] : [] })) });
vm.runInContext(fs.readFileSync(__dirname + '/../public/feedback.js', 'utf8') + '\n;this.fbSuggest = fbSuggest; this.FB_WISH = FB_WISH;', ctx);

let pass = 0, fail = 0;
const t = (name, ok, detail) => { if (ok) { pass++; console.log('PASS ', name); } else { fail++; console.log('FAIL ', name, detail || ''); } };
(async () => {
  const keys = async (q) => (await ctx.fbSuggest(q)).map((x) => x.t.template_key);
  const waste = await keys('อยากเห็นของเสียแยกตามหมวดสินค้า');
  t('waste by category is found first', waste[0] === 'wastage_by_category', waste.join(','));
  t('no kitchen or POS sales widget for a waste request', !waste.some((k) => /^cks_|pos_|ck_/.test(k)), waste.join(','));
  const hourly = await keys('อยากเห็นยอดขายรายชั่วโมง');
  t('hourly sales: nothing (no widget has time of day)', hourly.length === 0, hourly.join(','));
  const booking = await keys('อยากเห็นยอดจองโต๊ะรายวัน');
  t('table bookings: nothing', booking.length === 0, booking.join(','));
  const price = await keys('อยากเห็นราคาที่ซัพพลายเออร์แต่ละเจ้าขายให้');
  t('supplier price comparison is suggested', price.some((k) => /price/.test(k)), price.join(','));
  const over = await keys('อยากเห็นบิลเกินของที่รับ');
  t('over-billing widgets are not pushed out by the totals card the shop has', over.includes('ita_overbilled') || over.includes('sq_overbill_credit'), over.join(','));
  const across = await keys('อยากเห็นราคาต่างกันระหว่างซัพพลายเออร์');
  t('price across suppliers is not answered with the price trend the shop has', across[0] !== 'price_avg_trend', across.join(','));
  const moves = await keys('อยากเห็นราคาสินค้าที่ขยับขึ้น');
  t('a clearly better match wins over a weaker one already on the dashboard', moves[0] === 'pc_extra_by_product', moves.join(','));
  t('wish: "อยากเห็นยอดขาย"', ctx.FB_WISH.test('อยากเห็นยอดขาย'));
  t('wish: "มีรายงานของเสียไหม"', ctx.FB_WISH.test('มีรายงานของเสียไหม'));
  t('not a wish: "อยากรู้ว่าเดือนนี้ขายได้เท่าไหร่"', !ctx.FB_WISH.test('อยากรู้ว่าเดือนนี้ขายได้เท่าไหร่'));
  t('not a wish: "ดูยอดเมื่อวานได้ไหม"', !ctx.FB_WISH.test('ดูยอดเมื่อวานได้ไหม'));
  t('not a wish: "มีข้อมูลวันนี้ไหม"', !ctx.FB_WISH.test('มีข้อมูลวันนี้ไหม'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
