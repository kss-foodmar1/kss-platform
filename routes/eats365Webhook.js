// Eats365 webhook receiver (no auth: Eats365 calls it from outside).
//   POST /api/webhooks/eats365   Eats365 -> us
//   GET  /api/webhooks/eats365   liveness check, answers 200
// Stage 1: accept and acknowledge, and log only the shape of what arrives (content type,
// size, top-level field names, header NAMES), never header values or the body, so the real
// payload and signature scheme can be read from Eats365's docs and a first delivery.
// Signature verification is added once the scheme is known; until then nothing here
// writes to company data.
const express = require('express');

const router = express.Router();

router.get('/', (req, res) => res.json({ ok: true, service: 'eats365-webhook' }));

router.post('/', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : null;
    console.log('Eats365 webhook received:', JSON.stringify({
      content_type: req.get('content-type') || null,
      bytes: req.rawBody ? req.rawBody.length : Number(req.get('content-length')) || 0,
      fields: body ? Object.keys(body).slice(0, 30) : null,
      headers: Object.keys(req.headers).filter((h) => /sign|key|event|id|token|time/i.test(h)),
    }));
  } catch (e) { console.error('Eats365 webhook log failed:', e.message); }
  res.status(200).json({ ok: true });
});

module.exports = { router };
