import { createHmac, randomBytes } from "node:crypto";

/**
 * Signed Binance Web3 API (developer portal).
 * Docs: https://web3.binance.com/en/dev-docs/authentication
 *
 * The signed path must include the `/build` prefix. Omitting it returns 40102.
 */

const HOST = "https://web3.binance.com";
const BUILD_PREFIX = "/build";

export class BinanceWeb3ApiError extends Error {
  readonly status: number;
  readonly code?: number | string;

  constructor(message: string, status: number, code?: number | string) {
    super(message);
    this.name = "BinanceWeb3ApiError";
    this.status = status;
    this.code = code;
  }
}

export function web3Credentials(): { apiKey: string; secretKey: string } | null {
  const apiKey = process.env.OC_API_KEY?.trim();
  const secretKey = process.env.OC_SECRET_KEY?.trim();
  if (!apiKey || !secretKey) return null;
  return { apiKey, secretKey };
}

export function buildPreHash(timestamp: string, method: string, requestPath: string, body: string): string {
  return `${timestamp}${method.toUpperCase()}${requestPath}${body}`;
}

export function signPreHash(preHash: string, secretKey: string): string {
  return createHmac("sha256", secretKey).update(preHash, "utf8").digest("base64");
}

function queryString(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

function successCode(code: unknown): boolean {
  if (code === undefined || code === null || code === "") return true;
  const text = String(code);
  return text === "0" || text === "000000" || text === "200";
}

export async function signedWeb3<T = unknown>(
  method: "GET" | "POST",
  path: string,
  opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {}
): Promise<T> {
  const creds = web3Credentials();
  if (!creds) {
    throw new BinanceWeb3ApiError("Set OC_API_KEY and OC_SECRET_KEY from the Binance Web3 developer portal", 0);
  }

  const query = opts.query ? queryString(opts.query) : "";
  const fullPath = query ? `${path}?${query}` : path;
  const body = method === "GET" ? "" : JSON.stringify(opts.body ?? {});
  const timestamp = new Date().toISOString();
  const requestPath = `${BUILD_PREFIX}${fullPath}`;
  const signature = signPreHash(buildPreHash(timestamp, method, requestPath, body), creds.secretKey);

  const response = await fetch(`${HOST}${BUILD_PREFIX}${fullPath}`, {
    method,
    headers: {
      "X-OC-APIKEY": creds.apiKey,
      "X-OC-TIMESTAMP": timestamp,
      "X-OC-SIGN": signature,
      "X-OC-NONCE": randomBytes(16).toString("hex"),
      "X-OC-RECV-WINDOW": "15000",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body || undefined,
    signal: AbortSignal.timeout(20_000),
  });

  const text = await response.text();
  let payload: { code?: number | string; msg?: string; data?: T } | null = null;
  try {
    payload = text ? (JSON.parse(text) as { code?: number | string; msg?: string; data?: T }) : null;
  } catch {
    payload = null;
  }

  if (!response.ok || (payload && !successCode(payload.code))) {
    throw new BinanceWeb3ApiError(
      payload?.msg || text.slice(0, 240) || response.statusText || "Binance Web3 API request failed",
      response.status,
      payload?.code
    );
  }

  return (payload?.data ?? payload) as T;
}

export interface RwaPriceRow {
  tokenContractAddress: string;
  symbol?: string;
  platformId?: string;
  onChainPrice: number | null;
  referencePrice: number | null;
  spreadPct: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.map(asRecord).filter((row): row is Record<string, unknown> => Boolean(row));
  const record = asRecord(data);
  const list = record?.list ?? record?.tokens ?? record?.items ?? record?.rows;
  if (Array.isArray(list)) return list.map(asRecord).filter((row): row is Record<string, unknown> => Boolean(row));
  return record ? [record] : [];
}

function positive(value: unknown): number | null {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function mapPrice(row: Record<string, unknown>): RwaPriceRow {
  const onChainPrice = positive(row.onChainPrice ?? row.price ?? row.tokenPrice ?? row.dexPrice);
  const referencePrice = positive(row.referencePrice);
  const spreadPct =
    onChainPrice != null && referencePrice != null
      ? Math.round(((onChainPrice - referencePrice) / referencePrice) * 10000) / 100
      : null;
  return {
    tokenContractAddress: String(row.tokenContractAddress ?? row.contractAddress ?? ""),
    symbol: row.symbol ? String(row.symbol) : undefined,
    platformId: row.platformId ? String(row.platformId) : undefined,
    onChainPrice,
    referencePrice,
    spreadPct,
  };
}

/** On-chain price and the API's per-share reference price. Max 100 addresses. */
export async function getRwaTokenPrices(addresses: string[], chainId = "56"): Promise<RwaPriceRow[]> {
  const tokenContractAddresses = [...new Set(addresses.map((address) => address.trim()).filter(Boolean))].slice(0, 100);
  if (!tokenContractAddresses.length) return [];
  const data = await signedWeb3("GET", "/api/v1/dex/market/rwa/price", {
    query: { binanceChainId: chainId, tokenContractAddresses: tokenContractAddresses.join(",") },
  });
  return asRows(data).map(mapPrice);
}

export async function listRwaTokens(platformId = "bstock", chainId = "56"): Promise<unknown> {
  return signedWeb3("GET", "/api/v1/dex/market/rwa/tokens", {
    query: { binanceChainId: chainId, platformId },
  });
}

export async function searchRwaToken(keyword: string, platformId = "bstock"): Promise<unknown> {
  return signedWeb3("GET", "/api/v1/dex/market/rwa/search", {
    query: { keyword, platformId },
  });
}

export async function getGasPrice(chainId = "56"): Promise<unknown> {
  return signedWeb3("GET", "/api/v1/dex/pre-transaction/gas-price", {
    query: { binanceChainId: chainId },
  });
}

/** Dry-run an EVM call. Does not broadcast. */
export async function simulateEvmTransaction(input: {
  from: string;
  to: string;
  data?: string;
  value?: string;
  chainId?: string;
}): Promise<unknown> {
  return signedWeb3("POST", "/api/v1/dex/pre-transaction/simulate", {
    body: {
      binanceChainId: input.chainId ?? "56",
      evmTx: {
        from: input.from,
        to: input.to,
        value: input.value ?? "0",
        data: input.data ?? "0x",
      },
    },
  });
}

export interface RwaListedToken {
  tokenContractAddress: string;
  symbol: string;
  underlyingTicker?: string;
  underlyingName?: string;
  platformId?: string;
  decimals: number | null;
  marketStatus: string;
  nextOpenTime: number | null;
  nextCloseTime: number | null;
  onChainPrice: number | null;
  referencePrice: number | null;
  spreadPct: number | null;
}

export interface MarketCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface AggregatedQuoteRoute {
  quoteId: string;
  vendorName?: string;
  executionMode?: string;
  fromTokenAmount?: string;
  toTokenAmount?: string;
  toDecimals: number | null;
  raw: Record<string, unknown>;
}

export interface SwapCall {
  to: string;
  data: string;
  value: string;
  executionMode?: string;
  vendorName?: string;
  signedTransaction?: string;
}

function millis(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  const text = String(value).trim();
  const n = Number(text);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function readStatus(row: Record<string, unknown>): { marketStatus: string; nextOpenTime: number | null; nextCloseTime: number | null } {
  const info = asRecord(row.statusInfo) ?? row;
  const raw = info.marketStatus ?? row.marketStatus;
  const named = typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : "";
  const reason = String(info.reasonCode ?? row.reasonCode ?? "").toUpperCase();
  const open = info.openState ?? row.openState;
  let marketStatus = named;
  if (!marketStatus) {
    marketStatus = open === false || reason === "PAUSE" || reason === "HALT" ? "pause" : "unknown";
  }
  return {
    marketStatus,
    nextOpenTime: millis(info.nextOpenTime ?? row.nextOpenTime),
    nextCloseTime: millis(info.nextCloseTime ?? row.nextCloseTime),
  };
}

function mapListedToken(row: Record<string, unknown>): RwaListedToken {
  const price = mapPrice(row);
  const status = readStatus(row);
  const symbol = String(row.tokenSymbol ?? row.symbol ?? row.underlyingTicker ?? "").toUpperCase();
  const decimalsRaw = row.decimals ?? row.tokenDecimals;
  const decimals = typeof decimalsRaw === "number" ? decimalsRaw : parseInt(String(decimalsRaw ?? ""), 10);
  return {
    tokenContractAddress: price.tokenContractAddress || String(row.tokenContractAddress ?? ""),
    symbol,
    underlyingTicker: row.underlyingTicker ? String(row.underlyingTicker).toUpperCase() : undefined,
    underlyingName: row.underlyingName ? String(row.underlyingName) : row.underlyingFullName ? String(row.underlyingFullName) : undefined,
    platformId: row.platformId ? String(row.platformId) : undefined,
    decimals: Number.isFinite(decimals) ? decimals : null,
    marketStatus: status.marketStatus,
    nextOpenTime: status.nextOpenTime,
    nextCloseTime: status.nextCloseTime,
    onChainPrice: price.onChainPrice,
    referencePrice: price.referencePrice,
    spreadPct: price.spreadPct,
  };
}

/** bStock board. tabId 9 is the Magnificent 7 sector from the RWA docs. */
export async function listRwaTokenBoard(opts: {
  platformId?: string;
  chainId?: string;
  tabId?: number;
} = {}): Promise<RwaListedToken[]> {
  const data = await signedWeb3("GET", "/api/v1/dex/market/rwa/tokens", {
    query: {
      binanceChainId: opts.chainId ?? "56",
      platformId: opts.platformId ?? "bstock",
      tabId: opts.tabId,
    },
  });
  return asRows(data).map(mapListedToken).filter((row) => row.tokenContractAddress);
}

export async function getRwaUnderlyingMarket(address: string, chainId = "56"): Promise<RwaListedToken | null> {
  const data = await signedWeb3("GET", "/api/v1/dex/market/rwa/underlying-market", {
    query: { binanceChainId: chainId, tokenContractAddress: address },
  });
  const row = asRows(data)[0];
  return row ? mapListedToken(row) : null;
}

export async function getRwaUnderlyingProfile(address: string, chainId = "56"): Promise<Record<string, unknown> | null> {
  const data = await signedWeb3("GET", "/api/v1/dex/market/rwa/underlying-profile", {
    query: { binanceChainId: chainId, tokenContractAddress: address },
  });
  return asRecord(data) ?? asRows(data)[0] ?? null;
}

function candleFrom(value: unknown): MarketCandle | null {
  if (Array.isArray(value) && value.length >= 5) {
    const timestamp = millis(value[0]);
    const open = positive(value[1]);
    const high = positive(value[2]);
    const low = positive(value[3]);
    const close = positive(value[4]);
    if (timestamp == null || close == null || open == null || high == null || low == null) return null;
    const volume = positive(value[5]) ?? undefined;
    return { timestamp, open, high, low, close, volume };
  }
  const row = asRecord(value);
  if (!row) return null;
  const timestamp = millis(row.timestamp ?? row.openTime ?? row.t ?? row.time);
  const open = positive(row.open ?? row.o);
  const high = positive(row.high ?? row.h);
  const low = positive(row.low ?? row.l);
  const close = positive(row.close ?? row.c ?? row.price);
  if (timestamp == null || close == null || open == null || high == null || low == null) return null;
  return { timestamp, open, high, low, close, volume: positive(row.volume ?? row.v) ?? undefined };
}

/** Signed market candles. `bar` follows the Market API (default 15m). */
export async function getMarketCandles(address: string, opts: { chainId?: string; bar?: string; limit?: number } = {}): Promise<MarketCandle[]> {
  const data = await signedWeb3("GET", "/api/v1/dex/market/candles", {
    query: {
      binanceChainId: opts.chainId ?? "56",
      tokenContractAddress: address,
      bar: opts.bar ?? "15m",
      limit: opts.limit ?? 48,
    },
  });
  const rows = Array.isArray(data) ? data : asRows(data);
  return rows.map(candleFrom).filter((row): row is MarketCandle => Boolean(row));
}

function routeRows(data: unknown): Record<string, unknown>[] {
  const record = asRecord(data);
  const list = record?.routes ?? record?.quotes ?? record?.list ?? data;
  return asRows(list);
}

export async function getAggregatedQuote(input: {
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: string;
  userWalletAddress: string;
  chainId?: string;
}): Promise<AggregatedQuoteRoute | null> {
  const data = await signedWeb3("GET", "/api/v1/dex/aggregator/quote", {
    query: {
      binanceChainId: input.chainId ?? "56",
      fromTokenAddress: input.fromTokenAddress,
      toTokenAddress: input.toTokenAddress,
      amount: input.amount,
      userWalletAddress: input.userWalletAddress,
    },
  });
  const routes = routeRows(data);
  const best = routes.find((row) => row.isBest === true) ?? routes[0];
  if (!best) return null;
  const decimalsRaw = asRecord(best.toToken)?.decimals ?? best.toDecimals ?? best.decimals;
  const decimals = typeof decimalsRaw === "number" ? decimalsRaw : parseInt(String(decimalsRaw ?? ""), 10);
  return {
    quoteId: String(best.quoteId ?? ""),
    vendorName: best.vendorName ? String(best.vendorName) : undefined,
    executionMode: best.executionMode ? String(best.executionMode) : undefined,
    fromTokenAmount: best.fromTokenAmount != null ? String(best.fromTokenAmount) : undefined,
    toTokenAmount: best.toTokenAmount != null ? String(best.toTokenAmount) : undefined,
    toDecimals: Number.isFinite(decimals) ? decimals : null,
    raw: best,
  };
}

function nestedString(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value) return value;
  }
  const tx = asRecord(row.tx) ?? asRecord(row.transaction) ?? asRecord(row.evmTx);
  if (!tx) return undefined;
  for (const key of keys) {
    const value = tx[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export function extractSwapCall(data: unknown): SwapCall | null {
  const row = asRecord(data) ?? asRows(data)[0];
  if (!row) return null;
  const to = nestedString(row, ["to", "toAddress", "contractAddress"]);
  const dataHex = nestedString(row, ["data", "input", "inputData", "calldata"]);
  if (!to || !dataHex) return null;
  const signed = nestedString(row, ["signedTransaction"]);
  return {
    to,
    data: dataHex,
    value: nestedString(row, ["value"]) ?? "0",
    executionMode: row.executionMode ? String(row.executionMode) : undefined,
    vendorName: row.vendorName ? String(row.vendorName) : undefined,
    signedTransaction: signed,
  };
}

export async function buildSwapTransaction(input: {
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: string;
  userWalletAddress: string;
  quoteId?: string;
  slippagePercent?: string;
  chainId?: string;
}): Promise<SwapCall | null> {
  const data = await signedWeb3("GET", "/api/v1/dex/aggregator/swap", {
    query: {
      binanceChainId: input.chainId ?? "56",
      fromTokenAddress: input.fromTokenAddress,
      toTokenAddress: input.toTokenAddress,
      amount: input.amount,
      userWalletAddress: input.userWalletAddress,
      quoteId: input.quoteId,
      slippagePercent: input.slippagePercent ?? "1",
    },
  });
  return extractSwapCall(data);
}

/** Relay a raw signed transaction. Caller must already hold the signed hex. */
export async function broadcastSignedEvmTransaction(input: {
  signedTransaction: string;
  address: string;
  chainId?: string;
}): Promise<unknown> {
  return signedWeb3("POST", "/api/v1/dex/pre-transaction/broadcast-transaction", {
    body: {
      binanceChainId: input.chainId ?? "56",
      signedTransaction: input.signedTransaction,
      address: input.address,
    },
  });
}

export async function getAddressPortfolio(walletAddress: string, chainId = "56"): Promise<unknown> {
  return signedWeb3("GET", "/api/v1/dex/market/portfolio/overview", {
    query: { binanceChainId: chainId, walletAddress, timeFrame: "1" },
  });
}

function readApy(value: unknown, depth = 0): number | null {
  if (depth > 5) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = readApy(item, depth + 1);
      if (found != null) return found;
    }
    return null;
  }
  const row = asRecord(value);
  if (!row) return null;
  for (const [key, raw] of Object.entries(row)) {
    if (!/apy|apr/i.test(key)) continue;
    const n = typeof raw === "number" ? raw : parseFloat(String(raw ?? ""));
    if (Number.isFinite(n) && n > 0 && n < 100) return Math.round(n * 100) / 100;
  }
  for (const nested of Object.values(row)) {
    const found = readApy(nested, depth + 1);
    if (found != null) return found;
  }
  return null;
}

/** Highest readable BSC stable yield. Read-only: no deposit calldata is sent. */
export async function getDefiStableApy(chainId = "56"): Promise<number | null> {
  const data = await signedWeb3("POST", "/api/v1/defi/data/protocol/list", {
    body: { binanceChainId: chainId, page: 1, size: 10 },
  });
  return readApy(data);
}

export function simulationRejected(data: unknown): string | null {
  const row = asRecord(data);
  if (!row) return null;
  const detail = row.simulationErrorDetail ?? row.error ?? row.revertReason ?? asRecord(row.simulationResult)?.simulationErrorDetail;
  if (typeof detail === "string" && detail.trim()) return detail;
  const code = row.simulationCode ?? asRecord(row.simulationResult)?.simulationCode;
  if (code != null && !successCode(code) && String(code) !== "000000000") return `simulation ${String(code)}`;
  return null;
}
