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
ALTER TABLE nav_snapshots ADD COLUMN IF NOT EXISTS agent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_nav_snapshots_agent ON nav_snapshots(agent_id);

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
ALTER TABLE chain_syncs ADD COLUMN IF NOT EXISTS agent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_chain_syncs_agent ON chain_syncs(agent_id);

CREATE TABLE IF NOT EXISTS agent_state (
  key TEXT PRIMARY KEY,
  value_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE trades ADD COLUMN IF NOT EXISTS agent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_trades_agent ON trades(agent_id);

-- ── Platform multi-tenant registry ──
CREATE TABLE IF NOT EXISTS users (
  wallet_address TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  owner_wallet TEXT NOT NULL REFERENCES users(wallet_address),
  trading_wallet TEXT,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'provisioning', 'running', 'stopped', 'archived', 'failed')),
  erc8004_agent_id TEXT,
  agent_number SERIAL,
  api_secret_hash TEXT,
  runtime_url TEXT,
  runtime_port INTEGER,
  public_meta BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deployed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(LOWER(owner_wallet));
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

CREATE TABLE IF NOT EXISTS agent_config (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  is_secret BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, key)
);

CREATE TABLE IF NOT EXISTS deployments (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  container_id TEXT,
  host TEXT,
  port INTEGER,
  fee_tx_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deployments_agent ON deployments(agent_id);

-- Prevent fee-tx replay (skip zero-hash used in fee-skip / dev)
CREATE UNIQUE INDEX IF NOT EXISTS idx_deployments_fee_tx_unique
  ON deployments (LOWER(fee_tx_hash))
  WHERE fee_tx_hash IS NOT NULL
    AND fee_tx_hash <> ''
    AND fee_tx_hash !~* '^0x0+$';

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT,
  owner_wallet TEXT,
  action TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_owner ON audit_log(LOWER(owner_wallet));
