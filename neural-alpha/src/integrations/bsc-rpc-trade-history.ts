import { BSC_USDT_ADDRESS, STABLECOINS } from "../config.js";
import { BSC_TOKEN_ADDRESSES, symbolForKnownAddress } from "./bsc-token-addresses.js";
import { getBstockSymbolByAddress } from "./bstock.js";
import { logger } from "../utils/logger.js";
import type { TradeResult } from "../utils/types.js";
import { fetchRawBinancePositions } from "./binance-web3-trade-history.js";
import { preloadDecimals, tokenAmountFromRaw } from "./bsc-token-decimals.js";
import { classifyAssetTrade } from "../utils/trade-dedupe.js";

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
const STABLE_SET = new Set([...STABLECOINS, "BNB", "WBNB"]);

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
  blockNumber: string;
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
  return (
    symbolForKnownAddress(address) ??
    getBstockSymbolByAddress(address) ??
    ADDRESS_TO_SYMBOL[address.toLowerCase()] ??
    "UNKNOWN"
  );
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
        if (/limit|rate|too many|archive/i.test(msg)) {
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

function parseTransferLog(
  log: RpcLog,
  blockTimestampMs: number,
  decimalsByContract: Map<string, number>
) {
  if (log.topics.length < 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return null;
  const from = ("0x" + log.topics[1]!.slice(-40)).toLowerCase();
  const to = ("0x" + log.topics[2]!.slice(-40)).toLowerCase();
  const contract = log.address.toLowerCase();
  const symbol = symbolForContract(contract);
  const raw = BigInt(log.data || "0x0");
  const decimals = decimalsByContract.get(contract) ?? 18;
  const amount = tokenAmountFromRaw(raw, decimals);
  if (!(amount > 0)) return null;
  return { hash: log.transactionHash, from, to, amount, symbol, timestamp: blockTimestampMs };
}

async function parseTransferLogs(
  logs: RpcLog[],
  blockTimestampMs: number
): Promise<Array<{
  hash: string;
  from: string;
  to: string;
  amount: number;
  symbol: string;
  timestamp: number;
}>> {
  const contracts = logs
    .filter((l) => l.topics[0]?.toLowerCase() === TRANSFER_TOPIC)
    .map((l) => l.address.toLowerCase());
  const decimalsByContract = await preloadDecimals(contracts);
  return logs
    .map((l) => parseTransferLog(l, blockTimestampMs, decimalsByContract))
    .filter(Boolean) as Array<{
    hash: string;
    from: string;
    to: string;
    amount: number;
    symbol: string;
    timestamp: number;
  }>;
}

async function parseSwapsFromTx(
  txHash: string,
  wallet: string,
  blockTimestampMs: number
): Promise<TradeResult[]> {
  const receipt = await rpcCall<{ logs: RpcLog[] }>("eth_getTransactionReceipt", [txHash]);
  const walletLower = wallet.toLowerCase();
  const transfers = await parseTransferLogs(receipt.logs, blockTimestampMs);

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
    if (received && received.symbol !== "UNKNOWN") {
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
    if (sold && sold.symbol !== "UNKNOWN") {
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

function mergeBlockRanges(ranges: BlockRange[]): BlockRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const merged: BlockRange[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (cur.from <= last.to + 1) {
      last.to = Math.max(last.to, cur.to);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

function splitWideRanges(ranges: BlockRange[], maxSpan: number): BlockRange[] {
  const out: BlockRange[] = [];
  for (const r of ranges) {
    if (r.to - r.from + 1 <= maxSpan) {
      out.push(r);
      continue;
    }
    for (let start = r.from; start <= r.to; start += maxSpan) {
      out.push({ from: start, to: Math.min(r.to, start + maxSpan - 1) });
    }
  }
  return out;
}

/** Newest ranges first so recent sells appear before a long historical scan finishes. */
async function buildScanRanges(
  hints: Array<{ lastTx: number; activity: number }>
): Promise<BlockRange[]> {
  const window = parseInt(process.env.BSC_TRADE_SCAN_WINDOW || "6000", 10) || 6000;
  const maxSpan = parseInt(process.env.BSC_BLOCK_SCAN_MAX_SPAN || "12000", 10) || 12000;
  const recentDepth =
    parseInt(process.env.BSC_TRADE_RECENT_BLOCKS || "5000", 10) || 5000;

  const head = await getLatestBlock();
  const ranges: BlockRange[] = [{ from: Math.max(1, head - recentDepth), to: head }];

  for (const hint of hints) {
    if (!(hint.lastTx > 0)) continue;
    for (const ms of [hint.lastTx - BINANCE_TX_TIME_OFFSET_MS, hint.lastTx]) {
      if (!(ms > 0)) continue;
      const center = await findBlockNearTimestamp(ms);
      ranges.push({
        from: Math.max(1, center - window),
        to: center + window,
      });
    }
  }

  const merged = splitWideRanges(mergeBlockRanges(ranges), maxSpan);
  return merged.sort((a, b) => b.to - a.to);
}

function padTopicAddress(addr: string): string {
  return "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function tradeSeenKey(trade: TradeResult): string {
  const side = classifyAssetTrade(trade.fromToken, trade.toToken) ?? "unk";
  return `${(trade.txHash ?? "").toLowerCase()}:${side}`;
}

async function collectWalletSwapTxHashes(
  wallet: string,
  fromBlock: number,
  toBlock: number
): Promise<Map<string, number>> {
  const pad = padTopicAddress(wallet);
  const fromHex = `0x${fromBlock.toString(16)}`;
  const toHex = `0x${toBlock.toString(16)}`;
  const [asFrom, asTo] = await Promise.all([
    rpcCall<RpcLog[]>("eth_getLogs", [
      { fromBlock: fromHex, toBlock: toHex, topics: [TRANSFER_TOPIC, pad] },
    ]),
    rpcCall<RpcLog[]>("eth_getLogs", [
      { fromBlock: fromHex, toBlock: toHex, topics: [TRANSFER_TOPIC, null, pad] },
    ]),
  ]);

  const byTx = new Map<string, number>();
  for (const log of [...(asFrom ?? []), ...(asTo ?? [])]) {
    const hash = log.transactionHash;
    if (!hash) continue;
    const blockNumber = parseInt(log.blockNumber, 16);
    if (!Number.isFinite(blockNumber)) continue;
    const prev = byTx.get(hash);
    if (prev === undefined || blockNumber < prev) byTx.set(hash, blockNumber);
  }
  return byTx;
}

async function ingestParsedSwaps(
  wallet: string,
  txHash: string,
  blockTs: number,
  acc: TradeResult[],
  seenHash: Set<string>,
  limit: number
): Promise<void> {
  for (const t of await parseSwapsFromTx(txHash, wallet, blockTs)) {
    if (acc.length >= limit) return;
    if (!t.txHash) continue;
    const key = tradeSeenKey(t);
    if (seenHash.has(key)) continue;
    seenHash.add(key);
    acc.push(t);
  }
}

/**
 * Discover swaps by ERC-20 Transfer logs involving the wallet (from OR to).
 * Agentic Wallet / Binance Web3 sells are often submitted by a relayer, so
 * `tx.from` is not the user wallet.
 */
async function scanRangeViaTransferLogs(
  wallet: string,
  fromBlock: number,
  toBlock: number,
  seenTx: Set<string>,
  limit: number,
  acc: TradeResult[],
  seenHash: Set<string>
): Promise<void> {
  const byTx = await collectWalletSwapTxHashes(wallet, fromBlock, toBlock);
  const uniqueBlocks = [...new Set(byTx.values())];
  const tsByBlock = new Map<number, number>();
  await Promise.all(
    uniqueBlocks.map(async (block) => {
      tsByBlock.set(block, await getBlockTimestamp(block));
    })
  );

  const entries = [...byTx.entries()].sort((a, b) => b[1] - a[1]);
  for (const [hash, blockNumber] of entries) {
    if (acc.length >= limit) return;
    if (seenTx.has(hash)) continue;
    seenTx.add(hash);
    const blockTs = tsByBlock.get(blockNumber) ?? 0;
    try {
      await ingestParsedSwaps(wallet, hash, blockTs, acc, seenHash, limit);
    } catch {
      /* skip failed receipt fetches */
    }
  }
}

/** Fallback when getLogs is rate-limited: only origin-wallet txs (misses relayers). */
async function scanRangeViaTxFrom(
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
          await ingestParsedSwaps(wallet, tx.hash, blockTs, acc, seenHash, limit);
        } catch {
          /* skip failed receipt fetches */
        }
      }
    }
  }
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
  const logChunk = parseInt(process.env.BSC_GETLOGS_MAX_SPAN || "500", 10) || 500;

  for (let end = toBlock; end >= fromBlock && acc.length < limit; end -= logChunk) {
    const start = Math.max(fromBlock, end - logChunk + 1);
    try {
      await scanRangeViaTransferLogs(wallet, start, end, seenTx, limit, acc, seenHash);
    } catch (err) {
      logger.warn("BSC getLogs scan failed — falling back to tx.from filter", {
        from: start,
        to: end,
        error: String(err),
      });
      await scanRangeViaTxFrom(wallet, start, end, seenTx, limit, acc, seenHash);
    }
  }
}

async function scanWalletSwaps(
  walletAddress: string,
  hints: Array<{ lastTx: number; activity: number }>,
  limit: number,
  ranges?: BlockRange[]
): Promise<TradeResult[]> {
  const scanRanges = ranges ?? (await buildScanRanges(hints));
  const all: TradeResult[] = [];
  const seenHash = new Set<string>();
  const seenTx = new Set<string>();

  for (const range of scanRanges) {
    if (all.length >= limit) break;
    await scanBlockRangeForSwaps(
      walletAddress,
      range.from,
      range.to,
      seenTx,
      limit,
      all,
      seenHash
    );
  }

  all.sort((a, b) => b.timestamp - a.timestamp);
  if (all.length <= limit) return all;
  const sells = all.filter((t) => classifyAssetTrade(t.fromToken, t.toToken) === "sell");
  const rest = all.filter((t) => classifyAssetTrade(t.fromToken, t.toToken) !== "sell");
  return [...sells.slice(0, limit), ...rest.slice(0, Math.max(0, limit - Math.min(sells.length, limit)))]
    .sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Fast pass: scan only the chain head so new sells show up within ~1 min.
 */
export async function fetchRpcRecentTradeHistory(
  walletAddress: string,
  limit = 50
): Promise<TradeResult[]> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) return [];

  try {
    const head = await getLatestBlock();
    const recentDepth =
      parseInt(process.env.BSC_TRADE_RECENT_BLOCKS || "5000", 10) || 5000;
    const range: BlockRange = { from: Math.max(1, head - recentDepth), to: head };
    const trades = await scanWalletSwaps(walletAddress, [], limit, [range]);
    logger.info("BSC RPC recent trade scan", {
      wallet: walletAddress.slice(0, 10) + "…",
      swaps: trades.length,
      blocks: recentDepth,
    });
    return trades;
  } catch (err) {
    logger.warn("BSC RPC recent trade scan failed", { error: String(err) });
    return [];
  }
}

/**
 * Discover real BSC swap txs (hash + block time) via public BSC RPC.
 * Uses Binance Web3 lastTxTime hints with a clock-skew offset, then parses receipts.
 */
export async function fetchRpcTradeHistory(
  walletAddress: string,
  limit = 50,
  extraHints: Array<{ lastTx: number; activity: number }> = []
): Promise<TradeResult[]> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) return [];

  try {
    const positions = await fetchRawBinancePositions(walletAddress);
    const hints = [
      ...positions
        .map((p) => ({
          lastTx: parseNum(p.lastTxTime),
          activity: parseNum(p.buyCnt) + parseNum(p.sellCnt),
        }))
        .filter((h) => h.lastTx > 0 && h.activity > 0),
      ...extraHints.filter((h) => h.lastTx > 0),
    ];

    if (hints.length === 0) return [];

    const ranges = await buildScanRanges(hints);
    const trimmed = await scanWalletSwaps(walletAddress, hints, limit, ranges);
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
