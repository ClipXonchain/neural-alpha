/** Host sizing and the hard risk ceiling. The trading process only receives these values. */

export const CALLS_PER_CYCLE = 20;

/** Position size only. The hosted product does not use a drawdown halt. */
export const PRESETS = {
  cautious: { maxPositionUsd: 50, maxTradeUsd: 15, minBuyIntervalMs: 600_000 },
  normal: { maxPositionUsd: 100, maxTradeUsd: 25, minBuyIntervalMs: 600_000 },
  active: { maxPositionUsd: 250, maxTradeUsd: 40, minBuyIntervalMs: 600_000 },
};

export const PAYMENT_ASSETS = ["USDT", "USDC", "BNB", "U", "USD1"];

export const BSC_CHAIN_ID = 56;
export const REQUIRED_CONFIRMATIONS = 15;
export const CHECKOUT_EXPIRY_MS = 30 * 60_000;
/** Time for a payment mined before expiry to reach the required confirmations. */
export const CHECKOUT_SETTLEMENT_GRACE_MS = 15 * 60_000;
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
 * Computes the locked checkout price and adds a unique micro-dollar tail
 * (less than $0.01) so concurrent buyers can be matched without a material surcharge.
 */
export function quoteOrderAmount({ asset, priceUsd = 30, bnbPriceUsd = 600, tail = 1 }) {
  const upper = String(asset || "").trim().toUpperCase();
  if (!PAYMENT_ASSETS.includes(upper)) {
    throw Object.assign(new Error("paymentAsset must be USDT, USDC, BNB, U, or USD1"), { status: 400 });
  }
  const safePrice = positive(Number(priceUsd), "priceUsd");
  const requestedTail = Math.floor(Number(tail) || 0);
  const microTail = requestedTail <= 0 ? 0 : Math.min(9_999, requestedTail);
  let tailWei;

  let baseWei;
  if (upper === "BNB") {
    const safeBnb = positive(Number(bnbPriceUsd), "bnbPriceUsd");
    // Convert the base quote to 6-decimal BNB precision before adding a sub-cent marker.
    const baseMicroBnb = BigInt(Math.max(1, Math.round((safePrice / safeBnb) * 1_000_000)));
    baseWei = baseMicroBnb * 10n ** 12n;
    const bnbPriceMicroUsd = BigInt(Math.max(1, Math.round(safeBnb * 1_000_000)));
    // Convert the sub-cent USD identifier to BNB wei using integer arithmetic.
    const numerator = BigInt(microTail) * 10n ** 18n;
    tailWei = (numerator + bnbPriceMicroUsd / 2n) / bnbPriceMicroUsd;
  } else {
    const baseCents = BigInt(Math.round(safePrice * 100));
    baseWei = baseCents * 10n ** 16n;
    // One micro-dollar is one micro-token for these USD-pegged payment assets.
    tailWei = BigInt(microTail) * 10n ** 12n;
  }
  const amountWei = baseWei + tailWei;
  return {
    asset: upper,
    priceUsd: safePrice,
    tail: microTail,
    amountWei: amountWei.toString(),
    amountDisplay: formatUnits18(amountWei),
  };
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

export function resolveRisk(preset = "cautious") {
  const risk = PRESETS[preset];
  if (!risk) throw new Error("risk preset must be cautious, normal, or active");
  return { preset, ...risk };
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
