/** Host sizing and the hard risk ceiling. The trading process only receives these values. */

export const CALLS_PER_CYCLE = 20;

export const PRESETS = {
  cautious: { maxPositionUsd: 50, maxDrawdownPct: 8, maxTradeUsd: 15, minBuyIntervalMs: 600_000 },
  normal: { maxPositionUsd: 100, maxDrawdownPct: 10, maxTradeUsd: 25, minBuyIntervalMs: 600_000 },
  active: { maxPositionUsd: 250, maxDrawdownPct: 12, maxTradeUsd: 40, minBuyIntervalMs: 600_000 },
};

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
