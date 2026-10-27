/**
 * Where a customer's subscription stands, and what to do about it this tick.
 * Pure: no I/O. The scheduler in server.mjs applies the plan.
 *
 * active -> grace (3 days, agent keeps trading) -> lapsed (new buys stop; open
 * positions and exits are untouched). A customer who cancels skips the grace.
 */
export const GRACE_DAYS = 3;
export const REMINDER_DAYS = [7, 3, 1];
const DAY_MS = 86_400_000;

export function subscriptionState(row, nowMs) {
  const end = Date.parse(row.paid_until || "");
  const cancelling = Number(row.cancel_at_period_end) === 1;
  if (!Number.isFinite(end)) return { stage: "unknown", daysLeft: null, endsAt: null, graceEndsAt: null, cancelling };
  const graceEnd = end + (cancelling ? 0 : GRACE_DAYS * DAY_MS);
  const base = { endsAt: new Date(end).toISOString(), graceEndsAt: new Date(graceEnd).toISOString(), cancelling };
  if (end > nowMs) return { ...base, stage: "active", daysLeft: Math.ceil((end - nowMs) / DAY_MS) };
  return { ...base, stage: nowMs < graceEnd ? "grace" : "lapsed", daysLeft: 0 };
}

/** @returns {{ state: object, halt: boolean, stage: string | null, clearStage: boolean }} */
export function planLifecycle(row, nowMs) {
  const state = subscriptionState(row, nowMs);
  const sent = row.reminder_stage || "";
  const plan = { state, halt: false, stage: null, clearStage: false };
  if (state.stage === "unknown") return plan;
  if (state.stage === "lapsed") {
    plan.halt = !Number(row.buys_halted);
    if (sent !== "lapsed") plan.stage = "lapsed";
  } else if (state.stage === "grace") {
    if (sent !== "grace" && sent !== "lapsed") plan.stage = "grace";
  } else if (sent && state.daysLeft > Math.max(...REMINDER_DAYS)) {
    plan.clearStage = true; // renewed: the next countdown starts fresh
  } else if (!state.cancelling) {
    const day = REMINDER_DAYS.filter((d) => state.daysLeft <= d).sort((a, b) => a - b)[0];
    if (day !== undefined && (sent === "" || Number(sent) > day)) plan.stage = String(day);
  }
  return plan;
}

export function reminderText(stage, state, renewUrl) {
  const renew = renewUrl ? ` Renew here: ${renewUrl}` : "";
  if (stage === "lapsed") {
    return state.cancelling
      ? "Your Neural Alpha subscription has ended, as you asked. New buys are stopped. Open positions stay and their exits still run."
      : `Your Neural Alpha subscription has ended. New buys are stopped. Open positions stay and their exits still run.${renew}`;
  }
  if (stage === "grace") {
    return `Your Neural Alpha subscription ended. Your agent keeps trading until ${state.graceEndsAt.slice(0, 10)}, then new buys stop.${renew}`;
  }
  const d = Number(stage);
  return `Your Neural Alpha subscription ends in ${d} day${d === 1 ? "" : "s"}.${renew}`;
}
