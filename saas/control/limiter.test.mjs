import assert from "node:assert/strict";
import test from "node:test";
import { createAttemptLimiter } from "./limiter.mjs";

test("one client being blocked does not block another", () => {
  const l = createAttemptLimiter({ max: 3, windowMs: 1000 });
  for (let i = 0; i < 3; i++) l.fail("attacker", 100);
  assert.equal(l.allowed("attacker", 200), false);
  assert.equal(l.allowed("customer", 200), true);
});

test("attempts expire after the window", () => {
  const l = createAttemptLimiter({ max: 2, windowMs: 1000 });
  l.fail("a", 0);
  l.fail("a", 10);
  assert.equal(l.allowed("a", 500), false);
  assert.equal(l.allowed("a", 1011), true);
});

test("many distinct clients cannot grow memory without bound", () => {
  const l = createAttemptLimiter({ max: 2, windowMs: 60_000, maxKeys: 50 });
  for (let i = 0; i < 500; i++) l.fail(`ip-${i}`, 1);
  assert.ok(l.size() <= 50);
});
