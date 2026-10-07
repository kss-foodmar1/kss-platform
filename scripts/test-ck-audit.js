// Branch purchase audit (lib/ckAudit.js): name matching, unit sizes, and the
// demo company's planted leak (Bangna) being the one branch flagged.
// Needs the DB in the env (no server).
const ck = require('../lib/ckAudit');
const pool = require('../db/pool');
let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };
(async () => {
  check('branch part after "สาขา"', ck.branchPart('คุณป๊อป สาขา เซ็นจูรี่ - คุณป๊อป สาขา เซ็นจูรี่') === 'เซ็นจูรี่');
  check('POS branch guessed from customer', ck.guessBranch('ร้านเดโม สาขา บางนา - สาขา บางนา', ['สาขา สยาม', 'สาขา บางนา']) === 'สาขา บางนา');
  check('outside buyer not guessed', ck.guessBranch('บริษัท ฟู้ดเซอร์วิส จำกัด - โรงอาหารออฟฟิศ', ['สาขา สยาม', 'สาขา บางนา']) === null);
  const p1 = ck.packSize('BAG (5KG)', ''), p2 = ck.packSize('PACK', 'กุ้ง 500 กรัม/แพ็ค'), p3 = ck.packSize('BOTTLE', 'ชาไทย 1 ลิตร/ขวด');
  check('pack sizes: 5KG, 500 กรัม, 1 ลิตร', p1.base === 5000 && p2.base === 500 && p3.base === 1000 && p3.dim === 'vol', JSON.stringify([p1, p2, p3]));
  const [[demo]] = await pool.query(`SELECT id FROM companies WHERE data_source = 'demo' ORDER BY id LIMIT 1`);
  if (demo) {
    const b = await ck.build(demo.id);
    const latest = b['ck-audit'].filter((r) => r.is_latest);
    const flagged = latest.filter((r) => r.status === 'ควรตรวจ').map((r) => r.branch);
    check('demo: only Bangna is flagged', flagged.length === 1 && flagged[0] === 'สาขา บางนา', JSON.stringify(flagged));
    const bn = b['ck-audit-recipe'].filter((r) => r.branch === 'สาขา บางนา' && r.ingredient_code === 'FG-009');
    const need = bn.reduce((s, r) => s + r.need_units, 0), got = bn.reduce((s, r) => s + r.got_units, 0);
    check('demo: Bangna orders well under recipe need for the leaked item', need > 0 && got / need < 0.6, `${got}/${need}`);
    const si = b['ck-audit-recipe'].filter((r) => r.branch === 'สาขา สยาม' && r.ingredient_code === 'FG-009');
    const n2 = si.reduce((s, r) => s + r.need_units, 0), g2 = si.reduce((s, r) => s + r.got_units, 0);
    check('demo: Siam orders about what its sales need', g2 / n2 > 0.95 && g2 / n2 < 1.2, `${g2}/${n2}`);
    check('UPT rows exist for every branch', new Set(b['ck-audit-upt'].map((r) => r.branch)).size === 5);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
