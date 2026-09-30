require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');
const path = require('path');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const dashboardRoutes = require('./routes/dashboards');
const reportRoutes = require('./routes/reports');
const settingsRoutes = require('./routes/settings');
const { syncAll } = require('./lib/fmhCache');
const pool = require('./db/pool');

const app = express();

app.use(express.json());
app.use(cookieParser());
// no-cache on the HTML/JS/CSS app shell so a browser refresh always picks up
// the latest deploy — this app changes frequently and stale-cached index.html
// or app.js (missing new features like the Chart.js tag) is a recurring
// confusion otherwise. Static assets are tiny here, so no real cost.
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, must-revalidate'),
  })
);

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/dashboards', dashboardRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/settings', settingsRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

// SPA fallback: any non-API route serves the app shell.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Basic error handler so a thrown error returns JSON instead of crashing
// the process (Node.js Selector processes should stay up between requests).
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// Daily FMH sync — replaces the old "call FMH live on every dashboard view"
// approach so the monthly row quota isn't burned by ordinary page traffic.
// Runs at 1am Asia/Bangkok time every day; see lib/fmhCache.js for what it does.
cron.schedule('0 1 * * *', () => {
  console.log('Running daily FMH sync (1am Asia/Bangkok)...');
  syncAll().then((results) => {
    Object.entries(results).forEach(([key, r]) => {
      if (r.error) console.error(`  FMH sync "${key}" failed: ${r.error}`);
      else console.log(`  FMH sync "${key}" ok: ${r.data.length} rows`);
    });
  });
}, { timezone: 'Asia/Bangkok' });

// If the cache is completely empty (fresh deploy, or the FMH key was just
// added), run one sync immediately instead of leaving every dashboard
// showing "no data" until the next 1am run.
async function syncOnBootIfEmpty() {
  try {
    const [[{ count }]] = await pool.query(`SELECT COUNT(*) AS count FROM fmh_report_cache`);
    if (count > 0) return;
    console.log('FMH cache is empty — running an initial sync now...');
    const results = await syncAll();
    Object.entries(results).forEach(([key, r]) => {
      if (r.error) console.error(`  FMH sync "${key}" failed: ${r.error}`);
      else console.log(`  FMH sync "${key}" ok: ${r.data.length} rows`);
    });
  } catch (err) {
    console.error('syncOnBootIfEmpty failed:', err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KSS Platform listening on port ${PORT}`);
  syncOnBootIfEmpty();
});
