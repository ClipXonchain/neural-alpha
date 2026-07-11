/** Allowlisted env keys users may set from the dashboard. */
export const CONFIG_ALLOWLIST = [
  "STRATEGY",
  "MAX_DRAWDOWN_PCT",
  "DISABLE_DRAWDOWN_LIMIT",
  "MAX_DAILY_TRADES",
  "STOP_LOSS_PCT",
  "TAKE_PROFIT_PCT",
  "TRAILING_ACTIVATE_PCT",
  "TRAILING_GIVEBACK_PCT",
  "MIN_BUY_CONFIDENCE",
  "TRADE_INTERVAL_MS",
  "SIGNAL_REFRESH_MS",
  "PROTECTIVE_EXIT_CHECK_MS",
  "SLIPPAGE_TOLERANCE",
  "MIN_GAS_RESERVE_USD",
  "BSC_GAS_PRICE_GWEI",
  "BSC_SWAP_GAS_LIMIT",
  "MAX_PORTFOLIO_TOKENS",
  "MIN_TRADE_AMOUNT_USD",
  "MAX_POSITION_SIZE_USD",
  "AUTO_EXIT_ENABLED",
  "AGENT_DISPLAY_NAME",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "AI_SIGNAL_ANALYSIS",
  "AI_SIGNAL_TOP_N",
  "AGENT_UNIVERSE",
] as const;

export type ConfigKey = (typeof CONFIG_ALLOWLIST)[number];

export const SECRET_CONFIG_KEYS = new Set<string>([
  "OPENAI_API_KEY",
]);

export function isAllowedConfigKey(key: string): key is ConfigKey {
  return (CONFIG_ALLOWLIST as readonly string[]).includes(key);
}

export function validateConfigUpdates(
  updates: Record<string, unknown>
): { ok: true; clean: Record<string, string> } | { ok: false; error: string } {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!isAllowedConfigKey(key)) {
      return { ok: false, error: `Config key not allowed: ${key}` };
    }
    if (value === undefined || value === null) continue;
    const str = String(value);
    if (key === "STRATEGY" && !["safe", "medium", "momentum", "bstocks"].includes(str)) {
      return { ok: false, error: "STRATEGY must be safe, medium, momentum, or bstocks" };
    }
    if (
      key === "AGENT_UNIVERSE" &&
      !["spot", "alpha", "both", "bstocks"].includes(str)
    ) {
      return { ok: false, error: "AGENT_UNIVERSE must be spot, alpha, both, or bstocks" };
    }
    if (key === "MIN_GAS_RESERVE_USD") {
      const n = parseFloat(str);
      if (!Number.isFinite(n) || n < 0.1 || n > 100) {
        return { ok: false, error: "MIN_GAS_RESERVE_USD must be between 0.1 and 100" };
      }
    }
    if (key === "BSC_GAS_PRICE_GWEI") {
      if (str !== "" && str !== "0") {
        const n = parseFloat(str);
        // BSC often sits near 0.05 gwei; allow sub-gwei fixed prices.
        if (!Number.isFinite(n) || n < 0.01 || n > 500) {
          return { ok: false, error: "BSC_GAS_PRICE_GWEI must be 0 (auto) or 0.01–500" };
        }
      }
    }
    if (key === "BSC_SWAP_GAS_LIMIT") {
      if (str !== "" && str !== "0") {
        const n = parseInt(str, 10);
        if (!Number.isFinite(n) || n < 50_000 || n > 2_000_000) {
          return { ok: false, error: "BSC_SWAP_GAS_LIMIT must be 0 (auto) or 50k–2M" };
        }
      }
    }
    if (key === "MAX_POSITION_SIZE_USD") {
      const n = parseFloat(str);
      if (!Number.isFinite(n) || n < 1 || n > 1_000_000) {
        return { ok: false, error: "MAX_POSITION_SIZE_USD must be between $1 and $1,000,000" };
      }
    }
    if (key === "MIN_TRADE_AMOUNT_USD") {
      const n = parseFloat(str);
      if (!Number.isFinite(n) || n < 0.5 || n > 100_000) {
        return { ok: false, error: "MIN_TRADE_AMOUNT_USD must be between $0.50 and $100,000" };
      }
    }
    if (key === "MAX_PORTFOLIO_TOKENS") {
      const n = parseInt(str, 10);
      if (!Number.isFinite(n) || n < 1 || n > 50) {
        return { ok: false, error: "MAX_PORTFOLIO_TOKENS must be between 1 and 50" };
      }
    }
    clean[key] = str;
  }
  return { ok: true, clean };
}

