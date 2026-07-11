import { Pool } from "@neondatabase/serverless";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { agentDataDir, repoRoot } from "./paths.js";

let _pool: Pool | null = null;

export function getPool(): Pool | null {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  const connectionString = url.replace(/sslmode=required\b/i, "sslmode=require");
  if (!_pool) _pool = new Pool({ connectionString });
  return _pool;
}

export interface AgentRow {
  id: string;
  owner_wallet: string;
  trading_wallet: string | null;
  display_name: string | null;
  status: string;
  runtime_url: string | null;
  runtime_port: number | null;
  config_version: number | null;
  pm2_name: string | null;
  process_phase: string | null;
  host_id: string | null;
}

/** Apply fleet schema extensions (idempotent). */
export async function ensureFleetSchema(): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  const schemaPath = resolve(repoRoot(), "neural-alpha/src/db/schema.sql");
  if (existsSync(schemaPath)) {
    await pool.query(readFileSync(schemaPath, "utf8"));
  }

  await pool.query(`
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS config_version INTEGER NOT NULL DEFAULT 0;
  `);
  await pool.query(`
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS host_id TEXT NOT NULL DEFAULT 'local';
  `);
  await pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS pm2_name TEXT`);
  await pool.query(
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_health_at TIMESTAMPTZ`
  );
  await pool.query(
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS process_phase TEXT`
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_events (
      id BIGSERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      detail JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_agent_events_agent ON agent_events(agent_id)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_agent_events_created ON agent_events(created_at DESC)`
  );
}

export async function getAgent(agentId: string): Promise<AgentRow | null> {
  const pool = getPool();
  if (!pool) return null;
  const { rows } = await pool.query<AgentRow>(
    `SELECT id, owner_wallet, trading_wallet, display_name, status,
            runtime_url, runtime_port, config_version, pm2_name,
            process_phase, host_id
     FROM agents WHERE id = $1`,
    [agentId]
  );
  return rows[0] ?? null;
}

export async function listActiveAgents(): Promise<AgentRow[]> {
  const pool = getPool();
  if (!pool) return [];
  const { rows } = await pool.query<AgentRow>(
    `SELECT id, owner_wallet, trading_wallet, display_name, status,
            runtime_url, runtime_port, config_version, pm2_name,
            process_phase, host_id
     FROM agents WHERE status NOT IN ('archived', 'pending')
     ORDER BY created_at ASC`
  );
  return rows;
}

export async function getAgentConfigMap(
  agentId: string
): Promise<Record<string, string>> {
  const pool = getPool();
  if (!pool) return {};
  const { rows } = await pool.query<{ key: string; value: string | null }>(
    `SELECT key, value FROM agent_config WHERE agent_id = $1`,
    [agentId]
  );
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.value != null && r.value !== "") out[r.key] = r.value;
  }
  return out;
}

export async function updateAgentRuntime(
  agentId: string,
  fields: {
    status?: string;
    runtime_port?: number;
    runtime_url?: string;
    pm2_name?: string;
    process_phase?: string;
    last_health_at?: Date;
  }
): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    sets.push(`${k} = $${i++}`);
    vals.push(v);
  }
  if (sets.length === 0) return;
  vals.push(agentId);
  await pool.query(
    `UPDATE agents SET ${sets.join(", ")} WHERE id = $${i}`,
    vals
  );
}

export async function recordEvent(
  agentId: string,
  eventType: string,
  detail?: Record<string, unknown>
): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO agent_events (agent_id, event_type, detail) VALUES ($1,$2,$3)`,
      [agentId, eventType, detail ? JSON.stringify(detail) : null]
    );
  } catch {
    /* non-fatal */
  }
}

export function readAgentApiPort(agentId: string): number | null {
  const portFile = join(agentDataDir(), agentId, "api-port");
  if (!existsSync(portFile)) return null;
  try {
    const port = parseInt(readFileSync(portFile, "utf8").trim(), 10);
    return Number.isFinite(port) && port > 1024 ? port : null;
  } catch {
    return null;
  }
}

export function readAgentPid(agentId: string): number | null {
  const pidFile = join(agentDataDir(), agentId, "pid");
  if (!existsSync(pidFile)) return null;
  try {
    const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
