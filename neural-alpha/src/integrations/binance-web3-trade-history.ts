import { BSC_CHAIN_ID } from "./binance-web3-wallet.js";
import { logger } from "../utils/logger.js";
import type { TradeResult } from "../utils/types.js";

const POSITIONS_URL =
  "https://web3.binance.com/bapi/defi/v3/public/wallet-direct/buw/wallet/address/pnl/active-position-list/ai";

const DEFAULT_HEADERS = {
  clienttype: "web",
  clientversion: "1.2.0",
  "User-Agent": "binance-web3/1.1 (NeuralAlpha)",
};

const STABLES = new Set(["USDT", "USDC", "BUSD", "DAI", "FDUSD", "BNB"]);

interface BinancePositionRow {
  symbol?: string;
  remainQty?: string | number;
  swapAmount?: string | number;
  buyCnt?: string | number | null;
  sellCnt?: string | number | null;
  buyAmtUsd?: string | number | null;
  sellAmtUsd?: string | number | null;
  avgPrice?: string | number | null;
  lastTxTime?: string | number | null;
}

async function fetchRawPositions(address: string): Promise<BinancePositionRow[]> {
  const all: BinancePositionRow[] = [];
  let offset = 0;
  while (offset <= 500) {
    const url = `${POSITIONS_URL}?address=${encodeURIComponent(address)}&chainId=${BSC_CHAIN_ID}&offset=${offset}`;
    const res = await fetch(url, { headers: DEFAULT_HEADERS });
    if (!res.ok) break;
    const json = (await res.json()) as { data?: { list?: BinancePositionRow[] } };
    const list = json.data?.list ?? [];
    if (list.length === 0) break;
    all.push(...list);
    if (list.length < 50) break;
    offset += list.length;
  }
  return all;
}

function parseNum(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

function rowToActivityTrades(row: BinancePositionRow): TradeResult[] {
  const symbol = String(row.symbol ?? "").toUpperCase();
  if (STABLES.has(symbol)) return [];

  const buyCnt = parseNum(row.buyCnt);
  const sellCnt = parseNum(row.sellCnt);
  const buyUsd = parseNum(row.buyAmtUsd);
  const sellUsd = parseNum(row.sellAmtUsd);
  const avgPrice = parseNum(row.avgPrice);
  const lastTx = parseNum(row.lastTxTime);
  const qty = parseNum(row.remainQty) || parseNum(row.swapAmount);

  if (buyCnt <= 0 && sellCnt <= 0) return [];
  if (!lastTx) return [];

  const trades: TradeResult[] = [];
  const tsBase = lastTx;

  if (buyCnt > 0 && buyUsd > 0) {
    const tokenQty = avgPrice > 0 ? buyUsd / avgPrice : qty;
    trades.push({
      orderId: `binance-buy-${symbol}-${Math.floor(tsBase)}`,
      success: true,
      txHash: `binance-web3-${symbol.toLowerCase()}-buy`,
      fromToken: "USDT",
      toToken: symbol,
      fromAmount: String(buyUsd),
      toAmount: tokenQty > 0 ? String(tokenQty) : undefined,
      priceAtExecution: avgPrice > 0 ? avgPrice : tokenQty > 0 ? buyUsd / tokenQty : 0,
      timestamp: sellCnt > 0 ? tsBase - 1 : tsBase,
    });
  }

  if (sellCnt > 0 && sellUsd > 0) {
    const tokenQty = avgPrice > 0 ? sellUsd / avgPrice : qty;
    trades.push({
      orderId: `binance-sell-${symbol}-${Math.floor(tsBase)}`,
      success: true,
      txHash: `binance-web3-${symbol.toLowerCase()}-sell`,
      fromToken: symbol,
      toToken: "USDT",
      fromAmount: tokenQty > 0 ? String(tokenQty) : String(sellUsd / (avgPrice || 1)),
      toAmount: String(sellUsd),
      priceAtExecution: avgPrice > 0 ? avgPrice : 0,
      timestamp: tsBase,
    });
  }

  return trades;
}

/**
 * Binance Web3 public API does NOT expose per-transaction swap history — only
 * aggregate buy/sell stats per token on the active-position-list endpoint.
 * This builds summary trade rows (no individual tx hash) for Recent Trades.
 * No API key required — same source as wallet holdings sync.
 */
export async function fetchBinanceWeb3TradeActivity(
  walletAddress: string,
  limit = 50
): Promise<TradeResult[]> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) return [];

  try {
    const positions = await fetchRawPositions(walletAddress);
    const trades = positions.flatMap(rowToActivityTrades);
    trades.sort((a, b) => b.timestamp - a.timestamp);
    const trimmed = trades.slice(0, limit);
    logger.info("Binance Web3 trade activity loaded", {
      wallet: walletAddress.slice(0, 10) + "…",
      tokens: positions.filter((p) => parseNum(p.buyCnt) || parseNum(p.sellCnt)).length,
      rows: trimmed.length,
    });
    return trimmed;
  } catch (err) {
    logger.warn("Binance Web3 trade activity fetch failed", { error: String(err) });
    return [];
  }
}
