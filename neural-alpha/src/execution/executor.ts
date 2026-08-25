import type { TradeOrder, TradeResult, TradeSignal, AgentConfig } from "../utils/types.js";
import { BSC_CHAIN_ID, isEligibleToken, isTradableToken } from "../config.js";
import { hasBscSwapAddress } from "../integrations/bsc-token-addresses.js";
import { getBstockAddress, paymentTokenAddress, BSC_NATIVE_BNB } from "../integrations/bstock.js";
import { RiskManager } from "../risk/manager.js";
import { PortfolioTracker } from "../risk/portfolio.js";
import { getLatestPrice } from "../data/market.js";
import { logger } from "../utils/logger.js";
/**
 * Trade executor that routes all swaps through Binance Agentic Wallet (`baw`).
 * This module constructs trade orders and processes results.
 * Live execution is `baw market-order swap` + poll `market-order list`.
 *
 * Design: Agentic Wallet is the SOLE execution layer — MPC keyless signing,
 * no local private keys, campaign PnL only counts AW trades of eligible bStocks.
 */

let orderCounter = 0;

/** All buys are funded with USDT only. */
export function selectFundingCurrency(
  portfolio: PortfolioTracker,
  amountUsd: number,
  _swapCurrencies: string[]
): string | null {
  return portfolio.cash >= amountUsd ? "USDT" : null;
}

export function createTradeOrder(
  signal: TradeSignal,
  amountUsd: number,
  config: AgentConfig,
  fundingCurrency?: string,
  fromTokenAmount?: number
): TradeOrder {
  orderCounter++;
  const id = `order-${Date.now()}-${orderCounter}`;

  const isBuy = signal.action === "buy";
  const fromToken = isBuy ? (fundingCurrency ?? config.baseCurrency) : signal.symbol;
  const toToken = isBuy ? signal.symbol : config.baseCurrency;

  return {
    id,
    timestamp: Date.now(),
    symbol: signal.symbol,
    side: isBuy ? "buy" : "sell",
    amountUsd,
    ...(fromTokenAmount !== undefined && fromTokenAmount > 0
      ? { fromTokenAmount }
      : {}),
    fromToken,
    toToken,
    slippage: config.slippageTolerance,
  };
}

/** Round down token qty so the swap never requests more than the on-chain balance. */
export function floorTokenAmount(amount: number, decimals = 8): number {
  if (amount <= 0) return 0;
  const factor = 10 ** decimals;
  return Math.floor(amount * factor + 1e-12) / factor;
}

/** Human-readable qty for baw: USD for stable-funded buys, token units for sells. */
export function resolveSwapAmount(order: TradeOrder): string {
  if (order.side === "sell" && order.fromTokenAmount !== undefined && order.fromTokenAmount > 0) {
    return String(order.fromTokenAmount);
  }
  return String(order.amountUsd);
}

/**
 * Resolve a token to the contract address baw expects.
 * Native BNB uses the Binance sentinel address. Payment stables and bStocks
 * use the type=3 / common-token tables — never fabricate an address.
 */
export function resolveSwapToken(token: string): string {
  const upper = token.toUpperCase();
  if (upper === "BNB") return BSC_NATIVE_BNB;
  const payment = paymentTokenAddress(upper);
  if (payment) return payment;
  const bstock = getBstockAddress(upper);
  if (bstock) return bstock;
  return token;
}

export function buildSwapParams(order: TradeOrder): {
  fromTokenQty: string;
  fromToken: string;
  toToken: string;
  binanceChainId: string;
  slippage: string;
} {
  return {
    fromTokenQty: resolveSwapAmount(order),
    fromToken: resolveSwapToken(order.fromToken),
    toToken: resolveSwapToken(order.toToken),
    binanceChainId: BSC_CHAIN_ID,
    slippage: String(order.slippage),
  };
}

/** Quote params match swap params so the same route is priced. */
export function buildQuoteParams(order: TradeOrder): ReturnType<typeof buildSwapParams> {
  return buildSwapParams(order);
}
const ON_CHAIN_TX_PATTERN = /^0x[a-fA-F0-9]{40,}$/;

