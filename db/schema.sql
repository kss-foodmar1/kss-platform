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

-- Seed: one admin user + one demo dashboard/report so the app is usable immediately.
-- Password for both seeded accounts is set by db/seed.js (bcrypt-hashed there, not here).
