import { createHmac } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  getAgent,
  getAgentConfigMap,
  readAgentApiPort,
  updateAgentRuntime,
} from "./db.js";
import { agentDataDir, agentDir, agentPm2Name } from "./paths.js";

function rpcUrl(): string {
  return (
    process.env.BSC_RPC_URL?.trim() ||
    process.env.RPC_URL?.trim() ||
    "https://bsc-dataseed.binance.org"
  );
}

function requireWalletMasterSecret(): string {
  const secret = process.env.WALLET_MASTER_SECRET?.trim();
  if (!secret) throw new Error("WALLET_MASTER_SECRET is required");
  return secret;
}

function deriveAgentApiSecret(agentId: string): string {
  return createHmac("sha256", requireWalletMasterSecret())
    .update(`api-secret:${agentId}`)
    .digest("hex");
}

/** Materialize spawn env from DB + platform secrets. */
export async function buildSpawnEnv(
  agentId: string
): Promise<Record<string, string>> {
  const agent = await getAgent(agentId);
  if (!agent) throw new Error("Agent not found");

  const cfg = await getAgentConfigMap(agentId);
  const port =
    agent.runtime_port ?? readAgentApiPort(agentId) ?? 4000;
  const apiSecret = cfg.API_SECRET || deriveAgentApiSecret(agentId);

  return {
    AGENT_ID: agentId,
    AGENT_MODE: "live",
    BRIDGE_MODE: "evm",
    DASHBOARD_PORT: String(port),
    API_SECRET: apiSecret,
    AGENT_DATA_DIR: agentDataDir(),
    AGENT_WALLET_ADDRESS: agent.trading_wallet || "",
    AGENT_DISPLAY_NAME:
      agent.display_name || `Agent ${agentId.slice(0, 8)}`,
    OWNER_WALLET: agent.owner_wallet,
    PUBLIC_BASE_URL:
      process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") ||
      `http://127.0.0.1:${port}`,
    CMC_PRO_API_KEY:
      process.env.CMC_PRO_API_KEY || process.env.CMC_API_KEY || "",
    BINANCE_WEB3_API_KEY: process.env.BINANCE_WEB3_API_KEY || "",
    BINANCE_WEB3_API_SECRET: process.env.BINANCE_WEB3_API_SECRET || "",
    MARKET_FEED_URL:
      process.env.MARKET_FEED_URL || "http://127.0.0.1:4100",
    DATABASE_URL: process.env.DATABASE_URL || "",
    BSC_RPC_URL: rpcUrl(),
    ...cfg,
  };
}

/** Write human-readable mirror (no WALLET_MASTER_SECRET). */
export function writeEnvMirror(
  agentId: string,
  env: Record<string, string>
): void {
  const dir = agentDir(agentId);
  mkdirSync(dir, { recursive: true });
  const lines = Object.entries(env)
    .filter(([k, v]) => v !== "" && k !== "WALLET_MASTER_SECRET")
    .map(([k, v]) => `${k}=${v}`);
  writeFileSync(join(dir, ".env"), lines.join("\n") + "\n", { mode: 0o600 });
}

export async function syncRuntimeFromDisk(agentId: string): Promise<number | null> {
  const diskPort = readAgentApiPort(agentId);
  if (!diskPort) return null;
  const url = `http://127.0.0.1:${diskPort}`;
  await updateAgentRuntime(agentId, {
    runtime_port: diskPort,
    runtime_url: url,
    pm2_name: agentPm2Name(agentId),
  });
  return diskPort;
}

export { requireWalletMasterSecret, agentPm2Name };
