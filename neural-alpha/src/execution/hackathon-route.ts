/**
 * Live send path: Trading API calldata, Transaction API simulate,
 * then one broadcast. market-order is the fallback only when Developer
 * Mode cannot sign this call. A failed simulation never falls through.
 */
import { bawData, bawJson, BawCliError } from "../integrations/baw-cli.js";
import {
  broadcastSignedEvmTransaction,
  buildSwapTransaction,
  getAddressPortfolio,
  getAggregatedQuote,
  simulationRejected,
  simulateEvmTransaction,
  type SwapCall,
} from "../integrations/binance-web3-signed.js";
import { logger } from "../utils/logger.js";

export interface LiveRouteInput {
  wallet: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  /** Human amount of the token being sold (USDT for a buy, shares for a sell). */
  fromAmount: number;
  fromDecimals: number;
  bawOutput?: number | null;
  slippagePct: number;
  chainId?: string;
}

export interface LiveRouteResult {
  outcome: "sent" | "fallback" | "blocked";
  txHash?: string;
  simulate?: string;
  reason: string;
}

function smallestUnit(amount: number, decimals: number): string {
  const safeDecimals = Math.max(0, Math.min(18, decimals));
  const fixed = amount.toFixed(Math.min(8, safeDecimals));
  const [whole, frac = ""] = fixed.split(".");
  const fraction = (frac + "0".repeat(safeDecimals)).slice(0, safeDecimals);
  return BigInt(`${whole}${fraction}` || "0").toString();
}

