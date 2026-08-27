import type { TradeResult } from "./types.js";

const ON_CHAIN_TX = /^0x[a-fA-F0-9]{64}$/;

/** Campaign payment tokens + common stables. Address form of BSC USDT also counts. */
const FUNDING_TOKENS = new Set([
  "USDT", "USDC", "U", "USD1", "BNB", "WBNB", "BUSD", "DAI", "FDUSD", "TUSD",
]);
const BSC_USDT_ADDRESS = "0x55d398326f99059ff775485246999027b3197955";

export function isOnChainTxHash(hash?: string): boolean {
  return !!hash && ON_CHAIN_TX.test(hash);
}

export function isFundingToken(token: string): boolean {
  const t = token.trim();
  if (!t) return false;
  if (t.toLowerCase() === BSC_USDT_ADDRESS) return true;
  return FUNDING_TOKENS.has(t.toUpperCase());
}

/** Tokenized US stocks use a trailing `B` (NVDAB, LINKB). Funding coins like BNB are excluded. */
export function looksLikeBstock(token: string): boolean {
  if (isFundingToken(token)) return false;
  return /^[A-Z0-9]{2,12}B$/.test(token.trim().toUpperCase());
}

/**
 * Buy = funding → asset. Sell = asset → funding.
 * bStock → unknown quote (contract address, unusual ticker) is still a sell.
 */
export function classifyAssetTrade(fromToken: string, toToken: string): "buy" | "sell" | null {
  const fromFund = isFundingToken(fromToken);
  const toFund = isFundingToken(toToken);
  if (fromFund && !toFund) return "buy";
  if (!fromFund && toFund) return "sell";
  if (looksLikeBstock(fromToken) && !looksLikeBstock(toToken)) return "sell";
  if (!looksLikeBstock(fromToken) && looksLikeBstock(toToken)) return "buy";
  return null;
}

export function tradeAssetSymbol(trade: TradeResult): string | null {
  const side = classifyAssetTrade(trade.fromToken, trade.toToken);
  if (side === "buy") return trade.toToken.toUpperCase();
  if (side === "sell") return trade.fromToken.toUpperCase();
  return null;
}

/** `SYMBOL:buy` / `SYMBOL:sell` — used to keep Binance aggregates only when no real tx exists. */
export function symbolSideKey(trade: TradeResult): string | null {
  const side = classifyAssetTrade(trade.fromToken, trade.toToken);
  const symbol = tradeAssetSymbol(trade);
  if (!side || !symbol) return null;
  return `${symbol}:${side}`;
}

export function realSymbolSideKeys(trades: TradeResult[]): Set<string> {
  const covered = new Set<string>();
  for (const t of trades) {
    if (!isOnChainTxHash(t.txHash)) continue;
    const key = symbolSideKey(t);
    if (key) covered.add(key);
  }
  return covered;
}

/** Prefer agent-recorded trades over chain-backfill rows for the same tx. */
export function preferTradeRecord(
  existing: TradeResult,
  incoming: TradeResult
): TradeResult {
  const existingChain = existing.orderId.startsWith("chain-");
  const incomingChain = incoming.orderId.startsWith("chain-");
  let chosen: TradeResult;
  if (existingChain && !incomingChain) chosen = incoming;
  else if (!existingChain && incomingChain) chosen = existing;
  else {
    const existingBinance = existing.txHash?.startsWith("binance-web3-") ?? false;
    const incomingBinance = incoming.txHash?.startsWith("binance-web3-") ?? false;
    if (existingBinance && !incomingBinance) chosen = incoming;
    else if (!existingBinance && incomingBinance) chosen = existing;
    else chosen = incoming.timestamp >= existing.timestamp ? incoming : existing;
  }

  const other = chosen === incoming ? existing : incoming;
  if (chosen.realizedPnl == null && other.realizedPnl != null) {
    return { ...chosen, realizedPnl: other.realizedPnl };
  }
  return chosen;
}

export function tradeDedupeKey(trade: TradeResult): string {
  const hash = trade.txHash?.toLowerCase();
  const side = classifyAssetTrade(trade.fromToken, trade.toToken) ?? "unk";
  if (hash && ON_CHAIN_TX.test(hash)) return `hash:${hash}:${side}`;
  if (hash?.startsWith("binance-web3-")) return `binance:${hash}`;
  return `order:${trade.orderId}`;
}

/** Collapse duplicate rows (same tx hash + side, agent + chain backfill, etc.). */
export function dedupeTradeResults(trades: TradeResult[]): TradeResult[] {
  const byKey = new Map<string, TradeResult>();
  for (const t of trades) {
    const key = tradeDedupeKey(t);
    const prev = byKey.get(key);
    byKey.set(key, prev ? preferTradeRecord(prev, t) : t);
  }
  return [...byKey.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Drop a Binance aggregate row only when a real 0x hash exists for the
 * same asset symbol and same side (buy vs sell). Agent-recorded buys must
 * not wipe Binance sell summaries for symbols with no on-chain sell tx.
 */
export function dropBinanceAggregateDuplicates(trades: TradeResult[]): TradeResult[] {
  const covered = realSymbolSideKeys(trades);
  if (covered.size === 0) return trades;
  return trades.filter((t) => {
    if (!t.txHash?.startsWith("binance-web3-")) return true;
    const key = symbolSideKey(t);
    return !key || !covered.has(key);
  });
}

export function dedupeAndCleanTradeResults(trades: TradeResult[]): TradeResult[] {
  return dedupeTradeResults(dropBinanceAggregateDuplicates(trades));
}
