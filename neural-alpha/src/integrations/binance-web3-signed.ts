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
