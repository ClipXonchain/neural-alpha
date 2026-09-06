/**
 * Cadence for paid campaign x402 (CMC MCP + Agent Studio).
 *
 * When portfolio slots are open, fire after the immediate cooldown (default 15m).
 * When slots are full, wait for the configured interval.
 */

/** Min gap between paid calls of the same source when a slot is open. */
export const X402_IMMEDIATE_COOLDOWN_MS = 15 * 60 * 1000;

/** Matches the historical CMC_MACRO_REFRESH_MS code default. */
export const DEFAULT_X402_INTERVAL_MS = 4 * 60 * 60 * 1000;

export interface X402Settings {
  cmcX402Enabled: boolean;
  studioX402Enabled: boolean;
  /** When slots are full, CMC paid-call interval (ms). */
  cmcX402IntervalMs: number;
  /** When slots are full, Studio paid-call interval (ms). */
  studioX402IntervalMs: number;
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
  slotsOpen: boolean;
  lastFiredAt: number;
  intervalMs: number;
  now?: number;
  minCooldownMs?: number;
}): boolean {
  if (!opts.enabled) return false;
  const now = opts.now ?? Date.now();
  const cooldown = opts.minCooldownMs ?? X402_IMMEDIATE_COOLDOWN_MS;
  const elapsed = opts.lastFiredAt > 0 ? now - opts.lastFiredAt : Number.POSITIVE_INFINITY;
  if (elapsed < cooldown) return false;
  if (opts.slotsOpen) return true;
  return elapsed >= opts.intervalMs;
}
