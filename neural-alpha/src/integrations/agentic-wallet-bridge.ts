import type { McpBridge } from "../agent.js";
import type { PortfolioHolding } from "../utils/types.js";
import { buildQuoteParams, buildSwapParams } from "../execution/executor.js";
import { logger } from "../utils/logger.js";
import {
  BAW_BINANCE_CHAIN_ID,
  BawCliError,
  bawData,
  bawJson,
  bawWalletStatus,
} from "./baw-cli.js";
import {
  CAMPAIGN_JOIN_URL,
  campaignQualification,
  loadCampaignState,
  markCampaignRegistered,
} from "./campaign.js";
import {
  CAMPAIGN_PAYMENT_TOKENS,
  getBstockAddress,
  getEligibleBstockSymbols,
  isEligibleBstock,
  isEligibilityConfirmed,
  paymentTokenAddress,
} from "./bstock.js";
import { fetchTokenDynamic } from "./binance-web3-market.js";

const POLL_MS = 2_000;
const POLL_TIMEOUT_MS = 60_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseNum(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

function chainId(_chain?: string): string {
  return process.env.BINANCE_CHAIN_ID?.trim() || BAW_BINANCE_CHAIN_ID;
}

function paymentSymbol(): string {
  const raw = (process.env.PAYMENT_TOKEN || "USDT").toUpperCase();
  return (CAMPAIGN_PAYMENT_TOKENS as readonly string[]).includes(raw) ? raw : "USDT";
}

async function waitUnlocked(binanceChainId: string) {
  for (let i = 0; i < 15; i++) {
    try {
      const rec = await bawJson(
        ["wallet", "tx-lock", "--binanceChainId", binanceChainId],
        { timeoutMs: 15_000 }
      );
      const status = String(bawData<{ status?: string }>(rec).status ?? "UNLOCKED");
      if (status.toUpperCase() === "UNLOCKED") return;
      logger.info("Agentic Wallet tx-lock — waiting", { status });
    } catch (err) {
      logger.warn("wallet tx-lock check failed", { error: String(err) });
      return;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(
    "Agentic Wallet is LOCKED (pending tx or App double-confirm). Resolve it in the Binance App, then retry."
  );
}

async function pollMarketOrder(orderId: string): Promise<Record<string, unknown>> {
  const started = Date.now();
  while (Date.now() - started < POLL_TIMEOUT_MS) {
    const rec = await bawJson(
      ["market-order", "list", "--orderId", orderId, "--binanceChainId", chainId()],
      { timeoutMs: 20_000 }
    );
    const data = bawData<{ list?: Array<Record<string, unknown>> }>(rec);
    const row = Array.isArray(data.list) ? data.list[0] : asRecord(data);
    const status = String(row?.status ?? "").toUpperCase();
    if (status === "FINISHED" || status === "FAILED") {
      return row ?? { orderId, status };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return { orderId, status: "PENDING", error: "Swap still PENDING after poll timeout" };
}

function balanceRows(result: Record<string, unknown>): Array<Record<string, unknown>> {
  const data = result.data ?? result;
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  const rec = asRecord(data);
  if (Array.isArray(rec?.list)) return rec.list as Array<Record<string, unknown>>;
  if (rec && (rec.symbol || rec.balance)) return [rec];
  return [];
}

export async function createAgenticWalletBridge(): Promise<McpBridge> {
  let status = "UNCONNECTED";
  try {
    status = await bawWalletStatus();
  } catch (err) {
    throw new Error(
      `Binance Agentic Wallet CLI unavailable (${String(err)}). ` +
        "Install: npm i -g @binance/agentic-wallet  then  baw auth signin"
    );
  }

  logger.info("Binance Agentic Wallet status", { status });
  if (status !== "CONNECTED") {
    logger.warn("Agentic Wallet is not CONNECTED — live swaps will fail until baw auth signin");
  }

  return {
    async getTokenPrice(_chain, token) {
      const address = getBstockAddress(token) ?? paymentTokenAddress(token);
      if (!address) return null;
      const quote = await fetchTokenDynamic(address);
      return quote && quote.price > 0 ? { price: quote.price } : null;
    },

    async getWalletBalance(_chain) {
      try {
        const rec = await bawJson(
          ["wallet", "balance", "--symbol", "BNB", "--binanceChainId", chainId()],
          { timeoutMs: 25_000 }
        );
        const row = balanceRows(rec)[0];
        return { balance: String(row?.balance ?? "0") };
      } catch (err) {
        logger.warn("baw wallet balance (BNB) failed", { error: String(err) });
        return null;
      }
    },

    async getSwapQuote(params: ReturnType<typeof buildQuoteParams>) {
      const rec = await bawJson(
        [
          "market-order",
          "quote",
          "--fromTokenQty",
          params.fromTokenQty,
          "--fromToken",
          params.fromToken,
          "--toToken",
          params.toToken,
          "--binanceChainId",
          params.binanceChainId,
          "--slippage",
          params.slippage,
        ],
        { timeoutMs: 30_000 }
      );
      const data = bawData(rec);
      return {
        ...data,
        estimatedOutput: String(
          (data as { toCoinAmount?: string }).toCoinAmount ?? params.fromTokenQty
        ),
      };
    },

    async executeSwap(params: ReturnType<typeof buildSwapParams>) {
      await waitUnlocked(params.binanceChainId);
      const submitted = await bawJson(
        [
          "market-order",
          "swap",
          "--fromTokenQty",
          params.fromTokenQty,
          "--fromToken",
          params.fromToken,
          "--toToken",
          params.toToken,
          "--binanceChainId",
          params.binanceChainId,
          "--slippage",
          params.slippage,
          "--mev",
          "true",
          "--gasLevel",
          "HIGH",
        ],
        { timeoutMs: 90_000 }
      );
      const orderId = String(bawData<{ orderId?: string }>(submitted).orderId ?? "");
      if (!orderId) {
        return { success: false, error: "market-order swap returned no orderId", ...submitted };
      }

      logger.info("Agentic Wallet swap submitted", { orderId });
      const settled = await pollMarketOrder(orderId);
      const status = String(settled.status ?? "").toUpperCase();
      const txHash = typeof settled.txHash === "string" ? settled.txHash : undefined;
      const fromAmount = String(settled.fromTokenQty ?? params.fromTokenQty);
      const toAmount =
        settled.toTokenQty != null
          ? String(settled.toTokenQty)
          : settled.toAmount != null
            ? String(settled.toAmount)
            : undefined;

      if (status !== "FINISHED" || !txHash) {
        return {
          success: false,
          orderId,
          status,
          txHash,
          fromAmount,
          toAmount,
          error:
            status === "FAILED"
              ? "Market order FAILED on-chain"
              : `Market order not finished (status=${status || "unknown"})`,
          ...settled,
        };
      }

      return {
        success: true,
        orderId,
        status,
        txHash,
        fromAmount,
        toAmount,
        ...settled,
      };
    },

    async getAddress(_chain) {
      try {
        const rec = await bawJson(["wallet", "address"], { timeoutMs: 20_000 });
        const data = bawData<{ addresses?: Array<{ binanceChainId?: string; address?: string }> }>(
          rec
        );
        const wanted = chainId();
        const match = (data.addresses ?? []).find(
          (a) => String(a.binanceChainId) === wanted && a.address
        );
        const fallback = (data.addresses ?? []).find((a) => a.address?.startsWith("0x"));
        const address = match?.address ?? fallback?.address;
        return address ? { address } : null;
      } catch (err) {
        logger.warn("baw wallet address failed", { error: String(err) });
        return null;
      }
    },

    async x402Request(_url, _maxPayment) {
      return null;
    },

    async getTrendingTokens(limit: number) {
      const symbols = getEligibleBstockSymbols().slice(0, Math.max(1, limit));
      return symbols.map((symbol) => ({ symbol }));
    },

    async checkTokenRisk(_chain, token) {
      if (token && isEligibleBstock(token) && isEligibilityConfirmed()) {
        return { isHoneypot: false, riskLevel: "low", skipped: true, reason: "campaign-eligible" };
      }
      return { isHoneypot: false, riskLevel: "unknown", skipped: true };
    },

    async getStablecoinBalance(_chain) {
      const symbol = paymentSymbol();
      try {
        const rec = await bawJson(
          ["wallet", "balance", "--symbol", symbol, "--binanceChainId", chainId()],
          { timeoutMs: 25_000 }
        );
        const row = balanceRows(rec).find(
          (r) => String(r.symbol ?? "").toUpperCase() === symbol
        ) ?? balanceRows(rec)[0];
        return { balance: parseNum(row?.balance), symbol };
      } catch (err) {
        logger.warn("baw stablecoin balance failed", { error: String(err), symbol });
        return null;
      }
    },

    async getPortfolio(_chain) {
      try {
        const rec = await bawJson(
          ["wallet", "balance", "--binanceChainId", chainId()],
          { timeoutMs: 30_000 }
        );
        const holdings: PortfolioHolding[] = [];
        for (const row of balanceRows(rec)) {
          const symbol = String(row.symbol ?? "").toUpperCase();
          const amount = parseNum(row.balance);
          if (!symbol || amount <= 0) continue;
          holdings.push({
            symbol,
            amount,
            priceUsd: parseNum(row.price) || undefined,
            valueUsd: parseNum(row.value) || undefined,
          });
        }
        return holdings;
      } catch (err) {
        logger.warn("baw wallet balance (portfolio) failed", { error: String(err) });
        return null;
      }
    },

    async getTokenBalance(_chain, symbol) {
      const upper = symbol.toUpperCase();
      const tokenAddress = getBstockAddress(upper) ?? paymentTokenAddress(upper);
      try {
        const args = ["wallet", "balance", "--binanceChainId", chainId()];
        if (tokenAddress) args.push("--tokenAddress", tokenAddress);
        else args.push("--symbol", upper);
        const rec = await bawJson(args, { timeoutMs: 25_000 });
        const row =
          balanceRows(rec).find((r) => String(r.symbol ?? "").toUpperCase() === upper) ??
          balanceRows(rec)[0];
        if (!row) return null;
        const amount = parseNum(row.balance);
        if (amount <= 0) return null;
        return {
          symbol: upper,
          amount,
          priceUsd: parseNum(row.price) || undefined,
          valueUsd: parseNum(row.value) || undefined,
        };
      } catch (err) {
        logger.warn("baw getTokenBalance failed", { symbol: upper, error: String(err) });
        return null;
      }
    },

    async switchWalletMode(_mode) {
      const current = await bawWalletStatus();
      return { mode: "agentic-wallet", state: current, walletType: "binance-agentic-wallet" };
    },

    async getWalletStatus() {
      const current = await bawWalletStatus();
      return {
        state: current.toLowerCase(),
        mode: "agentic-wallet",
        walletType: "binance-agentic-wallet",
        status: current,
      };
    },

    async competitionRegister() {
      const existing = loadCampaignState();
      if (existing.registered || process.env.CAMPAIGN_REGISTERED === "true") {
        return { ok: true, registered: true, joinUrl: CAMPAIGN_JOIN_URL };
      }
      const marked = markCampaignRegistered();
      return {
        ok: true,
        registered: marked.registered,
        joinUrl: CAMPAIGN_JOIN_URL,
        message:
          "Bind this Agentic Wallet on the official campaign page (Join Now). Trades before registration do not count.",
      };
    },

    async competitionStatus() {
      const q = campaignQualification();
      return {
        ...q,
        registrationOpen: q.active,
      };
    },
  };
}

export async function startAgenticSignin(): Promise<Record<string, unknown>> {
  const rec = await bawJson(["auth", "signin"], { timeoutMs: 30_000 });
  return bawData(rec);
}

export async function verifyAgenticSignin(qrCodeId: string): Promise<Record<string, unknown>> {
  try {
    const rec = await bawJson(["auth", "verify", "--qrCodeId", qrCodeId], {
      timeoutMs: 320_000,
    });
    return bawData(rec);
  } catch (err) {
    if (err instanceof BawCliError) {
      return { success: false, error: err.message, code: err.code };
    }
    throw err;
  }
}
