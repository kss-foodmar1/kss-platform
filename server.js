require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');
const path = require('path');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const dashboardRoutes = require('./routes/dashboards');
const settingsRoutes = require('./routes/settings');
const adminRoutes = require('./routes/admin');
const { syncAllCompanies, syncCompany, sourcesUsedByCompany } = require('./lib/fmhCache');
const pool = require('./db/pool');

const app = express();

app.use(express.json());
app.use(cookieParser());
// no-cache on the HTML/JS/CSS app shell so a browser refresh always picks up
// the latest deploy — stale cached index.html/app.js was a recurring confusion.
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, must-revalidate'),
  })
);

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/dashboards', dashboardRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/admin', adminRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

// SPA fallback: any non-API route serves the app shell.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
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

// On boot, fill in any company that has a key but is missing cached data for
// a source it uses (fresh deploy, new widget, key just added) instead of
// leaving those widgets empty until 1am.
async function syncMissingOnBoot() {
  try {
    const [companies] = await pool.query(
      `SELECT id, name FROM companies WHERE fmh_api_key_enc IS NOT NULL AND status <> 'suspended'`
    );
    for (const c of companies) {
      const used = await sourcesUsedByCompany(c.id);
      const [cached] = await pool.query(`SELECT cache_key FROM fmh_report_cache WHERE company_id = ?`, [c.id]);
      const have = new Set(cached.map((r) => r.cache_key));
      const missing = used.filter((s) => !have.has(s));
      if (!missing.length) continue;
      console.log(`Boot sync for company ${c.id} (${c.name}): ${missing.join(', ')}`);
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
