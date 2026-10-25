import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertTenantId } from "./policy.mjs";

export function tenantDir(root, id) {
  assertTenantId(id);
  const base = resolve(root);
  const dir = resolve(base, id);
  if (dir !== join(base, id)) throw new Error("tenant path escapes the data root");
  return dir;
}

export function writeTenantFiles(dir, spec) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tenant.env"), renderEnv(spec), { mode: 0o600 });
  writeFileSync(join(dir, "override.yml"), renderOverride(spec), "utf8");
}

export function renderEnv(spec) {
  const lines = [
    `AGENT_MODE=${spec.agentMode}`,
    "PAYMENT_TOKEN=USDT",
    "BRIDGE_MODE=auto",
    "DASHBOARD_PORT=3847",
    "SQLITE_PATH=/data/book/neural-alpha.sqlite",
    "EXTERNAL_FLOWS_FILE=/data/book/external-flows.json",
    `TRADE_INTERVAL_MS=${spec.intervalMs}`,
    `MIN_BUY_INTERVAL_MS=${spec.risk.minBuyIntervalMs}`,
    `MAX_POSITION_SIZE_USD=${spec.risk.maxPositionUsd}`,
    `MAX_DRAWDOWN_PCT=${spec.risk.maxDrawdownPct}`,
    `HACKATHON_MAX_TRADE_USD=${spec.risk.maxTradeUsd}`,
    "DISABLE_DRAWDOWN_LIMIT=false",
    "BINANCE_MARKET_CONCURRENCY=2",
    "BINANCE_KLINE_CONCURRENCY=2",
    `SAAS_START_DELAY_SEC=${spec.staggerSec}`,
  ];
  if (spec.databaseUrl) lines.push(`DATABASE_URL=${spec.databaseUrl}`);
  return `${lines.join("\n")}\n`;
}

export function renderOverride(spec) {
  const path = spec.dataDir;
  if (path.includes("\n") || path.includes('"')) throw new Error("tenant path cannot be quoted safely");
  return `services:
  worker:
    container_name: ${spec.containerName}
    volumes:
      - "${path}:/data:rw"
    environment:
      AGENT_MODE: "${spec.agentMode}"
      HOME: /data/home
      DASHBOARD_PORT: "3847"
      SAAS_START_DELAY_SEC: "${spec.staggerSec}"
      TRADE_INTERVAL_MS: "${spec.intervalMs}"
      MIN_BUY_INTERVAL_MS: "${spec.risk.minBuyIntervalMs}"
      MAX_POSITION_SIZE_USD: "${spec.risk.maxPositionUsd}"
      MAX_DRAWDOWN_PCT: "${spec.risk.maxDrawdownPct}"
      HACKATHON_MAX_TRADE_USD: "${spec.risk.maxTradeUsd}"
      DISABLE_DRAWDOWN_LIMIT: "false"
      BINANCE_MARKET_CONCURRENCY: "2"
      BINANCE_KLINE_CONCURRENCY: "2"
    networks:
      - neural-saas
    restart: unless-stopped
`;
}
