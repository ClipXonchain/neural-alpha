import assert from "node:assert/strict";
import test from "node:test";
import { evaluate, parseAlerts } from "./watchdog.mjs";

const row = { id: "ab12cd34", status: "running", agent_mode: "live" };
const up = (over = {}) => ({ reachable: true, running: true, cycleCount: 5, recent: [], ...over });
const STALL = 30 * 60_000;
const step = (prev, desk, nowMs, r = row) => evaluate({ row: r, desk, nowMs, prev, stallMs: STALL });

test("one missed answer does not page; two in a row do, once", () => {
  let r = step({}, { reachable: false }, 1000);
  assert.equal(r.events.length, 0);
  r = step(r.next, { reachable: false }, 2000);
  assert.deepEqual(r.events.map((e) => [e.type, e.kind]), [["open", "agent_down"]]);
  assert.match(r.events[0].ops, /Agent ab12cd34 is not responding/);
  r = step(r.next, { reachable: false }, 3000);
  assert.equal(r.events.length, 0);
});

test("recovery resolves the issue once", () => {
  let r = step({}, { reachable: false }, 1);
  r = step(r.next, { reachable: false }, 2);
  r = step(r.next, up(), 3);
  assert.deepEqual(r.events.map((e) => [e.type, e.kind]), [["resolved", "agent_down"]]);
  r = step(r.next, up(), 4);
  assert.equal(r.events.filter((e) => e.type !== "trade").length, 0);
});

test("a cycle counter that stops moving opens agent_stalled after the stall window", () => {
  let r = step({}, up({ cycleCount: 9 }), 0);
  r = step(r.next, up({ cycleCount: 9 }), STALL - 1);
  r = step(r.next, up({ cycleCount: 9 }), STALL + 1);
  assert.equal(r.events.length, 0, "first stalled check only counts");
  r = step(r.next, up({ cycleCount: 9 }), STALL + 2);
  assert.deepEqual(r.events.map((e) => e.kind), ["agent_stalled"]);
  r = step(r.next, up({ cycleCount: 10 }), STALL + 3);
  assert.deepEqual(r.events.map((e) => e.type), ["resolved"]);
});

test("a stopped loop is reported, a paused container is not", () => {
  let r = step({}, up({ running: false }), 1);
  r = step(r.next, up({ running: false }), 2);
  assert.equal(r.events[0].kind, "agent_stopped");
  const paused = step({}, { reachable: false }, 1, { ...row, status: "paused" });
  assert.deepEqual(paused.events, []);
});

test("trades notify once, oldest first, and never replay on first look", () => {
  const t1 = { time: 100, side: "buy", symbol: "NVDAB", usd: 100 };
  const t2 = { time: 200, side: "sell", symbol: "NVDAB", usd: 104.5, pnl: 4.5 };
  let r = step({}, up({ recent: [t2, t1] }), 1);
  assert.equal(r.events.length, 0);
  assert.equal(r.next.lastTrade, 200);
  const t3 = { time: 300, side: "buy", symbol: "TSLAB", usd: 50 };
  const t4 = { time: 400, side: "sell", symbol: "TSLAB", usd: 49, pnl: -1 };
  r = step(r.next, up({ recent: [t4, t3, t2, t1] }), 2);
  assert.deepEqual(r.events.map((e) => e.customer), ["Bought TSLAB for $50.00", "Sold TSLAB for $49.00 (-$1.00)"]);
  r = step(r.next, up({ recent: [t4, t3, t2, t1] }), 3);
  assert.equal(r.events.length, 0);
});

test("paper trades are labelled", () => {
  const first = step({}, up({ recent: [] }), 1, { ...row, agent_mode: "paper" });
  const r = step(first.next, up({ recent: [{ time: 5, side: "buy", symbol: "AAPLB", usd: 10 }] }), 2, { ...row, agent_mode: "paper" });
  assert.match(r.events[0].customer, /^\[paper\] Bought AAPLB/);
});

test("parseAlerts survives junk", () => {
  assert.deepEqual(parseAlerts("not json"), {});
  assert.deepEqual(parseAlerts(null), {});
  assert.deepEqual(parseAlerts('{"a":1}'), { a: 1 });
});
