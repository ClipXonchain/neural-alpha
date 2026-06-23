import { BSC_USDT_ADDRESS, STABLECOINS } from "../config.js";
import { BSC_TOKEN_ADDRESSES } from "./bsc-token-addresses.js";
import { logger } from "../utils/logger.js";
import type { TradeResult } from "../utils/types.js";

const ETHERSCAN_V2 = "https://api.etherscan.io/v2/api";
const BSC_CHAIN_ID = "56";
const NATIVE_GAS = new Set(["BNB"]);

/** contract (lower) → symbol */
const ADDRESS_TO_SYMBOL: Record<string, string> = (() => {
  const map: Record<string, string> = {
    [BSC_USDT_ADDRESS.toLowerCase()]: "USDT",
  };
  for (const [sym, addr] of Object.entries(BSC_TOKEN_ADDRESSES)) {
    map[addr.toLowerCase()] = sym.toUpperCase();
  }
  return map;
})();

const STABLE_SET = new Set([...STABLECOINS, "BNB"]);

interface EtherscanTokenTx {
  hash: string;
  from: string;
  to: string;
  value: string;
  tokenSymbol?: string;
  tokenDecimal?: string;
  contractAddress: string;
  timeStamp: string;
}

interface ParsedTransfer {
  hash: string;
  from: string;
  to: string;
  amount: number;
  symbol: string;
  timestamp: number;
}

function parseTokenAmount(value: string, decimals: number): number {
  const raw = BigInt(value || "0");
  const base = 10n ** BigInt(Math.min(decimals, 18));
  return Number(raw) / Number(base);
}

function resolveSymbol(row: EtherscanTokenTx): string {
  const fromMap = ADDRESS_TO_SYMBOL[row.contractAddress?.toLowerCase() ?? ""];
  if (fromMap) return fromMap;
  const sym = String(row.tokenSymbol ?? "").toUpperCase().trim();
  return sym || "UNKNOWN";
}

function isStable(symbol: string): boolean {
  return STABLE_SET.has(symbol.toUpperCase());
}

async function fetchTokenTransfers(
  walletAddress: string,
  apiKey: string,
  maxPages = 3
): Promise<EtherscanTokenTx[]> {
  const all: EtherscanTokenTx[] = [];
  const pageSize = 100;

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({
      chainid: BSC_CHAIN_ID,
      module: "account",
      action: "tokentx",
      address: walletAddress,
      page: String(page),
      offset: String(pageSize),
      sort: "desc",
      apikey: apiKey,
    });

    const res = await fetch(`${ETHERSCAN_V2}?${params}`);
    if (!res.ok) {
      throw new Error(`BscScan API HTTP ${res.status}`);
    }

    const json = (await res.json()) as {
      status?: string;
      message?: string;
      result?: EtherscanTokenTx[] | string;
    };

    if (json.status !== "1" || !Array.isArray(json.result)) {
      const msg = typeof json.result === "string" ? json.result : json.message ?? "unknown";
      if (page === 1) throw new Error(`BscScan tokentx: ${msg}`);
      break;
    }

    all.push(...json.result);
    if (json.result.length < pageSize) break;
  }

  return all;
}

function toParsedTransfers(rows: EtherscanTokenTx[]): ParsedTransfer[] {
  const out: ParsedTransfer[] = [];
  for (const row of rows) {
    const decimals = parseInt(row.tokenDecimal ?? "18", 10) || 18;
    const amount = parseTokenAmount(row.value, decimals);
    if (!(amount > 0)) continue;
    out.push({
      hash: row.hash,
      from: row.from.toLowerCase(),
      to: row.to.toLowerCase(),
      amount,
      symbol: resolveSymbol(row),
      timestamp: parseInt(row.timeStamp, 10) * 1000,
    });
  }
  return out;
}

/**
 * Infer USDT↔token swaps from grouped ERC-20 transfers in each transaction.
 * Handles typical PancakeSwap / router swap patterns (stable out + token in, or reverse).
 */
