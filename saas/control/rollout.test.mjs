import assert from "node:assert/strict";
import test from "node:test";
import { rollout } from "./rollout.mjs";

const rows = ["a", "b", "c"].map((id) => ({ id, image_tag: "old" }));
function world({ badOn = [], throwOn = [] } = {}) {
  const tags = Object.fromEntries(rows.map((r) => [r.id, r.image_tag]));
  const log = [];
  return {
    tags,
    log,
    apply: async (row, tag) => {
      log.push(`${row.id}->${tag || "default"}`);
      if (throwOn.includes(row.id) && tag === "new") throw new Error("compose failed");
      tags[row.id] = tag;
    },
    ready: async (row) => !(badOn.includes(row.id) && tags[row.id] === "new"),
  };
}

test("a good image reaches everyone, canary first", async () => {
  const w = world();
  const r = await rollout({ rows, tag: "new", apply: w.apply, ready: w.ready });
  assert.deepEqual(r, { ok: true, tag: "new", done: ["a", "b", "c"] });
  assert.deepEqual(w.log, ["a->new", "b->new", "c->new"]);
});

test("a bad canary is rolled back and nobody else is touched", async () => {
  const w = world({ badOn: ["a"] });
  const r = await rollout({ rows, tag: "new", apply: w.apply, ready: w.ready });
  assert.equal(r.ok, false);
  assert.equal(r.failed, "a");
  assert.equal(r.rolledBack, true);
  assert.deepEqual(r.done, []);
  assert.deepEqual(w.tags, { a: "old", b: "old", c: "old" });
});

test("a failure part-way keeps the earlier customers and restores the failing one", async () => {
  const w = world({ badOn: ["b"] });
  const r = await rollout({ rows, tag: "new", apply: w.apply, ready: w.ready });
  assert.deepEqual(r.done, ["a"]);
  assert.equal(r.failed, "b");
  assert.deepEqual(w.tags, { a: "new", b: "old", c: "old" });
});

test("an apply error is reported as the reason", async () => {
  const w = world({ throwOn: ["a"] });
  const r = await rollout({ rows, tag: "new", apply: w.apply, ready: w.ready });
  assert.equal(r.reason, "compose failed");
  assert.equal(r.rolledBack, true);
});

test("the soak wait re-checks the canary", async () => {
  let checks = 0;
  const slept = [];
  const r = await rollout({
    rows: [rows[0]],
    tag: "new",
    soakMs: 5000,
    apply: async () => {},
    ready: async () => ++checks < 2,
    sleep: async (ms) => slept.push(ms),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /soak/);
  assert.deepEqual(slept, [5000]);
});

test("a bad tag is rejected before anything runs", async () => {
  await assert.rejects(rollout({ rows, tag: "x; rm -rf /", apply: async () => {}, ready: async () => true }), /tag must be/);
});
