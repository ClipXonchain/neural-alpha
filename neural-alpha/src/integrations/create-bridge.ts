import type { McpBridge } from "../agent.js";
import { logger } from "../utils/logger.js";
import { createMockBridge } from "./mock-bridge.js";
import { createAgenticWalletBridge } from "./agentic-wallet-bridge.js";
import { createCmcProBridge } from "./cmc-pro-bridge.js";
import { bootstrapBstocks } from "./bstock.js";
import { setEligibleTokens } from "../config.js";

export type BridgeSource =
  | "baw+cmc-pro"
  | "baw"
  | "cmc-pro"
  | "mock"
  | "mock-fallback";

export interface BridgeHandle {
  bridge: McpBridge;
  source: BridgeSource;
}

function createHybridBridge(walletBridge: McpBridge, cmcApiKey: string): McpBridge {
  const cmcBridge = createCmcProBridge(cmcApiKey);

  return {
    getTokenPrice: async (chain, token) => {
      const fromWallet = await walletBridge.getTokenPrice(chain, token);
      if (fromWallet?.price) return fromWallet;
      return cmcBridge.getTokenPrice(chain, token);
    },
    x402Request: cmcBridge.x402Request,
    getTrendingTokens: walletBridge.getTrendingTokens,

    getWalletBalance: walletBridge.getWalletBalance,
    getSwapQuote: walletBridge.getSwapQuote,
    executeSwap: walletBridge.executeSwap,
    getAddress: walletBridge.getAddress,
    checkTokenRisk: walletBridge.checkTokenRisk,
    getStablecoinBalance: walletBridge.getStablecoinBalance,
    getTokenBalance: walletBridge.getTokenBalance,
    getPortfolio: walletBridge.getPortfolio,
    switchWalletMode: walletBridge.switchWalletMode,
    getWalletStatus: walletBridge.getWalletStatus,
    competitionRegister: walletBridge.competitionRegister,
    competitionStatus: walletBridge.competitionStatus,
  };
}

/**
 * Select data/execution bridge.
 *
 * BRIDGE_MODE=auto:
 *   1. Agentic Wallet (`baw`) + CMC Pro key → bStock execution + CMC sentiment
 *   2. Agentic Wallet alone → execution + Binance Web3 prices
 *   3. CMC Pro alone → paper swaps
 *   4. Mock
 *
 * Explicit: auto | baw | cmc-pro | mock
 */
export async function createBridge(agentMode: string): Promise<BridgeHandle> {
  const boot = await bootstrapBstocks();
  setEligibleTokens(boot.eligible);

  const mode = (process.env.BRIDGE_MODE || "auto").toLowerCase();
  const cmcApiKey = process.env.CMC_PRO_API_KEY?.trim();

  if (mode === "mock") {
    logger.warn("DATA SOURCE: MOCK — prices are simulated, not live bStock quotes");
    return { bridge: createMockBridge(), source: "mock" };
  }

  if (mode === "cmc-pro") {
    if (!cmcApiKey) {
      throw new Error("BRIDGE_MODE=cmc-pro requires CMC_PRO_API_KEY in .env");
    }
    logger.info("DATA SOURCE: CMC Pro API — paper swaps only (no Agentic Wallet)");
    return { bridge: createCmcProBridge(cmcApiKey), source: "cmc-pro" };
  }

  if (mode === "baw" || mode === "twak" || mode === "auto") {
    let walletBridge: McpBridge | null = null;

    try {
      walletBridge = await createAgenticWalletBridge();
    } catch (err) {
      if (mode === "baw" || mode === "twak" || agentMode === "live") {
        throw new Error(
          `Binance Agentic Wallet connection failed (${String(err)}). ` +
            "Install `@binance/agentic-wallet`, run `baw auth signin`, or set BRIDGE_MODE=cmc-pro / mock."
        );
      }
      logger.warn("Agentic Wallet unavailable", { error: String(err) });
    }

    if (walletBridge) {
      if (cmcApiKey) {
        logger.info("DATA SOURCE: Agentic Wallet (execution) + CMC Pro (sentiment)", {
          hint: "Swaps via baw market-order; campaign x402 calls still use baw x402-payment",
        });
        return {
          bridge: createHybridBridge(walletBridge, cmcApiKey),
          source: "baw+cmc-pro",
        };
      }
      logger.info("DATA SOURCE: Binance Agentic Wallet — bStock swaps + wallet balances");
      return { bridge: walletBridge, source: "baw" };
    }

    if (cmcApiKey) {
      logger.info("DATA SOURCE: CMC Pro API (Agentic Wallet unavailable — paper swaps only)");
      return { bridge: createCmcProBridge(cmcApiKey), source: "cmc-pro" };
    }

    logger.warn("DATA SOURCE: MOCK (fallback) — no baw CLI, no CMC_PRO_API_KEY");
    return { bridge: createMockBridge(), source: "mock-fallback" };
  }

  return { bridge: createMockBridge(), source: "mock" };
}
