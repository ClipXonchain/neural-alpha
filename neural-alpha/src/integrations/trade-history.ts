import type { TradeResult } from "../utils/types.js";
import {
  classifyAssetTrade,
  isOnChainTxHash,
  tradeDedupeKey,
  dropBinanceAggregateDuplicates,
} from "../utils/trade-dedupe.js";
import { fetchBinanceWeb3TradeActivity } from "./binance-web3-trade-history.js";
import { fetchOnChainTradeHistory as fetchBscScanTradeHistory } from "./bsc-trade-history.js";
import { fetchRpcRecentTradeHistory, fetchRpcTradeHistory } from "./bsc-rpc-trade-history.js";
import { logger } from "../utils/logger.js";

function capPreservingSells(trades: TradeResult[], limit: number): TradeResult[] {
  if (trades.length <= limit) return trades;
  const sells: TradeResult[] = [];
  const rest: TradeResult[] = [];
  for (const t of trades) {
    if (classifyAssetTrade(t.fromToken, t.toToken) === "sell") sells.push(t);
    else rest.push(t);
  }
  const keepSells = sells.slice(0, limit);
  const keepRest = rest.slice(0, Math.max(0, limit - keepSells.length));
  return [...keepSells, ...keepRest].sort((a, b) => b.timestamp - a.timestamp);
}

function mergeByDedupeKey(primary: TradeResult[], secondary: TradeResult[]): TradeResult[] {
  const seen = new Set(primary.map((t) => t.orderId));
  const seenKeys = new Set(primary.map(tradeDedupeKey));
  const merged = [...primary];
  for (const t of secondary) {
    if (seen.has(t.orderId)) continue;
    const key = tradeDedupeKey(t);
    if (seenKeys.has(key)) continue;
    merged.push(t);
    seen.add(t.orderId);
    seenKeys.add(key);
  }
  merged.sort((a, b) => b.timestamp - a.timestamp);
  return merged;
}

/**
 * Load wallet trade history for Recent Trades backfill:
 * 1. BscScan/Etherscan v2 (per-tx, paid BSC plan)
 * 2. BSC public RPC block scan (per-tx, free — real hashes + block timestamps)
 * 3. Binance Web3 aggregate (summary rows — last resort, per symbol+side)
 */
export async function fetchWalletTradeHistory(
  walletAddress: string,
  limit = 50
): Promise<TradeResult[]> {
  const recent = await fetchRpcRecentTradeHistory(walletAddress, limit);

  const bsc = await fetchBscScanTradeHistory(walletAddress, limit);
  const rpc =
    bsc.length >= limit ? [] : await fetchRpcTradeHistory(walletAddress, limit);

  let merged = mergeByDedupeKey(mergeByDedupeKey(recent, bsc), rpc);

  const binance = await fetchBinanceWeb3TradeActivity(walletAddress, limit);
  if (recent.length === 0 && bsc.length === 0 && rpc.length === 0 && binance.length === 0) {
    logger.info("No wallet trade history from BscScan, RPC, or Binance Web3", {
      wallet: walletAddress.slice(0, 10) + "…",
    });
    return [];
  }

  // Always consider Binance aggregates: dropBinanceAggregateDuplicates only
  // removes a summary row when a real 0x hash exists for that symbol+side.
  merged = dropBinanceAggregateDuplicates(mergeByDedupeKey(merged, binance));
  logger.info("Wallet trade history merged", {
    recent: recent.length,
    bsc: bsc.length,
    rpc: rpc.length,
    binance: binance.length,
    real: merged.filter((t) => isOnChainTxHash(t.txHash)).length,
    total: merged.length,
  });
  return capPreservingSells(merged, limit);
}
