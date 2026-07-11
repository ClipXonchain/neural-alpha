import "server-only";
import { Pool } from "@neondatabase/serverless";
import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { getServerEnv, isNextProductionBuild } from "./server-env";

let _pool: Pool | null = null;
let _initPromise: Promise<void> | null = null;
let _reconcileStarted = false;

function scheduleRuntimeReconcile() {
  if (_reconcileStarted || isNextProductionBuild()) return;
  _reconcileStarted = true;
  void import("./platform-registry")
    .then((m) => m.reconcileAgentRuntime())
    .catch((err) => console.warn("Agent runtime reconcile failed", err));
}

export function getPlatformPool(): Pool | null {
  const url = getServerEnv("DATABASE_URL");
  if (!url) return null;
  // Neon expects sslmode=require (not "required")
  const connectionString = url.replace(/sslmode=required\b/i, "sslmode=require");
  if (!_pool) _pool = new Pool({ connectionString });
  return _pool;
}

/** Apply agent + platform schema (idempotent). */
export async function ensurePlatformSchema(): Promise<boolean> {
  const pool = getPlatformPool();
  if (!pool) return false;
  if (_initPromise) {
    await _initPromise;
    return true;
  }
  _initPromise = (async () => {
    const candidates = [
      resolve(process.cwd(), "../neural-alpha/src/db/schema.sql"),
      resolve(process.cwd(), "neural-alpha/src/db/schema.sql"),
      join(process.cwd(), "..", "neural-alpha", "src", "db", "schema.sql"),
    ];
    const path = candidates.find((p) => existsSync(p));
    if (!path) {
      // Minimal platform tables if schema file not found
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          wallet_address TEXT PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_login TIMESTAMPTZ
        );
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          owner_wallet TEXT NOT NULL,
          trading_wallet TEXT,
          display_name TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          erc8004_agent_id TEXT,
          agent_number SERIAL,
          api_secret_hash TEXT,
          runtime_url TEXT,
          runtime_port INTEGER,
          public_meta BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deployed_at TIMESTAMPTZ
        );
        CREATE TABLE IF NOT EXISTS agent_config (
          agent_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT,
          is_secret BOOLEAN NOT NULL DEFAULT false,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (agent_id, key)
        );
        CREATE TABLE IF NOT EXISTS deployments (
          id BIGSERIAL PRIMARY KEY,
          agent_id TEXT NOT NULL,
          container_id TEXT,
          host TEXT,
          port INTEGER,
          fee_tx_hash TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS audit_log (
          id BIGSERIAL PRIMARY KEY,
          agent_id TEXT,
          owner_wallet TEXT,
          action TEXT NOT NULL,
          payload JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_deployments_fee_tx_unique
          ON deployments (LOWER(fee_tx_hash))
          WHERE fee_tx_hash IS NOT NULL
            AND fee_tx_hash <> ''
            AND fee_tx_hash !~* '^0x0+$';
      `);
      return;
    }
    const schema = readFileSync(path, "utf8");
    await pool.query(schema);
    // Ensure fee-tx unique index even on older DBs that already had schema applied
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_deployments_fee_tx_unique
        ON deployments (LOWER(fee_tx_hash))
        WHERE fee_tx_hash IS NOT NULL
          AND fee_tx_hash <> ''
          AND fee_tx_hash !~* '^0x0+$';
    `);
    // Fleet columns + events (idempotent for existing DBs)
    for (const sql of [
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS config_version INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS host_id TEXT NOT NULL DEFAULT 'local'`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS pm2_name TEXT`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_health_at TIMESTAMPTZ`,
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS process_phase TEXT`,
      `CREATE TABLE IF NOT EXISTS agent_events (
        id BIGSERIAL PRIMARY KEY,
        agent_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        detail JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_agent_events_agent ON agent_events(agent_id)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_events_created ON agent_events(created_at DESC)`,
    ]) {
      await pool.query(sql);
    }
  })();
  await _initPromise;
  scheduleRuntimeReconcile();
  return true;
}
