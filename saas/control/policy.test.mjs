import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderEnv, tenantDir } from "./files.mjs";
import { containerName, hostPlan, resolveRisk, staggerSeconds } from "./policy.mjs";

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

test("risk presets cannot turn drawdown protection off or exceed $250", () => {
  assert.throws(() => resolveRisk("unlocked"), /preset/);
  const active = resolveRisk("active");
  assert.equal(active.maxPositionUsd, 250);
  const env = renderEnv({
    agentMode: "paper",
    intervalMs: 400_000,
    staggerSec: 3,
    risk: active,
  });
  assert.match(env, /DISABLE_DRAWDOWN_LIMIT=false/);
  assert.doesNotMatch(env, /DISABLE_DRAWDOWN_LIMIT=true/);
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
    risk: resolveRisk("cautious"),
    databaseUrl: "postgres://example",
  });
  assert.match(text, /AGENT_MODE=paper/);
  assert.match(text, /DATABASE_URL=postgres:\/\/example/);
});
