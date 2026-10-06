# Billing ขั้น 1 — ลูกค้าจ่าย/ต่ออายุรายปีผ่าน Omise PromptPay

KSS ยังตั้งบริษัท/Dashboard ให้ลูกค้าเอง (white-glove) — ขั้นนี้เพิ่มแค่ "จ่ายเงินแล้วต่ออายุอัตโนมัติ"

## Flow
1. Admin Console → บริษัท → หัวข้อ 5 → กรอกรายละเอียด + จำนวนเงิน (พิมพ์เองทุกครั้ง ไม่มีราคาในโค้ด) + จำนวนเดือน → ได้ลิงก์ `/pay/<token>`
2. ลูกค้าเปิดลิงก์ (ไม่ต้อง login) → กด "ชำระด้วย PromptPay QR" → สแกนจ่าย
3. ระบบยืนยันจาก Omise เอง (ไม่เชื่อ body ของ webhook) → `payments.status = paid` → `companies.subscription_ends_at` ต่อ = max(วันนี้, วันหมดอายุเดิม) + N เดือน
4. จ่ายแล้ว: บริษัทสถานะ trial → active, และปลดระงับถ้าระงับเพราะ billing (ระงับด้วยมือจะไม่ถูกปลด)
5. โอนธนาคาร: ปุ่ม "โอนแล้ว" (ต้องใส่หมายเหตุ) ต่ออายุแบบเดียวกัน

## ความปลอดภัย / กันพลาด
- `subscription_ends_at = NULL` = ไม่หมดอายุ (ลูกค้านำร่อง 3 รายไม่โดนกระทบ)
- ระงับอัตโนมัติเมื่อหมดอายุ + ผ่อนผัน ทำงานเฉพาะเมื่อ `BILLING_ENFORCE=1` (ปิดเป็นค่าเริ่มต้น) เฉพาะสถานะ active
- settle เป็น idempotent: webhook ซ้ำ / poll หน้าจ่ายเงิน / cron ซ้ำ ไม่ต่ออายุซ้ำ
- charge ต้อง successful + paid + THB + จำนวนเงินตรงรายการ + metadata `kss_payment_id` ตรง
- Omise ไม่รับประกัน retry webhook → cron ทุก 10 นาที + หน้าจ่ายเงินตรวจเอง ทำให้ webhook เป็นแค่ตัวเร่ง

## ตั้งค่า (Railway variables — ใส่ key เองที่ Railway ห้ามแปะในแชท/โค้ด)
| ตัวแปร | ความหมาย |
|---|---|
| `OMISE_SECRET_KEY` | `skey_test_...` บน staging, `skey_...` บน production |
| `OMISE_WEBHOOK_SECRET` | secret (base64) ของ webhook endpoint ใน Omise dashboard — ไม่ใส่ก็ใช้งานได้ ตรวจสถานะเองทุก 10 นาที |
| `PUBLIC_BASE_URL` | เช่น `https://kss-platform-staging.up.railway.app` (ถ้าไม่ใส่ใช้ host ของ request) |
| `BILLING_ENFORCE` | `1` เพื่อเปิดระงับอัตโนมัติ |
| `BILLING_GRACE_DAYS` | ผ่อนผันหลังหมดอายุ (ค่าเริ่มต้น 14) |

Webhook URL: `<PUBLIC_BASE_URL>/api/webhooks/omise` เหตุการณ์ `charge.complete`

## ทดสอบ
`scripts/fake-omise.js` (Omise จำลอง) + `scripts/test-billing.js` (18 เช็ก) — ดูหัวไฟล์สำหรับวิธีรัน

## ยังไม่ทำ (ขั้นถัดไป)
ใบกำกับภาษี/ใบเสร็จอัตโนมัติ (FlowAccount/PEAK), แจ้งเตือนใกล้หมดอายุ, ป้ายอายุใช้งานให้ company_admin เห็น, บัตรเครดิต/ต่ออายุอัตโนมัติ, สมัครเอง (ขั้น 2)


## Production switch (2026-10-07)

Online payment is **off on production** until KSS decides to launch it. While it is off:

- payment links cannot be created
- `/pay/...` and `/api/pay` return not found
- the Omise webhook returns not found
- the 10-minute reconcile does nothing
- the Admin Console billing card shows only the subscription end date

The rule is in `lib/omise.js`, `paymentsEnabled()`:

- `OMISE_PAYMENTS=on` or `off` decides, if it is set.
- Otherwise it is off when Railway's `RAILWAY_ENVIRONMENT_NAME` is `production`.
- Otherwise it is on when an Omise secret key is set.

To launch payments on production, set `OMISE_PAYMENTS=on` together with the live keys.
