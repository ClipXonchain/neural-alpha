import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_X402_INTERVAL_MS,
  X402_IMMEDIATE_COOLDOWN_MS,
  isCmcX402Enabled,
  isStudioX402Enabled,
  lastSettledCallAt,
  parseX402Settings,
  shouldFireX402,
} from "./campaign-x402-schedule.js";

const INTERVAL = 3_600_000;

describe("parseX402Settings", () => {
  it("defaults both sources ON with the 4h interval", () => {
    const s = parseX402Settings({});
    assert.equal(s.cmcX402Enabled, true);
    assert.equal(s.studioX402Enabled, true);
    assert.equal(s.cmcX402IntervalMs, DEFAULT_X402_INTERVAL_MS);
    assert.equal(s.studioX402IntervalMs, DEFAULT_X402_INTERVAL_MS);
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
});

describe("shouldFireX402", () => {
  const now = 1_000_000;

  it("never fires when disabled", () => {
    assert.equal(
      shouldFireX402({
        enabled: false,
        slotsOpen: true,
        lastFiredAt: 0,
        intervalMs: INTERVAL,
        now,
      }),
      false
    );
  });

  it("fires immediately when slots are open (even if interval has not elapsed)", () => {
    assert.equal(
      shouldFireX402({
        enabled: true,
        slotsOpen: true,
        lastFiredAt: now - 60_000,
        intervalMs: INTERVAL,
        now,
      }),
      true
    );
  });

  it("respects a short cooldown even when slots are open", () => {
    assert.equal(
      shouldFireX402({
        enabled: true,
        slotsOpen: true,
        lastFiredAt: now - 5_000,
        intervalMs: INTERVAL,
        now,
      }),
      false
    );
    assert.equal(
      shouldFireX402({
        enabled: true,
        slotsOpen: true,
        lastFiredAt: now - (X402_IMMEDIATE_COOLDOWN_MS + 1),
        intervalMs: INTERVAL,
        now,
      }),
      true
    );
  });

  it("when slots are full, waits for the interval", () => {
    assert.equal(
      shouldFireX402({
        enabled: true,
        slotsOpen: false,
        lastFiredAt: now - 60_000,
        intervalMs: INTERVAL,
        now,
      }),
      false
    );
    assert.equal(
      shouldFireX402({
        enabled: true,
        slotsOpen: false,
        lastFiredAt: now - INTERVAL,
        intervalMs: INTERVAL,
        now,
      }),
      true
    );
  });

  it("first call (lastFiredAt=0) fires even when slots are full", () => {
    assert.equal(
      shouldFireX402({
        enabled: true,
        slotsOpen: false,
        lastFiredAt: 0,
        intervalMs: INTERVAL,
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
