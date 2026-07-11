/**
 * Binance Web3 Wallet Trading API (OnchainOS DEX aggregator).
 * Docs: https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/trading-api
 *
 * Auth: HMAC-SHA256 → Base64 over
 *   `{isoTimestamp}{METHOD}/build{path}?{query}`
 * Headers: X-OC-APIKEY / X-OC-TIMESTAMP / X-OC-SIGN / X-OC-RECV-WINDOW
 */
import { createHmac, randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";

const BASE_URL =
  process.env.BINANCE_WEB3_TRADING_BASE_URL?.trim() ||
  "https://web3.binance.com/build";

/** BSC chain id as used by Binance Web3 aggregator */
export const BINANCE_CHAIN_BSC = "56";

/** Native gas token sentinel used by the aggregator (not WBNB). */
export const AGGREGATOR_NATIVE =
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const;

const RECV_WINDOW = "15000";

export interface AggregatorTokenMeta {
  tokenContractAddress?: string;
  tokenSymbol?: string;
  tokenUnitPrice?: string;
  decimal?: string;
  isHoneyPot?: boolean;
  taxRate?: string;
}

export interface AggregatorQuote {
  quoteId: string;
  vendorName?: string;
  binanceChainId?: string;
  fromTokenAmount: string;
  toTokenAmount: string;
  tradeFee?: string | null;
  estimateGasFee?: string | null;
  priceImpactPercent?: string | null;
  router?: string;
  fromToken?: AggregatorTokenMeta;
  toToken?: AggregatorTokenMeta;
}

export interface AggregatorSwapTx {
  from?: string;
  to: string;
  data: string;
  value: string;
  gas?: string;
  gasPrice?: string;
  maxPriorityFeePerGas?: string;
  minReceiveAmount?: string;
  slippagePercent?: string;
  signatureData?: string[];
}

export interface AggregatorSwapResult {
  routerResult?: {
    vendorName?: string;
    fromTokenAmount?: string;
    toTokenAmount?: string;
    priceImpactPercent?: string | null;
    router?: string;
  };
  tx: AggregatorSwapTx;
}

export interface AggregatorApproveTx {
  data: string;
  dexContractAddress: string;
  gasLimit?: string;
  gasPrice?: string;
}

function requireCreds(): { apiKey: string; apiSecret: string } {
  const apiKey = process.env.BINANCE_WEB3_API_KEY?.trim() || "";
  const apiSecret = process.env.BINANCE_WEB3_API_SECRET?.trim() || "";
  if (!apiKey || !apiSecret) {
    throw new Error(
      "BINANCE_WEB3_API_KEY and BINANCE_WEB3_API_SECRET are required for aggregator swaps (Binance Web3 Trading API)"
    );
  }
  return { apiKey, apiSecret };
}

export function isBinanceWeb3TradingConfigured(): boolean {
  return !!(
    process.env.BINANCE_WEB3_API_KEY?.trim() &&
    process.env.BINANCE_WEB3_API_SECRET?.trim()
  );
}

/** ISO-8601 UTC with millisecond precision, matching the official SDK. */
function isoTimestamp(): string {
  const d = new Date();
  const ms = String(d.getUTCMilliseconds()).padStart(3, "0");
  return (
    `${d.getUTCFullYear()}-` +
    `${String(d.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getUTCDate()).padStart(2, "0")}T` +
    `${String(d.getUTCHours()).padStart(2, "0")}:` +
    `${String(d.getUTCMinutes()).padStart(2, "0")}:` +
    `${String(d.getUTCSeconds()).padStart(2, "0")}.` +
    `${ms}Z`
  );
}

/** Build query string in stable insertion order (signature-sensitive). */
function encodeQuery(params: Record<string, string | number | boolean>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(
      `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
    );
  }
  return parts.join("&");
}

function signRequest(
  apiSecret: string,
  method: string,
  path: string,
  query: string,
  timestamp: string,
  bodyStr = ""
): string {
  const preHash = query
    ? `${timestamp}${method.toUpperCase()}/build${path}?${query}${bodyStr}`
    : `${timestamp}${method.toUpperCase()}/build${path}${query}${bodyStr}`;
  return createHmac("sha256", apiSecret).update(preHash).digest("base64");
}

async function signedGet<T>(
  path: string,
  params: Record<string, string | number | boolean>
): Promise<T> {
  const { apiKey, apiSecret } = requireCreds();
  const query = encodeQuery(params);
  const timestamp = isoTimestamp();
  const signature = signRequest(apiSecret, "GET", path, query, timestamp);
  const url = query ? `${BASE_URL}${path}?${query}` : `${BASE_URL}${path}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-OC-APIKEY": apiKey,
      "X-OC-TIMESTAMP": timestamp,
      "X-OC-SIGN": signature,
      "X-OC-RECV-WINDOW": RECV_WINDOW,
      "X-OC-NONCE": randomUUID().replace(/-/g, ""),
      "User-Agent": "NeuralAlpha/1.0 (binance-web3-trading)",
    },
  });

  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Binance Web3 Trading API non-JSON (${res.status}): ${text.slice(0, 200)}`
    );
  }

  if (!res.ok) {
    const msg = String(json.msg ?? json.message ?? text).slice(0, 300);
    throw new Error(`Binance Web3 Trading API ${res.status}: ${msg}`);
  }

  // API wraps business errors as HTTP 200 with code != 0 / success=false
  const code = json.code;
  const success = json.success;
  if (
    (typeof code === "number" && code !== 0) ||
    (typeof code === "string" && code !== "0" && code !== "") ||
    success === false
  ) {
    throw new Error(
      `Binance Web3 Trading API error ${String(code)}: ${String(json.msg ?? "unknown")}`
    );
  }

  return json as T;
}

interface QuoteApiResponse {
  code?: number | string;
  msg?: string;
  success?: boolean;
  data?: AggregatorQuote[];
}

interface SwapApiResponse {
  code?: number | string;
  msg?: string;
  success?: boolean;
  data?: AggregatorSwapResult;
}

interface ApproveApiResponse {
  code?: number | string;
  msg?: string;
  success?: boolean;
  data?: AggregatorApproveTx[];
}

/**
 * Query aggregated DEX routes (1inch / LiFi / LiquidMesh / Pancake / …).
 * Returns routes sorted by toTokenAmount descending; pick the first viable one.
 */
export async function getAggregatedQuotes(params: {
  amountWei: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  chainId?: string;
}): Promise<AggregatorQuote[]> {
  const json = await signedGet<QuoteApiResponse>("/api/v1/dex/aggregator/quote", {
    binanceChainId: params.chainId || BINANCE_CHAIN_BSC,
    amount: params.amountWei,
    fromTokenAddress: params.fromTokenAddress,
    toTokenAddress: params.toTokenAddress,
  });

  const list = Array.isArray(json.data) ? json.data : [];
  if (list.length === 0) {
    throw new Error("No aggregator routes returned for this pair/amount");
  }
  return list.filter((q) => q.quoteId && q.toTokenAmount);
}

/** Best route by output amount, skipping honeypot-flagged destinations. */
export function pickBestQuote(
  quotes: AggregatorQuote[],
  maxPriceImpactPct: number
): AggregatorQuote {
  for (const q of quotes) {
    if (q.toToken?.isHoneyPot) {
      logger.warn("Skipping honeypot-flagged aggregator route", {
        vendor: q.vendorName,
        symbol: q.toToken?.tokenSymbol,
      });
      continue;
    }
    const impact = parseFloat(String(q.priceImpactPercent ?? "0"));
    if (Number.isFinite(impact) && impact > maxPriceImpactPct) {
      logger.warn("Skipping high price-impact aggregator route", {
        vendor: q.vendorName,
        priceImpactPercent: impact,
        max: maxPriceImpactPct,
      });
      continue;
    }
    return q;
  }
  throw new Error(
    `No safe aggregator route (all honeypot or price impact > ${maxPriceImpactPct}%)`
  );
}

/** Build on-chain swap calldata from a fresh quoteId (~30s TTL). */
export async function buildSwapTransaction(params: {
  amountWei: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  slippagePercent: string;
  userWalletAddress: string;
  quoteId: string;
  chainId?: string;
  priceImpactProtectionPercent?: string;
}): Promise<AggregatorSwapResult> {
  const payload: Record<string, string> = {
    binanceChainId: params.chainId || BINANCE_CHAIN_BSC,
    amount: params.amountWei,
    fromTokenAddress: params.fromTokenAddress,
    toTokenAddress: params.toTokenAddress,
    slippagePercent: params.slippagePercent,
    userWalletAddress: params.userWalletAddress,
    quoteId: params.quoteId,
  };
  if (params.priceImpactProtectionPercent) {
    payload.priceImpactProtectionPercent = params.priceImpactProtectionPercent;
  }

  const json = await signedGet<SwapApiResponse>(
    "/api/v1/dex/aggregator/swap",
    payload
  );

  const data = json.data;
  if (!data?.tx?.to || !data.tx.data) {
    throw new Error("Aggregator swap response missing tx calldata");
  }
  return {
    ...data,
    tx: {
      ...data.tx,
      value: data.tx.value || "0",
    },
  };
}

/** Build ERC-20 approve calldata for the aggregator router spender. */
export async function getErc20ApproveTransaction(params: {
  tokenContractAddress: string;
  approveAmount: string;
  chainId?: string;
}): Promise<AggregatorApproveTx> {
  const json = await signedGet<ApproveApiResponse>(
    "/api/v1/dex/aggregator/approve-transaction",
    {
      binanceChainId: params.chainId || BINANCE_CHAIN_BSC,
      tokenContractAddress: params.tokenContractAddress,
      approveAmount: params.approveAmount,
    }
  );

  const row = Array.isArray(json.data) ? json.data[0] : undefined;
  if (!row?.dexContractAddress) {
    throw new Error("Aggregator approve response missing dexContractAddress");
  }
  return row;
}
