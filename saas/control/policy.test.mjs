import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderEnv, renderOverride, tenantDir } from "./files.mjs";
import {
  containerName,
  hostPlan,
  CHECKOUT_EXPIRY_MS,
  checkoutAmountIsCurrent,
  parseUnits18,
  QUOTE_MARKER_MAX,
  quoteOrderAmount,
  resolveRisk,
  SOFTWARE_BNB_PRICE_USD,
  SOFTWARE_FEE_USD,
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
  assert.throws(() => resolveRisk("active"), /preset/);
  const active = resolveRisk("250");
  assert.equal(active.maxPositionUsd, 250);
  assert.equal(active.maxTradeUsd, 250);
  assert.equal(active.x402PerDay, 2);
  assert.equal(active.maxDrawdownPct, undefined);
  const custom = resolveRisk({ preset: "custom", positionUsd: 750, x402PerDay: 4 });
  assert.equal(custom.maxPositionUsd, 750);
  assert.equal(custom.maxTradeUsd, 750);
  assert.equal(custom.x402PerDay, 4);
  assert.throws(() => resolveRisk({ preset: "custom", positionUsd: 0 }), /positive/);
  assert.throws(() => resolveRisk({ preset: "custom", positionUsd: 10_000_000_000 }), /10000/);
  assert.throws(() => resolveRisk({ preset: "100", x402PerDay: 1 }), /x402PerDay/);
  const legacy = resolveRisk({ preset: "cautious", positionUsd: 50 }, { allowLegacy: true });
  assert.equal(legacy.maxPositionUsd, 50);
  assert.equal(legacy.maxTradeUsd, 50);
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
  assert.match(env, /HACKATHON_MAX_TRADE_USD=250/);
  assert.match(env, /X402_MIN_PAYMENTS_PER_DAY=2/);
  assert.match(env, /CMC_X402_ENABLED=true/);
  assert.match(env, /STUDIO_X402_ENABLED=true/);
  assert.match(env, /CMC_X402_INTERVAL_MS=86400000/);
  assert.match(env, /STUDIO_X402_INTERVAL_MS=86400000/);
  assert.match(env, /BINANCE_MARKET_CONCURRENCY=2/);
  const customEnv = renderEnv({
    agentMode: "paper",
    intervalMs: 400_000,
    staggerSec: 3,
    paymentAsset: "USDC",
    apiSecret: "abc123",
    risk: custom,
  });
  assert.match(customEnv, /PAYMENT_TOKEN=USDT/);
  assert.doesNotMatch(customEnv, /PAYMENT_TOKEN=USDC/);
  assert.match(customEnv, /MAX_POSITION_SIZE_USD=750/);
  assert.match(customEnv, /HACKATHON_MAX_TRADE_USD=750/);
  assert.match(customEnv, /X402_MIN_PAYMENTS_PER_DAY=4/);
  assert.match(customEnv, /CMC_X402_INTERVAL_MS=43200000/);
  assert.match(customEnv, /STUDIO_X402_INTERVAL_MS=43200000/);
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
  const risk = resolveRisk("100");
  const spec = {
    agentMode: "paper",
    intervalMs: 400_000,
    staggerSec: 1,
    paymentAsset: "BNB",
    apiSecret: "abc123",
    risk,
    databaseUrl: "postgres://example",
    dataDir: "/tmp/na-tenant",
    containerName: "na-abcd1234",
  };
  const text = renderEnv(spec);
  assert.match(text, /AGENT_MODE=paper/);
  assert.match(text, /DATABASE_URL=postgres:\/\/example/);
  assert.match(text, /PAYMENT_TOKEN=USDT/);
  assert.doesNotMatch(text, /PAYMENT_TOKEN=BNB/);
  assert.match(text, /MAX_POSITION_SIZE_USD=100/);
  assert.match(text, /HACKATHON_MAX_TRADE_USD=100/);
  const yml = renderOverride(spec);
  assert.match(yml, /PAYMENT_TOKEN: "USDT"/);
  assert.doesNotMatch(yml, /PAYMENT_TOKEN: "BNB"/);
  assert.match(yml, /X402_MIN_PAYMENTS_PER_DAY: "2"/);
  assert.match(yml, /CMC_X402_INTERVAL_MS: "86400000"/);
  assert.match(yml, /STUDIO_X402_INTERVAL_MS: "86400000"/);
});

