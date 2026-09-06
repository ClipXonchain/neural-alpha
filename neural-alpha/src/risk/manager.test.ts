import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { PortfolioTracker } from "./portfolio.js";
import { RiskManager } from "./manager.js";
import type { TradeSignal } from "../utils/types.js";

function sellSignal(symbol = "NVDAB"): TradeSignal {
  return {
    symbol,
    action: "sell",
    strength: "strong_sell",
    score: -40,
    reasons: ["test"],
    targetAllocationPct: 0,
    confidence: 0.9,
  };
}

function buySignal(symbol = "NVDAB"): TradeSignal {
  return {
    ...sellSignal(symbol),
    action: "buy",
    strength: "buy",
    score: 20,
    reasons: ["test buy"],
  };
}

describe("max position size does not block sells", () => {
  it("allows a full exit when the position grew past MAX_POSITION_SIZE_USD", () => {
    const config = {
      ...loadConfig(),
      maxPositionSizeUsd: 600,
      minTradeAmountUsd: 5,
      minBuyConfidence: 0,
      drawdownLimitEnabled: false,
    };
    const portfolio = new PortfolioTracker(2000);
    const risk = new RiskManager(config, portfolio);

    const sell = risk.validateTrade(sellSignal(), 610);
    assert.equal(sell.passed, true, sell.violations.join("; "));
    assert.equal(
      sell.violations.some((v) => /max position size/i.test(v)),
      false
    );
  });

  it("still caps autonomous buys above the max", () => {
    const config = {
      ...loadConfig(),
      maxPositionSizeUsd: 600,
      minTradeAmountUsd: 5,
      minBuyConfidence: 0,
      drawdownLimitEnabled: false,
    };
    const portfolio = new PortfolioTracker(2000);
    const risk = new RiskManager(config, portfolio);

    const buy = risk.validateTrade(buySignal(), 610);
    assert.equal(buy.passed, false);
    assert.match(buy.violations.join(" "), /exceeds max position size/);
  });
});
