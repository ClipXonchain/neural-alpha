/**
 * Cadence for paid campaign x402 (CMC MCP + Agent Studio).
 *
 * Each source costs about $0.01 in USDT or U. Calls run only when the agent
 * still has free USDT above the reserve, and never more often than the
 * interval (default 2h per source).
 */

/** Default gap between paid calls of the same source. */
export const DEFAULT_X402_INTERVAL_MS = 2 * 60 * 60 * 1000;

/**
 * Skip paid calls unless free USDT is at least this many dollars.
 * Below this there is no spare cash to justify a $0.01 research payment.
 */
export const DEFAULT_X402_MIN_FREE_USDT = 5;

export interface X402Settings {
  cmcX402Enabled: boolean;
  studioX402Enabled: boolean;
  /** CMC paid-call interval (ms). */
  cmcX402IntervalMs: number;
  /** Studio paid-call interval (ms). */
  studioX402IntervalMs: number;
  /** Minimum free USDT required before either paid call. */
  x402MinFreeUsdtUsd: number;
}

function envFlagOn(
  env: Record<string, string | undefined>,
  name: string
): boolean | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  return raw !== "false" && raw !== "0";
}

function envIntervalMs(
  env: Record<string, string | undefined>,
  name: string,
  fallbackName: string | undefined,
  defaultMs: number
): number {
  const raw = env[name] || (fallbackName ? env[fallbackName] : undefined) || String(defaultMs);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
}

function envPositiveNumber(
  env: Record<string, string | undefined>,
  name: string,
  defaultValue: number
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}

/**
 * CMC paid x402 is ON by default. Either `CMC_X402_ENABLED=false` or the
 * legacy `CMC_MACRO_ENABLED=false` turns it off.
 */
export function isCmcX402Enabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const primary = envFlagOn(env, "CMC_X402_ENABLED");
  const legacy = envFlagOn(env, "CMC_MACRO_ENABLED");
  if (primary === false || legacy === false) return false;
  return true;
}

/** Agent Studio paid x402 is ON by default. `STUDIO_X402_ENABLED=false` turns it off. */
export function isStudioX402Enabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return envFlagOn(env, "STUDIO_X402_ENABLED") !== false;
}

export function parseX402Settings(
  env: Record<string, string | undefined> = process.env
): X402Settings {
  return {
    cmcX402Enabled: isCmcX402Enabled(env),
    studioX402Enabled: isStudioX402Enabled(env),
    cmcX402IntervalMs: envIntervalMs(
      env,
      "CMC_X402_INTERVAL_MS",
      "CMC_MACRO_REFRESH_MS",
      DEFAULT_X402_INTERVAL_MS
    ),
    studioX402IntervalMs: envIntervalMs(
      env,
      "STUDIO_X402_INTERVAL_MS",
      undefined,
      DEFAULT_X402_INTERVAL_MS
    ),
    x402MinFreeUsdtUsd: envPositiveNumber(
      env,
      "X402_MIN_FREE_USDT",
      DEFAULT_X402_MIN_FREE_USDT
    ),
  };
}

export function lastSettledCallAt(
  calls: Array<{ at: number; settled: boolean }>
): number {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i]!.settled) return calls[i]!.at;
  }
  return 0;
}

export function shouldFireX402(opts: {
  enabled: boolean;
  lastFiredAt: number;
  intervalMs: number;
  /** On-chain free USDT (or payment stable) available to the agent. */
  freeUsdtUsd: number;
  /** Paid calls stay off until free USDT is at least this large. */
  minFreeUsdtUsd?: number;
  now?: number;
}): boolean {
  if (!opts.enabled) return false;
  const minFree = opts.minFreeUsdtUsd ?? DEFAULT_X402_MIN_FREE_USDT;
  if (!(opts.freeUsdtUsd >= minFree)) return false;
  const now = opts.now ?? Date.now();
  const elapsed = opts.lastFiredAt > 0 ? now - opts.lastFiredAt : Number.POSITIVE_INFINITY;
  return elapsed >= opts.intervalMs;
}
