import assert from "node:assert/strict";
import test from "node:test";
import { planLifecycle, reminderText, subscriptionState } from "./lifecycle.mjs";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-01T00:00:00Z");
const row = (over = {}) => ({ paid_until: new Date(T0 + 30 * DAY).toISOString(), reminder_stage: "", buys_halted: 0, cancel_at_period_end: 0, ...over });

test("a fresh month sends nothing", () => {
  const plan = planLifecycle(row(), T0);
  assert.equal(plan.state.stage, "active");
  assert.equal(plan.stage, null);
  assert.equal(plan.halt, false);
});

test("reminders go out at 7, 3 and 1 days and never repeat or go backwards", () => {
  assert.equal(planLifecycle(row(), T0 + 23 * DAY).stage, "7");
  assert.equal(planLifecycle(row({ reminder_stage: "7" }), T0 + 23 * DAY).stage, null);
  assert.equal(planLifecycle(row({ reminder_stage: "7" }), T0 + 27 * DAY).stage, "3");
  assert.equal(planLifecycle(row({ reminder_stage: "3" }), T0 + 25 * DAY).stage, null);
  assert.equal(planLifecycle(row({ reminder_stage: "3" }), T0 + 29.5 * DAY).stage, "1");
});

test("a customer who skipped to 2 days left gets one reminder, the 3-day one", () => {
  assert.equal(planLifecycle(row(), T0 + 28 * DAY).stage, "3");
});

test("expiry gives a 3-day grace, then halts buys once", () => {
  const grace = planLifecycle(row(), T0 + 31 * DAY);
  assert.equal(grace.state.stage, "grace");
  assert.equal(grace.halt, false);
  assert.equal(grace.stage, "grace");
  assert.equal(planLifecycle(row({ reminder_stage: "grace" }), T0 + 32 * DAY).stage, null);

  const lapsed = planLifecycle(row({ reminder_stage: "grace" }), T0 + 34 * DAY);
  assert.equal(lapsed.state.stage, "lapsed");
  assert.equal(lapsed.halt, true);
  assert.equal(lapsed.stage, "lapsed");
  const done = planLifecycle(row({ reminder_stage: "lapsed", buys_halted: 1 }), T0 + 40 * DAY);
  assert.equal(done.halt, false);
  assert.equal(done.stage, null);
});

test("cancelling skips the grace and the reminders", () => {
  assert.equal(planLifecycle(row({ cancel_at_period_end: 1 }), T0 + 29.5 * DAY).stage, null);
  const ended = planLifecycle(row({ cancel_at_period_end: 1 }), T0 + 30 * DAY + 1);
  assert.equal(ended.state.stage, "lapsed");
  assert.equal(ended.halt, true);
  assert.match(reminderText("lapsed", ended.state, ""), /as you asked/);
});

test("renewing clears the stage so the next countdown starts fresh", () => {
  const renewed = row({ reminder_stage: "lapsed", buys_halted: 0, paid_until: new Date(T0 + 60 * DAY).toISOString() });
  const plan = planLifecycle(renewed, T0 + 35 * DAY);
  assert.equal(plan.clearStage, true);
  assert.equal(planLifecycle({ ...renewed, reminder_stage: "" }, T0 + 35 * DAY).stage, null);
});

test("rows without a paid_until are left alone", () => {
  assert.equal(subscriptionState({ paid_until: null }, T0).stage, "unknown");
  assert.deepEqual(planLifecycle({ paid_until: null }, T0).stage, null);
});

test("reminder text names the days and the renew link", () => {
  const s = subscriptionState(row(), T0 + 29.5 * DAY);
  assert.match(reminderText("1", s, "https://x/portal?renew=1"), /1 day\.\s+Renew here: https:\/\/x\/portal\?renew=1/);
  assert.match(reminderText("7", s, ""), /7 days\./);
});
