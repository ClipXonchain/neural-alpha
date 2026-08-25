import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../utils/logger.js";
import { cacheBscTokenAddress } from "./bsc-token-addresses.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const ELIGIBLE_FILE = join(PKG_ROOT, "data/eligible-bstocks.json");

const BSTOCK_LIST_URL =
  "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai?type=3";

const HEADERS = {
  "Accept-Encoding": "identity",
  "User-Agent": "binance-web3/1.1 (AgenticStocks)",
  Accept: "application/json",
};

export const BSC_NATIVE_BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
export const BSC_USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
export const BSC_U = "0xcE24439F2D9C6a2289F741120FE202248B666666";
export const BSC_USD1 = "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d";

/** Only these 5 tokens count toward campaign Realized PnL when buying bStock. */
export const CAMPAIGN_PAYMENT_TOKENS = ["BNB", "USDT", "USDC", "U", "USD1"] as const;
export type CampaignPaymentToken = (typeof CAMPAIGN_PAYMENT_TOKENS)[number];

export const PAYMENT_TOKEN_ADDRESSES: Record<CampaignPaymentToken, string> = {
  BNB: BSC_NATIVE_BNB,
  USDT: BSC_USDT,
  USDC: BSC_USDC,
  U: BSC_U,
  USD1: BSC_USD1,
};

export interface BStockToken {
  symbol: string;
  ticker: string;
  name?: string;
  contractAddress: string;
  chainId: string;
  multiplier: number;
  leveraged: boolean;
}

interface EligibleFile {
  week?: string;
  fetchedAt?: string;
  symbols?: string[];
}

let universe: BStockToken[] = [];
let eligibleSymbols: Set<string> | null = null;
let eligibilityConfirmed = false;
let lastBootstrapAt = 0;

const BOOTSTRAP_TTL_MS = 30 * 60_000;

function parseNum(value: unknown): number {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : 0;
}

function isEvmAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

export function isCampaignPaymentToken(symbol: string): boolean {
  return (CAMPAIGN_PAYMENT_TOKENS as readonly string[]).includes(symbol.toUpperCase());
}

export function paymentTokenAddress(symbol: string): string | undefined {
  const upper = symbol.toUpperCase() as CampaignPaymentToken;
  return PAYMENT_TOKEN_ADDRESSES[upper];
}

export function tickerFromBstock(symbol: string): string {
  const upper = symbol.toUpperCase();
  return upper.endsWith("B") && upper.length > 1 ? upper.slice(0, -1) : upper;
}

function parseRow(row: Record<string, unknown>): BStockToken | null {
  const symbol = String(row.symbol ?? row.asset ?? "").toUpperCase();
  const contractAddress = String(row.contractAddress ?? row.address ?? "");
  if (!symbol || !isEvmAddress(contractAddress)) return null;
  if (row.type != null && Number(row.type) !== 3) return null;

  const multiplier = parseNum(row.multiplier) || 1;
  const ticker = String(row.ticker ?? tickerFromBstock(symbol)).toUpperCase();
  const leveraged = Math.abs(multiplier - 1) > 0.15;

  return {
    symbol,
    ticker,
    name: row.name ? String(row.name) : undefined,
    contractAddress,
    chainId: String(row.chainId ?? "56"),
    multiplier,
    leveraged,
  };
}

async function fetchType3Universe(): Promise<BStockToken[]> {
  const res = await fetch(BSTOCK_LIST_URL, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`bStock type=3 API HTTP ${res.status}`);
  }
  const json = (await res.json()) as { success?: boolean; data?: unknown };
  const list = Array.isArray(json.data) ? json.data : [];
  const tokens: BStockToken[] = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const parsed = parseRow(row as Record<string, unknown>);
    if (parsed) tokens.push(parsed);
  }
  return tokens;
}

function loadEligibleFile(): { week?: string; symbols: string[] } | null {
  if (!existsSync(ELIGIBLE_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(ELIGIBLE_FILE, "utf8")) as EligibleFile;
    const symbols = (raw.symbols ?? []).map((s) => s.toUpperCase()).filter(Boolean);
    if (symbols.length === 0) return null;
    return { week: raw.week, symbols };
  } catch (err) {
    logger.warn("Could not read eligible-bstocks.json", { error: String(err) });
    return null;
  }
}

