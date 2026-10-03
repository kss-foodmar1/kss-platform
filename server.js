require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const dashboardRoutes = require('./routes/dashboards');
const settingsRoutes = require('./routes/settings');
const adminRoutes = require('./routes/admin');
const billingRoutes = require('./routes/billing');
const billing = require('./lib/billing');
const { syncAllCompanies, syncCompany, pullsUsedByCompany, cacheKeyFor } = require('./lib/fmhCache');
const pool = require('./db/pool');

const app = express();

// Cache busting for the app shell.
//
// "no-cache, must-revalidate" asks the browser to revalidate, and twice now it
// has served a stale app.js anyway while the new server code was already
// running — which produces the worst kind of bug report, because the symptom
// (a 500, then "[object Object]") points at the new server code rather than at
// a months-old script still in the browser's memory cache.
//
// So the asset URLs change instead of asking nicely: every deploy gets a new
// stamp, index.html is rewritten to reference /app.js?v=<stamp>, and a URL the
// browser has never seen cannot be served from cache. The stamp is the newest
// mtime among the shell files, so it changes exactly when they do and stays
// stable across restarts that changed nothing.
const SHELL_FILES = ['app.js', 'admin.js', 'style.css', 'index.html'];
const ASSET_VERSION = (() => {
  try {
    const newest = SHELL_FILES.reduce((max, f) => {
      const t = fs.statSync(path.join(__dirname, 'public', f)).mtimeMs;
      return t > max ? t : max;
    }, 0);
    return Math.floor(newest).toString(36);
  } catch {
    return Date.now().toString(36); // can't stat: fall back to per-boot
  }
})();

const SHELL_HTML = (() => {
  const raw = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  return raw.replace(/(src|href)="\/(app\.js|admin\.js|style\.css)"/g, `$1="/$2?v=${ASSET_VERSION}"`);
})();

function sendShell(res) {
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.type('html').send(SHELL_HTML);
}

// Keep the raw bytes of webhook bodies: Omise's signature is over them.
app.use(express.json({ verify: (req, res, buf) => { if (req.originalUrl.startsWith('/api/webhooks/')) req.rawBody = buf; } }));
app.use(cookieParser());

// The shell is served from memory with versioned asset URLs, so it never comes
// from the static handler.
app.get(['/', '/index.html'], (req, res) => sendShell(res));

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
      // A versioned URL can be cached hard; anything else must revalidate.
      const versioned = SHELL_FILES.some((f) => filePath.endsWith(path.sep + f));
      res.setHeader('Cache-Control', versioned ? 'no-cache, must-revalidate' : 'public, max-age=300');
    },
  })
);

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/dashboards', dashboardRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/admin/billing', billingRoutes.adminRouter);
app.use('/api/admin', adminRoutes);
app.use('/api/pay', billingRoutes.publicRouter);
app.use('/api/webhooks', billingRoutes.webhookRouter);
app.get('/pay/:token', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'pay.html'));
});

app.get('/health', (req, res) => res.json({ ok: true }));

// SPA fallback: any non-API route serves the app shell.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  sendShell(res);
});

app.use((err, req, res, next) => {
  // A body express could not parse is the caller's mistake, not ours. Saying
  // "Server error" for it sends whoever is debugging to the wrong place.
  if (err && err.type === 'entity.parse.failed') {
    console.error('Malformed JSON body on', req.method, req.originalUrl);
    return res.status(400).json({ error: 'ส่งข้อมูลมาในรูปแบบที่อ่านไม่ได้' });
  }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

function logSync(label, results) {
  Object.entries(results).forEach(([source, r]) => {
    if (r.ok) console.log(`  ${label} "${source}" ok: ${r.rows} rows`);
    else console.error(`  ${label} "${source}" failed: ${r.error}`);
  });
}

// Daily FMH sync at 1am Asia/Bangkok: every company with an FMH key, only the
// report sources that company's widgets actually use.
cron.schedule(
  '0 1 * * *',
  async () => {
    console.log('Running daily FMH sync (1am Asia/Bangkok)...');
    try {
      const all = await syncAllCompanies();
      Object.entries(all).forEach(([company, results]) => logSync(company, results));
    } catch (err) {
      console.error('Daily FMH sync failed:', err.message);
    }
  },
  { timezone: 'Asia/Bangkok' }
);

// Billing: every 10 minutes settle any QR that was paid but whose webhook never
// arrived (Omise does not guarantee retries); daily 02:00 apply expiry rules.
cron.schedule('*/10 * * * *', () => billing.reconcilePending().catch((e) => console.error('Reconcile failed:', e.message)), { timezone: 'Asia/Bangkok' });
cron.schedule(
  '0 2 * * *',
  async () => {
    try {
      const r = await billing.enforceExpiry();
      if (r.suspended) console.log(`Billing: suspended ${r.suspended} company(ies) past subscription + grace`);
    } catch (e) {
      console.error('Billing expiry check failed:', e.message);
    }
  },
  { timezone: 'Asia/Bangkok' }
);

// On boot, fill in any company that has a key but is missing cached data for
// a source it uses (fresh deploy, new widget, key just added) instead of
// leaving those widgets empty until 1am.
async function syncMissingOnBoot() {
  try {
    const [companies] = await pool.query(
      `SELECT id, name FROM companies WHERE fmh_api_key_enc IS NOT NULL AND status <> 'suspended'`
    );
    for (const c of companies) {
      const used = await pullsUsedByCompany(c.id);
      const [cached] = await pool.query(`SELECT cache_key FROM fmh_report_cache WHERE company_id = ?`, [c.id]);
      const have = new Set(cached.map((r) => r.cache_key));
      const missing = used.filter((p) => !have.has(cacheKeyFor(p.source, p.grouping)));
      if (!missing.length) continue;
      console.log(`Boot sync for company ${c.id} (${c.name}): ${missing.map((p) => cacheKeyFor(p.source, p.grouping)).join(', ')}`);
      logSync(`${c.id}:${c.name}`, await syncCompany(c.id, missing));
    }
  } catch (err) {
    console.error('Boot sync failed:', err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KSS Platform listening on port ${PORT}`);
  syncMissingOnBoot();
});
