import { BSC_USDT_ADDRESS, STABLECOINS } from "../config.js";
import { BSC_TOKEN_ADDRESSES } from "./bsc-token-addresses.js";
import { logger } from "../utils/logger.js";
import type { TradeResult } from "../utils/types.js";
import { fetchRawBinancePositions } from "./binance-web3-trade-history.js";

const DEFAULT_RPC_URLS = [
  "https://bsc-dataseed.binance.org/",
  "https://bsc-dataseed1.binance.org/",
  "https://bsc-dataseed2.binance.org/",
  "https://bsc.publicnode.com",
];

function rpcEndpoints(): string[] {
  const fromEnv = process.env.BSC_RPC_URLS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (fromEnv?.length) return fromEnv;
  const single = process.env.BSC_RPC_URL?.trim();
  if (single) return [single];
  return DEFAULT_RPC_URLS;
}

let rpcEndpointIndex = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Typical BSC inter-block time (~450–750ms; 3000ms breaks timestamp→block mapping). */
const BSC_BLOCK_TIME_MS =
  parseInt(process.env.BSC_BLOCK_TIME_MS || "500", 10) || 500;
/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const NATIVE_GAS = new Set(["BNB"]);
const STABLE_SET = new Set([...STABLECOINS, "BNB"]);

/** Binance Web3 lastTxTime is often ~9h ahead of on-chain block time. */
const BINANCE_TX_TIME_OFFSET_MS =
  parseInt(process.env.BINANCE_TX_TIME_OFFSET_MS || String(9 * 3600 * 1000), 10) || 0;

const ADDRESS_TO_SYMBOL: Record<string, string> = (() => {
  const map: Record<string, string> = { [BSC_USDT_ADDRESS.toLowerCase()]: "USDT" };
  for (const [sym, addr] of Object.entries(BSC_TOKEN_ADDRESSES)) {
    map[addr.toLowerCase()] = sym.toUpperCase();
  }
  return map;
})();

interface RpcBlock {
  number: string;
  timestamp: string;
  transactions?: Array<{ hash: string; from: string }>;
}

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
}

interface BlockRange {
  from: number;
  to: number;
}

function parseNum(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

function isStable(symbol: string): boolean {
  return STABLE_SET.has(symbol.toUpperCase());
}

function symbolForContract(address: string): string {
  return ADDRESS_TO_SYMBOL[address.toLowerCase()] ?? "UNKNOWN";
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const endpoints = rpcEndpoints();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < endpoints.length * 2; attempt++) {
    const url = endpoints[rpcEndpointIndex % endpoints.length]!;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const json = (await res.json()) as { result?: T; error?: { message?: string } };
      if (json.error) {
        const msg = json.error.message ?? "RPC error";
        if (/limit|rate|too many/i.test(msg)) {
          rpcEndpointIndex++;
          lastError = new Error(msg);
          await sleep(250);
          continue;
        }
        throw new Error(msg);
      }
      return json.result as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      rpcEndpointIndex++;
      await sleep(200);
    }
  }

  throw lastError ?? new Error("All BSC RPC endpoints failed");
}

async function getLatestBlock(): Promise<number> {
  const hex = await rpcCall<string>("eth_blockNumber", []);
  return parseInt(hex, 16);
}

let cachedHead: { block: number; ts: number } | null = null;

async function getChainHead(): Promise<{ block: number; ts: number }> {
  if (cachedHead) return cachedHead;
  const block = await getLatestBlock();
  const ts = await getBlockTimestamp(block);
  cachedHead = { block, ts };
  return cachedHead;
}

async function getBlockTimestamp(block: number): Promise<number> {
  const blockData = await rpcCall<RpcBlock>("eth_getBlockByNumber", [
    `0x${block.toString(16)}`,
    false,
  ]);
  return parseInt(blockData.timestamp, 16) * 1000;
}

