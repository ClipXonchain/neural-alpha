/**
 * Host sizing and the hard risk ceiling. The trading process only receives these values.
 *
 * Presets are 100, 250, and 500 USDT. Custom is any positive USDT amount up to
 * MAX_CUSTOM_POSITION_USD. The per-order trade cap is that same position size.
 * There is no second closed-market or off-hours number.
 *
 * Swap origin is always USDT. The software-fee asset is not the swap token.
 * The daily x402 count is the number of paid CMC calls a day, with a floor of 1.
 * The worker does not read X402_MIN_PAYMENTS_PER_DAY. It reads CMC_X402_INTERVAL_MS
 * and STUDIO_X402_INTERVAL_MS, so the hosted files set those from the same count.
 * Agent Studio is optional and starts off; when a customer turns it on it runs
 * at the same gap as CMC.
 */

export const CALLS_PER_CYCLE = 20;

/** Position size in USDT. The trade cap written for the worker equals this number. */
export const POSITION_PRESETS = {
  "100": 100,
  "250": 250,
  "500": 500,
};

export const DEFAULT_POSITION_PRESET = "100";
/** Largest custom position a customer may type. Stops a nonsense multi-billion cap. */
export const MAX_CUSTOM_POSITION_USD = 10_000;
export const MIN_BUY_INTERVAL_MS = 600_000;

/** Paid CMC x402 calls per day for each hosted user. One a day is the minimum. */
export const DEFAULT_X402_PER_DAY = 1;
export const MIN_X402_PER_DAY = 1;
export const MAX_X402_PER_DAY = 48;
const DAY_MS = 86_400_000;

/** Gap between paid calls of one source: a day divided by `perDay`. */
export function x402IntervalMs(perDay) {
  const n = Number(perDay);
  const count = Number.isInteger(n) && n >= MIN_X402_PER_DAY && n <= MAX_X402_PER_DAY
    ? n
    : DEFAULT_X402_PER_DAY;
  return Math.floor(DAY_MS / count);
}

/** Worker swap/quote token. Software fees may use other assets; swaps do not. */
export const SWAP_PAYMENT_TOKEN = "USDT";

/** Older rows. Kept so a mode change or renewal can still read them. Trade cap follows the stored position. */
const LEGACY_PRESETS = {
  cautious: 50,
  normal: 100,
  active: 250,
};

export const PAYMENT_ASSETS = ["USDT", "USDC", "BNB", "U", "USD1"];

/** Software subscription in USD. Stables are charged this amount; BNB is the equivalent. */
export const SOFTWARE_FEE_USD = 15;
/** Static BNB/USD mark used only to convert the software fee. Not a live price. */
export const SOFTWARE_BNB_PRICE_USD = 600;

export const BSC_CHAIN_ID = 56;
export const REQUIRED_CONFIRMATIONS = 15;
export const CHECKOUT_EXPIRY_MS = 10 * 60_000;
/** Checkout uniqueness is a 3-digit marker, 001–999. */
export const QUOTE_MARKER_MAX = 999;

/**
 * Stablecoin checkouts are stored as exactly three decimal places (`15.184`).
 * BNB quotes are a live-price amount and are not rewritten into that shape.
 */
export function checkoutAmountIsCurrent(asset, amountDisplay) {
  const upper = String(asset || "").trim().toUpperCase();
  if (upper === "BNB" || !PAYMENT_ASSETS.includes(upper)) return true;
  return /^\d+\.\d{3}$/.test(String(amountDisplay || "").trim());
}

/** Time for a payment mined before expiry to reach the required confirmations. */
export const CHECKOUT_SETTLEMENT_GRACE_MS = 15 * 60_000;
/** How long a matched transfer can wait for the customer container after the quote grace. */
export const CHECKOUT_PROVISION_RETRY_MS = 6 * 60 * 60_000;
export const SUBSCRIPTION_DAYS = 30;
export const SUBSCRIPTION_MS = SUBSCRIPTION_DAYS * 86_400_000;

/** Pinned BSC (chainId 56) contracts. All use 18 decimals on BSC. */
export const DEFAULT_TOKEN_CONTRACTS = {
  BNB: "native",
  USDT: "0x55d398326f99059ff775485246999027b3197955",
  USDC: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
  U: "0xce24439f2d9c6a2289f741120fe202248b666666",
  USD1: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
};

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function assertAddress(value, label = "address") {
  const clean = String(value || "").trim().toLowerCase();
  if (!ADDRESS_RE.test(clean)) {
    throw Object.assign(new Error(`${label} must be a 20-byte 0x hex address`), { status: 400 });
  }
  return clean;
}

export function resolveTokenContracts(env = {}) {
  return {
    BNB: "native",
    USDT: assertAddress(env.SAAS_CONTRACT_USDT || DEFAULT_TOKEN_CONTRACTS.USDT, "SAAS_CONTRACT_USDT"),
    USDC: assertAddress(env.SAAS_CONTRACT_USDC || DEFAULT_TOKEN_CONTRACTS.USDC, "SAAS_CONTRACT_USDC"),
    U: assertAddress(env.SAAS_CONTRACT_U || DEFAULT_TOKEN_CONTRACTS.U, "SAAS_CONTRACT_U"),
    USD1: assertAddress(env.SAAS_CONTRACT_USD1 || DEFAULT_TOKEN_CONTRACTS.USD1, "SAAS_CONTRACT_USD1",),
  };
}

