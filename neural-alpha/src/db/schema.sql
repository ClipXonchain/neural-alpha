-- Neural Alpha persistence schema (Neon Postgres)
-- Applied automatically on agent start when DATABASE_URL is set.

CREATE TABLE IF NOT EXISTS trades (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  amount_usd DOUBLE PRECISION NOT NULL,
  from_token TEXT NOT NULL,
  to_token TEXT NOT NULL,
  from_amount TEXT,
  to_amount TEXT,
  price_usd DOUBLE PRECISION,
  tx_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed', 'paper')),
  error_message TEXT,
  twak_response JSONB,
  realized_pnl DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ
);

-- Wallet that executed the trade — scopes "Recent Trades" to the active wallet
-- so a shared DATABASE_URL never mixes activity from other wallets/agents.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS wallet_address TEXT;

CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_wallet ON trades(LOWER(wallet_address));

CREATE TABLE IF NOT EXISTS nav_snapshots (
  id BIGSERIAL PRIMARY KEY,
  cycle_id INTEGER,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cash_usd DOUBLE PRECISION NOT NULL,
  gas_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  positions_json JSONB NOT NULL DEFAULT '[]',
  total_nav_usd DOUBLE PRECISION NOT NULL,
  peak_nav_usd DOUBLE PRECISION NOT NULL,
  drawdown_pct DOUBLE PRECISION NOT NULL,
  total_pnl_usd DOUBLE PRECISION,
  total_pnl_pct DOUBLE PRECISION,
  mode TEXT NOT NULL DEFAULT 'live'
);

CREATE INDEX IF NOT EXISTS idx_nav_snapshots_timestamp ON nav_snapshots(timestamp DESC);

-- Extended per-cycle agent stats (added incrementally; safe on existing tables).
ALTER TABLE nav_snapshots ADD COLUMN IF NOT EXISTS realized_pnl DOUBLE PRECISION;
ALTER TABLE nav_snapshots ADD COLUMN IF NOT EXISTS daily_pnl DOUBLE PRECISION;
ALTER TABLE nav_snapshots ADD COLUMN IF NOT EXISTS positions_count INTEGER;
ALTER TABLE nav_snapshots ADD COLUMN IF NOT EXISTS total_trades INTEGER;
ALTER TABLE nav_snapshots ADD COLUMN IF NOT EXISTS today_trades INTEGER;
ALTER TABLE nav_snapshots ADD COLUMN IF NOT EXISTS win_rate DOUBLE PRECISION;
ALTER TABLE nav_snapshots ADD COLUMN IF NOT EXISTS fear_greed INTEGER;
ALTER TABLE nav_snapshots ADD COLUMN IF NOT EXISTS emergency_mode BOOLEAN;

CREATE TABLE IF NOT EXISTS chain_syncs (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  holdings_json JSONB NOT NULL DEFAULT '{}',
  usdt_balance DOUBLE PRECISION NOT NULL,
  positions_added TEXT[] DEFAULT '{}',
  positions_removed TEXT[] DEFAULT '{}',
  gas_symbol TEXT,
  gas_amount DOUBLE PRECISION,
  gas_usd DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS idx_chain_syncs_timestamp ON chain_syncs(timestamp DESC);

CREATE TABLE IF NOT EXISTS agent_state (
  key TEXT PRIMARY KEY,
  value_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
