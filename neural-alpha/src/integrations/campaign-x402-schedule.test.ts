import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_X402_INTERVAL_MS,
  DEFAULT_X402_MIN_FREE_USDT,
  isCmcX402Enabled,
  isStudioX402Enabled,
  lastSettledCallAt,
  parseX402Settings,
  shouldFireX402,
} from "./campaign-x402-schedule.js";

const INTERVAL = 2 * 60 * 60 * 1000;
const FREE = 50;

describe("parseX402Settings", () => {
  it("defaults both sources ON with a 2h interval and a USDT reserve", () => {
    const s = parseX402Settings({});
    assert.equal(s.cmcX402Enabled, true);
    assert.equal(s.studioX402Enabled, true);
    assert.equal(s.cmcX402IntervalMs, DEFAULT_X402_INTERVAL_MS);
    assert.equal(s.studioX402IntervalMs, DEFAULT_X402_INTERVAL_MS);
    assert.equal(s.x402MinFreeUsdtUsd, DEFAULT_X402_MIN_FREE_USDT);
    assert.equal(DEFAULT_X402_INTERVAL_MS, INTERVAL);
  });

  it("disables CMC via CMC_X402_ENABLED=false", () => {
    const s = parseX402Settings({ CMC_X402_ENABLED: "false" });
    assert.equal(s.cmcX402Enabled, false);
    assert.equal(s.studioX402Enabled, true);
  });

  it("disables CMC via legacy CMC_MACRO_ENABLED=false", () => {
    assert.equal(isCmcX402Enabled({ CMC_MACRO_ENABLED: "false" }), false);
    assert.equal(isCmcX402Enabled({ CMC_X402_ENABLED: "true", CMC_MACRO_ENABLED: "false" }), false);
  });

  it("disables Studio independently", () => {
    const s = parseX402Settings({ STUDIO_X402_ENABLED: "false", CMC_X402_ENABLED: "true" });
    assert.equal(s.studioX402Enabled, false);
    assert.equal(s.cmcX402Enabled, true);
    assert.equal(isStudioX402Enabled({ STUDIO_X402_ENABLED: "0" }), false);
  });

  it("reads CMC interval from CMC_X402_INTERVAL_MS then CMC_MACRO_REFRESH_MS", () => {
    assert.equal(
      parseX402Settings({ CMC_X402_INTERVAL_MS: "2700000" }).cmcX402IntervalMs,
      2_700_000
    );
    assert.equal(
      parseX402Settings({ CMC_MACRO_REFRESH_MS: "1800000" }).cmcX402IntervalMs,
      1_800_000
    );
    assert.equal(
      parseX402Settings({
        CMC_X402_INTERVAL_MS: "60000",
        CMC_MACRO_REFRESH_MS: "1800000",
      }).cmcX402IntervalMs,
      60_000
    );
  });

  it("reads Studio interval from STUDIO_X402_INTERVAL_MS", () => {
    assert.equal(
      parseX402Settings({ STUDIO_X402_INTERVAL_MS: "900000" }).studioX402IntervalMs,
      900_000
    );
  });

  it("reads the free-USDT floor from X402_MIN_FREE_USDT", () => {
    assert.equal(parseX402Settings({ X402_MIN_FREE_USDT: "25" }).x402MinFreeUsdtUsd, 25);
    assert.equal(parseX402Settings({ X402_MIN_FREE_USDT: "0" }).x402MinFreeUsdtUsd, 0);
    assert.equal(parseX402Settings({ X402_MIN_FREE_USDT: "nope" }).x402MinFreeUsdtUsd, DEFAULT_X402_MIN_FREE_USDT);
  });
});

describe("shouldFireX402", () => {
  const now = 1_000_000_000;

  it("never fires when disabled", () => {
    assert.equal(
      shouldFireX402({
        enabled: false,
        lastFiredAt: 0,
        intervalMs: INTERVAL,
        freeUsdtUsd: FREE,
        now,
      }),
      false
    );
  });

  it("stays off when free USDT is below the reserve", () => {
    assert.equal(
      shouldFireX402({
        enabled: true,
        lastFiredAt: 0,
        intervalMs: INTERVAL,
        freeUsdtUsd: DEFAULT_X402_MIN_FREE_USDT - 0.01,
        now,
      }),
      false
    );
    assert.equal(
      shouldFireX402({
        enabled: true,
        lastFiredAt: now - INTERVAL,
        intervalMs: INTERVAL,
        freeUsdtUsd: 0,
        minFreeUsdtUsd: 5,
        now,
      }),
      false
    );
  });

  it("fires once the interval has elapsed and free USDT covers the reserve", () => {
    assert.equal(
      shouldFireX402({
        enabled: true,
        lastFiredAt: now - (INTERVAL - 1),
        intervalMs: INTERVAL,
        freeUsdtUsd: FREE,
        now,
      }),
      false
    );
    assert.equal(
      shouldFireX402({
        enabled: true,
        lastFiredAt: now - INTERVAL,
        intervalMs: INTERVAL,
        freeUsdtUsd: FREE,
        now,
      }),
      true
    );
  });

  it("first call fires when there is free USDT", () => {
    assert.equal(
      shouldFireX402({
        enabled: true,
        lastFiredAt: 0,
        intervalMs: INTERVAL,
        freeUsdtUsd: DEFAULT_X402_MIN_FREE_USDT,
        now,
      }),
      true
    );
  });
});

describe("lastSettledCallAt", () => {
  it("returns 0 when empty and the latest settled timestamp otherwise", () => {
    assert.equal(lastSettledCallAt([]), 0);
    assert.equal(
      lastSettledCallAt([
        { at: 10, settled: true },
        { at: 20, settled: false },
        { at: 30, settled: true },
      ]),
      30
    );
  });
});
