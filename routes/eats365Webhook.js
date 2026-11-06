// Eats365 webhook receiver (no auth: Eats365 calls it from outside).
//   POST /api/webhooks/eats365   Eats365 -> us
//   GET  /api/webhooks/eats365   liveness check, answers 200
// Per Eats365's API document (Webhook section): the request body is a JSON array of one or
// more event payloads, signed with HMAC-SHA512 using the webhook secret we gave Eats365; the
// signature is in the EATS365-SIGNATURE header. Any answer other than 200 OK makes Eats365
// retry once after 5 seconds. The secret is EATS365_WEBHOOK_KEY (one value per environment).
// Stage 1: verify, acknowledge and log the shape only (never header values or the body);
// nothing is written to company data yet.
const crypto = require('crypto');
const express = require('express');

const router = express.Router();

// 'valid' | 'invalid' | 'missing' (no signature header) | 'no-key' (variable not set).
// The document does not say hex or base64, so both are accepted.
function check(req) {
  const key = process.env.EATS365_WEBHOOK_KEY;
  if (!key) return 'no-key';
  const sig = req.get('eats365-signature');
  if (!sig) return 'missing';
  if (!req.rawBody) return 'invalid';
  const mac = (enc) => crypto.createHmac('sha512', key).update(req.rawBody).digest(enc);
  const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const v = sig.trim().replace(/^sha512=/i, '');
  return same(v.toLowerCase(), mac('hex')) || same(v, mac('base64')) ? 'valid' : 'invalid';
}

router.get(/.*/, (req, res) => res.json({ ok: true, service: 'eats365-webhook' }));

// Eats365 appends /webhook/<event> (e.g. /webhook/menu-updated) to the URL it was given, so any
// path under this router is accepted. Mounted at /api/webhooks/eats365 and at /webhook.
router.post(/.*/, (req, res) => {
  const verified = check(req);
  try {
    const body = req.body;
    console.log('Eats365 webhook received:', JSON.stringify({
      verified,
      path: String(req.originalUrl).split('?')[0].slice(0, 80),
      actions: Array.isArray(body) ? [...new Set(body.map((e) => e && typeof e.action === 'string' ? e.action.slice(0, 40) : null).filter(Boolean))] : null,
      content_type: req.get('content-type') || null,
      bytes: req.rawBody ? req.rawBody.length : Number(req.get('content-length')) || 0,
      events: Array.isArray(body) ? body.length : null,
      fields: Array.isArray(body) ? [...new Set(body.flatMap((e) => (e && typeof e === 'object' ? Object.keys(e) : [])))].slice(0, 30)
        : body && typeof body === 'object' ? Object.keys(body).slice(0, 30) : null,
    }));
  } catch (e) { console.error('Eats365 webhook log failed:', e.message); }
  // Only a signature that is present and wrong is refused. An unsigned request (a URL test from
  // Eats365's form, say) gets 200 but is never acted on: when data handling is added it must run
  // only for verified === 'valid'. Eats365 retries once on non-200.
  if (verified === 'invalid') return res.status(401).json({ ok: false });
  res.status(200).json({ ok: true });
});

module.exports = { router };
