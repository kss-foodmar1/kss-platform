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
    a: 'เพิ่ม widget 3 ขั้น:\n1. กดปุ่มด้านล่างเพื่อเปิด **คลัง Widget**\n2. เลือกการ์ดที่ตรงกับคำถามที่อยากรู้ (เช่น “สินค้าไหนราคาขึ้น”) จะเห็นตัวอย่างจากข้อมูลจริงของบริษัทก่อน\n3. กด **เพิ่มเข้า Dashboard** แล้วเลือกว่าจะใส่ใน Dashboard ไหน',
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
    q: ['ดูแพ็กเกจ', 'ราคาแพ็กเกจ', 'ค่าบริการรายปี', 'ต่ออายุแพ็กเกจ', 'ชำระเงินค่าบริการ', 'บัตรเครดิตที่ผูกไว้', 'ใบเสร็จค่าบริการ', 'แพ็กเกจหมดอายุเมื่อไหร่'],
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
  // ---- ความหมายทางธุรกิจ (ตอบแบบหลักทั่วไป ไม่ใช่ตัวเลขของบริษัท) ----
  {
    id: 'foodcost',
    q: ['food cost ที่ดีควรกี่เปอร์เซ็นต์', 'food cost ควรเท่าไหร่', 'ต้นทุนอาหารควรกี่ %', 'cogs ควรเท่าไร', 'เป้า food cost'],
    a: 'ไม่มีตัวเลขเดียวที่ใช้ได้ทุกร้าน ขึ้นกับประเภทร้านและราคาขาย โดยทั่วไปร้านอาหารมักตั้งต้นทุนวัตถุดิบไว้ราว 30–35% ของยอดขาย (หลักทั่วไป ไม่ใช่มาตรฐาน) ร้านสเต๊กหรือซีฟู้ดมักสูงกว่านี้ ส่วนเครื่องดื่มต่ำกว่ามาก แนะนำให้ตั้ง **เป้าของร้านเอง** ต่อเมนูหรือสาขา แล้วดูว่าเมนู/สาขาไหนเกินเป้า และแนวโน้มหลายเดือนไปทางไหน มากกว่าดูตัวเลขเดือนเดียว',
    go: [['ดู widget ต้นทุนเมนู', 'library']],
    ask: 'ถ้าอยากตั้งเป้า food cost ต่อเมนูหรือสาขา ปรึกษาผู้ดูแลบริษัทของคุณได้',
  },
  {
    id: 'gm_two',
    q: ['gm ตามสูตรกับจ่ายจริงต่างกันยังไง', 'กำไรตามสูตรกับกำไรจริง', 'gm จ่ายจริงคืออะไร', 'ทำไมกำไรจริงต่ำกว่าตามสูตร'],
    a: '- **GM ตามสูตร** = กำไรที่ควรได้ถ้าทำตามสูตรและราคาวัตถุดิบในสูตรเป๊ะ บอกว่าเมนูออกแบบมาดีแค่ไหน\n- **GM จ่ายจริง** = คิดจากต้นทุนของที่ซื้อจริง (ไม่ใช่ที่ใช้) ถ้าซื้อมากกว่าที่ใช้ในเดือนนั้น หรือสต็อกคงเหลือเปลี่ยน ตัวเลขจะเคลื่อนได้ บอกว่าครัวทำได้จริงแค่ไหน\nส่วนต่างเกิดได้จากสูตรหรือราคาในสูตรล้าหลัง หน่วยแปลงผิด ผลผลิตหลังตัดแต่ง การนับสต็อก ของเสียที่ไม่ได้บันทึก หรือของหายจริง ไล่ตรวจสาเหตุเหล่านี้ก่อน',
    go: [],
  },
  {
    id: 'three_way',
    q: ['3-way match คืออะไร', 'three way match', 'po grn invoice ต่างกันยังไง', 'po grn invoice คืออะไร', 'ทำไมต้องเทียบ po grn invoice'],
    a: 'คือการเทียบเอกสาร 3 ใบของการซื้อ:\n- **PO** = สั่งอะไร เท่าไร\n- **GRN** = รับของจริงอะไร เท่าไร\n- **Invoice** = ซัพพลายเออร์เรียกเก็บอะไร เท่าไร\nควรตรงกัน ถ้า GRN ต่ำกว่า PO คือส่งขาด ถ้า Invoice สูงกว่า GRN คือวางบิลเกินของที่รับ ข้อควรระวัง: GRN ต่ำกว่า PO อาจเป็นการทยอยส่ง/ค้างส่ง ไม่ใช่ส่งขาดเสมอไป ยอด Invoice อาจต่างเพราะรวม/ไม่รวม VAT หรือราคาต่อหน่วยในบิลไม่ตรง PO และบิลมักมาช้ากว่าการรับของตามเครดิตของซัพพลายเออร์ ก่อนจ่ายเงินควรให้ 3 ใบตรงกันหรือมีใบลดหนี้รองรับ',
    go: [],
  },
  {
    id: 'credit_note',
    q: ['ใบลดหนี้คืออะไร', 'ใบลดหนี้ทำไมต้องตาม', 'ใบลดหนี้ซัพพลายเออร์'],
    a: '**ใบลดหนี้** คือเอกสารที่ซัพพลายเออร์ออกเพื่อลดยอดที่เรียกเก็บไปแล้ว เช่น คืนสินค้า ของไม่ได้คุณภาพ ราคาผิด หรือวางบิลเกิน (ถ้าซัพพลายเออร์วางบิลตามที่ส่งจริงอยู่แล้ว ส่งขาดมักไม่ต้องมีใบลดหนี้) ใบลดหนี้มักมาหลังบิล ถ้าไม่ได้ตามเก็บ ยอดค้างจ่ายจะสูงกว่าที่ควร widget กลุ่ม “คุณภาพซัพพลายเออร์” ช่วยดูว่าเจ้าไหนต้องตาม',
    go: [],
  },
  {
    id: 'stock_variance',
    q: ['ส่วนต่างการนับสต็อกคืออะไร', 'ของเสียกับส่วนต่างสต็อก', 'นับสต็อกไม่ตรงทำไง', 'ทำไมสต็อกไม่ตรง'],
    a: '- **ของเสีย** = ของที่บันทึกว่าทิ้ง/เสียหาย\n- **ส่วนต่างการนับ** = ของที่นับจริงไม่ตรงกับในระบบ โดยไม่มีบันทึกอธิบาย\nส่วนต่างที่ไม่มีบันทึกคือจุดที่ควรเข้าไปดูก่อน: การรับของ การเบิก การเตรียมของ หรือการนับรอบก่อนหน้าคลาดเคลื่อน',
    go: [],
  },
  {
    id: 'not_match_fmh',
    q: ['ทำไมเลขไม่ตรงกับ fmh', 'ตัวเลขไม่ตรง fmh', 'ยอดไม่ตรงกับในระบบ', 'เลขไม่ตรงกับบัญชี'],
    a: 'ลองเช็ก 4 จุด: (1) ช่วงวันที่และตัวกรองสาขา/ซัพพลายเออร์ที่เลือกอยู่ตรงกับที่เทียบไหม (2) เอกสารที่ยังไม่ปิดหรือถูกยกเลิก (3) ข้อมูลที่เก็บไว้ล่าสุดตอนไหน — ลองกด “Refresh ด่วน” ด้านบน (4) แต่ละ widget นับต่างกัน เช่นตาม **วันที่สั่ง** หรือ **วันที่รับ** และยอดบางที่รวม VAT บางที่ไม่รวม กด “อธิบาย” เพื่อดูว่า widget นั้นนับอะไร ถ้ายังต่าง ส่งตัวอย่างเอกสารให้ทีม KSS ตรวจ',
    go: [],
  },
  {
    id: 'partial_period',
    q: ['เดือนนี้ยังไม่จบเทียบได้ไหม', 'สัปดาห์ล่าสุดตกทำไม', 'ยอดเดือนนี้น้อยกว่าเดือนที่แล้ว', 'เดือนล่าสุดดูต่ำ'],
    a: 'เดือนหรือสัปดาห์ที่ยังไม่จบมีข้อมูลไม่เต็มช่วง เทียบกับช่วงที่ครบแล้วจะดูเหมือนตก ทั้งที่ยังไม่ตก ปุ่ม **อธิบาย** จึงเทียบถึงช่วงที่ครบล่าสุดและบอกไว้ ถ้าจะเทียบจริง ให้เทียบ “ช่วงเดียวกันของเดือนก่อน” หรือรอให้เดือนปิด',
    go: [],
  },
  {
    id: 'data_fresh',
    q: ['ข้อมูลอัปเดตล่าสุดเมื่อไร', 'ข้อมูลเป็นปัจจุบันไหม', 'ข้อมูลเก่าไหม', 'refresh ข้อมูล', 'รีเฟรชข้อมูล'],
    a: 'ข้อมูลบนหน้าคือรายงานที่ระบบดึงจาก FMH ไว้ล่าสุด ถ้าต้องการให้ใหม่ที่สุดตอนนี้ กด **Refresh ด่วน** ด้านบนของ Dashboard ส่วน **ใช้ข้อมูลที่เก็บไว้** จะเปิดเร็วกว่าแต่เป็นรอบดึงล่าสุด',
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

function helpFaq(question, extra) {
  const qn = hpNorm(question);
  let best = null;
  HELP_FAQ.concat(extra || []).forEach((e) => {
    const sc = Math.max(...e.q.map((p) => hpScore(qn, hpNorm(p))));
    if (!best || sc > best.sc) best = { e, sc };
  });
  return best && best.sc >= 0.5 ? best : null;
}

// ---- the page ------------------------------------------------------------
// parts: { head: [lines], widgets: [{ id, title, facts: [..] }] }
const HP_PROBLEM_Q = /ผิดปกติ|น่าห่วง|รีบดู|เสี่ยง|ต้องดู|ปัญหา|แย่|ต้องแก้|เรื่องด่วน/;
// Facts the explain rules write when something crosses a line they can check.
const HP_PROBLEM_FACT = /เกินเป้า|ต่ำกว่าเป้า|ระดับ “สูง”|ห่างเกิน|ส่วนใหญ่ของทั้งหมด|ไม่กี่รายการ/;
const HP_TREND_Q = /เพิ่มขึ้น|ลดลง|ขึ้นไหม|ลงไหม|แนวโน้ม|ตกไหม|ตกหรือเปล่า/;
const HP_TREND_FACT = /เพิ่มขึ้น|ลดลง|ทรงตัว/;
const HP_SUMMARY = /สรุป|ภาพรวม|overview|หน้านี้มีอะไร|เล่าให้ฟัง/;
const HP_STATE = /ช่วงวันที่|ตัวกรองอะไร|กรองอะไร|กำลังดูอะไร|ดูข้อมูลช่วงไหน/;

// kind: 'widget' (a widget is named — beats a FAQ match) | 'page' (general)
function helpFromPage(question, parts) {
  if (!parts || !parts.widgets || !parts.widgets.length) return null;
  const qn = hpNorm(question);
  const ws = parts.widgets.filter((w) => w.facts.length);
  if (HP_STATE.test(question)) return { text: parts.head.join('\n'), source: 'data', go: [], kind: 'page' };
  if (HP_SUMMARY.test(question) && ws.length) {
    const lines = ws.slice(0, 8).map((w) => `- **${w.title}**: ${w.facts[0]}`);
    const more = ws.length > 8 ? `\n(และอีก ${ws.length - 8} widget — กด “อธิบาย” ที่แต่ละตัวเพื่อดูต่อ)` : '';
    return { text: `${parts.head[0]} · ${parts.head.slice(1).join(' · ')}\n${lines.join('\n')}${more}`.replace(' · \n', '\n'), source: 'data', go: [], kind: 'page' };
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
    return { text, source: 'data', go: [], kind: 'widget' };
  }
  // "What's off / is it going up" — generic, or about a subject that must
  // actually be on this page (otherwise "ราคาหมูขึ้นไหม" would get a trend of
  // some other number).
  const isProblem = HP_PROBLEM_Q.test(question), isTrend = HP_TREND_Q.test(question);
  if (isProblem || isTrend) {
    const subject = qn.replace(HP_PROBLEM_Q, '').replace(HP_TREND_Q, '').replace(/อะไร|บ้าง|ไหม|หรือเปล่า|หรือไม่|ที่|ของ|ใน|หน้านี้|ตัวเลข|เรื่อง|มี|จุด|ต้อง|ตอนนี้|ช่วงนี้|เดือนนี้|วันนี้/g, '');
    const pool = subject.length <= 3 ? ws : ws.filter((w) => hpNorm(w.title + w.facts.join('')).includes(subject));
    const hits = [];
    const re = isProblem ? HP_PROBLEM_FACT : HP_TREND_FACT;
    pool.forEach((w) => w.facts.forEach((f) => { if (re.test(f) && (isProblem || /→/.test(f))) hits.push(`- **${w.title}**: ${f}`); }));
    if (isProblem && (pool.length || subject.length <= 3)) {
      return {
        text: hits.length
          ? `จุดที่ควรดูในหน้านี้ (ตามที่ระบบตรวจจากตัวเลขได้):\n${hits.slice(0, 6).join('\n')}`
          : 'จากตัวเลขบนหน้านี้ ระบบไม่เห็นจุดที่เกินเกณฑ์หรือเกินเป้า แต่ระบบตรวจได้เฉพาะเรื่องที่ตั้งเกณฑ์ไว้ ลองกด “อธิบาย” ที่ widget หรือดู widget กลุ่มตัวเตือน',
        source: 'data',
        go: [],
        kind: 'page',
      };
    }
    if (isTrend && hits.length) return { text: `แนวโน้มที่เห็นในหน้านี้:\n${hits.slice(0, 6).join('\n')}`, source: 'data', go: [], kind: 'page' };
  }
  return null;
}

function helpAnswer(question, parts, canSettings, taught) {
  const q = String(question || '').trim();
  if (!q) return null;
  const extra = (taught || []).map((t) => ({ id: 't' + t.id, q: t.phrases, a: t.answer, go: [], taught: true }));
  const f = helpFaq(q, extra);
  const page = helpFromPage(q, parts);
  // A widget named in the question beats all but a near-exact FAQ match.
  if (page && page.kind === 'widget' && !(f && f.sc >= 0.95)) return page;
  if (f && (f.sc >= 0.75 || !page)) {
    const e = f.e;
    const go = canSettings ? (e.go || []).map(([label, act]) => ({ label, act })) : [];
    const text = canSettings || !e.ask ? e.a : e.ask;
    return { text, source: 'faq', go, id: e.id };
  }
  return page;
}

if (typeof module !== 'undefined') module.exports = { helpAnswer, helpFaq, HELP_FAQ, hpNorm };
