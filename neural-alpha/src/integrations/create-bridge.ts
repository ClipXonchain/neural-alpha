import type { McpBridge } from "../agent.js";
import { logger } from "../utils/logger.js";
import { createMockBridge } from "./mock-bridge.js";
import { createCmcProBridge } from "./cmc-pro-bridge.js";
import { createEvmWalletBridge } from "./evm-wallet-bridge.js";

export type BridgeSource =
  | "evm"
  | "evm+cmc-pro"
  | "cmc-pro"
  | "mock"
  | "mock-fallback";

export interface BridgeHandle {
  bridge: McpBridge;
  source: BridgeSource;
}

/**
 * Hybrid: CMC Pro for market data, self-custodial EVM wallet for execution.
 */
function createHybridBridge(evmBridge: McpBridge, cmcApiKey: string): McpBridge {
  const cmcBridge = createCmcProBridge(cmcApiKey);

  return {
    getTokenPrice: cmcBridge.getTokenPrice,
    x402Request: cmcBridge.x402Request,
    getTrendingTokens: cmcBridge.getTrendingTokens,

    getWalletBalance: evmBridge.getWalletBalance,
    getSwapQuote: evmBridge.getSwapQuote,
    executeSwap: evmBridge.executeSwap,
    getAddress: evmBridge.getAddress,
    checkTokenRisk: evmBridge.checkTokenRisk,
    getStablecoinBalance: evmBridge.getStablecoinBalance,
    getTokenBalance: evmBridge.getTokenBalance,
    getPortfolio: evmBridge.getPortfolio,
    getWalletStatus: evmBridge.getWalletStatus,
  };
}

/**
 * Select data/execution bridge.
 *
 * BRIDGE_MODE:
 *   - auto    → CMC Pro + EVM wallet (default for production)
 *   - evm     → self-custodial wallet (requires WALLET_MASTER_SECRET / keystore)
 *   - cmc-pro → market data only (swaps disabled — dev/testing)
 *   - mock    → simulated everything (dev/testing)
 */
export async function createBridge(): Promise<BridgeHandle> {
  const mode = (process.env.BRIDGE_MODE || "auto").toLowerCase();
  const cmcApiKey =
    process.env.CMC_PRO_API_KEY?.trim() || process.env.CMC_API_KEY?.trim();

  if (mode === "mock") {
    logger.warn("DATA SOURCE: MOCK — prices/F&G/trending are simulated");
    return { bridge: createMockBridge(), source: "mock" };
  }

  if (mode === "cmc-pro") {
    if (!cmcApiKey) {
      throw new Error("BRIDGE_MODE=cmc-pro requires CMC_PRO_API_KEY in .env");
    }
    logger.warn("DATA SOURCE: CMC Pro API — market data only (no live swaps)", {
      base: process.env.CMC_PRO_BASE_URL || "https://pro-api.coinmarketcap.com",
    });
    return { bridge: createCmcProBridge(cmcApiKey), source: "cmc-pro" };
  }

  // evm or auto — self-custodial wallet required for live trading
  if (mode === "evm" || mode === "auto") {
    try {
      const evmBridge = await createEvmWalletBridge();
      if (cmcApiKey) {
        logger.info("DATA SOURCE: EVM wallet (execution) + CMC Pro API (data)");
        return {
          bridge: createHybridBridge(evmBridge, cmcApiKey),
          source: "evm+cmc-pro",
        };
      }
      logger.info("DATA SOURCE: EVM wallet — set CMC_PRO_API_KEY for market data");
      return { bridge: evmBridge, source: "evm" };
    } catch (err) {
      throw new Error(
        `EVM wallet init failed (${String(err)}). ` +
          "Set WALLET_MASTER_SECRET, BINANCE_WEB3_API_KEY, BINANCE_WEB3_API_SECRET, and ensure AGENT_DATA_DIR is writable."
      );
    }
  }

  return { bridge: createMockBridge(), source: "mock" };
}