async function findBlockNearTimestamp(targetMs: number): Promise<number> {
  const head = await getChainHead();
  const estimate = Math.max(
    1,
    Math.min(
      head.block,
      head.block - Math.round((head.ts - targetMs) / BSC_BLOCK_TIME_MS)
    )
  );
  let lo = Math.max(1, estimate - 1500);
  let hi = Math.min(head.block, estimate + 1500);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const ts = await getBlockTimestamp(mid);
    if (ts < targetMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function parseTransferLog(log: RpcLog, blockTimestampMs: number) {
  if (log.topics.length < 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return null;
  const from = ("0x" + log.topics[1]!.slice(-40)).toLowerCase();
  const to = ("0x" + log.topics[2]!.slice(-40)).toLowerCase();
  const contract = log.address.toLowerCase();
  const symbol = symbolForContract(contract);
  const raw = BigInt(log.data || "0x0");
  const amount = Number(raw) / 1e18;
  if (!(amount > 0)) return null;
  return { hash: log.transactionHash, from, to, amount, symbol, timestamp: blockTimestampMs };
}

async function parseSwapsFromTx(
  txHash: string,
  wallet: string,
  blockTimestampMs: number
): Promise<TradeResult[]> {
  const receipt = await rpcCall<{ logs: RpcLog[] }>("eth_getTransactionReceipt", [txHash]);
  const walletLower = wallet.toLowerCase();
  const transfers = receipt.logs
    .map((l) => parseTransferLog(l, blockTimestampMs))
    .filter(Boolean) as Array<{
    hash: string;
    from: string;
    to: string;
    amount: number;
    symbol: string;
    timestamp: number;
  }>;

  const legs = transfers.filter((t) => t.from === walletLower || t.to === walletLower);
  if (legs.length === 0) return [];

  const outgoing = legs.filter((l) => l.from === walletLower);
  const incoming = legs.filter((l) => l.to === walletLower);
  const trades: TradeResult[] = [];

  const stableOut = outgoing.filter((l) => isStable(l.symbol));
  const stableIn = incoming.filter((l) => isStable(l.symbol));
  const tokenOut = outgoing.filter((l) => !isStable(l.symbol) && !NATIVE_GAS.has(l.symbol));
  const tokenIn = incoming.filter((l) => !isStable(l.symbol) && !NATIVE_GAS.has(l.symbol));

  if (stableOut.length > 0 && tokenIn.length > 0) {
    const spent = stableOut.sort((a, b) => b.amount - a.amount)[0];
    const received = tokenIn.sort((a, b) => b.amount - a.amount)[0];
    if (received.symbol !== "UNKNOWN") {
      trades.push({
        orderId: `chain-${txHash.slice(2, 12)}-buy-${received.symbol}`,
        success: true,
        txHash,
        fromToken: spent.symbol,
        toToken: received.symbol,
        fromAmount: String(spent.amount),
        toAmount: String(received.amount),
        priceAtExecution: received.amount > 0 ? spent.amount / received.amount : 0,
        timestamp: blockTimestampMs,
      });
    }
  }

  if (tokenOut.length > 0 && stableIn.length > 0) {
    const sold = tokenOut.sort((a, b) => b.amount - a.amount)[0];
    const received = stableIn.sort((a, b) => b.amount - a.amount)[0];
    if (sold.symbol !== "UNKNOWN") {
      trades.push({
        orderId: `chain-${txHash.slice(2, 12)}-sell-${sold.symbol}`,
        success: true,
        txHash,
        fromToken: sold.symbol,
        toToken: received.symbol,
        fromAmount: String(sold.amount),
        toAmount: String(received.amount),
        priceAtExecution: sold.amount > 0 ? received.amount / sold.amount : 0,
        timestamp: blockTimestampMs,
      });
    }
  }

  return trades;
}

async function scanBlockRangeForSwaps(
  wallet: string,
  fromBlock: number,
  toBlock: number,
  seenTx: Set<string>,
  limit: number,
  acc: TradeResult[],
  seenHash: Set<string>
): Promise<void> {
  const walletLower = wallet.toLowerCase();
  const batchSize = 25;

    for (let start = toBlock; start >= fromBlock && acc.length < limit; start -= batchSize) {
      const end = Math.max(fromBlock, start - batchSize + 1);
      const blocks = await Promise.all(
        Array.from({ length: start - end + 1 }, (_, i) => start - i).map((b) =>
          rpcCall<RpcBlock>("eth_getBlockByNumber", [`0x${b.toString(16)}`, true]).catch(
            () => null
          )
        )
      );
      await sleep(50);

    for (const block of blocks) {
      if (!block?.transactions?.length || acc.length >= limit) continue;
      const blockTs = parseInt(block.timestamp, 16) * 1000;

      for (const tx of block.transactions) {
        if (acc.length >= limit) return;
        if (tx.from?.toLowerCase() !== walletLower) continue;
        if (seenTx.has(tx.hash)) continue;
        seenTx.add(tx.hash);
        try {
          for (const t of await parseSwapsFromTx(tx.hash, wallet, blockTs)) {
            if (!t.txHash || seenHash.has(t.txHash)) continue;
            seenHash.add(t.txHash);
            acc.push(t);
            if (acc.length >= limit) return;
          }
        } catch {
          /* skip failed receipt fetches */
        }
      }
    }
  }
}

async function buildScanRanges(hints: Array<{ lastTx: number; activity: number }>): Promise<BlockRange[]> {
  const window = parseInt(process.env.BSC_TRADE_SCAN_WINDOW || "5000", 10) || 5000;
  const offsetCenters: number[] = [];
  const rawCenters: number[] = [];

  for (const hint of hints) {
    rawCenters.push(await findBlockNearTimestamp(hint.lastTx));
    if (BINANCE_TX_TIME_OFFSET_MS > 0) {
      offsetCenters.push(await findBlockNearTimestamp(hint.lastTx - BINANCE_TX_TIME_OFFSET_MS));
    }
  }

  const ranges: BlockRange[] = [];

  if (offsetCenters.length > 0) {
    const sorted = [...offsetCenters].sort((a, b) => a - b);
    const newest = sorted[sorted.length - 1]!;
    const cluster = sorted.filter((c) => newest - c <= 20_000);
    ranges.push({
      from: Math.max(1, Math.min(...cluster) - window),
      to: Math.max(...cluster) + window,
    });
  }

  if (rawCenters.length > 0) {
    const sorted = [...rawCenters].sort((a, b) => a - b);
    const newest = sorted[sorted.length - 1]!;
    const cluster = sorted.filter((c) => newest - c <= 15_000);
    const rawRange: BlockRange = {
      from: Math.max(1, Math.min(...cluster) - window),
      to: Math.max(...cluster) + window,
    };
    const overlaps = ranges.some(
      (r) => rawRange.from <= r.to + 1 && rawRange.to >= r.from - 1
    );
    if (!overlaps) ranges.push(rawRange);
  }

  return ranges;
}

/**
 * Discover real BSC swap txs (hash + block time) via public BSC RPC.
 * Uses Binance Web3 lastTxTime hints with a clock-skew offset, then parses receipts.
 */
export async function fetchRpcTradeHistory(
  walletAddress: string,
  limit = 50
): Promise<TradeResult[]> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) return [];

  try {
    const positions = await fetchRawBinancePositions(walletAddress);
    const hints = positions
      .map((p) => ({
        lastTx: parseNum(p.lastTxTime),
        activity: parseNum(p.buyCnt) + parseNum(p.sellCnt),
      }))
      .filter((h) => h.lastTx > 0 && h.activity > 0);

    if (hints.length === 0) return [];

    const ranges = await buildScanRanges(hints);
    const all: TradeResult[] = [];
    const seenHash = new Set<string>();
    const seenTx = new Set<string>();

    for (const range of ranges) {
      await scanBlockRangeForSwaps(
        walletAddress,
        range.from,
        range.to,
        seenTx,
        limit,
        all,
        seenHash
      );
      if (all.length >= limit) break;
    }

    all.sort((a, b) => b.timestamp - a.timestamp);
    const trimmed = all.slice(0, limit);
    logger.info("BSC RPC trade history scanned", {
      wallet: walletAddress.slice(0, 10) + "…",
      swaps: trimmed.length,
      ranges: ranges.length,
      blocks: ranges.reduce((n, r) => n + (r.to - r.from + 1), 0),
    });
    return trimmed;
  } catch (err) {
    logger.warn("BSC RPC trade history scan failed", { error: String(err) });
    return [];
  }
}