/** Map persisted env keys → live agent `/api/control/config` body (camelCase). */
export function envToControlBody(
  env: Record<string, string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (env.STRATEGY) out.strategy = env.STRATEGY;
  if (env.MAX_DRAWDOWN_PCT) out.maxDrawdownPct = parseFloat(env.MAX_DRAWDOWN_PCT);
  if (env.STOP_LOSS_PCT) out.stopLossPct = parseFloat(env.STOP_LOSS_PCT);
  if (env.TAKE_PROFIT_PCT) out.takeProfitPct = parseFloat(env.TAKE_PROFIT_PCT);
  if (env.MAX_DAILY_TRADES) out.maxDailyTrades = parseInt(env.MAX_DAILY_TRADES, 10);
  if (env.SLIPPAGE_TOLERANCE) out.slippageTolerance = parseFloat(env.SLIPPAGE_TOLERANCE);
  if (env.MIN_GAS_RESERVE_USD) out.minGasReserveUsd = parseFloat(env.MIN_GAS_RESERVE_USD);
  if (env.BSC_GAS_PRICE_GWEI) {
    const g = parseFloat(env.BSC_GAS_PRICE_GWEI);
    if (Number.isFinite(g) && g > 0) out.bscGasPriceGwei = g;
  }
  if (env.BSC_SWAP_GAS_LIMIT) {
    const l = parseInt(env.BSC_SWAP_GAS_LIMIT, 10);
    if (Number.isFinite(l) && l > 0) out.bscSwapGasLimit = l;
  }
  if (env.TRADE_INTERVAL_MS) out.tradeIntervalMs = parseInt(env.TRADE_INTERVAL_MS, 10);
  if (env.SIGNAL_REFRESH_MS) out.signalRefreshMs = parseInt(env.SIGNAL_REFRESH_MS, 10);
  if (env.MAX_POSITION_SIZE_USD) out.maxPositionSizeUsd = parseFloat(env.MAX_POSITION_SIZE_USD);
  if (env.MAX_PORTFOLIO_TOKENS) out.maxPortfolioTokens = parseInt(env.MAX_PORTFOLIO_TOKENS, 10);
  if (env.MIN_TRADE_AMOUNT_USD) out.minTradeAmountUsd = parseFloat(env.MIN_TRADE_AMOUNT_USD);
  if (env.MIN_BUY_CONFIDENCE) out.minBuyConfidence = parseFloat(env.MIN_BUY_CONFIDENCE);
  if (env.TRAILING_ACTIVATE_PCT) out.trailingActivatePct = parseFloat(env.TRAILING_ACTIVATE_PCT);
  if (env.TRAILING_GIVEBACK_PCT) out.trailingGivebackPct = parseFloat(env.TRAILING_GIVEBACK_PCT);
  if (env.PROTECTIVE_EXIT_CHECK_MS)
    out.protectiveExitCheckMs = parseInt(env.PROTECTIVE_EXIT_CHECK_MS, 10);
  if (env.AUTO_EXIT_ENABLED !== undefined)
    out.autoExitEnabled = env.AUTO_EXIT_ENABLED === "true";
  if (env.DISABLE_DRAWDOWN_LIMIT !== undefined)
    out.drawdownLimitEnabled = env.DISABLE_DRAWDOWN_LIMIT !== "true";
  return out;
}

export function maskSecrets(
  config: Record<string, { value: string | null; is_secret: boolean }>
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(config)) {
    if (v.is_secret && v.value) {
      out[k] = "••••••••";
    } else {
      out[k] = v.value;
    }
  }
  return out;
}
