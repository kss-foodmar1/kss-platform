// Test-only preload: replaces fetch for api.omise.co with an in-memory Omise
// (PromptPay charges that can be "paid" via a control endpoint file flag).
// Usage: node -r ./scripts/fake-omise.js server.js
const realFetch = global.fetch;
const charges = new Map();
const customers = new Map();
const cardFrom = (token, k) => {
  const behavior = /3ds/.test(token) ? '3ds' : /fail/.test(token) ? 'fail' : 'ok';
  const card = { id: `card_test_${k}`, brand: 'Visa', last_digits: behavior === 'ok' ? '4242' : behavior === '3ds' ? '3155' : '0002', expiration_month: 12, expiration_year: 2030 };
  return { behavior, default_card: card.id, cards: { object: 'list', data: [card] } };
};
let n = 0;
global.__fakeOmise = {
  charges,
  pay(id) { charges.get(id).status = 'successful'; charges.get(id).paid = true; },
  customers,
  setStatus(id, s) { charges.get(id).status = s; },
};
const resp = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });
global.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://api.omise.co')) return realFetch(url, opts);
  const path = String(url).slice('https://api.omise.co'.length);
  const auth = (opts.headers || {}).Authorization || '';
  if (!auth.startsWith('Basic ')) return resp({ object: 'error', code: 'authentication_failure', message: 'no auth' }, 401);
  if (opts.method === 'POST' && path === '/charges' && !JSON.parse(opts.body).customer) {
    const b = JSON.parse(opts.body);
    const id = `chrg_test_${++n}`;
    const c = { object: 'charge', id, amount: b.amount, currency: b.currency, status: 'pending', paid: false, metadata: b.metadata,
      expires_at: new Date(Date.now() + 3600e3).toISOString(),
      source: { type: 'promptpay', scannable_code: { image: { download_uri: `https://api.omise.co/charges/${id}/documents/qr.svg` } } } };
    charges.set(id, c);
    return resp(c);
  }
  // Customers with a card on file. The token decides how the card behaves:
  // tokn_test_ok pays, tokn_test_3ds waits for 3-D Secure, tokn_test_fail is declined.
  if (path === '/customers' && opts.method === 'POST') {
    const b = JSON.parse(opts.body);
    const id = `cust_test_${++n}`;
    customers.set(id, { object: 'customer', id, email: b.email, description: b.description, metadata: b.metadata, ...cardFrom(b.card, n) });
    return resp(customers.get(id));
  }
  const cm = path.match(/^\/customers\/([^/]+)$/);
  if (cm && customers.has(cm[1])) {
    if (opts.method === 'PATCH') Object.assign(customers.get(cm[1]), cardFrom(JSON.parse(opts.body).card, ++n));
    return resp(customers.get(cm[1]));
  }
  if (opts.method === 'POST' && path === '/charges' && JSON.parse(opts.body).customer) {
    const b = JSON.parse(opts.body);
    const cust = customers.get(b.customer);
    if (!cust) return resp({ object: 'error', code: 'not_found', message: 'customer not found' }, 404);
    const id = `chrg_test_${++n}`;
    const how = cust.behavior;
    const c = { object: 'charge', id, amount: b.amount, currency: b.currency, customer: b.customer, metadata: b.metadata, return_uri: b.return_uri,
      status: how === 'ok' ? 'successful' : how === '3ds' ? 'pending' : 'failed', paid: how === 'ok',
      authorize_uri: how === '3ds' ? `https://bank.test/3ds/${id}` : null,
      failure_code: how === 'fail' ? 'insufficient_fund' : null, failure_message: how === 'fail' ? 'insufficient funds in the account' : null };
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
  // /card?cust=...&how=ok|fail|3ds — change how a saved card behaves from now on
  else if (u.pathname === '/card' && customers.has(u.searchParams.get('cust'))) { customers.get(u.searchParams.get('cust')).behavior = u.searchParams.get('how'); res.end('ok'); }
  else { res.statusCode = 404; res.end(); }
}).listen(Number(process.env.FAKE_CTL_PORT || 4599), '127.0.0.1');
