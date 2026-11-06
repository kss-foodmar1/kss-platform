// Eats365 webhook receiver (no auth: Eats365 calls it from outside).
//   POST /api/webhooks/eats365   Eats365 -> us
//   GET  /api/webhooks/eats365   liveness check, answers 200
// Stage 1: accept and acknowledge, and log only the shape of what arrives (content type,
// size, top-level field names, header NAMES), never header values or the body, so the real
// payload and signature scheme can be read from Eats365's docs and a first delivery.
// The log says whether the request proves it knows EATS365_WEBHOOK_KEY (see proof). It still
// answers 200 either way, so Eats365's own URL test cannot fail, and nothing here writes to
// company data until the scheme is confirmed and unverified requests are rejected.
const crypto = require('crypto');
const express = require('express');


// Which kind of proof (if any) the request carries for EATS365_WEBHOOK_KEY. Eats365's scheme is
// not confirmed yet, so two common ones are tried: the key itself in a header, or an HMAC-SHA256
// of the raw body (hex or base64, optional "sha256=" prefix) in a header. Returns 'header-key',
// 'hmac-sha256', 'none' (no match) or 'no-key' (variable not set). Never returns or logs values.
function proof(req) {
  const key = process.env.EATS365_WEBHOOK_KEY;
  if (!key) return 'no-key';
  const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const mac = (enc) => crypto.createHmac('sha256', key).update(req.rawBody).digest(enc);
  const hex = req.rawBody ? mac('hex') : null;
  const b64 = req.rawBody ? mac('base64') : null;
  for (const raw of Object.values(req.headers)) {
    const v = String(raw).replace(/^(bearer|sha256=)\s*/i, '').trim();
    if (!v) continue;
    if (same(v, key)) return 'header-key';
    if (hex && (same(v.toLowerCase(), hex) || same(v, b64))) return 'hmac-sha256';
  }
  return 'none';
}

const router = express.Router();

router.get('/', (req, res) => res.json({ ok: true, service: 'eats365-webhook' }));

router.post('/', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : null;
    console.log('Eats365 webhook received:', JSON.stringify({
      content_type: req.get('content-type') || null,
      bytes: req.rawBody ? req.rawBody.length : Number(req.get('content-length')) || 0,
      fields: body ? Object.keys(body).slice(0, 30) : null,
      verified: proof(req),
      headers: Object.keys(req.headers).filter((h) => /sign|key|event|id|token|time/i.test(h)),
    }));
  } catch (e) { console.error('Eats365 webhook log failed:', e.message); }
  res.status(200).json({ ok: true });
});

module.exports = { router };