function inferSwapsFromTransfers(
  walletAddress: string,
  transfers: ParsedTransfer[]
): TradeResult[] {
  const wallet = walletAddress.toLowerCase();
  const byHash = new Map<string, ParsedTransfer[]>();

  for (const t of transfers) {
    if (t.from !== wallet && t.to !== wallet) continue;
    const list = byHash.get(t.hash) ?? [];
    list.push(t);
    byHash.set(t.hash, list);
  }

  const trades: TradeResult[] = [];
  const seen = new Set<string>();

  for (const [hash, legs] of byHash) {
    const outgoing = legs.filter((l) => l.from === wallet);
    const incoming = legs.filter((l) => l.to === wallet);
    if (outgoing.length === 0 || incoming.length === 0) continue;

    const stableOut = outgoing.filter((l) => isStable(l.symbol));
    const stableIn = incoming.filter((l) => isStable(l.symbol));
    const tokenOut = outgoing.filter((l) => !isStable(l.symbol) && !NATIVE_GAS.has(l.symbol));
    const tokenIn = incoming.filter((l) => !isStable(l.symbol) && !NATIVE_GAS.has(l.symbol));

    const ts = Math.max(...legs.map((l) => l.timestamp));

    // Buy: spent stable (USDT), received token
    if (stableOut.length > 0 && tokenIn.length > 0) {
      const spent = stableOut.sort((a, b) => b.amount - a.amount)[0];
      const received = tokenIn.sort((a, b) => b.amount - a.amount)[0];
      if (received.symbol === "UNKNOWN") continue;
      const key = `${hash}-buy-${received.symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const price = received.amount > 0 ? spent.amount / received.amount : 0;
      trades.push({
        orderId: `chain-${hash.slice(2, 12)}-buy-${received.symbol}`,
        success: true,
        txHash: hash,
        fromToken: spent.symbol,
        toToken: received.symbol,
        fromAmount: String(spent.amount),
        toAmount: String(received.amount),
        priceAtExecution: price,
        timestamp: ts,
      });
    }

    // Sell: sent token, received stable
    if (tokenOut.length > 0 && stableIn.length > 0) {
      const sold = tokenOut.sort((a, b) => b.amount - a.amount)[0];
      const received = stableIn.sort((a, b) => b.amount - a.amount)[0];
      if (sold.symbol === "UNKNOWN") continue;
      const key = `${hash}-sell-${sold.symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const price = sold.amount > 0 ? received.amount / sold.amount : 0;
      trades.push({
        orderId: `chain-${hash.slice(2, 12)}-sell-${sold.symbol}`,
        success: true,
        txHash: hash,
        fromToken: sold.symbol,
        toToken: received.symbol,
        fromAmount: String(sold.amount),
        toAmount: String(received.amount),
        priceAtExecution: price,
        timestamp: ts,
      });
    }
  }

  return trades.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Fetch recent swap-like activity for a BSC wallet via Etherscan API v2 (BSC chainid=56).
 * Requires BSCSCAN_API_KEY (free tier works). Returns newest-first up to `limit`.
 */
export async function fetchOnChainTradeHistory(
  walletAddress: string,
  limit = 50
): Promise<TradeResult[]> {
  const apiKey = process.env.BSCSCAN_API_KEY?.trim();
  if (!apiKey) {
    logger.warn("BSCSCAN_API_KEY not set — cannot backfill trade history from chain");
    return [];
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
    return [];
  }

  try {
    const rows = await fetchTokenTransfers(walletAddress, apiKey, 5);
    const transfers = toParsedTransfers(rows);
    const swaps = inferSwapsFromTransfers(walletAddress, transfers);
    const trimmed = swaps.slice(-limit).reverse();
    logger.info("On-chain trade history fetched", {
      wallet: walletAddress.slice(0, 10) + "…",
      transfers: transfers.length,
      swaps: trimmed.length,
    });
    return trimmed;
  } catch (err) {
    logger.warn("On-chain trade history fetch failed", { error: String(err) });
    return [];
  }
}
