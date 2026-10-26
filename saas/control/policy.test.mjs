import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderEnv, tenantDir } from "./files.mjs";
import {
  containerName,
  hostPlan,
  parseUnits18,
  quoteOrderAmount,
  resolveRisk,
  resolveTokenContracts,
  staggerSeconds,
} from "./policy.mjs";

test("a 16 GB host holds 20 customers inside a 60 call budget", () => {
  const plan = hostPlan({
    ramMb: 16_384,
    mbPerTenant: 512,
    budgetPerMin: 60,
    callsPerCycle: 20,
    minIntervalMs: 300_000,
    maxIntervalMs: 900_000,
    maxTenantsCap: 20,
    reservePct: 0.3,
  });
  assert.equal(plan.maxTenants, 20);
  assert.equal(plan.intervalMs, 400_000);
  assert.ok(plan.fullUsePerMin <= 60);
});

test("risk presets cap size and do not arm a drawdown halt", () => {
  assert.throws(() => resolveRisk("unlocked"), /preset/);
  const active = resolveRisk("active");
  assert.equal(active.maxPositionUsd, 250);
  assert.equal(active.maxDrawdownPct, undefined);
  const env = renderEnv({
    agentMode: "paper",
    intervalMs: 400_000,
    staggerSec: 3,
    paymentAsset: "USDT",
    apiSecret: "abc123",
    risk: active,
  });
  assert.match(env, /DISABLE_DRAWDOWN_LIMIT=true/);
  assert.doesNotMatch(env, /MAX_DRAWDOWN_PCT/);
  assert.match(env, /PAYMENT_TOKEN=USDT/);
  assert.match(env, /MAX_POSITION_SIZE_USD=250/);
  assert.match(env, /BINANCE_MARKET_CONCURRENCY=2/);
});

test("tenant folders stay inside the data root and container names differ", () => {
  const root = mkdtempSync(join(tmpdir(), "na-saas-"));
  const a = tenantDir(root, "abcd1234");
  const b = tenantDir(root, "1234abcd");
  assert.equal(a, join(root, "abcd1234"));
  assert.equal(b, join(root, "1234abcd"));
  assert.notEqual(containerName("abcd1234"), containerName("1234abcd"));
  assert.throws(() => tenantDir(root, "../secret"));
  assert.equal(staggerSeconds("abcd1234") < 45, true);
});

test("env file for a customer is readable", () => {
  const text = renderEnv({
    agentMode: "paper",
    intervalMs: 400_000,
    staggerSec: 1,
    paymentAsset: "BNB",
    apiSecret: "abc123",
    risk: resolveRisk("cautious"),
    databaseUrl: "postgres://example",
  });
  assert.match(text, /AGENT_MODE=paper/);
  assert.match(text, /DATABASE_URL=postgres:\/\/example/);
});

test("checkout quotes lock 18-decimal amounts with a sub-cent unique tail and halted buys zero out new entries", () => {
  const contracts = resolveTokenContracts();
  assert.equal(contracts.BNB, "native");
  assert.equal(contracts.USDT, "0x55d398326f99059ff775485246999027b3197955");
  assert.equal(contracts.USDC, "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d");
  assert.equal(contracts.U, "0xce24439f2d9c6a2289f741120fe202248b666666");
  assert.equal(contracts.USD1, "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d");

  const usdtQuote = quoteOrderAmount({ asset: "USDT", priceUsd: 30, tail: 4281 });
  assert.equal(usdtQuote.amountDisplay, "30.004281");
  assert.equal(usdtQuote.amountWei, parseUnits18("30.004281").toString());
  assert.equal(quoteOrderAmount({ asset: "USDT", priceUsd: 30, tail: 9_999 }).amountDisplay, "30.009999");
  assert.equal(quoteOrderAmount({ asset: "USDT", priceUsd: 30, tail: 0 }).amountDisplay, "30");

  const bnbQuote = quoteOrderAmount({ asset: "BNB", priceUsd: 30, bnbPriceUsd: 600, tail: 123 });
  assert.equal(bnbQuote.amountDisplay, "0.050000205");
  assert.equal(bnbQuote.amountWei, parseUnits18("0.050000205").toString());
  assert.equal(quoteOrderAmount({ asset: "BNB", priceUsd: 30, bnbPriceUsd: 600, tail: 0 }).amountDisplay, "0.05");

  const haltedEnv = renderEnv({
    agentMode: "live",
    intervalMs: 400_000,
    staggerSec: 2,
    paymentAsset: "USDT",
    apiSecret: "abc123",
    risk: resolveRisk("normal"),
    buysHalted: true,
  });
  assert.match(haltedEnv, /DISABLE_NEW_BUYS=true/);
  assert.match(haltedEnv, /MAX_POSITION_SIZE_USD=0/);
  assert.match(haltedEnv, /HACKATHON_MAX_TRADE_USD=0/);
});
