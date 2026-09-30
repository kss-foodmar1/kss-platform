-- KSS Platform schema — shared across all future dashboard apps.
-- Run this once against the kss_platform_dev (or kss_platform) database.

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  role ENUM('admin','client') NOT NULL DEFAULT 'client',
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- A "dashboard" is one tab in the shell. Each dashboard holds 1+ reports.
CREATE TABLE IF NOT EXISTS dashboards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  dashboard_key VARCHAR(50) UNIQUE NOT NULL,   -- 'purchase_analysis', 'cogs', etc.
  display_name VARCHAR(255) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

-- A report belongs to exactly one dashboard tab.
CREATE TABLE IF NOT EXISTS reports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  dashboard_id INT NOT NULL,
  report_key VARCHAR(50) UNIQUE NOT NULL,      -- 'price_change', 'price_comparison', etc.
  display_name VARCHAR(255) NOT NULL,
  data_source VARCHAR(50) NOT NULL DEFAULT 'FMH',
  sort_order INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  FOREIGN KEY (dashboard_id) REFERENCES dashboards(id)
);

-- Which dashboards (tabs) a given user is allowed to see. Admins always see
-- every active dashboard regardless of this table (enforced in routes/
-- dashboards.js) — this only restricts client accounts, so each client can
-- have a different number of tabs.
CREATE TABLE IF NOT EXISTS user_dashboard_access (
  user_id INT NOT NULL,
  dashboard_id INT NOT NULL,
  PRIMARY KEY (user_id, dashboard_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE
);

-- Key/value store for platform-wide settings — currently just the FMH API key.
-- Value is stored encrypted (AES-256-GCM via ENCRYPTION_KEY); see lib/crypto.js.
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(100) PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Cached FMH report data — populated by a daily sync job (lib/fmhCache.js,
-- cron in server.js) plus on-demand user-triggered refreshes, instead of
-- every dashboard page view calling FMH directly. This is what keeps FMH's
-- monthly row quota from being burned by ordinary page traffic. data_json
-- holds the raw FMH rows for a 90-day rolling window (FMH's own max lookback);
-- quota_json holds the {monthly_row_limit, rows_used, rows_remaining,
-- resets_at} object FMH returned on that same call, so the dashboard can show
-- quota status without a separate FMH call just to check it.
CREATE TABLE IF NOT EXISTS fmh_report_cache (
  cache_key VARCHAR(50) PRIMARY KEY,   -- 'cogs', 'menu-costing', 'sales-by-branch', 'purchase-analysis'
  data_json LONGTEXT NOT NULL,
  quota_json TEXT,
  synced_at TIMESTAMP NOT NULL
);

-- Seed: one admin user + one demo dashboard/report so the app is usable immediately.
-- Password for both seeded accounts is set by db/seed.js (bcrypt-hashed there, not here).
