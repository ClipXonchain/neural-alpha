import type { McpBridge } from "../agent.js";
import { logger } from "../utils/logger.js";
import { createMockBridge } from "./mock-bridge.js";
import { createTwakMcpBridge } from "./twak-mcp-bridge.js";
import { createCmcProBridge } from "./cmc-pro-bridge.js";

export type BridgeSource =
  | "twak-mcp"
  | "twak+cmc-pro"
  | "cmc-pro"
  | "mock"
  | "mock-fallback";

export interface BridgeHandle {
  bridge: McpBridge;
  source: BridgeSource;
}

/**
 * Build a hybrid bridge: CMC Pro API for data, TWAK MCP for execution.
 * x402Request goes through CMC Pro (free with API key) instead of TWAK x402
 * (which needs USDC on BSC). Swaps/wallet/risk still go through TWAK MCP.
 */
function createHybridBridge(twakBridge: McpBridge, cmcApiKey: string): McpBridge {
  const cmcBridge = createCmcProBridge(cmcApiKey);

  return {
    // Data: CMC Pro API (free with hackathon key)
    getTokenPrice: cmcBridge.getTokenPrice,
    x402Request: cmcBridge.x402Request,
    getTrendingTokens: cmcBridge.getTrendingTokens,

    // Execution: TWAK MCP (swap, wallet, risk)
    getWalletBalance: twakBridge.getWalletBalance,
    getSwapQuote: twakBridge.getSwapQuote,
    executeSwap: twakBridge.executeSwap,
    getAddress: twakBridge.getAddress,
    checkTokenRisk: twakBridge.checkTokenRisk,
  };
}

/**
 * Select data/execution bridge for standalone agent.
 *
 * Priority order for BRIDGE_MODE=auto:
 *   1. TWAK MCP + CMC Pro key → real data (API key) + real execution (TWAK)
 *   2. TWAK MCP alone         → CMC x402 data + real execution
 *   3. CMC Pro alone          → real data, paper swaps only
 *   4. Mock                   → simulated everything
 *
 * Explicit modes:
 *   - BRIDGE_MODE=twak    → TWAK MCP only, x402 for data (fails if unavailable)
 *   - BRIDGE_MODE=cmc-pro → CMC Pro API key only, paper swaps (fails if no key)
 *   - BRIDGE_MODE=mock    → simulated data
 *   - BRIDGE_MODE=auto    → best available (default)
 */
export async function createBridge(agentMode: string): Promise<BridgeHandle> {
  const mode = (process.env.BRIDGE_MODE || "auto").toLowerCase();
  const cmcApiKey = process.env.CMC_PRO_API_KEY?.trim();

  // Explicit mock
  if (mode === "mock") {
    logger.warn("DATA SOURCE: MOCK — prices/F&G/trending are simulated, not live CMC");
    return { bridge: createMockBridge(), source: "mock" };
  }

  // Explicit CMC Pro API key mode (no TWAK needed)
  if (mode === "cmc-pro") {
    if (!cmcApiKey) {
      throw new Error("BRIDGE_MODE=cmc-pro requires CMC_PRO_API_KEY in .env");
    }
    logger.info("DATA SOURCE: CMC Pro API — real market data via API key (paper swaps)", {
      base: process.env.CMC_PRO_BASE_URL || "https://pro-api.coinmarketcap.com",
    });
    return { bridge: createCmcProBridge(cmcApiKey), source: "cmc-pro" };
  }

  // TWAK MCP (explicit or auto)
  if (mode === "twak" || mode === "auto") {
    let twakBridge: McpBridge | null = null;

    try {
      twakBridge = await createTwakMcpBridge();
    } catch (err) {
      if (mode === "twak" || agentMode === "live") {
        throw new Error(
          `TWAK MCP connection failed (${String(err)}). ` +
            "Run `twak serve` or set BRIDGE_MODE=cmc-pro / mock."
        );
      }
      // auto mode, TWAK failed — fall through below
      logger.warn("TWAK MCP unavailable", { error: String(err) });
    }

    // TWAK connected — check if we should hybrid with CMC Pro
    if (twakBridge) {
      if (cmcApiKey) {
        logger.info("DATA SOURCE: TWAK MCP (execution) + CMC Pro API (data)", {
          hint: "x402 skipped — using free API key for market data, TWAK for swaps/wallet",
        });
        return {
          bridge: createHybridBridge(twakBridge, cmcApiKey),
          source: "twak+cmc-pro",
        };
      }
      // No CMC Pro key — pure TWAK with x402 for data
      logger.info("DATA SOURCE: TWAK MCP — CMC Agent Hub via x402_request", {
        hint: "Set CMC_PRO_API_KEY for free data (no USDC needed for x402)",
      });
      return { bridge: twakBridge, source: "twak-mcp" };
    }

    // TWAK failed, auto mode — try CMC Pro key before mock
    if (cmcApiKey) {
      logger.info("DATA SOURCE: CMC Pro API (TWAK unavailable — paper swaps only)", {
        hint: "Start `twak serve` for real BSC execution.",
      });
      return { bridge: createCmcProBridge(cmcApiKey), source: "cmc-pro" };
    }

    logger.warn("DATA SOURCE: MOCK (fallback) — no TWAK MCP, no CMC_PRO_API_KEY", {
      hint: "Set CMC_PRO_API_KEY for real data, or run `twak serve` for full execution",
    });
    return { bridge: createMockBridge(), source: "mock-fallback" };
  }

  return { bridge: createMockBridge(), source: "mock" };
}
