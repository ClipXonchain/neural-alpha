import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertTenantId, DEFAULT_X402_PER_DAY, MAX_X402_PER_DAY, MIN_X402_PER_DAY, SWAP_PAYMENT_TOKEN, x402IntervalMs } from "./policy.mjs";

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

function x402PerDay(risk) {
  const n = Number(risk?.x402PerDay);
  return Number.isInteger(n) && n >= MIN_X402_PER_DAY && n <= MAX_X402_PER_DAY ? n : DEFAULT_X402_PER_DAY;
}

function flag(on) {
  return on === false ? "false" : "true";
}

function x402ScheduleLines(risk) {
  const perDay = x402PerDay(risk);
  const intervalMs = x402IntervalMs(perDay);
  return { perDay, intervalMs };
}

export function renderEnv(spec) {
  const halted = Boolean(spec.buysHalted);
  const minBuyIntervalMs = halted ? 315_360_000_000 : spec.risk.minBuyIntervalMs;
  const maxPositionUsd = halted ? 0 : spec.risk.maxPositionUsd;
  // Same ceiling as the position. Not a smaller off-hours cap. Zero only while buys are halted.
  const maxTradeUsd = halted ? 0 : spec.risk.maxTradeUsd;
  const lines = [
    `AGENT_MODE=${spec.agentMode}`,
    "BRIDGE_MODE=auto",
    "DASHBOARD_PORT=3847",
    "SQLITE_PATH=/data/book/neural-alpha.sqlite",
    "EXTERNAL_FLOWS_FILE=/data/book/external-flows.json",
    `TRADE_INTERVAL_MS=${spec.intervalMs}`,
    `PAYMENT_TOKEN=${SWAP_PAYMENT_TOKEN}`,
    `MIN_BUY_INTERVAL_MS=${minBuyIntervalMs}`,
    `MAX_POSITION_SIZE_USD=${maxPositionUsd}`,
    `HACKATHON_MAX_TRADE_USD=${maxTradeUsd}`,
    `X402_MIN_PAYMENTS_PER_DAY=${x402ScheduleLines(spec.risk).perDay}`,
    `CMC_X402_ENABLED=${flag(spec.signals?.cmc)}`,
    `STUDIO_X402_ENABLED=${flag(spec.signals ? spec.signals.studio : false)}`,
    `CMC_X402_INTERVAL_MS=${x402ScheduleLines(spec.risk).intervalMs}`,
    `STUDIO_X402_INTERVAL_MS=${x402ScheduleLines(spec.risk).intervalMs}`,
    "DISABLE_DRAWDOWN_LIMIT=true",
    `API_SECRET=${spec.apiSecret}`,
    "BINANCE_MARKET_CONCURRENCY=2",
    "BINANCE_KLINE_CONCURRENCY=2",
    `SAAS_START_DELAY_SEC=${spec.staggerSec}`,
  ];
  if (halted) lines.push("DISABLE_NEW_BUYS=true");
  if (spec.databaseUrl) lines.push(`DATABASE_URL=${spec.databaseUrl}`);
  return `${lines.join("\n")}\n`;
}

export function renderOverride(spec) {
  const path = spec.dataDir;
  if (path.includes("\n") || path.includes('"')) throw new Error("tenant path cannot be quoted safely");
  const halted = Boolean(spec.buysHalted);
  const minBuyIntervalMs = halted ? 315_360_000_000 : spec.risk.minBuyIntervalMs;
  const maxPositionUsd = halted ? 0 : spec.risk.maxPositionUsd;
  const maxTradeUsd = halted ? 0 : spec.risk.maxTradeUsd;
  const image = /^[A-Za-z0-9_.-]{1,64}$/.test(spec.imageTag || "") ? `\n    image: neural-saas-worker:${spec.imageTag}` : "";
  return `services:
  worker:
    container_name: ${spec.containerName}${image}
    volumes:
      - "${path}:/data:rw"
    environment:
      AGENT_MODE: "${spec.agentMode}"
      HOME: /data/home
      DASHBOARD_PORT: "3847"
      PAYMENT_TOKEN: "${SWAP_PAYMENT_TOKEN}"
      SAAS_START_DELAY_SEC: "${spec.staggerSec}"
      TRADE_INTERVAL_MS: "${spec.intervalMs}"
      MIN_BUY_INTERVAL_MS: "${minBuyIntervalMs}"
      MAX_POSITION_SIZE_USD: "${maxPositionUsd}"
      HACKATHON_MAX_TRADE_USD: "${maxTradeUsd}"
      X402_MIN_PAYMENTS_PER_DAY: "${x402ScheduleLines(spec.risk).perDay}"
      CMC_X402_ENABLED: "${flag(spec.signals?.cmc)}"
      STUDIO_X402_ENABLED: "${flag(spec.signals ? spec.signals.studio : false)}"
      CMC_X402_INTERVAL_MS: "${x402ScheduleLines(spec.risk).intervalMs}"
      STUDIO_X402_INTERVAL_MS: "${x402ScheduleLines(spec.risk).intervalMs}"
      DISABLE_DRAWDOWN_LIMIT: "true"
      DISABLE_NEW_BUYS: "${halted ? "true" : "false"}"
      API_SECRET: "${spec.apiSecret}"
      BINANCE_MARKET_CONCURRENCY: "2"
      BINANCE_KLINE_CONCURRENCY: "2"
    restart: unless-stopped
`;
}