function envEligibleSymbols(): string[] {
  return (process.env.ELIGIBLE_BSTOCKS ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * Load the type=3 bStock universe (contract addresses) and the current-week
 * eligible list used for campaign PnL scoring.
 *
 * Address source = type=3 API (authoritative for contracts).
 * Eligibility = ELIGIBLE_BSTOCKS env, else data/eligible-bstocks.json, else
 * all non-leveraged type=3 tokens with eligibilityConfirmed=false.
 */
export async function bootstrapBstocks(force = false): Promise<{
  universe: BStockToken[];
  eligible: string[];
  eligibilityConfirmed: boolean;
}> {
  if (!force && universe.length > 0 && Date.now() - lastBootstrapAt < BOOTSTRAP_TTL_MS) {
    return {
      universe,
      eligible: getEligibleBstockSymbols(),
      eligibilityConfirmed,
    };
  }

  try {
    universe = await fetchType3Universe();
    lastBootstrapAt = Date.now();
    for (const token of universe) {
      cacheBscTokenAddress(token.symbol, token.contractAddress);
    }
    logger.info("Loaded bStock universe (type=3)", { count: universe.length });
  } catch (err) {
    logger.warn("bStock type=3 fetch failed — using cached/empty universe", {
      error: String(err),
    });
    if (universe.length === 0) {
      lastBootstrapAt = Date.now();
    }
  }

  const envList = envEligibleSymbols();
  const fileList = loadEligibleFile();
  const allowLeveraged = process.env.ALLOW_LEVERAGED_BSTOCKS === "true";

  if (envList.length > 0) {
    eligibleSymbols = new Set(envList);
    eligibilityConfirmed = true;
    logger.info("Campaign eligible list from ELIGIBLE_BSTOCKS", { count: envList.length });
  } else if (fileList) {
    eligibleSymbols = new Set(fileList.symbols);
    eligibilityConfirmed = true;
    logger.info("Campaign eligible list from eligible-bstocks.json", {
      week: fileList.week,
      count: fileList.symbols.length,
    });
  } else {
    const fallback = universe
      .filter((t) => allowLeveraged || !t.leveraged)
      .map((t) => t.symbol);
    eligibleSymbols = new Set(fallback);
    eligibilityConfirmed = false;
    logger.warn(
      "Weekly eligible bStock list unavailable — trading the type=3 universe. PnL scoring is unconfirmed until the official list is set (ELIGIBLE_BSTOCKS or data/eligible-bstocks.json).",
      { count: fallback.length }
    );
  }

  if (!allowLeveraged) {
    for (const token of universe) {
      if (token.leveraged) eligibleSymbols.delete(token.symbol);
    }
  }

  return {
    universe,
    eligible: getEligibleBstockSymbols(),
    eligibilityConfirmed,
  };
}

export function getBstockUniverse(): BStockToken[] {
  return universe;
}

export function getBstock(symbol: string): BStockToken | undefined {
  const upper = symbol.toUpperCase();
  return universe.find((t) => t.symbol === upper || t.ticker === upper);
}

export function getBstockAddress(symbol: string): string | undefined {
  return getBstock(symbol)?.contractAddress ?? paymentTokenAddress(symbol);
}

export function getEligibleBstockSymbols(): string[] {
  if (eligibleSymbols && eligibleSymbols.size > 0) return [...eligibleSymbols];
  return universe.filter((t) => !t.leveraged).map((t) => t.symbol);
}

export function isEligibleBstock(symbol: string): boolean {
  const upper = symbol.toUpperCase();
  if (eligibleSymbols) return eligibleSymbols.has(upper);
  return universe.some((t) => t.symbol === upper && !t.leveraged);
}

export function isEligibilityConfirmed(): boolean {
  return eligibilityConfirmed;
}

export function isLeveragedBstock(symbol: string): boolean {
  return getBstock(symbol)?.leveraged === true;
}
