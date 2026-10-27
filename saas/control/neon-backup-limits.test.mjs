import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { backupSaasUsers, BOOK_ROW_LIMITS, createBackupController } from "./neon-backup.mjs";

// A controllable clock, so "5 minutes later" takes no time.
function fakeClock() {
  let t = 0;
  const timers = [];
  return {
    now: () => t,
    schedule(fn, ms) {
      const h = { fn, at: t + ms, off: false, unref() {} };
      timers.push(h);
      return h;
    },
    clear: (h) => h && (h.off = true),
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = timers.filter((x) => !x.off && x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        next.off = true;
        t = next.at;
        next.fn();
        for (let i = 0; i < 8; i++) await Promise.resolve();
      }
      t = end;
    },
  };
}

test("a flood of changes cannot cause back-to-back backup passes", async () => {
  const clock = fakeClock();
  const runs = [];
  const c = createBackupController({
    run: async () => { runs.push(clock.now()); },
    intervalMs: 3_600_000,
    debounceMs: 1000,
    minGapMs: 300_000,
    now: clock.now,
    schedule: clock.schedule,
    clear: clock.clear,
  });
  await c.started;
  // something writes to the store every second for 20 minutes
  for (let s = 0; s < 1200; s++) {
    c.kick();
    await clock.advance(1000);
  }
  c.stop();
  assert.ok(runs.length >= 3 && runs.length <= 6, `expected a handful of passes, got ${runs.length}`);
  for (let i = 1; i < runs.length; i++) assert.ok(runs[i] - runs[i - 1] >= 300_000, `passes ${i - 1} and ${i} were only ${runs[i] - runs[i - 1]} ms apart`);
});

test("a change during a pass is picked up later, not immediately", async () => {
  const clock = fakeClock();
  const runs = [];
  let release;
  const c = createBackupController({
    run: async () => {
      runs.push(clock.now());
      if (runs.length === 1) await new Promise((r) => (release = r));
    },
    intervalMs: 3_600_000,
    debounceMs: 1000,
    minGapMs: 60_000,
    now: clock.now,
    schedule: clock.schedule,
    clear: clock.clear,
  });
  for (let i = 0; i < 4; i++) await Promise.resolve();
  c.kick(); // arrives while the first pass is still running
  await clock.advance(2000);
  release();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(runs.length, 1, "no instant re-run");
  await clock.advance(61_000);
  assert.equal(runs.length, 2, "the change is backed up once the gap has passed");
  c.stop();
});

test("a huge customer book is read newest-first and capped, never loaded whole", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "na-bigbook-"));
  mkdirSync(join(dataDir, "book"), { recursive: true });
  const db = new DatabaseSync(join(dataDir, "book", "neural-alpha.sqlite"));
  db.exec(`CREATE TABLE nav_snapshots (id INTEGER PRIMARY KEY, timestamp TEXT, cash_usd REAL, gas_usd REAL, positions_json TEXT, total_nav_usd REAL, peak_nav_usd REAL, drawdown_pct REAL, mode TEXT)`);
  const total = BOOK_ROW_LIMITS.nav_snapshots + 7000;
  const insert = db.prepare("INSERT INTO nav_snapshots (id, timestamp, cash_usd, gas_usd, positions_json, total_nav_usd, peak_nav_usd, drawdown_pct, mode) VALUES (?, 't', 1, 1, '[]', 1, 1, 0, 'paper')");
  db.exec("BEGIN");
  for (let i = 1; i <= total; i++) insert.run(1_000_000 + i);
  db.exec("COMMIT");
  db.close();

  const seen = new Set();
  const pool = {
    async query(sql, params) {
      if (String(sql).startsWith("INSERT INTO saas_backup.tenant_nav_snapshots")) for (const p of params || []) seen.add(p);
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  };
  const store = {
    list: () => [{ id: "abcd1234", host_id: "box-a", data_dir: dataDir, status: "running", created_at: "t", updated_at: "t" }],
    listOrders: () => [],
  };
  await backupSaasUsers({ store, pool, log() {} });
  const newest = 1_000_000 + total;
  assert.ok(seen.has(newest), "the newest row is backed up");
  assert.ok(seen.has(newest - BOOK_ROW_LIMITS.nav_snapshots + 1), "the last row inside the cap is backed up");
  assert.ok(!seen.has(newest - BOOK_ROW_LIMITS.nav_snapshots), "rows beyond the cap are not loaded this pass");
  assert.ok(!seen.has(1_000_001), "the oldest row is not loaded");
});
