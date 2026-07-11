import "server-only";
import { createHmac } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getPlatformPool } from "./platform-db";
import { getServerEnv } from "./server-env";

const DEV_SESSION_FALLBACK = "dev-only-session-secret-change-me-32chars!!";

/** Per-agent API secret derived from platform master (deterministic). */
export function deriveAgentApiSecret(agentId: string): string {
  const master = requireWalletMasterSecret();
  return createHmac("sha256", master)
    .update(`api-secret:${agentId}`)
    .digest("hex");
}

export function requireWalletMasterSecret(): string {
  const secret = getServerEnv("WALLET_MASTER_SECRET");
  if (!secret) {
    throw new Error("WALLET_MASTER_SECRET is required");
  }
  return secret;
}

export function requireSessionSecret(): string {
  const secret =
    getServerEnv("SESSION_SECRET") || getServerEnv("NEXTAUTH_SECRET");
  const isProd = process.env.NODE_ENV === "production";

  if (isProd) {
    if (!secret || secret.length < 32) {
      throw new Error(
        "SESSION_SECRET (min 32 characters) is required in production"
      );
    }
    if (secret === DEV_SESSION_FALLBACK) {
      throw new Error("SESSION_SECRET must not use the dev default in production");
    }
    return secret;
  }

  return (
    secret ||
    process.env.SESSION_SECRET?.trim() ||
    process.env.NEXTAUTH_SECRET?.trim() ||
    DEV_SESSION_FALLBACK
  );
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Resolve API secret for proxy / hot-reload (DB → agent .env → derived). */
export async function getAgentApiSecret(
  agentId: string
): Promise<string | undefined> {
  const pool = getPlatformPool();
  if (pool) {
    const { rows } = await pool.query<{ value: string | null }>(
      `SELECT value FROM agent_config WHERE agent_id = $1 AND key = 'API_SECRET' LIMIT 1`,
      [agentId]
    );
    if (rows[0]?.value?.trim()) return rows[0].value.trim();
  }

  const fromEnv = readApiSecretFromAgentEnv(agentId);
  if (fromEnv) return fromEnv;

  try {
    return deriveAgentApiSecret(agentId);
  } catch {
    return getServerEnv("API_SECRET");
  }
}

function readApiSecretFromAgentEnv(agentId: string): string | undefined {
  const dataDir =
    getServerEnv("AGENT_DATA_DIR") ||
    join(process.cwd(), "..", "data", "agents");
  const envPath = join(dataDir, agentId, ".env");
  if (!existsSync(envPath)) return undefined;
  try {
    const text = readFileSync(envPath, "utf8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("API_SECRET=")) continue;
      return t.slice("API_SECRET=".length).trim();
    }
  } catch {
    /* ignore */
  }
  return undefined;
}