export function parseUnits18(amountStr) {
  const raw = String(amountStr ?? "").trim();
  if (!/^\d+(?:\.\d{1,18})?$/.test(raw)) {
    throw Object.assign(new Error("amount must be a positive decimal with up to 18 decimals"), { status: 400 });
  }
  const [whole, frac = ""] = raw.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0"));
}

export function formatUnits18(weiValue) {
  const wei = BigInt(weiValue);
  if (wei < 0n) throw new Error("wei cannot be negative");
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * Locked checkout price plus a 3-digit unique marker.
 * Stables are exactly three decimal places (`15.184`). BNB keeps the live
 * dollar equivalent and puts that same 3-digit marker in the last places,
 * rounded up so the quote is never below the live price. `tail` 0 is the
 * unmarked fee shown on an asset button.
 */
export function quoteOrderAmount({ asset, priceUsd = SOFTWARE_FEE_USD, bnbPriceUsd = SOFTWARE_BNB_PRICE_USD, tail = 1 }) {
  const upper = String(asset || "").trim().toUpperCase();
  if (!PAYMENT_ASSETS.includes(upper)) {
    throw Object.assign(new Error("paymentAsset must be USDT, USDC, BNB, U, or USD1"), { status: 400 });
  }
  const safePrice = positive(Number(priceUsd), "priceUsd");
  const requestedTail = Math.floor(Number(tail) || 0);
  const marker = requestedTail <= 0 ? 0 : Math.min(QUOTE_MARKER_MAX, requestedTail);

  if (upper === "BNB") {
    const safeBnb = positive(Number(bnbPriceUsd), "bnbPriceUsd");
    if (marker === 0) {
      const baseMicroBnb = BigInt(Math.max(1, Math.round((safePrice / safeBnb) * 1_000_000)));
      const amountWei = baseMicroBnb * 10n ** 12n;
      return quoteResult(upper, safePrice, 0, amountWei, formatUnits18(amountWei));
    }
    const priceMicroUsd = BigInt(Math.round(safePrice * 1_000_000));
    const bnbMicroUsd = BigInt(Math.max(1, Math.round(safeBnb * 1_000_000)));
    const numerator = priceMicroUsd * 1_000_000n;
    const trueMicroFloor = numerator / bnbMicroUsd;
    const minMicro = numerator % bnbMicroUsd === 0n ? trueMicroFloor : trueMicroFloor + 1n;
    let high = minMicro / 1000n;
    if (high * 1000n + BigInt(marker) < minMicro) high += 1n;
    const amountMicro = high * 1000n + BigInt(marker);
    const amountWei = amountMicro * 10n ** 12n;
    return quoteResult(upper, safePrice, marker, amountWei, formatScaled(amountMicro, 6));
  }

  const cents = BigInt(Math.round(safePrice * 100));
  if (marker === 0) {
    const amountWei = cents * 10n ** 16n;
    return quoteResult(upper, safePrice, 0, amountWei, formatUnits18(amountWei));
  }
  const thousandths = cents * 10n + BigInt(marker);
  const amountWei = thousandths * 10n ** 15n;
  return quoteResult(upper, safePrice, marker, amountWei, formatScaled(thousandths, 3));
}

function quoteResult(asset, priceUsd, tail, amountWei, amountDisplay) {
  return {
    asset,
    priceUsd,
    tail,
    amountWei: amountWei.toString(),
    amountDisplay,
  };
}

function formatScaled(units, places) {
  const base = 10n ** BigInt(places);
  const whole = units / base;
  const frac = (units % base).toString().padStart(places, "0");
  return `${whole}.${frac}`;
}

/** Base fee shown on an asset button, before the per-order 3-digit marker. */
export function softwareFeeDisplay(asset) {
  return quoteOrderAmount({ asset, tail: 0 }).amountDisplay;
}

export function assertPayment(body) {
  const asset = String(body?.paymentAsset || "").trim().toUpperCase();
  const tx = String(body?.paymentTx || "").trim().toLowerCase();
  if (!PAYMENT_ASSETS.includes(asset)) {
    throw Object.assign(new Error("paymentAsset must be USDT, USDC, BNB, U, or USD1"), { status: 400 });
  }
  if (!/^0x[a-f0-9]{64}$/.test(tx)) {
    throw Object.assign(new Error("paymentTx must be a transaction hash"), { status: 400 });
  }
  return { asset, tx };
}

const ID_RE = /^[a-z0-9]{8}$/;

export function assertTenantId(id) {
  if (!ID_RE.test(id)) throw new Error("tenant id must be 8 lowercase letters or digits");
  return id;
}

export function containerName(id) {
  return `na-${assertTenantId(id)}`;
}

export function projectName(id) {
  return containerName(id);
}

export function resolveX402PerDay(value) {
  if (value == null || value === "") return DEFAULT_X402_PER_DAY;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < MIN_X402_PER_DAY || n > MAX_X402_PER_DAY) {
    throw Object.assign(
      new Error(`x402PerDay must be an integer from ${MIN_X402_PER_DAY} to ${MAX_X402_PER_DAY}`),
      { status: 400 },
    );
  }
  return n;
}

