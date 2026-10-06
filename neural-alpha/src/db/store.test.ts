import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { PortfolioSnapshot, TradeOrder, TradeResult } from "../utils/types.js";
import { AgentStore } from "./store.js";

const dir = mkdtempSync(join(tmpdir(), "neural-alpha-db-"));
const store = new AgentStore({
  sqlitePath: join(dir, "neural-alpha.sqlite"),
  databaseUrl: "",
});

const order: TradeOrder = {
  id: "ord-1",
  timestamp: Date.parse("2026-10-01T12:00:00Z"),
  symbol: "NVDAB",
  side: "buy",
  amountUsd: 25,
  fromToken: "USDT",
  toToken: "NVDAB",
  slippage: 1,
};

const result: TradeResult = {
  orderId: "ord-1",
  success: true,
  txHash: "0x" + "ab".repeat(32),
  fromToken: "USDT",
  toToken: "NVDAB",
  fromAmount: "25",
  toAmount: "0.5",
  priceAtExecution: 50,
  timestamp: Date.parse("2026-10-01T12:00:00Z"),
  realizedPnl: 1.5,
};

function snapshot(timestamp: number, nav: number): PortfolioSnapshot {
  return {
    timestamp,
    totalValueUsd: nav,
    cashUsd: 40,
    positions: [],
    dailyPnl: 1,
    totalPnl: 2,
    totalPnlPct: 1,
    realizedPnl: 1.5,
    maxDrawdownPct: 3,
    tradeCount: 1,
    gasReserveUsd: 2,
  };
}

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("sqlite agent store", () => {
  it("opens without Neon and round-trips trades, NAV, syncs, and state", async () => {
    assert.equal(await store.init(), true);
    assert.equal(store.enabled, true);
    assert.equal(store.backupEnabled, false);

    await store.saveTrade(order, result, "live", { note: "ok" }, "0xABC");
    const recent = await store.loadRecentTrades(10, "0xabc");
    assert.equal(recent.length, 1);
    assert.equal(recent[0]?.orderId, "ord-1");
    assert.equal(recent[0]?.realizedPnl, 1.5);
    assert.deepEqual(await store.loadRecentTrades(10, "0xother"), []);
    assert.deepEqual(await store.loadTradedSymbols("0xabc"), ["NVDAB"]);

    const older = Date.parse("2026-10-01T00:00:00Z");
    const newer = Date.parse("2026-10-02T00:00:00Z");
    await store.saveNavSnapshot(snapshot(older, 100), 1, "live", 100, {
      realizedPnl: 1,
      dailyPnl: 0,
      positionsCount: 1,
      totalTrades: 1,
      todayTrades: 1,
      winRate: 1,
      fearGreed: 40,
      emergencyMode: false,
    });
    await store.saveNavSnapshot(snapshot(newer, 110), 2, "live", 110);
    assert.equal(await store.loadLastNavBefore(newer), 100);
    assert.equal(await store.loadLastNavBefore(older), null);

    await store.saveChainSync({
      holdings: { NVDAB: 0.5 },
      usdtBalance: 40,
      positionsAdded: ["NVDAB"],
      positionsRemoved: [],
    });
    assert.deepEqual(await store.loadLastChainSyncHoldings(), ["NVDAB"]);

    await store.saveNavState({
      peakNavUsd: 110,
      initialNavUsd: 100,
      baselineInitialized: true,
      dayStartNavUsd: 100,
      dayStartUtcDate: "2026-10-02",
    });
    assert.equal((await store.loadNavState())?.peakNavUsd, 110);

    await store.saveUserBlacklist(["gmeb"]);
    assert.deepEqual(await store.loadUserBlacklist(), ["GMEB"]);

    await store.savePositionEntries({ NVDAB: { avgEntryPrice: 50, peakPnlPct: 4 } });
    assert.equal((await store.loadPositionEntries())?.NVDAB?.avgEntryPrice, 50);
  });
});
