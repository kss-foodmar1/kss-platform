-- KSS Platform schema — multi-tenant, widget-based.
--
-- Hierarchy:  Company -> Dashboards -> Widgets (instances of Widget Templates)
--             Company -> Users -> (per-user access to that company's dashboards)
--
-- This file is the shape of a FRESH database. It's run on every boot by
-- db/migrate.js, and every statement is CREATE TABLE IF NOT EXISTS — so on an
-- existing (pre-multi-tenant) database these are no-ops for tables that
-- already exist, and db/migrate.js then upgrades those tables in place.

-- One client (tenant). status 'demo' = the sales demo company (not billed).
CREATE TABLE IF NOT EXISTS companies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  status ENUM('active','trial','suspended','demo') NOT NULL DEFAULT 'active',
  plan_tier ENUM('starter','growth','enterprise') NOT NULL DEFAULT 'starter',
  fmh_api_key_enc TEXT NULL,
  fmh_key_updated_at TIMESTAMP NULL,
  subscription_ends_at DATE NULL,
  data_source ENUM('fmh','demo') NOT NULL DEFAULT 'fmh',
  suspended_reason VARCHAR(20) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) DEFAULT CHARSET=utf8mb4;

-- Payment requests KSS issues to a company (annual subscription / renewal).
-- The amount is typed by KSS staff per request — no price is built into code.
-- A request is paid by PromptPay QR through Omise (charge_id) or marked paid
-- by hand (bank transfer). Paying extends companies.subscription_ends_at.
CREATE TABLE IF NOT EXISTS payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  token VARCHAR(64) NOT NULL UNIQUE,
  description VARCHAR(255) NOT NULL,
  amount_satang INT NOT NULL,
  period_months INT NOT NULL DEFAULT 12,
  status ENUM('pending','paid','cancelled') NOT NULL DEFAULT 'pending',
  charge_id VARCHAR(64) NULL,
  charge_expires_at DATETIME NULL,
  qr_url TEXT NULL,
  paid_at DATETIME NULL,
  paid_via ENUM('omise','manual') NULL,
  manual_note VARCHAR(255) NULL,
  extended_from DATE NULL,
  extended_to DATE NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_payments_company (company_id),
  INDEX idx_payments_charge (charge_id)
) DEFAULT CHARSET=utf8mb4;

-- kss_superadmin = KSS staff (company_id NULL, sees every company + Admin Console)
-- company_admin  = client's own admin (manages their company's users + FMH key)
-- client         = viewer, sees only dashboards granted in user_dashboard_access
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  role ENUM('kss_superadmin','company_admin','client') NOT NULL DEFAULT 'client',
  company_id INT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  language ENUM('th','en') NOT NULL DEFAULT 'th',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_users_company (company_id)
) DEFAULT CHARSET=utf8mb4;

-- The Widget Catalog: company-agnostic templates, built once, reused by every
-- company. Built-ins are synced from lib/widgetCatalog.js on boot unless the
-- team edited them in the Admin Console (customized = TRUE).
CREATE TABLE IF NOT EXISTS widget_templates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  template_key VARCHAR(80) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  description VARCHAR(500) NULL,
  category VARCHAR(100) NOT NULL DEFAULT 'General',
  report_source VARCHAR(50) NOT NULL,
  chart_type VARCHAR(30) NOT NULL,
  default_config_json TEXT NOT NULL,
  tier_requirement ENUM('starter','growth','enterprise') NOT NULL DEFAULT 'starter',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  customized BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) DEFAULT CHARSET=utf8mb4;

-- A dashboard = one page (tab) belonging to one company, made of widgets.
CREATE TABLE IF NOT EXISTS dashboards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NULL,
  display_name VARCHAR(255) NOT NULL,
  description VARCHAR(500) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_dashboards_company (company_id)
) DEFAULT CHARSET=utf8mb4;

-- A widget instance: one catalog template placed on one dashboard, with
-- optional per-instance overrides (title, config merged over the default).
CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  dashboard_id INT NOT NULL,
  widget_template_id INT NOT NULL,
  title VARCHAR(255) NULL,
  position INT NOT NULL DEFAULT 0,
  config_json TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE,
  FOREIGN KEY (widget_template_id) REFERENCES widget_templates(id)
) DEFAULT CHARSET=utf8mb4;

