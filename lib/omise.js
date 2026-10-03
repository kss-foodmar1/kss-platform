// Minimal Omise (Opn Payments) client — only what subscription billing needs:
// create a PromptPay QR charge, read a charge back, verify webhook signatures.
//
// Keys come from the environment and are never logged or returned to a browser:
//   OMISE_SECRET_KEY      skey_test_... on staging, skey_... in production
//   OMISE_WEBHOOK_SECRET  the (base64) secret shown for the webhook endpoint
const crypto = require('crypto');

const BASE = 'https://api.omise.co';

function secretKey() {
  const k = process.env.OMISE_SECRET_KEY;
  if (!k) throw new Error('ยังไม่ได้ตั้งค่า OMISE_SECRET_KEY');
  return k;
}

// 'test' | 'live' | null — from the key prefix, so the Admin Console can show
// which mode a deploy is in without ever exposing the key.
function mode() {
  const k = process.env.OMISE_SECRET_KEY || '';
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

function getCharge(id) {
  return call('GET', `/charges/${encodeURIComponent(id)}`);
}

// Omise signs `<timestamp>.<raw body>` with HMAC-SHA256 using the base64-decoded
// webhook secret and sends the hex digest in Omise-Signature (several
// comma-separated digests while a secret is being rotated).
function verifyWebhookSignature(rawBody, signatureHeader, timestampHeader, secretB64 = process.env.OMISE_WEBHOOK_SECRET) {
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

module.exports = { mode, createPromptPayCharge, getCharge, verifyWebhookSignature };
