import "./load-env.js";
import { TradingAgent } from "./agent.js";
import { createBridge } from "./integrations/create-bridge.js";
import { closeTwakMcpBridge } from "./integrations/twak-mcp-bridge.js";
import { logger } from "./utils/logger.js";
import { initAgentStore } from "./db/store.js";
import { startDashboard } from "./web/server.js";

/**
 * Neural Alpha — Autonomous Trading Agent
 *
 * Data: CoinMarketCap Agent Hub via x402 (TWAK x402_request)
 * Execution: TWAK MCP (swap, risk checks, wallet)
 * Monitor: Web dashboard on DASHBOARD_PORT
 *
 * CMC Agent Hub setup: https://coinmarketcap.com/api/agent/#dev-steps
 *   1. TWAK MCP server: `twak serve` (or BRIDGE_MODE=mock for offline paper)
 *   2. Agent pays per CMC request via x402_request → quotes, trending, F&G
 *
 * Usage:
 *   AGENT_MODE=paper npm run agent        # Paper trading (default)
 *   AGENT_MODE=live  npm run agent        # Live trading on BSC
 *   BRIDGE_MODE=twak npm run agent        # Force real TWAK + CMC x402
 *
 * Environment:
 *   AGENT_MODE              - "paper" or "live" (default: paper)
 *   BRIDGE_MODE             - "auto" | "twak" | "mock" (default: auto)
 *   TWAK_MCP_COMMAND        - MCP server binary (default: twak)
 *   TWAK_MCP_ARGS           - MCP server args (default: serve)
 *   CMC_X402_BASE_URL       - CMC Agent Hub base URL
 *   CMC_X402_MAX_PAYMENT    - Max micropayment per request in USDC atomic units (default: 10000 = 0.01)
 *   CMC_X402_PREFER_NETWORK - x402 payment network (default: bsc)
 *   TRADE_INTERVAL_MS         - Full cycle interval in ms (buys + scans)
 *   PROTECTIVE_EXIT_CHECK_MS  - SL/TP/trailing check interval (default 60s)
 *   DASHBOARD_PORT            - Web UI port (default: 3847)
 */

// Prevent TWAK stdio transport EPIPE from crashing the process on hot reload.
process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (
    err.code === "EPIPE" ||
    err.code === "ERR_STREAM_DESTROYED" ||
    /write EPIPE|broken pipe/i.test(String(err.message ?? err))
  ) {
    logger.warn("Pipe error (TWAK transport) — suppressed", { code: err.code });
    return;
  }
  if (err.code === "EADDRINUSE") {
    logger.warn("Port in use — handled by server retry logic", { code: err.code });
    return;
  }
  logger.error("Uncaught exception", { error: String(err) });
  process.exit(1);
});

async function main() {
  const mode = process.env.AGENT_MODE || "paper";
  const dashPort = process.env.DASHBOARD_PORT || "3847";
  const initialCash = parseFloat(process.env.INITIAL_CASH_USD || "1000");

  console.log(`
\x1b[1;33m╔══════════════════════════════════════════════════════════╗
║   Neural Alpha — Autonomous BSC Trading Agent           ║
║   CMC Agent Hub (x402) → Strategy → TWAK → BSC          ║
╚══════════════════════════════════════════════════════════╝\x1b[0m
`);

  const hasCmcKey = !!process.env.CMC_PRO_API_KEY?.trim();

  logger.info("Starting agent", {
    mode,
    bridgeMode: process.env.BRIDGE_MODE || "auto",
    cmcProApiKey: hasCmcKey ? "set" : "not set",
    initialCash,
    dashboardPort: dashPort,
    logLevel: process.env.LOG_LEVEL || "info",
    cmcX402Base: process.env.CMC_X402_BASE_URL || "https://agenthub.coinmarketcap.com",
    tradeInterval: process.env.TRADE_INTERVAL_MS || "(mode default)",
  });

  if (mode === "paper") {
    logger.info("PAPER mode — swaps simulated");
  } else {
    logger.info("LIVE mode — requires TWAK MCP (`twak serve`) with funded wallet");
  }

  if (!hasCmcKey) {
    logger.warn("CMC_PRO_API_KEY not set — will use x402 (needs TWAK) or fall back to mock data");
  }

  const { bridge, source } = await createBridge(mode);
  logger.info("Bridge ready", {
    source,
    cmcIntegration: "https://coinmarketcap.com/api/agent/#dev-steps",
  });

  await initAgentStore();

  const agent = new TradingAgent(bridge, initialCash, source);
  startDashboard(agent);

  let shuttingDown = false;
  const gracefulShutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal} — shutting down gracefully`);
    agent.stop();
    void closeTwakMcpBridge()
      .catch(() => undefined)
      .finally(() => {
        setTimeout(() => process.exit(0), 100).unref();
      });
    setTimeout(() => {
      logger.warn("Graceful shutdown timeout — forcing exit");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  await agent.start();

  const portfolio = agent.getPortfolio();
  const trades = portfolio.getTradeHistory();
  const snapshots = portfolio.getSnapshots();

  logger.info("Agent loop finished", {
    totalTrades: trades.length,
    successful: trades.filter((t) => t.success).length,
    finalValue: snapshots.length > 0 ? snapshots[snapshots.length - 1].totalValueUsd : 0,
  });
}

main().catch((err) => {
  logger.error("Fatal error", { error: String(err) });
  process.exit(1);
});
