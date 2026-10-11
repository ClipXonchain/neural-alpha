import assert from "node:assert/strict";
import test from "node:test";
import { decideRwaTrade, sessionForMarketStatus } from "./rwa-book.js";

const base = {
  holdsToken: false,
  requestedUsd: 40,
  researchFresh: true,
  otherOpenPositions: 0,
};

test("market status maps onto the existing session names", () => {
  assert.equal(sessionForMarketStatus("regular"), "rth");
  assert.equal(sessionForMarketStatus("postmarket"), "close");
  assert.equal(sessionForMarketStatus("closed"), "overnight");
  assert.equal(sessionForMarketStatus("premarket"), "overnight");
});

test("pause blocks a new order", () => {
  const decision = decideRwaTrade({ ...base, marketStatus: "pause", spreadPct: 0.1, side: "buy" });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /paused/);
});

test("a rich on-chain print blocks the buy and allows a small sell", () => {
  const buy = decideRwaTrade({ ...base, marketStatus: "regular", spreadPct: 1.8, side: "buy" });
  assert.equal(buy.allowed, false);
  const sell = decideRwaTrade({
    ...base,
    marketStatus: "closed",
    spreadPct: 2,
    side: "sell",
    holdsToken: true,
    requestedUsd: 40,
  });
  assert.equal(sell.allowed, true);
  assert.equal(sell.amountUsd, 15);
});

test("a closed-market discount buy stays inside the dollar cap", () => {
  const fresh = decideRwaTrade({ ...base, marketStatus: "closed", spreadPct: -2, side: "buy" });
  assert.equal(fresh.allowed, true);
  assert.equal(fresh.amountUsd, 15);
  const stale = decideRwaTrade({
    ...base,
    marketStatus: "overnight",
    spreadPct: -2,
    side: "buy",
    researchFresh: false,
  });
  assert.equal(stale.amountUsd, 8);
});

test("regular hours keep the requested size when the spread is inside fees", () => {
  const decision = decideRwaTrade({ ...base, marketStatus: "regular", spreadPct: 0.08, side: "buy" });
  assert.equal(decision.allowed, true);
  assert.equal(decision.amountUsd, 40);
  assert.equal(decision.capped, false);
});

test("a second closed-market entry is refused", () => {
  const decision = decideRwaTrade({
    ...base,
    marketStatus: "closed",
    spreadPct: 0.1,
    side: "buy",
    otherOpenPositions: 1,
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /one closed-market entry/);
});

test("an empty RWA status uses the New York clock", () => {
  const decision = decideRwaTrade({
    ...base,
    marketStatus: "unknown",
    clockStatus: "closed",
    spreadPct: 0.08,
    side: "buy",
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.amountUsd, 15);
  assert.match(decision.reason, /NY clock is closed/);
});

test("missing status does not invent a permission", () => {
  const decision = decideRwaTrade({ ...base, marketStatus: null, spreadPct: null, side: "buy" });
  assert.equal(decision.allowed, false);
});
