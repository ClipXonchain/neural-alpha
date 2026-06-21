import type { McpBridge } from "../agent.js";
import { buildQuoteParams, buildSwapParams } from "../execution/executor.js";
import { logger } from "../utils/logger.js";

const CMC_PRO_BASE = process.env.CMC_PRO_BASE_URL || "https://pro-api.coinmarketcap.com";

async function cmcFetch(path: string, apiKey: string): Promise<Record<string, unknown> | null> {
  const url = `${CMC_PRO_BASE}${path}`;
  try {
    const res = await fetch(url, {
      headers: {
        "X-CMC_PRO_API_KEY": apiKey,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      logger.warn("CMC Pro API error", { status: res.status, url });
      return null;
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    logger.warn("CMC Pro API fetch failed", { url, error: String(err) });
    return null;
  }
}

/**
 * Bridge that fetches real market data from CMC Pro API (traditional API key auth)
 * while still routing execution through TWAK MCP or paper simulation.
 *
 * Best of both worlds: real CMC data without needing x402 / funded TWAK wallet.
 * The CMC hackathon team provides free Pro API keys to participants.
 */
export function createCmcProBridge(apiKey: string): McpBridge {
  return {
    async getTokenPrice(_chain: string, token: string) {
      const raw = await cmcFetch(
        `/v1/cryptocurrency/quotes/latest?symbol=${encodeURIComponent(token)}&convert=USD`,
        apiKey
      );
      if (!raw) return null;
      try {
        const data = raw.data as Record<string, Record<string, unknown>>;
        const entry = data?.[token.toUpperCase()];
        if (!entry) return null;
        const usd = (entry.quote as Record<string, Record<string, number>>)?.USD;
        return usd?.price != null ? { price: usd.price } : null;
      } catch {
        return null;
      }
    },

    async getWalletBalance(_chain: string) {
      return { balance: "0" };
    },

    async getSwapQuote(_params: ReturnType<typeof buildQuoteParams>) {
      return { estimatedOutput: "0", priceImpact: "0%" };
    },

    async executeSwap(_params: ReturnType<typeof buildSwapParams>) {
      return {
        txHash: `paper-${Date.now()}`,
        toAmount: "0",
      };
    },

    async getAddress(_chain: string) {
      return { address: "0x" + "0".repeat(40) };
    },

    async x402Request(url: string, _maxPayment: string) {
      const parsed = new URL(url);
      let path = parsed.pathname + parsed.search;

      // Translate Agent Hub paths → CMC Pro API paths where they differ
      if (path.includes("/global-metrics/fear-and-greed")) {
        path = "/v3/fear-and-greed/latest";
      }

      const raw = await cmcFetch(path, apiKey);
      return raw;
    },

    async getTrendingTokens(limit: number) {
      const raw = await cmcFetch(
        `/v1/cryptocurrency/trending/latest?limit=${limit}`,
        apiKey
      );
      if (!raw) return null;
      try {
        const items = raw.data;
        if (!Array.isArray(items)) return null;
        return items.map((item) => {
          const row = item as Record<string, unknown>;
          return { symbol: String(row.symbol || "").toUpperCase() };
        }).filter((t) => t.symbol.length > 0);
      } catch {
        return null;
      }
    },

    async checkTokenRisk(_chain: string, _token?: string) {
      return { isHoneypot: false, riskLevel: "unknown" };
    },
  };
}