/** Paper-mode swaps use a synthetic hash prefix. */
export function isPaperTxHash(txHash: string | undefined): boolean {
  return !!txHash && txHash.startsWith("paper-");
}

/** Live BSC swaps must return a real transaction hash. */
export function isOnChainTxHash(txHash: string | undefined): boolean {
  return !!txHash && ON_CHAIN_TX_PATTERN.test(txHash);
}

export function isConfirmedTxHash(
  txHash: string | undefined,
  requireOnChain: boolean
): boolean {
  if (!txHash) return false;
  if (isPaperTxHash(txHash)) return !requireOnChain;
  return isOnChainTxHash(txHash);
}

/** Agentic Wallet / baw failures use `success: false` plus a `code` / `message`. */
export function isSwapFailure(mcpResult: Record<string, unknown>): boolean {
  if (mcpResult.success === false) return true;
  if (mcpResult.isError === true) return true;
  if (typeof mcpResult.error === "string" && mcpResult.error.length > 0) return true;
  if (mcpResult.success !== true) {
    const code = mcpResult.code ?? mcpResult.errorCode;
    if (typeof code === "string" && code.length > 0) {
      const upper = code.toUpperCase();
      if (upper !== "SUCCESS" && upper !== "OK") return true;
    }
  }
  return false;
}

function swapFailureMessage(mcpResult: Record<string, unknown>): string | undefined {
  if (typeof mcpResult.message === "string" && mcpResult.message.length > 0) {
    return mcpResult.message;
  }
  if (typeof mcpResult.error === "string" && mcpResult.error.length > 0) {
    return mcpResult.error;
  }
  const code = mcpResult.code ?? mcpResult.errorCode;
  return typeof code === "string" ? code : undefined;
}

/** Pull swap tx hash from baw market-order payloads (structured fields only). */
export function extractTxHash(mcpResult: Record<string, unknown>, depth = 0): string | undefined {
  if (depth > 4) return undefined;

  const hashKeys = ["txHash", "hash", "transactionHash", "txId", "transaction_hash"];
  for (const key of hashKeys) {
    const value = mcpResult[key];
    if (typeof value === "string" && ON_CHAIN_TX_PATTERN.test(value)) return value;
  }

  // Recurse into any nested object that might contain the hash
  const nestKeys = ["transaction", "result", "data", "swap", "receipt", "response", "details"];
  for (const key of nestKeys) {
    const nested = mcpResult[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const inner = extractTxHash(nested as Record<string, unknown>, depth + 1);
      if (inner) return inner;
    }
  }

  return undefined;
}

/** Parse swap summaries like "4.9 AAPLB -> 1.84 USDT" or output "113.3 USDT". */
function parseSwapSummary(summary: string): { fromAmount?: string; toAmount?: string } {
  const arrow = summary.match(/^([\d.]+)\s+\S+\s*->\s*([\d.]+)/);
  if (arrow) return { fromAmount: arrow[1], toAmount: arrow[2] };
  const outOnly = summary.match(/^([\d.]+)\s+\S+/);
  if (outOnly) return { toAmount: outOnly[1] };
  return {};
}

/**
 * Process the swap result from Agentic Wallet into our TradeResult format.
 * Live trades require a confirmed on-chain tx hash before counting as success.
 */
