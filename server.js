require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const dashboardRoutes = require('./routes/dashboards');
const reportRoutes = require('./routes/reports');
const settingsRoutes = require('./routes/settings');

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KSS Platform listening on port ${PORT}`);
});
