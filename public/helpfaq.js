// "ถาม AI", the part that costs nothing: answers worked out in the browser.
//   helpAnswer(question, view) -> { text, source: 'faq'|'data', go: [{label, act}] } | null
// 1) FAQ — how to use the Dashboard (static answers below, with a button that
//    takes the person to the page).
// 2) The page itself — the same sentences the "อธิบาย" button writes
//    (explain.js), picked by what the question mentions.
// null means "not sure": the chat then asks Gemini (if on) or logs a miss.
// Nothing here leaves the browser.

// act: 'library' | 'settings:<tab>'. Buttons show only to people who can open
// settings; others see `ask` instead (who to ask).
const HELP_FAQ = [
  {
    id: 'add_widget',
    q: ['เพิ่ม widget ยังไง', 'อยากได้กราฟเพิ่ม', 'เพิ่มกราฟ', 'หา widget', 'ใส่ widget', 'มี widget อะไรบ้าง', 'คลัง widget'],
    a: 'เปิด **คลัง Widget** แล้วเลือกจากคำถามที่อยากรู้ เช่น “สินค้าไหนราคาขึ้น” — ดูตัวอย่างจากข้อมูลจริงของบริษัทได้ก่อน แล้วกด **เพิ่มเข้า Dashboard** เลือก Dashboard ที่ต้องการ',
    go: [['เปิดคลัง Widget', 'library']],
    ask: 'การเพิ่ม widget ทำได้โดยผู้ดูแลบริษัทของคุณ ลองบอกว่าอยากรู้เรื่องอะไร เขาจะเลือกจากคลัง Widget ให้',
  },
  {
    id: 'new_dashboard',
    q: ['สร้าง dashboard ใหม่', 'dashboard ใหม่', 'เริ่มต้น dashboard', 'ชุดสำเร็จรูป', 'สร้างหน้าใหม่', 'แยก dashboard'],
    a: 'ไปที่ **ตั้งค่า › จัดการ Dashboard** มีปุ่มสร้างเปล่า หรือเริ่มจาก Dashboard พื้นฐาน/ชุดสำเร็จรูป (เช่น เจ้าของร้านเช้านี้, ตรวจต้นทุนครัวกลาง) ที่เลือก widget ให้แล้ว',
    go: [['ไปที่จัดการ Dashboard', 'settings:dashboards']],
    ask: 'การสร้าง Dashboard ใหม่ทำได้โดยผู้ดูแลบริษัทของคุณ',
  },
  {
    id: 'empty',
    q: ['ทำไมข้อมูลว่าง', 'กราฟว่าง', 'ไม่มีข้อมูล', 'ไม่แสดงข้อมูล', 'ตารางว่าง', 'widget ไม่ขึ้น', 'ไม่มีตัวเลข'],
    a: 'ลองเช็กตามลำดับ:\n- **ช่วงวันที่** ด้านบนครอบคลุมวันที่มีเอกสารไหม\n- **ตัวกรอง** สาขา/ซัพพลายเออร์ ที่เลือกอยู่ อาจแคบเกินไป\n- **การเชื่อมข้อมูล** (FMH หรือไฟล์ POS) ต้องเชื่อมแล้ว และ widget บางตัวต้องมีข้อมูลประเภทนั้นก่อน เช่น ต้นทุนเมนูต้องมีสูตรอาหาร\nกดปุ่ม **อธิบาย** ที่ widget จะบอกเหตุผลที่ว่างของตัวนั้น',
    go: [['เช็กการเชื่อมข้อมูล', 'settings:data']],
    ask: 'ถ้าลองช่วงวันที่/ตัวกรองแล้วยังว่าง ให้แจ้งผู้ดูแลบริษัทของคุณตรวจการเชื่อมข้อมูล',
  },
  {
    id: 'connect_fmh',
    q: ['เชื่อม fmh', 'ใส่ api key', 'fmh key', 'ต่อ fmh', 'เชื่อมข้อมูลจัดซื้อ', 'ข้อมูลจัดซื้อไม่ขึ้น'],
    a: 'ไปที่ **ตั้งค่า › การเชื่อมข้อมูล** ใส่ FMH API key ของบริษัท ระบบจะดึงรายงานจัดซื้อมาให้เอง (ดึงย้อนหลังตามช่วงที่ระบบกำหนด)',
    go: [['ไปที่การเชื่อมข้อมูล', 'settings:data']],
    ask: 'การเชื่อม FMH ทำโดยผู้ดูแลบริษัทของคุณ',
  },
  {
    id: 'pos',
    q: ['อัปโหลดไฟล์ pos', 'ยอดขาย pos', 'เชื่อม pos', 'ไฟล์ eats365', 'ใส่ยอดขาย', 'ต้นทุนเมนูไม่ขึ้น'],
    a: 'widget ฝั่งยอดขาย/กำไรเมนูใช้ไฟล์ยอดขายจาก POS ไปที่ **ตั้งค่า › การเชื่อมข้อมูล** แล้วอัปโหลดไฟล์ POS ของแต่ละสาขา',
    go: [['ไปที่การเชื่อมข้อมูล', 'settings:data']],
    ask: 'การอัปโหลดไฟล์ POS ทำโดยผู้ดูแลบริษัทของคุณ',
  },
  {
    id: 'alerts',
    q: ['ตั้งแจ้งเตือน line', 'แจ้งเตือนเข้า line', 'ตัวเตือน', 'ราคาขึ้นแจ้งเตือน', 'แจ้งเตือน po', 'line bot'],
    a: 'ไปที่ **ตั้งค่า › ตัวเตือน & LINE** เลือกเรื่องที่อยากให้เตือน (ราคาเปลี่ยน, PO, ใบสั่งขาย, ครัวกลาง) และกลุ่ม LINE ที่จะรับ',
    go: [['ไปที่ตัวเตือน & LINE', 'settings:alerts']],
    ask: 'การตั้งแจ้งเตือน LINE ทำโดยผู้ดูแลบริษัทของคุณ',
  },
  {
    id: 'users',
    q: ['เพิ่มผู้ใช้', 'เชิญคน', 'ให้คนอื่นดู dashboard', 'สิทธิ์การดู', 'เพิ่มพนักงาน', 'ลบผู้ใช้'],
    a: 'ไปที่ **ตั้งค่า › ผู้ใช้** เพิ่มคนและเลือกว่าให้ดู Dashboard ไหนได้บ้าง ผู้ใช้ทั่วไปดูได้อย่างเดียว ไม่เปลี่ยนการตั้งค่า',
    go: [['ไปที่ผู้ใช้', 'settings:users']],
    ask: 'การเพิ่มผู้ใช้ทำโดยผู้ดูแลบริษัทของคุณ',
  },
  {
    id: 'plan',
    q: ['แพ็กเกจ', 'ชำระเงิน', 'ต่ออายุ', 'ราคา', 'ใบเสร็จ', 'บัตรเครดิต', 'หมดอายุเมื่อไหร่'],
    a: 'ดูแพ็กเกจ วันหมดอายุ และบัตรที่ผูกไว้ได้ที่ **ตั้งค่า › แพ็กเกจและการชำระเงิน** (แสดงเฉพาะบริษัทที่สมัครเอง)',
    go: [['ไปที่แพ็กเกจ', 'settings:plan']],
    ask: 'เรื่องแพ็กเกจและการชำระเงินสอบถามผู้ดูแลบริษัทของคุณ',
  },
  {
    id: 'range',
    q: ['เปลี่ยนช่วงวันที่', 'ดูย้อนหลัง', 'เลือกเดือน', 'ดูเดือนที่แล้ว', 'ช่วงเวลา', 'กรองวันที่'],
    a: 'ใช้ช่องเลือก **ช่วงวันที่** ด้านบนของ Dashboard ตัวเลขและกราฟทุก widget ในหน้านั้นเปลี่ยนตามช่วงที่เลือก',
    go: [],
  },
  {
    id: 'filter',
    q: ['กรองสาขา', 'เลือกสาขา', 'ดูเฉพาะสาขา', 'กรองซัพพลายเออร์', 'เลือกซัพพลายเออร์', 'ตัวกรอง'],
    a: 'ใช้ตัวกรอง **สาขา / ซัพพลายเออร์ / ลูกค้า** ด้านบนของ Dashboard (ตัวกรองที่มีขึ้นกับ widget ในหน้านั้น) เลือกแล้วทุก widget ที่รองรับจะกรองตามพร้อมกัน',
    go: [],
  },
  {
    id: 'switch',
    q: ['สลับ dashboard', 'เปลี่ยน dashboard', 'ไปหน้าอื่น', 'dashboard อื่น', 'หา dashboard', 'ดาวน์โหลด dashboard'],
    a: 'กดที่ **ชื่อ Dashboard** ด้านบนซ้าย จะมีรายการให้เลือก มีช่องค้นหา และดาวที่ปักหน้าที่ใช้บ่อย รวมถึงรายการที่เปิดล่าสุด',
    go: [],
  },
  {
    id: 'explain_btn',
    q: ['ปุ่มอธิบาย', 'อธิบายกราฟ', 'กราฟนี้บอกอะไร', 'อ่านกราฟยังไง', 'ตัวเลขนี้แปลว่าอะไร'],
    a: 'กดปุ่ม **อธิบาย** ที่มุมของแต่ละ widget จะสรุปว่าตอนนี้ตัวเลขบอกอะไร โดยคำนวณจากตัวเลขเดียวกับที่เห็นบนกราฟ และแนะนำสิ่งที่ควรทำต่อ หรือถามผมเรื่อง widget นั้นได้เลย',
    go: [],
  },
  {
    id: 'about',
    q: ['ถาม ai ทำอะไรได้', 'ใช้ยังไง', 'คุณทำอะไรได้', 'ช่วยอะไรได้บ้าง', 'help', 'วิธีใช้'],
    a: 'ผมช่วยได้ 3 อย่าง:\n- **อ่านตัวเลขในหน้านี้** เช่น “สรุปหน้านี้”, “ซัพพลายเออร์รายไหนซื้อมากสุด”\n- **บอกวิธีใช้ Dashboard** เช่น เพิ่ม widget, ตั้งแจ้งเตือน, ทำไมข้อมูลว่าง\n- **พาไปหน้าที่ต้องการ** ด้วยปุ่มใต้คำตอบ',
    go: [],
  },
];

