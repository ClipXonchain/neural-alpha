import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveInitialDepositUsd } from "../config.js";
import { PortfolioTracker } from "./portfolio.js";

describe("initial deposit + gas baseline", () => {
  it("reads INITIAL_DEPOSIT_USD then INITIAL_CASH_USD then AGENT_NAV_USD", () => {
    assert.equal(resolveInitialDepositUsd({ INITIAL_DEPOSIT_USD: "2000" }), 2000);
    assert.equal(resolveInitialDepositUsd({ INITIAL_CASH_USD: "1500" }), 1500);
    assert.equal(resolveInitialDepositUsd({ AGENT_NAV_USD: "2000" }), 2000);
    assert.equal(resolveInitialDepositUsd({}), null);
  });

  it("locks Total PnL against deposit plus starting gas", () => {
    const book = new PortfolioTracker(1000, true);
    book.setConfiguredDeposit(2000);
    book.setGasReserve("BNB", 0.02, 12);
    book.setCashUsd(2000);
    book.recordBuy("NVDAB", 600, 10, 60);

    const snap = book.peekSnapshot(new Map([["NVDAB", 66]]));
    assert.equal(snap.initialNavUsd, 2012);
    assert.equal(Math.round(snap.totalValueUsd), 1400 + 660 + 12);
    assert.equal(Math.round(snap.totalPnl), 60);
  });

  it("does not rewrite the deposit when current NAV has moved", () => {
    const book = new PortfolioTracker(1000, true);
    book.setConfiguredDeposit(2000);
    book.setGasReserve("BNB", 0.02, 12);
    book.setCashUsd(1800);
    book.realignNavBaselineIfStale(1812);
    assert.equal(book.initialValue, 2012);
  });
});
