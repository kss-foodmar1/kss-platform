// Test-only preload: replaces fetch for api.omise.co with an in-memory Omise
// (PromptPay charges that can be "paid" via a control endpoint file flag).
// Usage: node -r ./scripts/fake-omise.js server.js
const realFetch = global.fetch;
const charges = new Map();
let n = 0;
global.__fakeOmise = {
  charges,
  pay(id) { charges.get(id).status = 'successful'; charges.get(id).paid = true; },
  setStatus(id, s) { charges.get(id).status = s; },
};
const resp = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });
global.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://api.omise.co')) return realFetch(url, opts);
  const path = String(url).slice('https://api.omise.co'.length);
  const auth = (opts.headers || {}).Authorization || '';
  if (!auth.startsWith('Basic ')) return resp({ object: 'error', code: 'authentication_failure', message: 'no auth' }, 401);
  if (opts.method === 'POST' && path === '/charges') {
    const b = JSON.parse(opts.body);
    const id = `chrg_test_${++n}`;
    const c = { object: 'charge', id, amount: b.amount, currency: b.currency, status: 'pending', paid: false, metadata: b.metadata,
      expires_at: new Date(Date.now() + 3600e3).toISOString(),
      source: { type: 'promptpay', scannable_code: { image: { download_uri: `https://api.omise.co/charges/${id}/documents/qr.svg` } } } };
    charges.set(id, c);
    return resp(c);
  }
  const m = path.match(/^\/charges\/(.+)$/);
  if (opts.method === 'GET' && m) return charges.has(m[1]) ? resp(charges.get(m[1])) : resp({ object: 'error', code: 'not_found', message: 'nf' }, 404);
  return resp({ object: 'error', code: 'not_found', message: 'nf' }, 404);
};
// Test hook: POST http://127.0.0.1:PORT/__fake/pay?id=...  (only when loaded by this preload)
const http = require('http');
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const id = u.searchParams.get('id');
  if (u.pathname === '/pay' && charges.has(id)) { global.__fakeOmise.pay(id); res.end('ok'); }
  else if (u.pathname === '/status' && charges.has(id)) { global.__fakeOmise.setStatus(id, u.searchParams.get('s')); res.end('ok'); }
  else { res.statusCode = 404; res.end(); }
}).listen(Number(process.env.FAKE_CTL_PORT || 4599), '127.0.0.1');
