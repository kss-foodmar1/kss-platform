// Unit tests for lib/marketing.js (no database): reading cells, whole-file checks, daily budget spread.
//   DB_HOST=127.0.0.1 DB_USER=root DB_NAME=kss node scripts/test-marketing.js
const assert = require('assert');
const m = require('../lib/marketing');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '\n  ', e.message); } };

t('dates: ISO, day-first, Buddhist year, Excel serial, bad', () => {
  assert.strictEqual(m.parseDate('2026-11-05'), '2026-11-05');
  assert.strictEqual(m.parseDate('5/11/2026'), '2026-11-05');
  assert.strictEqual(m.parseDate('05/11/2569'), '2026-11-05');
  assert.strictEqual(m.parseDate(46331), '2026-11-05'); // Excel serial
  assert.strictEqual(m.parseDate('31/02/2026'), null);
  assert.strictEqual(m.parseDate('hello'), null);
});
t('months: 2026-11, 11/2026, พ.ย. 2569, full date, serial', () => {
  assert.strictEqual(m.parseMonth('2026-11'), '2026-11-01');
  assert.strictEqual(m.parseMonth('11/2026'), '2026-11-01');
  assert.strictEqual(m.parseMonth('พ.ย. 2569'), '2026-11-01');
  assert.strictEqual(m.parseMonth('November 2026'), '2026-11-01');
  assert.strictEqual(m.parseMonth('2026-11-17'), '2026-11-01');
  assert.strictEqual(m.parseMonth(46331), '2026-11-01');
  assert.strictEqual(m.parseMonth('13/2026'), null);
});
t('amounts: commas, baht sign, text, negative kept for the caller to reject', () => {
  assert.strictEqual(m.parseAmount('1,234.50'), 1234.5);
  assert.strictEqual(m.parseAmount('฿ 1,200'), 1200);
  assert.strictEqual(m.parseAmount('1200 บาท'), 1200);
  assert.strictEqual(m.parseAmount(55), 55);
  assert.strictEqual(m.parseAmount('abc'), null);
  assert.strictEqual(m.parseAmount(''), null);
});
t('channels: spellings collapse, unknown kept as typed', () => {
  assert.strictEqual(m.parseChannel('facebook'), 'Meta');
  assert.strictEqual(m.parseChannel(' Meta  Ads '), 'Meta');
  assert.strictEqual(m.parseChannel('ติ๊กต็อก'), 'TikTok');
  assert.strictEqual(m.parseChannel('Google'), 'Google Ads');
  assert.strictEqual(m.parseChannel('ป้ายหน้าร้าน'), 'ป้ายหน้าร้าน');
  assert.strictEqual(m.parseChannel(''), null);
});

