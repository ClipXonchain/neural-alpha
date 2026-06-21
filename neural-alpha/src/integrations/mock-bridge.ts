import type { McpBridge } from "../agent.js";
import { buildQuoteParams, buildSwapParams } from "../execution/executor.js";

/**
 * Mock bridge for offline paper trading.
 * x402Request simulates CMC Agent Hub response shapes so the same
 * parsing path runs as with real TWAK x402 payments.
 */
export function createMockBridge(): McpBridge {
  const basePrices: Record<string, number> = {
    ETH: 3800, LINK: 15.2, AVAX: 35,
    FET: 2.3, FLOKI: 0.00018, PENDLE: 4.5, INJ: 22, BONK: 0.000025,
    APE: 1.2, CAKE: 2.8, "1INCH": 0.45, SNX: 3.2, DEXE: 8.5,
    PENGU: 0.012, AXS: 7.5, COMP: 55, LDO: 2.1, SUSHI: 1.1,
    RAY: 3.5, ZRO: 2.8, STG: 0.35, NXPC: 0.85, CHEEMS: 0.0000012,
    DOGE: 0.15, SHIB: 0.000025,
  };

  const trends: Record<string, number> = {};
  let fearGreed = 42;

  function driftPrice(symbol: string): number | null {
    const base = basePrices[symbol];
    if (!base) return null;

    if (!(symbol in trends)) {
      trends[symbol] = (Math.random() - 0.5) * 0.005;
    }
    if (Math.random() < 0.1) {
      trends[symbol] = (Math.random() - 0.5) * 0.008;
    }

    const noise = (Math.random() - 0.5) * 0.03;
    basePrices[symbol] = base * (1 + trends[symbol] + noise);
    return basePrices[symbol];
  }

  function cmcQuotePayload(symbols: string[]) {
    const data: Record<string, unknown> = {};
    for (const symbol of symbols) {
      const price = driftPrice(symbol);
      if (price === null) continue;
      data[symbol] = {
        symbol,
        quote: {
          USD: {
            price,
            percent_change_24h: (Math.random() - 0.45) * 12,
            volume_24h: 500_000 + Math.random() * 5_000_000,
            market_cap: price * (1_000_000 + Math.random() * 50_000_000),
          },
        },
      };
    }
    return { status: { error_code: 0 }, data };
  }

  return {
    async getTokenPrice(_chain: string, token: string) {
      const price = driftPrice(token);
      return price !== null ? { price } : null;
    },
    async getWalletBalance(_chain: string) {
      return { balance: "1.5" };
    },
    async getSwapQuote(params: ReturnType<typeof buildQuoteParams>) {
      return { estimatedOutput: params.amount, priceImpact: "0.1%" };
    },
    async executeSwap(_params: ReturnType<typeof buildSwapParams>) {
      return {
        txHash: `0x${Date.now().toString(16)}${"0".repeat(40)}`.slice(0, 66),
        toAmount: "100",
      };
    },
    async getAddress(_chain: string) {
      return { address: "0x" + "a".repeat(40) };
    },
    async x402Request(url: string, _maxPayment: string) {
      if (url.includes("/fear-and-greed")) {
        fearGreed = Math.max(5, Math.min(95, fearGreed + (Math.random() - 0.5) * 8));
        return { data: { value: Math.round(fearGreed), value_classification: "Neutral" } };
      }

      if (url.includes("/trending/latest")) {
        return {
          data: [
            { symbol: "FET" }, { symbol: "FLOKI" }, { symbol: "BONK" },
            { symbol: "PENDLE" }, { symbol: "INJ" }, { symbol: "PENGU" },
          ],
        };
      }

      if (url.includes("/quotes/latest")) {
        const parsed = new URL(url);
        const symbolParam = parsed.searchParams.get("symbol") || "";
        const symbols = symbolParam.split(",").map((s) => s.trim()).filter(Boolean);
        return cmcQuotePayload(symbols.length > 0 ? symbols : ["ETH"]);
      }

      // Unknown CMC endpoint — return empty success
      return { data: {} };
    },
    async getTrendingTokens(_limit: number) {
      return [
        { symbol: "FET" }, { symbol: "FLOKI" }, { symbol: "BONK" },
        { symbol: "PENDLE" }, { symbol: "INJ" }, { symbol: "PENGU" },
      ];
    },
    async checkTokenRisk(_chain: string, _token?: string) {
      return { isHoneypot: false, riskLevel: "low" };
    },

    async getStablecoinBalance(_chain: string) {
      return { balance: 1000, symbol: "USDT" };
    },

    async switchWalletMode(mode: "local" | "walletconnect") {
      return { mode, state: mode === "local" ? "local" : "wc-pairing" };
    },

    async getWalletStatus() {
      return { state: "local", mode: "local", walletType: "local" };
    },

    async competitionRegister() {
      return { ok: true, simulated: true, txHash: `0xmock${Date.now()}` };
    },

    async competitionStatus() {
      return { registered: false, registrationOpen: true, simulated: true };
    },
  };
}