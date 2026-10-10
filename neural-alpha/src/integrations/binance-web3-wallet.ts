import { logger } from "../utils/logger.js";
import type { PortfolioHolding } from "../utils/types.js";
import { normalizeBinanceIcon } from "./binance-web3-market.js";
import { filterVerifiedWalletPositions, isVerifiedWalletPosition } from "./wallet-position-filter.js";

const BINANCE_WEB3_BASE =
  "https://web3.binance.com/bapi/defi/v3/public/wallet-direct/buw/wallet/address/pnl/active-position-list/ai";

const DEFAULT_HEADERS = {
  clienttype: "web",
  clientversion: "1.2.0",
  "User-Agent": "binance-web3/1.1 (NeuralAlpha)",
};

/** BSC mainnet chain ID */
export const BSC_CHAIN_ID = "56";

export interface BinanceWeb3Position {
  chainId: string;
  address: string;
  contractAddress: string;
  name: string;
  symbol: string;
  icon?: string;
  decimals: number;
  price: number;
  percentChange24h: number;
  remainQty: number;
  valueUsd: number;
  /** Average buy price across this wallet's swaps (0 when Binance has none). */
  avgPrice?: number;
}

interface BinanceWeb3Response {
  code?: string;
  success?: boolean;
  data?: {
    list?: Array<Record<string, unknown>>;
  };
}

function parseNum(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

/** Same token on the same chain. Contract wins; native coins (BNB) key off the symbol. */
export function walletPositionKey(pos: {
  symbol: string;
  contractAddress?: string;
  chainId?: string;
}): string {
  const contract = (pos.contractAddress ?? "").trim().toLowerCase();
  const chain = pos.chainId ?? "";
  return contract ? `${chain}:${contract}` : `${chain}:${pos.symbol.toUpperCase()}`;
}

/** Collapse repeated pages of the same holding so NAV is not summed once per copy. */
export function dedupeWalletPositions<
  T extends { symbol: string; contractAddress?: string; chainId?: string },
>(positions: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const pos of positions) {
    const key = walletPositionKey(pos);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pos);
  }
  return out;
}

function parsePosition(row: Record<string, unknown>): BinanceWeb3Position | null {
  const symbol = String(row.symbol ?? row.tokenSymbol ?? "").toUpperCase();
  if (!symbol) return null;

  const remainQty = parseNum(row.remainQty ?? row.quantity);
  const price = parseNum(row.price ?? row.priceUsd);
  const valueUsd = remainQty > 0 && price > 0 ? remainQty * price : 0;
  const avgPrice = parseNum(row.buyCnt) > 0 ? parseNum(row.avgPrice) : 0;

  return {
    chainId: String(row.chainId ?? BSC_CHAIN_ID),
    address: String(row.address ?? row.walletAddress ?? ""),
    contractAddress: String(row.contractAddress ?? ""),
    name: String(row.name ?? row.tokenName ?? symbol),
    symbol,
    icon: normalizeBinanceIcon(
      row.icon ? String(row.icon) : row.iconUrl ? String(row.iconUrl) : undefined
    ),
    decimals: parseNum(row.decimals) || 18,
    price,
    percentChange24h: parseNum(row.percentChange24h ?? row.priceChange24h),
    remainQty,
    valueUsd,
    ...(avgPrice > 0 ? { avgPrice } : {}),
  };
}

/**
 * Fetch all token positions for a wallet from Binance Web3 public API.
 * Paginates until the list is empty or shorter than a page.
 */
export async function fetchWalletPositions(
  address: string,
  chainId: string = BSC_CHAIN_ID
): Promise<BinanceWeb3Position[]> {
  const all: BinanceWeb3Position[] = [];
  const seen = new Set<string>();
  let offset = 0;
  const pageSize = 50;

  while (true) {
    const url = `${BINANCE_WEB3_BASE}?address=${encodeURIComponent(address)}&chainId=${chainId}&offset=${offset}`;
    let json: BinanceWeb3Response;
    try {
      const res = await fetch(url, { headers: DEFAULT_HEADERS });
      if (!res.ok) {
        logger.warn("Binance Web3 wallet API error", { status: res.status, offset });
        break;
      }
      json = (await res.json()) as BinanceWeb3Response;
    } catch (err) {
      logger.warn("Binance Web3 wallet API fetch failed", { error: String(err), offset });
      break;
    }

    const list = json.data?.list ?? [];
    if (!Array.isArray(list) || list.length === 0) break;

    let added = 0;
    for (const row of list) {
      const pos = parsePosition(row as Record<string, unknown>);
      if (!pos || !(pos.remainQty > 0)) continue;
      const key = walletPositionKey(pos);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(pos);
      added++;
    }

    // active-position-list ignores `offset` and repeats page 1. A full page
    // used to be fetched until the 500-row cap — 11 copies, and NAV ×11.
    if (added === 0 || list.length < pageSize) break;
    offset += list.length;
    if (offset > 500) break; // safety cap
  }

  const verified = filterVerifiedWalletPositions(all);
  const dropped = all.length - verified.length;
  if (dropped > 0) {
    const spamSymbols = all
      .filter((p) => !isVerifiedWalletPosition(p))
      .map((p) => `${p.symbol}${p.contractAddress ? `@${p.contractAddress.slice(0, 10)}` : ""}`)
      .slice(0, 12);
    logger.info("Filtered wallet spam / fake-ticker tokens", {
      dropped,
      examples: spamSymbols,
    });
  }

  return verified;
}

/** Convert Binance Web3 positions to PortfolioHolding format. */
export function positionsToHoldings(positions: BinanceWeb3Position[]): PortfolioHolding[] {
  return positions.map((p) => ({
    symbol: p.symbol,
    amount: p.remainQty,
    priceUsd: p.price > 0 ? p.price : undefined,
    valueUsd: p.valueUsd > 0 ? p.valueUsd : undefined,
  }));
}

/** Get USDT balance from Binance Web3 positions. */
export async function getUsdtBalance(address: string, chainId?: string): Promise<number> {
  const positions = await fetchWalletPositions(address, chainId);
  const usdt = positions.find((p) => p.symbol === "USDT");
  return usdt?.remainQty ?? 0;
}

/** Get balance for a specific token symbol. */
export async function getTokenBalance(
  address: string,
  symbol: string,
  chainId?: string
): Promise<number> {
  const positions = await fetchWalletPositions(address, chainId);
  const match = positions.find((p) => p.symbol === symbol.toUpperCase());
  return match?.remainQty ?? 0;
}

/** Fetch holdings in PortfolioHolding format for agent sync. */
export async function fetchBinanceWeb3Holdings(
  address: string,
  chainId?: string
): Promise<PortfolioHolding[]> {
  const positions = await fetchWalletPositions(address, chainId);
  return positionsToHoldings(positions);
}
