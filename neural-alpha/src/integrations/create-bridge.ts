import type { McpBridge } from "../agent.js";
import { logger } from "../utils/logger.js";
import { createMockBridge } from "./mock-bridge.js";
import { createAgenticWalletBridge } from "./agentic-wallet-bridge.js";
import { bootstrapBstocks } from "./bstock.js";
import { setEligibleTokens } from "../config.js";

export type BridgeSource = "baw" | "mock" | "mock-fallback";

export interface BridgeHandle {
  bridge: McpBridge;
  source: BridgeSource;
}

/**
 * Select data/execution bridge.
 *
 * BRIDGE_MODE=auto: Agentic Wallet (`baw`) when signed in, else mock (paper only).
 * Prices come from Binance Web3 bStock quotes; CMC and Agent Studio are paid
 * per call through `baw x402-payment`, so no CMC API key is used.
 *
 * Explicit: auto | baw | mock
 */
export async function createBridge(agentMode: string): Promise<BridgeHandle> {
  const boot = await bootstrapBstocks();
  setEligibleTokens(boot.eligible);

  const mode = (process.env.BRIDGE_MODE || "auto").toLowerCase();

  if (mode === "mock") {
    logger.warn("DATA SOURCE: MOCK — prices are simulated, not live bStock quotes");
    return { bridge: createMockBridge(), source: "mock" };
  }

  if (mode === "baw" || mode === "twak" || mode === "auto") {
    try {
      const walletBridge = await createAgenticWalletBridge();
      logger.info("DATA SOURCE: Binance Agentic Wallet — bStock swaps + wallet balances");
      return { bridge: walletBridge, source: "baw" };
    } catch (err) {
      if (mode === "baw" || mode === "twak" || agentMode === "live") {
        throw new Error(
          `Binance Agentic Wallet connection failed (${String(err)}). ` +
            "Install `@binance/agentic-wallet`, run `baw auth signin`, or set BRIDGE_MODE=mock."
        );
      }
      logger.warn("Agentic Wallet unavailable", { error: String(err) });
    }

    logger.warn("DATA SOURCE: MOCK (fallback) — no baw CLI signed in");
    return { bridge: createMockBridge(), source: "mock-fallback" };
  }

  return { bridge: createMockBridge(), source: "mock" };
}