const hpNorm = (s) => String(s || '').toLowerCase().replace(/[\s.,!?…"'“”‘’()[\]{}:;\-_/\\|*“”?]+/g, '');
function hpBigrams(s) {
  const o = new Set();
  for (let i = 0; i < s.length - 1; i++) o.add(s.substr(i, 2));
  return o;
}
function hpDice(a, b) {
  if (!a || !b) return 0;
  const x = hpBigrams(a), y = hpBigrams(b);
  if (!x.size || !y.size) return a === b ? 1 : 0;
  let hit = 0;
  x.forEach((k) => { if (y.has(k)) hit++; });
  return (2 * hit) / (x.size + y.size);
}
// How well does the question match a phrase? Containment either way is strong
// (people type short or long), otherwise bigram overlap.
function hpScore(qn, pn) {
  if (!qn || !pn) return 0;
  if (pn.length >= 5 && qn.includes(pn)) return 1;
  if (qn.length >= 5 && pn.includes(qn)) return 0.9;
  return hpDice(qn, pn);
}

function helpFaq(question) {
  const qn = hpNorm(question);
  let best = null;
  HELP_FAQ.forEach((e) => {
    const sc = Math.max(...e.q.map((p) => hpScore(qn, hpNorm(p))));
    if (!best || sc > best.sc) best = { e, sc };
  });
  return best && best.sc >= 0.5 ? best : null;
}

// ---- the page ------------------------------------------------------------
// parts: { head: [lines], widgets: [{ id, title, facts: [..] }] }
const HP_ANOMALY = /ผิดปกติ|น่าห่วง|รีบดู|เสี่ยง|ต้องดู|ปัญหา|แย่|เกินกว่า|ขาด|ลดลง|ลดลง|เพิ่มขึ้น|แพงขึ้น/;
const HP_SUMMARY = /สรุป|ภาพรวม|overview|หน้านี้มีอะไร|เล่าให้ฟัง/;
const HP_STATE = /ช่วงวันที่|ตัวกรองอะไร|กรองอะไร|กำลังดูอะไร|ดูข้อมูลช่วงไหน/;

function helpFromPage(question, parts) {
  if (!parts || !parts.widgets || !parts.widgets.length) return null;
  const qn = hpNorm(question);
  const ws = parts.widgets.filter((w) => w.facts.length);
  if (HP_STATE.test(question)) {
    return { text: parts.head.join('\n'), source: 'data', go: [] };
  }
  if (HP_SUMMARY.test(question) && ws.length) {
    const lines = ws.slice(0, 8).map((w) => `- **${w.title}**: ${w.facts[0]}`);
    const more = ws.length > 8 ? `\n(และอีก ${ws.length - 8} widget — กด “อธิบาย” ที่แต่ละตัวเพื่อดูต่อ)` : '';
    return { text: `${parts.head[0]} · ${parts.head.slice(1).join(' · ')}\n${lines.join('\n')}${more}`.replace(' · \n', '\n'), source: 'data', go: [] };
  }
  // A widget named in the question (title or any word of it).
  const scored = ws
    .map((w) => {
      const tn = hpNorm(w.title);
      let sc = hpScore(qn, tn);
      const words = String(w.title).split(/[\s/·|,()–-]+/).map(hpNorm).filter((x) => x.length >= 3);
      if (words.some((x) => qn.includes(x))) sc = Math.max(sc, 0.6);
      return { w, sc };
    })
    .filter((x) => x.sc >= 0.5)
    .sort((a, b) => b.sc - a.sc);
  if (scored.length) {
    const top = scored.slice(0, 2);
    const text = top.map((x) => `**${x.w.title}**\n${x.w.facts.slice(0, 4).map((f) => '- ' + f).join('\n')}`).join('\n\n');
    return { text, source: 'data', go: [] };
  }
  if (HP_ANOMALY.test(question)) {
    const hits = [];
    ws.forEach((w) => w.facts.forEach((f) => { if (HP_ANOMALY.test(f)) hits.push(`- **${w.title}**: ${f}`); }));
    if (hits.length) return { text: `จุดที่ควรดูในหน้านี้:\n${hits.slice(0, 6).join('\n')}`, source: 'data', go: [] };
  }
  return null;
}

function helpAnswer(question, parts, canSettings) {
  const q = String(question || '').trim();
  if (!q) return null;
  const f = helpFaq(q);
  // A page question that names a widget beats a weak FAQ match.
  const page = helpFromPage(q, parts);
  if (f && (f.sc >= 0.75 || !page)) {
    const e = f.e;
    const go = canSettings ? e.go.map(([label, act]) => ({ label, act })) : [];
    const text = canSettings || !e.ask ? e.a : e.ask;
    return { text, source: 'faq', go, id: e.id };
  }
  return page;
}

if (typeof module !== 'undefined') module.exports = { helpAnswer, helpFaq, HELP_FAQ, hpNorm };
