import "./load-env.js";
import { TradingAgent } from "./agent.js";
import { createBridge } from "./integrations/create-bridge.js";
import { ensureBinanceAlphaTokensLoaded } from "./integrations/binance-alpha-tokens.js";
import { logger } from "./utils/logger.js";
import { initAgentStore } from "./db/store.js";
import { startDashboard } from "./web/server.js";
import { assertAgentProductionSecrets } from "./utils/production-guards.js";
import { getAgentId } from "./wallet/index.js";

/**
 * Neural Alpha — Autonomous Trading Agent
 *
 * Data: CoinMarketCap Pro API
 * Execution: Self-custodial EVM wallet (viem + Binance Web3 aggregator)
 * Monitor: Web dashboard on DASHBOARD_PORT
 *
 * Usage:
 *   npm run agent                        # Live trading on BSC (default)
 *   BRIDGE_MODE=evm npm run agent        # Force self-custodial wallet
 *
 * Environment:
 *   BRIDGE_MODE             - "auto" | "evm" | "cmc-pro" | "mock"
 *   AGENT_ID                - Tenant id (default: "default")
 *   WALLET_MASTER_SECRET    - Encrypts per-agent keystores
 *   CMC_PRO_API_KEY         - CoinMarketCap Pro API key
 *   TRADE_INTERVAL_MS       - Full cycle interval (default: 60 min)
 *   DASHBOARD_PORT          - Agent API port (default: 3847)
 */

process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    logger.warn("Port in use — handled by server retry logic", { code: err.code });
    return;
  }
  logger.error("Uncaught exception", { error: String(err) });
  process.exit(1);
});

async function main() {
  if (process.env.AGENT_MODE && process.env.AGENT_MODE !== "live") {
    logger.warn("AGENT_MODE is ignored — only live BSC execution is supported", {
      requested: process.env.AGENT_MODE,
    });
  }

  const dashPort = process.env.DASHBOARD_PORT || "3847";
  const initialCash = parseFloat(process.env.INITIAL_CASH_USD || "0");
  assertAgentProductionSecrets();

  const agentId = getAgentId();

  console.log(`
\x1b[1;33m╔══════════════════════════════════════════════════════════╗
║   Neural Alpha — Autonomous BSC Trading Agent           ║
║   CMC Pro → Strategy → Self-Custodial Wallet → BSC      ║
╚══════════════════════════════════════════════════════════╝\x1b[0m
`);

  const hasCmcKey = !!process.env.CMC_PRO_API_KEY?.trim();

  logger.info("Starting agent", {
    agentId,
    mode: "live",
    bridgeMode: process.env.BRIDGE_MODE || "auto",
    cmcProApiKey: hasCmcKey ? "set" : "not set",
    initialCash,
    dashboardPort: dashPort,
    logLevel: process.env.LOG_LEVEL || "info",
    tradeInterval: process.env.TRADE_INTERVAL_MS || "3600000",
  });

  logger.info("LIVE mode — self-custodial EVM wallet + Binance Web3 aggregator on BSC");

  if (!hasCmcKey) {
    logger.warn("CMC_PRO_API_KEY not set — will fall back to mock market data");
  }

  const { bridge, source } = await createBridge();
  logger.info("Bridge ready", { source });

  await ensureBinanceAlphaTokensLoaded();

  await initAgentStore();

  const agent = new TradingAgent(bridge, initialCash, source);
  startDashboard(agent);

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal} — shutting down`);
    agent.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await agent.start();
}

main().catch((err) => {
  logger.error("Fatal startup error", { error: String(err) });
  process.exit(1);
});
