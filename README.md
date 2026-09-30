# KSS Platform — Demo Build

## สิ่งที่ทำแล้ว (ทดสอบผ่านครบทุกจุดในนี้ก่อนส่งให้)

1. Auth: login, JWT httpOnly cookie, bcrypt password hashing
2. บังคับเปลี่ยนรหัสผ่านรอบแรก (`must_change_password`)
3. หน้า Settings (ไอคอนเฟือง, admin เท่านั้น) — เพิ่ม/ลบ user ได้
4. ทุก user เปลี่ยนรหัสผ่านตัวเองได้ (ไอคอนกุญแจ)
5. Dashboard แบบ tab — 1 tab = 1 dashboard, ข้างในมีได้หลาย report
6. Report ตัวแรก "Price Change Report" — ใช้ **mock data** ตอนนี้ (โครงสร้างข้อมูลตรงกับ FMH
   `purchase_price_history` จริงที่ทดสอบผ่าน Swagger UI แล้วที่ `v10-core-be.foodmarkethub.com`)
   มี filter (วันที่/ซัพพลายเออร์/ค้นหา), sort ทุกคอลัมน์ (3-state), export CSV

## วิธี Deploy บน Hostneverdie (DirectAdmin)

### 1. เตรียม MySQL database
ใน DirectAdmin → MySQL Management → สร้าง database + user ตามที่คุยกันไว้
(ชื่อจริงจะมี prefix ตาม username DirectAdmin เช่น `kssxxx_platform_dev`)

จากนั้น import schema:
```
mysql -u <db_user> -p <db_name> < db/schema.sql
```
(หรือใช้ phpMyAdmin ใน DirectAdmin ก็ได้ — import ไฟล์ db/schema.sql)

### 2. ตั้งค่า Node.js App (Node.js Selector)
- Application root: path ของ subdomain `play`
- Application startup file: `server.js`
- หลังสร้าง instance แล้ว จะมีปุ่ม "Run NPM Install" — กดเพื่อติดตั้ง dependencies

### 3. สร้างไฟล์ `.env`
Copy `.env.example` เป็น `.env` แล้วใส่ค่าจริง:
- `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` — จากขั้นตอนที่ 1
- `JWT_SECRET`, `ENCRYPTION_KEY` — generate ด้วย:
  ```
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
  (รันคนละครั้งสำหรับแต่ละค่า อย่าใช้ค่าเดียวกันซ้ำ)
- `SEED_ADMIN_PASSWORD`, `SEED_DEMO_PASSWORD` — ตั้งรหัสผ่านเริ่มต้นที่ต้องการ (ใช้ครั้งเดียวตอน seed)

### 4. Seed ข้อมูลเริ่มต้น
```
npm run seed
```
จะสร้าง:
- Admin: `admin@kinsupplyandservice.com`
- Demo client: `demo@kinsupplyandservice.com` (บังคับเปลี่ยนรหัสผ่านตอน login ครั้งแรก)

### 5. Start app
ผ่านปุ่ม Start/Restart ใน Node.js Selector ของ DirectAdmin

### 6. ทดสอบ
เปิด `https://play.kinsupplyandservice.com` → login ด้วย admin หรือ demo account

## สิ่งที่ยังไม่ทำ (ทำต่อได้หลัง demo)

- **FMH จริง**: `routes/reports.js` ตอนนี้ generate mock data — สลับเป็น FMH จริงได้โดยแก้ฟังก์ชัน
  `generateMockPriceChange()` ให้ยิง `POST https://v10-core-be.foodmarkethub.com/v1/public/reports/catalog/purchase_price_history`
  แทน (โครงสร้าง response ตรงกันแล้ว ไม่ต้องแก้ frontend)
- **Per-client report entitlement**: ตอนนี้ทุก user login แล้วเห็นทุก dashboard/report เหมือนกันหมด
  ยังไม่มีตาราง `client_report_access` แบบที่ออกแบบไว้ในสเปกเต็ม (`kss-platform-backend-spec.md`)
- **FMH API key encryption per client**: ยังไม่มีตาราง `clients` เก็บ `fmh_api_key` เข้ารหัส —
  ต้องเพิ่มก่อนเชื่อม FMH จริงหลายราย
- **Daily email report job**: `/internal/run-daily-reports` และตาราง `notification_settings`
  ยังไม่ได้ implement ในรอบ demo นี้
- **Export Excel จริง (.xlsx)**: ตอนนี้ export เป็น CSV (เปิดใน Excel ได้ปกติ) — ถ้าต้องการไฟล์ .xlsx
  จริงต้องเพิ่ม library เช่น `exceljs`