-- Which of their company's dashboards a client user may see. company_admins
-- see all of their company's dashboards regardless; superadmins see all.
CREATE TABLE IF NOT EXISTS user_dashboard_access (
  user_id INT NOT NULL,
  dashboard_id INT NOT NULL,
  PRIMARY KEY (user_id, dashboard_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4;

-- Platform-wide key/value settings (the FMH key used to live here before it
-- moved onto companies.fmh_api_key_enc).
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(100) PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) DEFAULT CHARSET=utf8mb4;

-- Cached FMH report data per company — filled by the daily 1am sync plus
-- on-demand refreshes, so dashboard page views never spend FMH quota. Cached
-- per company (not per dashboard): every widget of a company that uses the
-- same report source shares one cached copy.
CREATE TABLE IF NOT EXISTS fmh_report_cache (
  company_id INT NOT NULL,
  cache_key VARCHAR(50) NOT NULL,
  data_json LONGTEXT NOT NULL,
  quota_json TEXT,
  synced_at TIMESTAMP NOT NULL,
  PRIMARY KEY (company_id, cache_key)
) DEFAULT CHARSET=utf8mb4;

-- Every FMH report call and the rows it returned, so the monthly row quota can
-- be traced to what spent it (trig: cron / boot / refresh / admin / warm / key_saved / probe).
CREATE TABLE IF NOT EXISTS fmh_usage_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  pull_key VARCHAR(128) NOT NULL,
  rows_fetched INT NOT NULL,
  trig VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_usage_company_time (company_id, created_at)
) DEFAULT CHARSET=utf8mb4;

-- The last pull of each report that actually returned rows. A later pull that
-- fails or comes back empty never touches it, so a demo (or a client) can
-- always fall back to "the last data we had" with one button.
CREATE TABLE IF NOT EXISTS fmh_cache_saved (
  company_id INT NOT NULL,
  cache_key VARCHAR(128) NOT NULL,
  data_json LONGTEXT NOT NULL,
  quota_json TEXT NULL,
  synced_at TIMESTAMP NOT NULL,
  PRIMARY KEY (company_id, cache_key)
) DEFAULT CHARSET=utf8mb4;

-- The latest failed pull per report (cleared on the next success), so the
-- dashboard can say "the last update failed" instead of failing silently.
CREATE TABLE IF NOT EXISTS fmh_sync_errors (
  company_id INT NOT NULL,
  cache_key VARCHAR(128) NOT NULL,
  error_text VARCHAR(500) NOT NULL,
  failed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, cache_key)
) DEFAULT CHARSET=utf8mb4;

-- POS sales uploaded from a file (Foodstory and other POS with no API).
-- Stored as daily totals per branch + menu — the browser aggregates the export
-- before upload, so bill numbers, customer names and phone numbers never reach
-- the server. A new upload replaces the days (per branch) it covers.
CREATE TABLE IF NOT EXISTS pos_uploads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  filename VARCHAR(255) NOT NULL,
  pos_format VARCHAR(32) NOT NULL DEFAULT 'generic',
  date_from DATE NULL,
  date_to DATE NULL,
  line_count INT NOT NULL DEFAULT 0,
  net_sales DECIMAL(14,2) NOT NULL DEFAULT 0,
  uploaded_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX (company_id),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pos_sales_daily (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  upload_id INT NOT NULL,
  sale_date DATE NOT NULL,
  branch VARCHAR(255) NOT NULL,
  menu_name VARCHAR(255) NOT NULL,
  pos_code VARCHAR(64) NOT NULL DEFAULT '',
  pos_group VARCHAR(255) NOT NULL DEFAULT '',
  pos_category VARCHAR(255) NOT NULL DEFAULT '',
  qty DECIMAL(14,3) NOT NULL DEFAULT 0,
  net_sales DECIMAL(14,2) NOT NULL DEFAULT 0,
  gross_sales DECIMAL(14,2) NOT NULL DEFAULT 0,
  discount DECIMAL(14,2) NOT NULL DEFAULT 0,
  line_count INT NOT NULL DEFAULT 0,
  INDEX (company_id, sale_date),
  INDEX (upload_id),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (upload_id) REFERENCES pos_uploads(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4;

-- How a POS menu name maps onto an FMH recipe, when the names differ.
-- fmh_menu_name NULL + ignore = TRUE: not a dish (bag fee, service charge).
CREATE TABLE IF NOT EXISTS pos_menu_map (
  company_id INT NOT NULL,
  pos_key VARCHAR(255) NOT NULL,
  pos_menu_name VARCHAR(255) NOT NULL,
  fmh_menu_name VARCHAR(255) NULL,
  ignore_menu BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, pos_key),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4;