export function processSwapResult(
  order: TradeOrder,
  mcpResult: Record<string, unknown>,
  currentPrice: number,
  options?: { requireOnChainTx?: boolean }
): TradeResult {
  const requireOnChainTx = options?.requireOnChainTx ?? false;
  const failed = isSwapFailure(mcpResult);
  const txHash = failed ? undefined : extractTxHash(mcpResult);
  const summaryParsed =
    typeof mcpResult.summary === "string"
      ? parseSwapSummary(mcpResult.summary)
      : {};
  const outputParsed =
    typeof mcpResult.output === "string"
      ? parseSwapSummary(mcpResult.output)
      : {};
  const inputAmount =
    typeof mcpResult.input === "string"
      ? mcpResult.input.match(/^([\d.]+)/)?.[1]
      : undefined;
  const fromAmount =
    (mcpResult.fromAmount as string | undefined) ??
    summaryParsed.fromAmount ??
    inputAmount ??
    (order.side === "sell" && order.fromTokenAmount
      ? String(order.fromTokenAmount)
      : String(order.amountUsd));
  const toAmount =
    (mcpResult.toAmount ?? mcpResult.tokenOutAmount ?? summaryParsed.toAmount ?? outputParsed.toAmount) as
      | string
      | undefined;
  const confirmed = isConfirmedTxHash(txHash, requireOnChainTx);
  const success = !failed && confirmed;

  let priceAtExecution = currentPrice;
  if (priceAtExecution <= 0 && fromAmount && toAmount) {
    const from = parseFloat(fromAmount);
    const to = parseFloat(toAmount);
    if (from > 0 && to > 0) priceAtExecution = to / from;
  }

  const result: TradeResult = {
    orderId: order.id,
    success,
    txHash,
    fromToken: order.fromToken,
    toToken: order.toToken,
    fromAmount,
    toAmount,
    priceAtExecution,
    timestamp: Date.now(),
    error: failed
      ? swapFailureMessage(mcpResult) ?? "Swap failed"
      : !confirmed
        ? "Swap returned no on-chain transaction hash — not confirmed"
        : undefined,
  };

  if (success) {
    logger.trade(
      `${order.side.toUpperCase()} executed`,
      {
        orderId: order.id,
        symbol: order.symbol,
        side: order.side,
        amountUsd: order.amountUsd,
        fromToken: order.fromToken,
        toToken: order.toToken,
        price: currentPrice,
      },
      txHash
    );
  } else {
    logger.error("Trade execution failed", {
      orderId: order.id,
      symbol: order.symbol,
      error: result.error,
      txHash,
    });
  }

  return result;
}

/** Resolve trade size — operator USD amount overrides strategy sizing for manual trades. */
function resolveTradeSizeUsd(
  signal: TradeSignal,
  riskManager: RiskManager,
  opts: { manual?: boolean; amountUsd?: number }
): { tradeSizeUsd: number; fromTokenAmount?: number } {
  const explicit = opts.manual && opts.amountUsd !== undefined && opts.amountUsd > 0;

  if (explicit) {
    if (signal.action === "buy") {
      const cash = riskManager.getPortfolio().getSpendableCash();
      return { tradeSizeUsd: Math.min(opts.amountUsd!, cash) };
    }
    const pos = riskManager.getPortfolio().getPosition(signal.symbol);
    if (!pos) return { tradeSizeUsd: 0 };
    const price = getLatestPrice(signal.symbol) ?? pos.avgEntryPrice;
    if (price <= 0) return { tradeSizeUsd: 0 };
    const maxUsd = pos.amount * price;
    const usd = Math.min(opts.amountUsd!, maxUsd);
    return {
      tradeSizeUsd: usd,
      fromTokenAmount: usd / price,
    };
  }

  return { tradeSizeUsd: riskManager.computeTradeSize(signal) };
}

/**
 * Full pre-trade validation pipeline.
 * Returns { approved, order?, violations? }.
 */