const budget = [['เดือน', 'ช่องทาง', 'จำนวนเงิน (บาท)'], ['2026-11', 'Meta', 50000], ['2026-11', 'TikTok', '30,000'], [null, null, null], ['2026-12', 'facebook', 60000]];
t('budget file: reads rows, skips blank lines, merges channel spellings', () => {
  const r = m.parseFile('budget', budget);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.rows.length, 3);
  assert.deepStrictEqual(r.rows.map((x) => [x.when, x.channel, x.cents]), [['2026-11-01', 'Meta', 5000000], ['2026-11-01', 'TikTok', 3000000], ['2026-12-01', 'Meta', 6000000]]);
});
t('budget file: header found below a title row; extra columns ignored', () => {
  const r = m.parseFile('budget', [['งบการตลาด PBT'], [], ['ผู้ดูแล', 'เดือน', 'ช่องทาง', 'งบ'], ['x', '2026-11', 'Meta', 100]]);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.rows[0].cents, 10000);
});
t('budget file: duplicate month x channel is an error, not silently summed', () => {
  const r = m.parseFile('budget', [['เดือน', 'ช่องทาง', 'จำนวนเงิน (บาท)'], ['2026-11', 'Meta', 1], ['2026-11', 'facebook', 2]]);
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(r.errors[0].row, 3);
});
t('actual file: same day x channel adds up and joins notes', () => {
  const r = m.parseFile('actual', [['วันที่', 'ช่องทาง', 'จำนวนเงิน (บาท)', 'หมายเหตุ'], ['2026-11-01', 'Meta', 1000.25, 'a'], ['01/11/2026', 'facebook', 500.5, 'b'], ['2026-11-02', 'TikTok', 10, '']]);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.rows.length, 2);
  assert.strictEqual(r.rows[0].cents, 150075);
  assert.strictEqual(r.rows[0].note, 'a; b');
});
t('actual file: bad rows are all reported with their row numbers', () => {
  const r = m.parseFile('actual', [['วันที่', 'ช่องทาง', 'จำนวนเงิน (บาท)'], ['2026-13-01', 'Meta', 10], ['2026-11-02', '', 10], ['2026-11-03', 'Meta', 'x'], ['2026-11-04', 'Meta', -5], ['2026-11-05', 'Meta', 10]]);
  assert.deepStrictEqual(r.errors.map((e) => e.row), [2, 3, 4, 5]);
  assert.strictEqual(r.rows.length, 1);
});
t('missing columns are named; empty file refused', () => {
  assert.throws(() => m.parseFile('budget', [['เดือน', 'จำนวนเงิน (บาท)'], ['2026-11', 5]]), /ช่องทาง/);
  assert.throws(() => m.parseFile('actual', []), /ไฟล์ว่าง/);
  assert.throws(() => m.parseFile('other', [['a']]), /budget หรือ actual/);
});
t('list templates read back as valid files', () => {
  ['budget', 'actual'].forEach((k) => {
    const csv = m.templateCsv(k, { layout: 'list' }).body.replace(/^﻿/, '');
    const table = csv.trim().split(/\r\n/).map((l) => l.split(','));
    const r = m.parseFile(k, table);
    assert.deepStrictEqual(r.errors, [], k);
    assert.ok(r.rows.length >= 3, k);
  });
});
t('daily spread: sums to the month budget to the satang, month_budget only on the 1st', () => {
  const rows = m.computeRows([{ month: '2026-11-01', channel: 'Meta', amount: 50000 }, { month: '2026-02-01', channel: 'Meta', amount: 100 }], []);
  const nov = rows.filter((r) => r.month === '2026-11');
  assert.strictEqual(nov.length, 30);
  assert.strictEqual(Math.round(nov.reduce((s, r) => s + r.budget_to_date, 0) * 100), 5000000);
  assert.strictEqual(nov.filter((r) => r.month_budget > 0).length, 1);
  assert.strictEqual(nov[0].month_budget, 50000);
  const feb = rows.filter((r) => r.month === '2026-02');
  assert.strictEqual(feb.length, 28);
  assert.strictEqual(Math.round(feb.reduce((s, r) => s + r.budget_to_date, 0) * 100), 10000);
});
t('report rows: actual lands on its day; channel with no budget has budget 0; leap February', () => {
  const rows = m.computeRows([{ month: '2028-02-01', channel: 'Meta', amount: 29 }], [{ date: '2026-11-03', channel: 'Influencer', amount: 12000.1, note: 'x' }, { date: '2028-02-29', channel: 'meta', amount: 7, note: '' }]);
  assert.strictEqual(rows.filter((r) => r.month === '2028-02').length, 29);
  const inf = rows.find((r) => r.channel === 'Influencer');
  assert.strictEqual(inf.actual, 12000.1);
  assert.strictEqual(inf.budget_to_date, 0);
  assert.strictEqual(rows.find((r) => r.spend_date === '2028-02-29').actual, 7);
});
t('horizontal budget: channel rows × month columns, totals and blanks ignored, label prefix and alias', () => {
  const r = m.parseFile('budget', [['หัวเรื่อง'], ['ช่องทาง', '2026-11', '2026-12', 'รวม'], ['- Facebook /IG ads', 25000, '', 25000], ['TikTok', '30,000', 20000, ''], ['รวม', 55000, 20000, 75000], ['4. หัวข้อ']]);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.rows.length, 3);
  assert.strictEqual(r.rows.find((x) => x.channel === 'Meta' && x.when === '2026-11-01').cents, 2500000);
  assert.ok(!r.rows.some((x) => x.channel === 'Meta' && x.when === '2026-12-01')); // blank = not entered
});
t('horizontal actual: day columns; a bad cell rejects with row and column', () => {
  const ok = m.parseFile('actual', [['ช่องทาง', '2026-11-01', '2026-11-02'], ['Meta', 1500, 1600], ['meta', 100, '']]);
  assert.deepStrictEqual(ok.errors, []);
  assert.strictEqual(ok.rows.find((x) => x.when === '2026-11-01').cents, 160000); // two rows of one channel add up
  const bad = m.parseFile('actual', [['ช่องทาง', '2026-11-01', '2026-11-02'], ['Meta', 1500, 'abc']]);
  assert.strictEqual(bad.errors.length, 1);
  assert.strictEqual(bad.errors[0].row, 2);
  assert.ok(bad.errors[0].message.includes('2026-11-02'));
});
t('horizontal: empty grid is rejected; duplicate month column and duplicate budget row are errors', () => {
  assert.ok(m.parseFile('budget', [['ช่องทาง', '2026-11'], ['Meta']]).errors.length);
  assert.ok(m.parseFile('budget', [['ช่องทาง', '2026-11', '11/2026'], ['Meta', 1, 2]]).errors.length);
  assert.ok(m.parseFile('budget', [['ช่องทาง', '2026-11'], ['Meta', 1], ['facebook', 2]]).errors.length);
});
t('horizontal templates: 12 month columns / every day of the month; list layout kept; the sheet reads back', () => {
  const b = m.templateCsv('budget', { from: '2026-11' }).body.split('\r\n')[0].split(',');
  assert.strictEqual(b.length, 13);
  assert.strictEqual(b[12], '2027-10');
  const a = m.templateCsv('actual', { month: '2028-02' }).body.split('\r\n')[0].split(',');
  assert.strictEqual(a.length, 30); // channel + 29 days
  assert.ok(m.templateCsv('budget', { layout: 'list' }).body.includes('จำนวนเงิน'));
  const rows = m.templateCsv('budget', { from: '2026-11' }).body.replace('\ufeff', '').split('\r\n').filter(Boolean).map((l) => l.split(','));
  rows[1][1] = '5000';
  assert.strictEqual(m.parseFile('budget', rows).rows.length, 1);
});
t('wide fixes: unreadable header with data errors; year hint; 2-digit year window; "-" blank; total/stop rows; first-header words', () => {
  const r1 = m.parseFile('budget', [['ช่องทาง', '2026-11', 'พ.ย', 'รวม'], ['Meta', 100, 200, 300]]);
  assert.ok(r1.errors.some((e) => e.message.includes('พ.ย')));
  const r2 = m.parseFile('budget', [['ช่องทาง', 'ม.ค.', 'ก.พ.'], ['Meta', 1, 2]], { year: 2027 });
  assert.deepStrictEqual(r2.errors, []);
  assert.deepStrictEqual(r2.rows.map((x) => x.when).sort(), ['2027-01-01', '2027-02-01']);
  assert.strictEqual(m.parseMonth('พ.ย. 69'), '2026-11-01');
  assert.strictEqual(m.parseMonth('พ.ย. 99'), null);
  const r3 = m.parseFile('budget', [['รายการ', '2026-11', '2026-12'], ['Meta', '-', 50], ['Total', 1, 50], [], ['อื่น ๆ', 9, 9]]);
  assert.deepStrictEqual(r3.errors, []);
  assert.strictEqual(r3.rows.length, 1); // "-" blank, Total skipped, stops at the blank row
  const r4 = m.parseFile('budget', [['', '2026-11', '2026-12'], ['Meta', 5, 6]]);
  assert.deepStrictEqual(r4.errors, []);
  assert.strictEqual(r4.rows.length, 2);
  const r5 = m.parseFile('budget', [['ช่องทาง', '2026-11'], ['Facebook', 1], ['IG', 2]]);
  assert.ok(r5.errors[0].message.includes('Facebook') && r5.errors[0].message.includes('IG'));
  assert.ok(!r5.errors[0].message.includes('แถวที่'.repeat(2)));
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
