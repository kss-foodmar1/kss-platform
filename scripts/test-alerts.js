// Alert widgets (lib/alerts.js) on the demo company: the planted price jumps
// and Bangna are found, thresholds and the baht floor work, history statuses,
// the widget source, and sync pulling the watcher's input first. Needs the DB.
const pool = require('../db/pool');
let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };
(async () => {
  const a = require('../lib/alerts');
  const fc = require('../lib/fmhCache');
  const [[demo]] = await pool.query(`SELECT id FROM companies WHERE data_source = 'demo' ORDER BY id LIMIT 1`);
  if (!demo) { console.log('no demo company — skipped'); process.exit(0); }
  const id = demo.id, today = a.bkkToday();
  await pool.query(`DELETE FROM alert_events WHERE company_id = ?`, [id]);
  await pool.query(`UPDATE company_line SET watch_json = NULL WHERE company_id = ?`, [id]);

  const p = await a.evaluate(id, 'price');
  const subj = p.findings.map((f) => f.subject);
  check('price: planted shrimp + pork jumps found', subj.some((s) => /กุ้งขาว · ทะเลสด/.test(s)) && subj.some((s) => /หมูสามชั้น/.test(s)), JSON.stringify(subj));
  check('price: small-baht jump (lime) left out by the floor', !subj.some((s) => /มะนาว/.test(s)));
  const shrimp = p.findings.find((f) => /กุ้งขาว/.test(f.subject));
  check('price: shrimp is high severity (≥25%)', shrimp && shrimp.severity === 'สูง' && shrimp.change_pct >= 25, JSON.stringify(shrimp));
  const strict = await a.WATCHERS.price.detect(id, { threshold: 30, min_impact: 300 }, today);
  check('price: a 30% threshold drops both', strict.findings.length === 0, JSON.stringify(strict.findings.map((f) => f.subject)));
  const floor = await a.WATCHERS.price.detect(id, { threshold: 10, min_impact: 1000 }, today);
  check('price: a ฿1,000 floor keeps shrimp, drops pork', floor.findings.length === 1 && /กุ้งขาว/.test(floor.findings[0].subject));

  const c = await a.evaluate(id, 'ck');
  check('ck: only Bangna, with an estimated baht impact', c.findings.length === 1 && c.findings[0].branch === 'สาขา บางนา' && c.findings[0].impact > 0, JSON.stringify(c.findings));

  let h = await a.history(id, 'price');
  check('history: first sighting is "ใหม่"', h.length >= 2 && h.every((r) => r.status === 'ใหม่' && r.is_active === 1));
  await pool.query(`UPDATE alert_events SET first_seen = ? WHERE company_id = ? AND watcher = 'price'`, [a.addDays(today, -1), id]);
  h = await a.history(id, 'price');
  check('history: seen before → "ต่อเนื่อง"', h.every((r) => r.status === 'ต่อเนื่อง'));
  await pool.query(`UPDATE alert_events SET last_seen = ?, first_seen = ?, sent_sig = sig WHERE company_id = ? AND watcher = 'price'`, [a.addDays(today, -5), a.addDays(today, -6), id]);
  h = await a.history(id, 'price');
  check('history: not found today → "จบแล้ว", still listed', h.length >= 2 && h.every((r) => r.status === 'จบแล้ว' && r.is_active === 0));
  await a.evaluate(id, 'price');
  const [[back]] = await pool.query(`SELECT first_seen, sent_sig FROM alert_events WHERE company_id = ? AND watcher = 'price' AND finding_key LIKE 'SEA-001%'`, [id]);
  const fs = back.first_seen instanceof Date ? back.first_seen : new Date(back.first_seen);
  check('history: back after a gap → new again, unsent', back.sent_sig === null && `${fs.getFullYear()}-${String(fs.getMonth() + 1).padStart(2, '0')}-${String(fs.getDate()).padStart(2, '0')}` === today);

  const pulls = fc.pullsForWidget('watch-price', {}).map((x) => x.source);
  check('sync: watcher pulls its input report first', pulls[0] === 'purchase-analysis' && pulls[1] === 'watch-price', JSON.stringify(pulls));
  const built = await fc.syncOne(id, 'watch-price', null);
  const cached = await fc.getCached(id, 'watch-price', null);
  check('widget source: cached rows + evaluated_on today', cached && cached.data.length >= 2 && cached.quota.watch.evaluated_on === today, JSON.stringify(cached && cached.quota));
  check('widget rows: open first by rank, no date field to filter on', built.data[0].is_active === 1 && built.data.every((r, i, arr) => i === 0 || arr[i - 1].rank >= r.rank) && !fc.FMH_REPORTS['watch-price'].dateField);

  const s = await a.saveSettings(id, { price: { threshold: 30, line: false }, ck: { line: true } });
  check('settings: saved and clamped to known fields', s.price.threshold === 30 && s.price.min_impact === 300 && s.price.line === false && s.ck.line === true);
  const p2 = await a.evaluate(id, 'price');
  check('settings: the widget uses the saved threshold too', p2.findings.length === 0);
  await pool.query(`UPDATE company_line SET watch_json = NULL WHERE company_id = ?`, [id]);

  const [[real]] = await pool.query(`SELECT id FROM companies WHERE data_source = 'fmh' ORDER BY id LIMIT 1`);
  if (real) {
    const n = await a.WATCHERS.ck.detect(real.id, {}, today);
    const q = await a.WATCHERS.price.detect(real.id, a.WATCHERS.price.defaults, today);
    check('no data: watchers say why instead of "all clear"', n.findings.length === 0 && /ยังไม่มี/.test(n.note) && q.findings.length === 0 && q.note, `${n.note} | ${q.note}`);
  }
  await pool.query(`DELETE FROM alert_events WHERE company_id = ?`, [id]);
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
