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

const PROBES = [
  { name: 'empty-200', send: (res) => res.status(200).end() },
  { name: 'text-OK', send: (res) => res.status(200).type('text/plain').send('OK') },
  { name: 'json-msg_code-0', send: (res) => res.status(200).json({ msg_code: 0 }) },
  { name: 'text-200-OK', send: (res) => res.status(200).type('text/plain').send('200 OK') },
  { name: 'json-success-true', send: (res) => res.status(200).json({ success: true }) },
];

// The app-wide express.json only reads application/json. If Eats365 sends another content type
// (the document does not say), keep the raw bytes here too, so the signature can still be checked
// and the JSON array still read. Skipped when express.json already read the body.
router.use(express.raw({ type: () => true, limit: '5mb' }), (req, res, next) => {
  if (Buffer.isBuffer(req.body)) {
    req.rawBody = req.body;
    try { req.body = req.body.length ? JSON.parse(req.body.toString('utf8')) : {}; } catch (e) { req.body = {}; }
  }
  next();
});

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

// Every request is logged by shape (method, path, user agent, content type, size, event names,
// signature verdict), never header values or the body, so Eats365's own URL test can be seen in
// the server log. Every request is answered 200 for now: nothing here acts on the data, and a
// refused test would only block registration. When data handling is added it must run only for
// verified === 'valid' and refuse the rest.
router.all(/.*/, (req, res) => {
  const verified = req.method === 'POST' ? check(req) : null;
  try {
    const body = req.body;
    console.log('Eats365 webhook received:', JSON.stringify({
      method: req.method,
      path: String(req.originalUrl).split('?')[0].slice(0, 80),
      ua: String(req.get('user-agent') || '').slice(0, 60),
      // query: names and short values (a verification challenge would show up here); header names only
      query: Object.fromEntries(Object.entries(req.query || {}).slice(0, 10).map(([k, v]) => [k.slice(0, 40), String(v).slice(0, 80)])),
      header_names: Object.keys(req.headers).filter((h) => !/^(cookie|authorization)$/i.test(h)).slice(0, 30),
      sig_len: (req.get('eats365-signature') || '').length,
      verified,
      content_type: req.get('content-type') || null,
      bytes: req.rawBody ? req.rawBody.length : Number(req.get('content-length')) || 0,
      events: Array.isArray(body) ? body.length : null,
      actions: Array.isArray(body) ? [...new Set(body.map((e) => e && typeof e.action === 'string' ? e.action.slice(0, 40) : null).filter(Boolean))] : null,
      fields: body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).slice(0, 30) : null,
    }));
  } catch (e) { console.error('Eats365 webhook log failed:', e.message); }
  // Discovery (temporary): Eats365's portal tests BOTH the staging and the production URL with a
  // bare GET on each Save, and says "response is invalid" without saying what it wants. The
  // candidate answer changes every minute by the clock, so staging and production give the same
  // one at the same moment; the log says which. Replace with the winning answer once known.
  if (req.method === 'GET' && !Object.keys(req.query || {}).length && process.env.EATS365_PROBE !== 'off') {
    const v = PROBES[Math.floor(Date.now() / 60000) % PROBES.length];
    console.log('Eats365 webhook GET answered with probe:', v.name);
    return v.send(res);
  }
  res.status(200).json({ ok: true, service: 'eats365-webhook' });
});

module.exports = { router };
