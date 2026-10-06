import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PortfolioTracker } from "./portfolio.js";
import type { ExternalFlow } from "./external-flows.js";

const DAY = 86_400_000;

describe("external wallet transfers", () => {
  it("adds tokens sent out back into Total PnL", () => {
    const book = new PortfolioTracker(1000, true);
    book.setConfiguredDeposit(2000);
    book.setCashUsd(2000);
    book.recordBuy("CRCLB", 600, 6, 100);

    // 6 CRCLB worth $540 leave the wallet; NAV drops but PnL must not.
    const sentOut: ExternalFlow = {
      direction: "out",
      symbol: "CRCLB",
      qty: 6,
      valueUsd: 540,
      timestamp: Date.now() - 2 * DAY,
    };
    book.setExternalFlows([sentOut]);

    const snap = book.peekSnapshot(new Map([["CRCLB", 90]]));
    assert.equal(Math.round(snap.totalValueUsd), 1400);
    assert.equal(Math.round(snap.totalPnl), -60);
    assert.equal(book.getAllPositions().has("CRCLB"), false);
  });

  it("treats tokens sent in as added capital, not profit", () => {
    const book = new PortfolioTracker(1000, true);
    book.setConfiguredDeposit(1000);
    book.setCashUsd(1000);
    book.setExternalFlows([
      { direction: "in", symbol: "USDT", qty: 500, valueUsd: 500, timestamp: Date.now() - DAY },
    ]);
    book.setCashUsd(1500);

    const snap = book.peekSnapshot(new Map());
    assert.equal(Math.round(snap.totalPnl), 0);
    assert.equal(Math.round(snap.totalPnlPct), 0);
  });
});
