import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PortfolioTracker, trailStopFromPeak } from "./portfolio.js";

const EXIT = {
  stopLossPct: 8,
  takeProfitPct: 100,
  trailingActivatePct: 100,
  trailingGivebackPct: 1,
};

describe("trailing take-profit", () => {
  it("does not sell at the TP arm — only after a 1% drop from peak price", () => {
    const book = new PortfolioTracker(2000);
    book.recordBuy("NVDAB", 600, 10, 60);

    const atArm = book.getRiskManagedExits(new Map([["NVDAB", 120]]), EXIT);
    assert.equal(atArm.length, 0, "hitting +100% should arm the trail, not sell");

    const newHigh = book.getRiskManagedExits(new Map([["NVDAB", 126]]), EXIT);
    assert.equal(newHigh.length, 0, "new peak +110% should keep holding");

    const peak = 126;
    const justAbove = peak * 0.995;
    const stillHold = book.getRiskManagedExits(new Map([["NVDAB", justAbove]]), EXIT);
    assert.equal(stillHold.length, 0, "drop of 0.5% from peak should still hold");

    const drop1 = peak * 0.989;
    const sold = book.getRiskManagedExits(new Map([["NVDAB", drop1]]), EXIT);
    assert.equal(sold.length, 1);
    assert.equal(sold[0]?.kind, "trailing_stop");
    assert.match(sold[0]?.reason ?? "", /Trailing TP/);
  });

  it("still cuts a loser at the hard stop before the trail arms", () => {
    const book = new PortfolioTracker(2000);
    book.recordBuy("NVDAB", 600, 10, 60);
    const exits = book.getRiskManagedExits(new Map([["NVDAB", 54]]), EXIT);
    assert.equal(exits[0]?.kind, "stop_loss");
  });

  it("computes trail stop as 1% below peak price", () => {
    assert.equal(trailStopFromPeak(60, 110, 1), 60 * 2.1 * 0.99);
  });
});
