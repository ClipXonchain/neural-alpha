import type { TradeOrder, TradeResult, TradeSignal, AgentConfig } from "../utils/types.js";
import { BSC_CHAIN, isEligibleToken } from "../config.js";
import { RiskManager } from "../risk/manager.js";
import { PortfolioTracker } from "../risk/portfolio.js";
import { logger } from "../utils/logger.js";

/**
 * Trade executor that routes all swaps through TWAK MCP.
 * This module constructs trade orders and processes results.
 * Actual MCP calls (swap, get_swap_quote) are invoked by the
 * agent orchestrator and results are fed back here.
 *
 * Design: TWAK is the SOLE execution layer — no direct RPC calls,
 * no custodial intermediaries. Keys stay with the user's local
 * wallet (self-custody integrity for the TWAK special prize).
 */

let orderCounter = 0;

export function createTradeOrder(
  signal: TradeSignal,
  amountUsd: number,
  config: AgentConfig
): TradeOrder {
  orderCounter++;
  const id = `order-${Date.now()}-${orderCounter}`;

  const isBuy = signal.action === "buy";
  return {
    id,
    timestamp: Date.now(),
    symbol: signal.symbol,
    side: isBuy ? "buy" : "sell",
    amountUsd,
    fromToken: isBuy ? config.baseCurrency : signal.symbol,
    toToken: isBuy ? signal.symbol : config.baseCurrency,
    slippage: config.slippageTolerance,
  };
}

/**
 * Build the TWAK MCP swap parameters from a TradeOrder.
 * Returns the argument object to pass to CallMcpTool("swap").
 */
export function buildSwapParams(order: TradeOrder): {
  fromChain: string;
  fromToken: string;
  toChain: string;
  toToken: string;
  amount: string;
  slippage: string;
} {
  return {
    fromChain: BSC_CHAIN,
    fromToken: order.fromToken,
    toChain: BSC_CHAIN,
    toToken: order.toToken,
    amount: String(order.amountUsd),
    slippage: String(order.slippage),
  };
}

/**
 * Build TWAK MCP quote parameters for pre-trade price check.
 */
export function buildQuoteParams(order: TradeOrder): {
  fromChain: string;
  fromToken: string;
  toChain: string;
  toToken: string;
  amount: string;
} {
  return {
    fromChain: BSC_CHAIN,
    fromToken: order.fromToken,
    toChain: BSC_CHAIN,
    toToken: order.toToken,
    amount: String(order.amountUsd),
  };
}

/**
 * Process the swap result from TWAK MCP into our TradeResult format.
 */
export function processSwapResult(
  order: TradeOrder,
  mcpResult: Record<string, unknown>,
  currentPrice: number
): TradeResult {
  const success = !mcpResult.error;
  const txHash = (mcpResult.txHash || mcpResult.hash || mcpResult.transactionHash) as string | undefined;
  const toAmount = mcpResult.toAmount as string | undefined;

  const result: TradeResult = {
    orderId: order.id,
    success,
    txHash,
    fromToken: order.fromToken,
    toToken: order.toToken,
    fromAmount: String(order.amountUsd),
    toAmount,
    priceAtExecution: currentPrice,
    timestamp: Date.now(),
    error: mcpResult.error as string | undefined,
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
      error: mcpResult.error,
    });
  }

  return result;
}

/**
 * Full pre-trade validation pipeline.
 * Returns { approved, order?, violations? }.
 */
export function validateAndCreateOrder(
  signal: TradeSignal,
  riskManager: RiskManager,
  config: AgentConfig
): { approved: boolean; order?: TradeOrder; violations?: string[] } {
  // Hard token eligibility check
  if (!isEligibleToken(signal.symbol)) {
    return {
      approved: false,
      violations: [`${signal.symbol} is not on the eligible BEP-20 token list`],
    };
  }

  if (signal.action === "hold") {
    return { approved: false, violations: ["Signal is HOLD — no trade needed"] };
  }

  const tradeSize = riskManager.computeTradeSize(signal);
  if (tradeSize <= 0) {
    return { approved: false, violations: ["Computed trade size is zero"] };
  }

  const riskCheck = riskManager.validateTrade(signal, tradeSize);
  if (!riskCheck.passed) {
    return { approved: false, violations: riskCheck.violations };
  }

  const order = createTradeOrder(signal, tradeSize, config);

  logger.info("Trade order approved", {
    orderId: order.id,
    symbol: signal.symbol,
    side: order.side,
    amountUsd: tradeSize,
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
  if (!result.success) return;

  portfolio.recordTrade(result);

  if (order.side === "buy") {
    const tokenAmount = result.toAmount
      ? parseFloat(result.toAmount)
      : order.amountUsd / result.priceAtExecution;
    portfolio.recordBuy(order.symbol, order.amountUsd, tokenAmount, result.priceAtExecution);
  } else {
    const pos = portfolio.getPosition(order.symbol);
    if (pos) {
      portfolio.recordSell(order.symbol, pos.amount, order.amountUsd, result.priceAtExecution);
    }
  }
}