test("checkout quotes lock a 3-digit unique marker and a 10-minute expiry, and halted buys zero out new entries", () => {
  const contracts = resolveTokenContracts();
  assert.equal(contracts.BNB, "native");
  assert.equal(contracts.USDT, "0x55d398326f99059ff775485246999027b3197955");
  assert.equal(contracts.USDC, "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d");
  assert.equal(contracts.U, "0xce24439f2d9c6a2289f741120fe202248b666666");
  assert.equal(contracts.USD1, "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d");
  assert.equal(CHECKOUT_EXPIRY_MS, 10 * 60_000);
  assert.equal(QUOTE_MARKER_MAX, 999);

  const usdtQuote = quoteOrderAmount({ asset: "USDT", priceUsd: SOFTWARE_FEE_USD, tail: 184 });
  assert.equal(SOFTWARE_FEE_USD, 15);
  assert.equal(usdtQuote.amountDisplay, "15.184");
  assert.equal(usdtQuote.tail, 184);
  assert.equal(usdtQuote.amountWei, parseUnits18("15.184").toString());
  assert.equal(BigInt(usdtQuote.amountWei) % 10n ** 15n, 0n);
  assert.equal(quoteOrderAmount({ asset: "USDC", tail: 7 }).amountDisplay, "15.007");
  assert.equal(quoteOrderAmount({ asset: "U", tail: 999 }).amountDisplay, "15.999");
  assert.equal(quoteOrderAmount({ asset: "USD1", priceUsd: SOFTWARE_FEE_USD, tail: 9_999 }).amountDisplay, "15.999");
  assert.equal(quoteOrderAmount({ asset: "USDT", tail: 0 }).amountDisplay, "15");
  assert.equal(checkoutAmountIsCurrent("USDT", "15.184"), true);
  assert.equal(checkoutAmountIsCurrent("USDC", "15.007"), true);
  assert.equal(checkoutAmountIsCurrent("U", "15.999"), true);
  assert.equal(checkoutAmountIsCurrent("USD1", "15.009"), true);
  assert.equal(checkoutAmountIsCurrent("USDT", "15.008513"), false);
  assert.equal(checkoutAmountIsCurrent("BNB", "0.020387"), true);

  const bnbQuote = quoteOrderAmount({ asset: "BNB", priceUsd: SOFTWARE_FEE_USD, bnbPriceUsd: SOFTWARE_BNB_PRICE_USD, tail: 123 });
  assert.equal(SOFTWARE_BNB_PRICE_USD, 600);
  assert.equal(bnbQuote.amountDisplay, "0.025123");
  assert.equal(bnbQuote.amountDisplay.slice(-3), "123");
  assert.equal(bnbQuote.amountWei, parseUnits18("0.025123").toString());
  assert.equal(BigInt(bnbQuote.amountWei) % 10n ** 12n, 0n);
  assert.equal(quoteOrderAmount({ asset: "BNB", tail: 0 }).amountDisplay, "0.025");
  assert.equal(quoteOrderAmount({ asset: "BNB", priceUsd: 15, bnbPriceUsd: 650, tail: 123 }).amountDisplay, "0.023123");
  assert.equal(quoteOrderAmount({ asset: "BNB", priceUsd: 15, bnbPriceUsd: 650, tail: 1 }).amountDisplay, "0.024001");
  assert.equal(quoteOrderAmount({ asset: "BNB", priceUsd: 15, bnbPriceUsd: 1000, tail: 184 }).amountDisplay, "0.015184");

  const haltedEnv = renderEnv({
    agentMode: "live",
    intervalMs: 400_000,
    staggerSec: 2,
    paymentAsset: "USDT",
    apiSecret: "abc123",
    risk: resolveRisk("500"),
    buysHalted: true,
  });
  assert.match(haltedEnv, /DISABLE_NEW_BUYS=true/);
  assert.match(haltedEnv, /MAX_POSITION_SIZE_USD=0/);
  assert.match(haltedEnv, /HACKATHON_MAX_TRADE_USD=0/);
});
