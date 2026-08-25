import "./load-env.js";
import { TradingAgent } from "./agent.js";
import { createBridge } from "./integrations/create-bridge.js";
import { logger } from "./utils/logger.js";
import { initAgentStore } from "./db/store.js";
import { startDashboard } from "./web/server.js";

/**
 * Neural Alpha — Autonomous bStock trading agent
 *
 * Data: Binance Web3 bStock quotes + CMC (sentiment / campaign x402)
 * Execution: Binance Agentic Wallet (`baw market-order swap`) on BSC
 * Campaign: bStock AI-Powered PnL Contest (Aug 17 – Sep 1 2026 UTC)
 *
 * Usage:
 *   AGENT_MODE=paper npm run agent
 *   AGENT_MODE=live  npm run agent
 *   BRIDGE_MODE=baw  npm run agent
 */

process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (
    err.code === "EPIPE" ||
    err.code === "ERR_STREAM_DESTROYED" ||
    /write EPIPE|broken pipe/i.test(String(err.message ?? err))
  ) {
    logger.warn("Pipe error — suppressed", { code: err.code });
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
║   Neural Alpha — Agentic Wallet bStock Agent            ║
║   CMC + Agent Studio (x402) → Strategy → baw → BSC      ║
╚══════════════════════════════════════════════════════════╝\x1b[0m
`);

  const hasCmcKey = !!process.env.CMC_PRO_API_KEY?.trim();

  logger.info("Starting agent", {
    mode,
    bridgeMode: process.env.BRIDGE_MODE || "auto",
    cmcProApiKey: hasCmcKey ? "set" : "not set",
    paymentToken: process.env.PAYMENT_TOKEN || "USDT",
    initialCash,
    dashboardPort: dashPort,
    logLevel: process.env.LOG_LEVEL || "info",
    tradeInterval: process.env.TRADE_INTERVAL_MS || "(mode default)",
  });

  if (mode === "paper") {
    logger.info("PAPER mode — swaps simulated");
  } else {
    logger.info("LIVE mode — requires Binance Agentic Wallet (`baw`) signed in with funded BSC wallet");
  }

  const { bridge, source } = await createBridge(mode);
  logger.info("Bridge ready", { source });

  await initAgentStore();

  const agent = new TradingAgent(bridge, initialCash, source);
  startDashboard(agent);

  let shuttingDown = false;
  const gracefulShutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal} — shutting down gracefully`);
    agent.stop();
    setTimeout(() => process.exit(0), 100).unref();
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