function humanUnit(raw: string | undefined, decimals: number | null): number | null {
  if (!raw || decimals == null) return null;
  try {
    const value = Number(BigInt(raw)) / 10 ** decimals;
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function quotesDisagree(tradingOut: number | null, bawOut: number | null, slippagePct: number): boolean {
  if (tradingOut == null || bawOut == null || bawOut <= 0 || tradingOut <= 0) return false;
  const gap = Math.abs(tradingOut - bawOut) / bawOut * 100;
  if (gap >= 25) return false;
  return gap > slippagePct;
}

function findString(value: unknown, key: string, depth = 0): string | undefined {
  if (depth > 5 || !value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, key, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const direct = row[key];
  if (typeof direct === "string" && direct.length > 0) return direct;
  for (const nested of Object.values(row)) {
    const found = findString(nested, key, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function wei(value: string): string {
  if (value.startsWith("0x")) return BigInt(value).toString();
  if (/^\d+$/.test(value)) return value;
  return "0";
}

async function developerMode(): Promise<boolean> {
  try {
    const settings = await bawJson(["wallet", "settings"], { timeoutMs: 20_000 });
    return readDevMode(settings) === true;
  } catch (err) {
    logger.warn("Agentic Wallet settings unreadable", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

function readDevMode(value: unknown, depth = 0): boolean | null {
  if (depth > 5 || !value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = readDevMode(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  const row = value as Record<string, unknown>;
  const dev = row.devMode;
  if (dev && typeof dev === "object" && !Array.isArray(dev) && typeof (dev as { enabled?: unknown }).enabled === "boolean") {
    return (dev as { enabled: boolean }).enabled;
  }
  for (const nested of Object.values(row)) {
    const found = readDevMode(nested, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

async function broadcastOrExecute(wallet: string, call: SwapCall, chainId: string): Promise<LiveRouteResult> {
  const signed = call.signedTransaction;
  if (signed && signed.startsWith("0x") && signed.length > 20) {
    const broadcast = await broadcastSignedEvmTransaction({
      signedTransaction: signed,
      address: wallet,
      chainId,
    });
    const txHash = findString(broadcast, "txHash") ?? findString(broadcast, "hash");
    return { outcome: "sent", txHash, simulate: "pass", reason: "Transaction API broadcast of the signed call" };
  }

  if (!(await developerMode())) {
    return { outcome: "fallback", simulate: "pass", reason: "Developer Mode is off; market-order will send" };
  }

  const preview = await bawJson(
    [
      "contract-call",
      "preview",
      "--binanceChainId",
      chainId,
      "--from",
      wallet,
      "--to",
      call.to,
      "--value",
      wei(call.value),
      "--inputData",
      call.data,
    ],
    { timeoutMs: 45_000 }
  );
  const previewSigned = findString(preview, "signedTransaction");
  if (previewSigned && previewSigned.startsWith("0x") && previewSigned.length > 20) {
    const broadcast = await broadcastSignedEvmTransaction({
      signedTransaction: previewSigned,
      address: wallet,
      chainId,
    });
    return {
      outcome: "sent",
      txHash: findString(broadcast, "txHash") ?? findString(broadcast, "hash"),
      simulate: "pass",
      reason: "Transaction API broadcast of the preview signature",
    };
  }

  const requestId = findString(preview, "requestId");
  if (!requestId) {
    return { outcome: "blocked", simulate: "pass", reason: "contract-call preview returned no requestId" };
  }
  const executed = await bawJson(["contract-call", "execute", "--requestId", requestId], { timeoutMs: 90_000 });
  const data = bawData<Record<string, unknown>>(executed);
  const status = String(data.status ?? "");
  if (status === "PENDING_CONFIRMATION") {
    return { outcome: "blocked", simulate: "pass", reason: "Confirm the contract call in the Binance app" };
  }
  const txHash = typeof data.txHash === "string" ? data.txHash : undefined;
  if (!txHash) {
    return { outcome: "blocked", simulate: "pass", reason: "contract-call execute returned no tx hash" };
  }
  return { outcome: "sent", txHash, simulate: "pass", reason: "baw contract-call broadcast the simulated swap" };
}

export async function routeLiveSwap(input: LiveRouteInput): Promise<LiveRouteResult> {
  const chainId = input.chainId ?? "56";
  const amount = smallestUnit(input.fromAmount, input.fromDecimals);
  if (amount === "0") return { outcome: "blocked", reason: "swap amount rounded to zero" };

  let quote;
  try {
    quote = await getAggregatedQuote({
      fromTokenAddress: input.fromTokenAddress,
      toTokenAddress: input.toTokenAddress,
      amount,
      userWalletAddress: input.wallet,
      chainId,
    });
  } catch (err) {
    return { outcome: "blocked", reason: err instanceof Error ? err.message : String(err) };
  }
  if (!quote?.quoteId) return { outcome: "blocked", reason: "Trading API quote returned no route" };

  const tradingOut = humanUnit(quote.toTokenAmount, quote.toDecimals);
  if (quotesDisagree(tradingOut, input.bawOutput ?? null, input.slippagePct)) {
    return {
      outcome: "blocked",
      reason: `Trading quote ${tradingOut} disagrees with Agentic Wallet ${input.bawOutput} beyond ${input.slippagePct}%`,
    };
  }

  let call: SwapCall | null = null;
  try {
    call = await buildSwapTransaction({
      fromTokenAddress: input.fromTokenAddress,
      toTokenAddress: input.toTokenAddress,
      amount,
      userWalletAddress: input.wallet,
      quoteId: quote.quoteId,
      slippagePercent: String(input.slippagePct),
      chainId,
    });
  } catch (err) {
    return { outcome: "blocked", reason: err instanceof Error ? err.message : String(err) };
  }

  if (!call) {
    return {
      outcome: "fallback",
      reason: `Trading route ${quote.executionMode ?? "RFQ"} has no EVM calldata; market-order will send`,
    };
  }

  try {
    const simulated = await simulateEvmTransaction({
      from: input.wallet,
      to: call.to,
      data: call.data,
      value: wei(call.value),
      chainId,
    });
    const rejected = simulationRejected(simulated);
    if (rejected) return { outcome: "blocked", simulate: "fail", reason: rejected };
  } catch (err) {
    return { outcome: "blocked", simulate: "fail", reason: err instanceof Error ? err.message : String(err) };
  }

  try {
    return await broadcastOrExecute(input.wallet, call, chainId);
  } catch (err) {
    if (err instanceof BawCliError && /DEV_MODE|developer mode/i.test(err.message)) {
      return { outcome: "fallback", simulate: "pass", reason: "Developer Mode refused the call; market-order will send" };
    }
    return { outcome: "blocked", simulate: "pass", reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function portfolioUsd(wallet: string): Promise<number | null> {
  try {
    const overview = await getAddressPortfolio(wallet);
    const text = JSON.stringify(overview);
    const match = text.match(/"(?:totalValueUsd|totalValue|balanceUsd)"\s*:\s*"?([0-9.]+)"?/);
    const n = match ? parseFloat(match[1]!) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    logger.warn("Wallet API portfolio read failed", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
