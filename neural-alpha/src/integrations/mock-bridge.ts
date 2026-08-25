import type { McpBridge } from "../agent.js";
import { buildQuoteParams, buildSwapParams } from "../execution/executor.js";
import { getEligibleBstockSymbols } from "./bstock.js";

/**
 * Mock bridge for offline paper trading of bStocks.
 */
export function createMockBridge(): McpBridge {
  const basePrices: Record<string, number> = {
    NVDAB: 180, AAPLB: 230, TSLAB: 350, MSFTB: 420, GOOGLB: 200,
    AMZNB: 230, METAB: 580, PLTRB: 175, SPYB: 640, QQQB: 560,
    NFLXB: 980, AMDB: 160, INTCB: 45, AVGOB: 1700, ORCLB: 240,
    COINB: 280, MSTRB: 380, HOODB: 90, CRCLB: 140, IRENB: 12,
    GMEB: 25, AMATB: 190, MUUB: 120, TSMB: 180,
  };

  const trends: Record<string, number> = {};

  function driftPrice(symbol: string): number | null {
    const upper = symbol.toUpperCase();
    if (!(upper in basePrices)) {
      if (getEligibleBstockSymbols().includes(upper) || upper.endsWith("B")) {
        basePrices[upper] = 50 + Math.random() * 200;
      } else {
        return null;
      }
    }
    const base = basePrices[upper]!;
    if (!(upper in trends)) trends[upper] = (Math.random() - 0.5) * 0.004;
    if (Math.random() < 0.1) trends[upper] = (Math.random() - 0.5) * 0.006;
    const noise = (Math.random() - 0.5) * 0.02;
    basePrices[upper] = base * (1 + trends[upper]! + noise);
    return basePrices[upper]!;
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
            percent_change_24h: (Math.random() - 0.45) * 8,
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
      return { estimatedOutput: params.fromTokenQty, priceImpact: "0.1%" };
    },
    async executeSwap(_params: ReturnType<typeof buildSwapParams>) {
      return {
        txHash: `0x${Date.now().toString(16)}${"0".repeat(40)}`.slice(0, 66),
        toAmount: "100",
        success: true,
      };
    },
    async getAddress(_chain: string) {
      return { address: "0x" + "a".repeat(40) };
    },
    async x402Request(url: string, _maxPayment: string) {
      if (url.includes("/trending/latest")) {
        return { data: getEligibleBstockSymbols().slice(0, 6).map((symbol) => ({ symbol })) };
      }
      if (url.includes("/quotes/latest")) {
        const parsed = new URL(url);
        const symbolParam = parsed.searchParams.get("symbol") || "";
        const symbols = symbolParam.split(",").map((s) => s.trim()).filter(Boolean);
        return cmcQuotePayload(symbols.length > 0 ? symbols : ["NVDAB"]);
      }
      return { data: {} };
    },
    async getTrendingTokens(limit: number) {
      return getEligibleBstockSymbols().slice(0, limit).map((symbol) => ({ symbol }));
    },
    async checkTokenRisk(_chain: string, _token?: string) {
      return { isHoneypot: false, riskLevel: "low" };
    },
    async getStablecoinBalance(_chain: string) {
      return { balance: 1000, symbol: "USDT" };
    },
    async switchWalletMode(mode: "local" | "walletconnect") {
      return { mode, state: "connected", walletType: "binance-agentic-wallet" };
    },
    async getWalletStatus() {
      return {
        state: "connected",
        mode: "agentic-wallet",
        walletType: "binance-agentic-wallet",
        status: "CONNECTED",
      };
    },
    async competitionRegister() {
      return { ok: true, simulated: true, joinUrl: "https://web3.binance.com/en/campaigns/bstock-pnl-contest" };
    },
    async competitionStatus() {
      return { registered: false, registrationOpen: true, simulated: true };
    },
  };
}
