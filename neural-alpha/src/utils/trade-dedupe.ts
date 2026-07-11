import type { TradeResult } from "./types.js";

const ON_CHAIN_TX = /^0x[a-fA-F0-9]{64}$/;

/** Prefer agent-recorded trades over chain-backfill rows for the same tx. */
export function preferTradeRecord(
  existing: TradeResult,
  incoming: TradeResult
): TradeResult {
  const existingChain = existing.orderId.startsWith("chain-");
  const incomingChain = incoming.orderId.startsWith("chain-");
  if (existingChain && !incomingChain) return incoming;
  if (!existingChain && incomingChain) return existing;

  const existingBinance = existing.txHash?.startsWith("binance-web3-") ?? false;
  const incomingBinance = incoming.txHash?.startsWith("binance-web3-") ?? false;
  if (existingBinance && !incomingBinance) return incoming;
  if (!existingBinance && incomingBinance) return existing;

  return incoming.timestamp >= existing.timestamp ? incoming : existing;
}

export function tradeDedupeKey(trade: TradeResult): string {
  const hash = trade.txHash?.toLowerCase();
  if (hash && ON_CHAIN_TX.test(hash)) return `hash:${hash}`;
  if (hash?.startsWith("binance-web3-")) return `binance:${hash}`;
  return `order:${trade.orderId}`;
}

/** Collapse duplicate rows (same tx hash, agent + chain backfill, etc.). */
export function dedupeTradeResults(trades: TradeResult[]): TradeResult[] {
  const byKey = new Map<string, TradeResult>();
  for (const t of trades) {
    const key = tradeDedupeKey(t);
    const prev = byKey.get(key);
    byKey.set(key, prev ? preferTradeRecord(prev, t) : t);
  }
  return [...byKey.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** Drop Binance aggregate summary rows when a real on-chain tx exists for the symbol. */
export function dropBinanceAggregateDuplicates(trades: TradeResult[]): TradeResult[] {
  const hasRealHash = trades.some((t) => t.txHash && ON_CHAIN_TX.test(t.txHash));
  if (!hasRealHash) return trades;
  return trades.filter((t) => !t.txHash?.startsWith("binance-web3-"));
}

export function dedupeAndCleanTradeResults(trades: TradeResult[]): TradeResult[] {
  return dedupeTradeResults(dropBinanceAggregateDuplicates(trades));
}
