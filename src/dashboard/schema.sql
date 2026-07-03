-- OpenCode Quota Dashboard - Historical Tracking Schema
-- Version: 1.0
-- Created: 2026-07-03

-- Quota snapshots (captured every 5 minutes)
CREATE TABLE IF NOT EXISTS quota_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,           -- 'anthropic', 'openai', 'deepseek', etc.
  captured_at INTEGER NOT NULL,     -- Unix timestamp (ms)
  quota_data TEXT NOT NULL,         -- JSON blob from provider API
  UNIQUE(provider, captured_at)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_provider_time 
  ON quota_snapshots(provider, captured_at);

-- Usage aggregated by day and model
CREATE TABLE IF NOT EXISTS usage_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  date TEXT NOT NULL,               -- YYYY-MM-DD
  model TEXT,                       -- 'claude-3-5-sonnet-20241022', 'gpt-4o', etc.
  tokens_input INTEGER DEFAULT 0,
  tokens_output INTEGER DEFAULT 0,
  tokens_cache INTEGER DEFAULT 0,   -- Cache read tokens (Claude only)
  cost_usd REAL DEFAULT 0.0,
  request_count INTEGER DEFAULT 0,
  UNIQUE(provider, date, model)
);

CREATE INDEX IF NOT EXISTS idx_usage_provider_date 
  ON usage_history(provider, date);

-- Weekly reset history (when quota windows reset)
CREATE TABLE IF NOT EXISTS weekly_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  reset_at INTEGER NOT NULL,        -- Unix timestamp (ms)
  quota_used REAL,                  -- % used at reset time
  quota_remaining REAL,             -- % remaining
  quota_limit REAL,                 -- Absolute limit (credits, requests, etc.)
  reset_type TEXT,                  -- '5hour', '7day', 'monthly'
  UNIQUE(provider, reset_at, reset_type)
);

CREATE INDEX IF NOT EXISTS idx_resets_provider_time 
  ON weekly_resets(provider, reset_at);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_version (version, applied_at) 
VALUES (1, strftime('%s', 'now') * 1000);
