-- Verifone Commander POS — CortexDB Schema
-- Raw JSONB storage + sync ledger + site configuration

-- ── Raw Data Schema ──────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS verifone;

-- Site configuration (Commander devices on LAN)
CREATE TABLE IF NOT EXISTS verifone.site_config (
  site_id         TEXT PRIMARY KEY,
  site_name       TEXT,
  commander_ip    TEXT NOT NULL,
  username        TEXT NOT NULL,
  password_enc    TEXT NOT NULL,           -- encrypted at rest
  sync_interval_ms INTEGER DEFAULT 300000, -- 5 min default
  timezone        TEXT DEFAULT 'America/New_York',
  has_fuel        BOOLEAN DEFAULT true,
  has_carwash     BOOLEAN DEFAULT false,
  enabled         BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  -- Password lifecycle (Commander passwords expire every 90 days)
  password_set_at     TIMESTAMPTZ DEFAULT now(),  -- when password was last changed
  password_expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '90 days'),
  password_auto_rotated_at TIMESTAMPTZ,           -- last successful auto-rotation
  password_rotation_failures INTEGER DEFAULT 0,    -- consecutive auto-rotation failures
  password_rotation_last_error TEXT,               -- last failure reason
  password_user_notified_at TIMESTAMPTZ            -- when user was last warned
);

-- Password rotation audit log
CREATE TABLE IF NOT EXISTS verifone.password_rotation_log (
  id              BIGSERIAL PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES verifone.site_config(site_id),
  action          TEXT NOT NULL,           -- 'auto_rotate_success', 'auto_rotate_failed', 'manual_update', 'user_notified'
  days_remaining  INTEGER,
  error           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Day summary reports (cmd=vrubyrept&reptname=summary&period=2)
CREATE TABLE IF NOT EXISTS verifone.data_day_summary (
  id              BIGSERIAL PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES verifone.site_config(site_id),
  report_date     DATE NOT NULL,
  raw_data        JSONB NOT NULL,
  fetched_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(site_id, report_date)
);

-- Shift summary reports (cmd=vrubyrept&reptname=summary&period=1)
CREATE TABLE IF NOT EXISTS verifone.data_shift_summary (
  id              BIGSERIAL PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES verifone.site_config(site_id),
  shift_id        TEXT NOT NULL,
  report_date     DATE NOT NULL,
  raw_data        JSONB NOT NULL,
  fetched_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(site_id, shift_id)
);

-- Department sales
CREATE TABLE IF NOT EXISTS verifone.data_department (
  id              BIGSERIAL PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES verifone.site_config(site_id),
  report_date     DATE NOT NULL,
  period_type     SMALLINT NOT NULL,       -- 1=shift, 2=day
  raw_data        JSONB NOT NULL,
  fetched_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(site_id, report_date, period_type)
);

-- PLU (item-level) sales
CREATE TABLE IF NOT EXISTS verifone.data_plu (
  id              BIGSERIAL PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES verifone.site_config(site_id),
  report_date     DATE NOT NULL,
  period_type     SMALLINT NOT NULL,
  raw_data        JSONB NOT NULL,
  fetched_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(site_id, report_date, period_type)
);

-- Hourly sales breakdown
CREATE TABLE IF NOT EXISTS verifone.data_hourly (
  id              BIGSERIAL PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES verifone.site_config(site_id),
  report_date     DATE NOT NULL,
  period_type     SMALLINT NOT NULL,
  raw_data        JSONB NOT NULL,
  fetched_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(site_id, report_date, period_type)
);

-- Tax collected
CREATE TABLE IF NOT EXISTS verifone.data_tax (
  id              BIGSERIAL PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES verifone.site_config(site_id),
  report_date     DATE NOT NULL,
  period_type     SMALLINT NOT NULL,
  raw_data        JSONB NOT NULL,
  fetched_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(site_id, report_date, period_type)
);

-- Network (payment method) totals
CREATE TABLE IF NOT EXISTS verifone.data_network (
  id              BIGSERIAL PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES verifone.site_config(site_id),
  report_date     DATE NOT NULL,
  period_type     SMALLINT NOT NULL,
  raw_data        JSONB NOT NULL,
  fetched_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(site_id, report_date, period_type)
);

-- Network totals (aggregate payment method)
CREATE TABLE IF NOT EXISTS verifone.data_network_totals (
  id              BIGSERIAL PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES verifone.site_config(site_id),
  report_date     DATE NOT NULL,
  period_type     SMALLINT NOT NULL,
  raw_data        JSONB NOT NULL,
  fetched_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(site_id, report_date, period_type)
);

-- Category sales
CREATE TABLE IF NOT EXISTS verifone.data_category (
  id              BIGSERIAL PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES verifone.site_config(site_id),
  report_date     DATE NOT NULL,
  period_type     SMALLINT NOT NULL,
  raw_data        JSONB NOT NULL,
  fetched_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(site_id, report_date, period_type)
);

-- Deal/combo sales
CREATE TABLE IF NOT EXISTS verifone.data_deal (
  id              BIGSERIAL PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES verifone.site_config(site_id),
  report_date     DATE NOT NULL,
  period_type     SMALLINT NOT NULL,
  raw_data        JSONB NOT NULL,
  fetched_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(site_id, report_date, period_type)
);

-- Car wash sales
CREATE TABLE IF NOT EXISTS verifone.data_carwash (
  id              BIGSERIAL PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES verifone.site_config(site_id),
  report_date     DATE NOT NULL,
  period_type     SMALLINT NOT NULL,
  raw_data        JSONB NOT NULL,
  fetched_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(site_id, report_date, period_type)
);

-- Transaction logs (from vperiodrept)
CREATE TABLE IF NOT EXISTS verifone.data_transaction_log (
  id              BIGSERIAL PRIMARY KEY,
  site_id         TEXT NOT NULL REFERENCES verifone.site_config(site_id),
  period_file     TEXT NOT NULL,
  report_date     DATE,
  raw_data        JSONB NOT NULL,
  fetched_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(site_id, period_file)
);

-- Sync ledger — resumable sync tracking
CREATE TABLE IF NOT EXISTS verifone.sync_ledger (
  site_id         TEXT NOT NULL REFERENCES verifone.site_config(site_id),
  endpoint        TEXT NOT NULL,            -- report type or 'period_list'
  status          TEXT NOT NULL DEFAULT 'pending', -- pending/running/done/failed
  last_period_file TEXT,
  last_report_date DATE,
  rows_synced     INTEGER DEFAULT 0,
  error           TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (site_id, endpoint)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_day_summary_site_date ON verifone.data_day_summary(site_id, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_shift_summary_site_date ON verifone.data_shift_summary(site_id, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_department_site_date ON verifone.data_department(site_id, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_plu_site_date ON verifone.data_plu(site_id, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_hourly_site_date ON verifone.data_hourly(site_id, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_txn_log_site_date ON verifone.data_transaction_log(site_id, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_sync_ledger_status ON verifone.sync_ledger(status);

-- ── Analytics Schema ─────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS verifone_analytics;