export function validateAndCreateOrder(
  signal: TradeSignal,
  riskManager: RiskManager,
  config: AgentConfig,
  opts: { manual?: boolean; amountUsd?: number } = {}
): { approved: boolean; order?: TradeOrder; violations?: string[] } {
  // Tradeable on BSC = curated allowlist OR any token we can resolve to a
  // verified BEP-20 contract (static map / runtime CMC cache). This lifts the
  // hard allowlist limit so the assistant can trade arbitrary BSC tokens.
  if (!isEligibleToken(signal.symbol) && !hasBscSwapAddress(signal.symbol)) {
    return {
      approved: false,
      violations: [`No verified bStock / BEP-20 contract for ${signal.symbol} on BSC — cannot route swap`],
    };
  }

  if (
    signal.action === "buy" &&
    !opts.manual &&
    !isTradableToken(signal.symbol, getLatestPrice(signal.symbol) ?? undefined)
  ) {
    return {
      approved: false,
      violations: [`${signal.symbol} is blocklisted or below min tradable price`],
    };
  }

  if (signal.action === "hold") {
    return { approved: false, violations: ["Signal is HOLD — no trade needed"] };
  }

  // Skip buys we can't route on BSC (no verified BEP-20 contract address).
  // Prevents wasted attempts / TOKEN_NOT_FOUND errors on the next candidate.
  if (signal.action === "buy" && !hasBscSwapAddress(signal.symbol)) {
    return {
      approved: false,
      violations: [`No verified BSC contract address for ${signal.symbol} — cannot route swap`],
    };
  }

  const explicitAmount = opts.manual && opts.amountUsd !== undefined && opts.amountUsd > 0;
  const { tradeSizeUsd: tradeSize, fromTokenAmount } = resolveTradeSizeUsd(
    signal,
    riskManager,
    opts
  );
  if (tradeSize <= 0) {
    return { approved: false, violations: ["Computed trade size is zero"] };
  }

  const riskCheck = riskManager.validateTrade(signal, tradeSize, {
    ...opts,
    explicitAmount,
  });
  if (!riskCheck.passed) {
    return { approved: false, violations: riskCheck.violations };
  }

  let fundingCurrency: string | undefined;
  if (signal.action === "buy") {
    fundingCurrency = selectFundingCurrency(
      riskManager.getPortfolio(),
      tradeSize,
      config.swapCurrencies
    ) ?? undefined;
    if (!fundingCurrency) {
      return {
        approved: false,
        violations: [
          `Insufficient USDT balance for $${tradeSize.toFixed(2)}`,
        ],
      };
    }
  }

  const order = createTradeOrder(
    signal,
    tradeSize,
    config,
    fundingCurrency,
    signal.action === "sell"
      ? fromTokenAmount ?? riskManager.getPortfolio().getPosition(signal.symbol)?.amount
      : undefined
  );

  logger.info("Trade order approved", {
    orderId: order.id,
    symbol: signal.symbol,
    side: order.side,
    amountUsd: tradeSize,
    ...(order.fromTokenAmount !== undefined
      ? { fromTokenAmount: order.fromTokenAmount }
      : {}),
    funding: order.fromToken,
    strength: signal.strength,
    score: Math.round(signal.score),
  });
  return { approved: true, order };
}

/**
 * Apply a successful trade result to the portfolio tracker.
 */
export function applyTradeToPortfolio(
  order: TradeOrder,
  result: TradeResult,
  portfolio: PortfolioTracker
) {
  if (!result.success || !result.txHash) return;

  portfolio.recordTrade(result);

  if (order.side === "buy") {
    const tokenAmount = result.toAmount
      ? parseFloat(result.toAmount)
      : order.amountUsd / result.priceAtExecution;
    portfolio.recordBuy(
      order.symbol,
      order.amountUsd,
      tokenAmount,
      result.priceAtExecution,
      order.fromToken
    );  } else {
    const pos = portfolio.getPosition(order.symbol);
    if (pos) {
      const soldTokens = result.fromAmount
        ? parseFloat(result.fromAmount)
        : order.fromTokenAmount ?? pos.amount;
      const receivedUsd = result.toAmount
        ? parseFloat(result.toAmount)
        : order.amountUsd;
      const price =
        result.priceAtExecution > 0
          ? result.priceAtExecution
          : soldTokens > 0
            ? receivedUsd / soldTokens
            : 0;
      const realizedPnl = portfolio.recordSell(
        order.symbol,
        soldTokens,
        receivedUsd,
        price
      );
      result.realizedPnl = realizedPnl;
    }
  }
}