export function assertPositionUsd(value) {
  if (typeof value === "boolean" || value == null || value === "") {
    throw Object.assign(new Error("position size must be a positive USDT amount"), { status: 400 });
  }
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0) {
    throw Object.assign(new Error("position size must be a positive USDT amount"), { status: 400 });
  }
  if (n > MAX_CUSTOM_POSITION_USD) {
    throw Object.assign(
      new Error(`position size cannot exceed ${MAX_CUSTOM_POSITION_USD} USDT`),
      { status: 400 },
    );
  }
  const cents = Math.round(n * 100);
  if (Math.abs(n - cents / 100) > 1e-6 || cents < 1) {
    throw Object.assign(new Error("position size must be a positive USDT amount with at most 2 decimals"), { status: 400 });
  }
  return cents / 100;
}

function packRisk(preset, maxPositionUsd, x402PerDay) {
  return {
    preset,
    maxPositionUsd,
    maxTradeUsd: maxPositionUsd,
    minBuyIntervalMs: MIN_BUY_INTERVAL_MS,
    x402PerDay,
  };
}

/**
 * @param {string | { preset?: string, positionUsd?: number | string, x402PerDay?: number | string } | null | undefined} input
 * @param {{ allowLegacy?: boolean }} [opts]
 */
export function resolveRisk(input = DEFAULT_POSITION_PRESET, opts = {}) {
  const body = input != null && typeof input === "object" ? input : { preset: input };
  const presetRaw =
    body.preset == null || String(body.preset).trim() === ""
      ? DEFAULT_POSITION_PRESET
      : String(body.preset).trim();
  const x402PerDay = resolveX402PerDay(body.x402PerDay);

  if (Object.hasOwn(POSITION_PRESETS, presetRaw)) {
    return packRisk(presetRaw, POSITION_PRESETS[presetRaw], x402PerDay);
  }
  if (presetRaw === "custom") {
    return packRisk("custom", assertPositionUsd(body.positionUsd), x402PerDay);
  }
  if (opts.allowLegacy && Object.hasOwn(LEGACY_PRESETS, presetRaw)) {
    const amount =
      body.positionUsd == null || body.positionUsd === ""
        ? LEGACY_PRESETS[presetRaw]
        : assertPositionUsd(body.positionUsd);
    return packRisk(presetRaw, amount, x402PerDay);
  }
  throw Object.assign(new Error("risk preset must be 100, 250, 500, or custom"), { status: 400 });
}

/**
 * One interval for the whole machine, sized for a full host.
 * Adding a customer does not speed the others up or slow them down.
 */
export function hostPlan(opts) {
  const ramMb = positive(opts.ramMb, "ramMb");
  const mbPerTenant = positive(opts.mbPerTenant, "mbPerTenant");
  const budgetPerMin = positive(opts.budgetPerMin, "budgetPerMin");
  const callsPerCycle = positive(opts.callsPerCycle, "callsPerCycle");
  const minIntervalMs = positive(opts.minIntervalMs, "minIntervalMs");
  const maxIntervalMs = positive(opts.maxIntervalMs, "maxIntervalMs");
  const reservePct = opts.reservePct ?? 0.3;
  if (reservePct < 0 || reservePct >= 1) throw new Error("reservePct must be between 0 and 1");
  if (maxIntervalMs < minIntervalMs) throw new Error("maxIntervalMs is below minIntervalMs");

  const byRam = Math.floor((ramMb * (1 - reservePct)) / mbPerTenant);
  const byBudget = Math.floor((budgetPerMin * maxIntervalMs) / (callsPerCycle * 60_000));
  const cap = opts.maxTenantsCap ?? byRam;
  const maxTenants = Math.max(0, Math.min(byRam, byBudget, cap));
  const slots = Math.max(maxTenants, 1);
  const needed = Math.ceil((callsPerCycle * 60_000 * slots) / budgetPerMin);
  const intervalMs = Math.min(maxIntervalMs, Math.max(minIntervalMs, needed));
  const fullUsePerMin = maxTenants === 0 ? 0 : (callsPerCycle * 60_000 * maxTenants) / intervalMs;

  return { maxTenants, intervalMs, budgetPerMin, callsPerCycle, fullUsePerMin, byRam, byBudget };
}

export function estimatedUsePerMin(running, intervalMs, callsPerCycle = CALLS_PER_CYCLE) {
  if (running <= 0 || intervalMs <= 0) return 0;
  return (callsPerCycle * 60_000 * running) / intervalMs;
}

export function staggerSeconds(id) {
  assertTenantId(id);
  let n = 0;
  for (const ch of id) n = (n + ch.charCodeAt(0)) % 45;
  return n;
}

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}
