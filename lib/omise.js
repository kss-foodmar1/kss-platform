// Minimal Omise (Opn Payments) client — only what subscription billing needs:
// create a PromptPay QR charge, read a charge back, verify webhook signatures.
//
// Keys come from the environment and are never logged or returned to a browser:
//   OMISE_SECRET_KEY      skey_test_... on staging, skey_... in production
//   OMISE_WEBHOOK_SECRET  the (base64) secret shown for the webhook endpoint
const crypto = require('crypto');

const BASE = 'https://api.omise.co';

// Tolerate the usual paste slips in the Railway UI: spaces, newlines, quotes.
const clean = (v) => String(v || '').trim().replace(/^["']|["']$/g, '').trim();

function secretKey() {
  const k = clean(process.env.OMISE_SECRET_KEY || process.env.omise_secret_key);
  if (!k) throw new Error('ยังไม่ได้ตั้งค่า OMISE_SECRET_KEY');
  return k;
}

// 'test' | 'live' | null — from the key prefix, so the Admin Console can show
// which mode a deploy is in without ever exposing the key.
function mode() {
  const k = clean(process.env.OMISE_SECRET_KEY || process.env.omise_secret_key);
  if (k.startsWith('skey_test_')) return 'test';
  if (k.startsWith('skey_')) return 'live';
  return null;
}

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(secretKey() + ':').toString('base64'),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error(`Omise ตอบกลับในรูปแบบที่อ่านไม่ได้ (HTTP ${res.status})`);
  }
  if (json && json.object === 'error') throw new Error(`Omise: ${json.code} — ${json.message}`);
  if (!res.ok) throw new Error(`Omise HTTP ${res.status}`);
  return json;
}

async function createPromptPayCharge({ amountSatang, description, metadata }) {
  return call('POST', '/charges', {
    amount: amountSatang,
    currency: 'thb',
    source: { type: 'promptpay' },
    description,
    metadata,
  });
}

// Card on file: a customer holding the card token from Omise.js (the card
// number never reaches KSS). A charge on a customer may need the cardholder's
// 3-D Secure step: then it is 'pending' with an authorize_uri to send them to.
function createCustomer({ email, description, cardToken, metadata }) {
  return call('POST', '/customers', { email, description, card: cardToken, metadata });
}
function updateCustomerCard(customerId, cardToken) {
  return call('PATCH', `/customers/${encodeURIComponent(customerId)}`, { card: cardToken });
}
function getCustomer(id) {
  return call('GET', `/customers/${encodeURIComponent(id)}`);
}
function createCardCharge({ customerId, amountSatang, description, metadata, returnUri }) {
  return call('POST', '/charges', { amount: amountSatang, currency: 'thb', customer: customerId, description, metadata, return_uri: returnUri });
}
// Public key for Omise.js in the browser (pkey_...). Safe to send to a page.
const publicKey = () => clean(process.env.OMISE_PUBLIC_KEY || process.env.omise_public_key) || null;

function getCharge(id) {
  return call('GET', `/charges/${encodeURIComponent(id)}`);
}

// Omise signs `<timestamp>.<raw body>` with HMAC-SHA256 using the base64-decoded
// webhook secret and sends the hex digest in Omise-Signature (several
// comma-separated digests while a secret is being rotated).
function verifyWebhookSignature(rawBody, signatureHeader, timestampHeader, secretB64 = clean(process.env.OMISE_WEBHOOK_SECRET || process.env.omise_webhook_secret)) {
  if (!secretB64 || !rawBody || !signatureHeader || !timestampHeader) return false;
  const expected = crypto
    .createHmac('sha256', Buffer.from(secretB64, 'base64'))
    .update(`${timestampHeader}.${rawBody.toString('utf8')}`)
    .digest();
  return String(signatureHeader)
    .split(',')
    .map((s) => s.trim())
    .some((sig) => {
      const given = Buffer.from(sig, 'hex');
      return given.length === expected.length && crypto.timingSafeEqual(given, expected);
    });
}

// Whether customers can pay online at all (payment links, QR, webhook).
// Off on Railway's production environment until KSS decides to launch it;
// on elsewhere when a key is set. OMISE_PAYMENTS=on|off overrides both.
function paymentsStatus() {
  const flag = clean(process.env.OMISE_PAYMENTS || process.env.omise_payments).toLowerCase();
  const env = clean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT).toLowerCase();
  const raw = clean(process.env.OMISE_SECRET_KEY || process.env.omise_secret_key);
  const pk = publicKey();
  const card = pk ? (pk.startsWith('pkey_') ? '' : 'OMISE_PUBLIC_KEY ต้องขึ้นต้นด้วย pkey_') : 'ยังไม่ได้ตั้ง OMISE_PUBLIC_KEY (ไม่มีตัวเลือกบัตร)';
  const out = (enabled, reason) => ({ enabled, reason, mode: mode(), railway_environment: env || null, card_note: card });
  if (flag === 'on') return mode() ? out(true, 'เปิดด้วย OMISE_PAYMENTS=on') : out(true, 'OMISE_PAYMENTS=on แต่ OMISE_SECRET_KEY ไม่ถูกต้อง (ต้องขึ้นต้นด้วย skey_) — การชำระจะล้มเหลว');
  if (flag === 'off') return out(false, 'ปิดด้วย OMISE_PAYMENTS=off');
  if (env === 'production') return out(false, `ปิดเพราะ Railway environment ชื่อ "production" — ถ้านี่คือ staging ให้ตั้ง OMISE_PAYMENTS=on`);
  if (!raw) return out(false, 'ยังไม่ได้ตั้ง OMISE_SECRET_KEY');
  if (!mode()) return out(false, 'OMISE_SECRET_KEY ไม่ถูกต้อง: ต้องขึ้นต้นด้วย skey_test_ (ทดสอบ) หรือ skey_ (ใช้จริง) — ตรวจว่าไม่ได้วาง pkey_ ผิดช่อง');
  return out(true, `เปิดอยู่ (โหมด ${mode() === 'test' ? 'ทดสอบ' : 'ใช้จริง'})`);
}
function paymentsEnabled() {
  return paymentsStatus().enabled && !!mode();
}

module.exports = { mode, paymentsEnabled, paymentsStatus, createPromptPayCharge, getCharge, verifyWebhookSignature, createCustomer, updateCustomerCard, getCustomer, createCardCharge, publicKey };
