import type { TradeResult } from "../utils/types.js";
import { fetchBinanceWeb3TradeActivity } from "./binance-web3-trade-history.js";
import { fetchOnChainTradeHistory as fetchBscScanTradeHistory } from "./bsc-trade-history.js";
import { fetchRpcTradeHistory } from "./bsc-rpc-trade-history.js";
import { logger } from "../utils/logger.js";

function mergeByOrderId(primary: TradeResult[], secondary: TradeResult[]): TradeResult[] {
  const seen = new Set(primary.map((t) => t.orderId));
  const seenHashes = new Set(
    primary.map((t) => t.txHash?.toLowerCase()).filter(Boolean) as string[]
  );
  const merged = [...primary];
  for (const t of secondary) {
    if (seen.has(t.orderId)) continue;
    if (t.txHash && seenHashes.has(t.txHash.toLowerCase())) continue;
    merged.push(t);
    seen.add(t.orderId);
  }
  merged.sort((a, b) => b.timestamp - a.timestamp);
  return merged.slice(0, 50);
}

function dropBinanceAggregateIfRealPresent(trades: TradeResult[]): TradeResult[] {
  const hasReal = trades.some((t) => t.txHash && /^0x[a-fA-F0-9]{64}$/.test(t.txHash));
  if (!hasReal) return trades;
  return trades.filter((t) => !t.txHash?.startsWith("binance-web3-"));
}

/**
 * Load wallet trade history for Recent Trades backfill:
 * 1. BscScan/Etherscan v2 (per-tx, paid BSC plan)
 * 2. BSC public RPC block scan (per-tx, free — real hashes + block timestamps)
 * 3. Binance Web3 aggregate (summary rows — last resort)
 */
export async function fetchWalletTradeHistory(
  walletAddress: string,
  limit = 50
): Promise<TradeResult[]> {
  const bsc = await fetchBscScanTradeHistory(walletAddress, limit);
  if (bsc.length >= limit) return bsc;

  const rpc = await fetchRpcTradeHistory(walletAddress, limit);
  if (rpc.length >= limit) return dropBinanceAggregateIfRealPresent(mergeByOrderId(bsc, rpc)).slice(0, limit);

  const binance = await fetchBinanceWeb3TradeActivity(walletAddress, limit);
  if (bsc.length === 0 && rpc.length === 0 && binance.length === 0) {
    logger.info("No wallet trade history from BscScan, RPC, or Binance Web3", {
      wallet: walletAddress.slice(0, 10) + "…",
    });
    return [];
  }

  const merged = dropBinanceAggregateIfRealPresent(mergeByOrderId(mergeByOrderId(bsc, rpc), binance));
  logger.info("Wallet trade history merged", {
    bsc: bsc.length,
    rpc: rpc.length,
    binance: binance.length,
    total: merged.length,
  });
  return merged;
}
