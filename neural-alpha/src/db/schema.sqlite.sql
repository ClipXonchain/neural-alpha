-- Neural Alpha local database (SQLite). This file is the live store.
-- Neon receives an hourly copy; the agent does not read from Neon.

PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  amount_usd REAL NOT NULL,
  from_token TEXT NOT NULL,
  to_token TEXT NOT NULL,
  from_amount TEXT,
  to_amount TEXT,
  price_usd REAL,
  tx_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed', 'paper')),
  error_message TEXT,
  twak_response TEXT,
  realized_pnl REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  confirmed_at TEXT,
  wallet_address TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_wallet ON trades(wallet_address);
CREATE INDEX IF NOT EXISTS idx_trades_updated ON trades(updated_at, id);

CREATE TABLE IF NOT EXISTS nav_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  cash_usd REAL NOT NULL,
  gas_usd REAL NOT NULL DEFAULT 0,
  positions_json TEXT NOT NULL DEFAULT '[]',
  total_nav_usd REAL NOT NULL,
  peak_nav_usd REAL NOT NULL,
  drawdown_pct REAL NOT NULL,
  total_pnl_usd REAL,
  total_pnl_pct REAL,
  mode TEXT NOT NULL DEFAULT 'live',
  realized_pnl REAL,
  daily_pnl REAL,
  positions_count INTEGER,
  total_trades INTEGER,
  today_trades INTEGER,
  win_rate REAL,
  fear_greed INTEGER,
  emergency_mode INTEGER
);

CREATE INDEX IF NOT EXISTS idx_nav_snapshots_timestamp ON nav_snapshots(timestamp DESC);

CREATE TABLE IF NOT EXISTS chain_syncs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  holdings_json TEXT NOT NULL DEFAULT '{}',
  usdt_balance REAL NOT NULL,
  positions_added TEXT NOT NULL DEFAULT '[]',
  positions_removed TEXT NOT NULL DEFAULT '[]',
  gas_symbol TEXT,
  gas_amount REAL,
  gas_usd REAL
);

CREATE INDEX IF NOT EXISTS idx_chain_syncs_timestamp ON chain_syncs(timestamp DESC);

CREATE TABLE IF NOT EXISTS agent_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Hourly Neon backup progress. Not copied to Neon.
CREATE TABLE IF NOT EXISTS backup_cursor (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
