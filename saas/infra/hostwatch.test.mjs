import assert from "node:assert/strict";
import test from "node:test";
import { evaluate } from "./hostwatch.mjs";

const ok = { diskPct: 40, memAvailPct: 60, pm2: [], containers: [] };
const kinds = (r) => r.events.map((e) => `${e.type}:${e.key}`);

test("a healthy server says nothing", () => {
  assert.deepEqual(evaluate(ok).events, []);
});

test("disk opens at 85% once, stays quiet, and only clears below 80%", () => {
  let r = evaluate({ ...ok, diskPct: 86 });
  assert.deepEqual(kinds(r), ["open:disk"]);
  r = evaluate({ ...ok, diskPct: 84 }, r.state);
  assert.deepEqual(kinds(r), [], "84% is still inside the gap");
  r = evaluate({ ...ok, diskPct: 79 }, r.state);
  assert.deepEqual(kinds(r), ["resolved:disk"]);
});

test("low memory is reported once", () => {
  let r = evaluate({ ...ok, memAvailPct: 6 });
  assert.deepEqual(kinds(r), ["open:memory"]);
  assert.deepEqual(kinds(evaluate({ ...ok, memAvailPct: 5 }, r.state)), []);
});

test("only Neural Alpha apps are watched; an app stopped on purpose is ignored", () => {
  const m = { ...ok, pm2: [{ name: "clipx-bot", status: "stopped", restarts: 6 }, { name: "neural-saas-cell", status: "errored", restarts: 2 }] };
  assert.deepEqual(kinds(evaluate(m)), ["open:pm2:neural-saas-cell"]);
});

test("a restart storm is reported", () => {
  const first = evaluate({ ...ok, pm2: [{ name: "neural-portal", status: "online", restarts: 3 }] });
  const r = evaluate({ ...ok, pm2: [{ name: "neural-portal", status: "online", restarts: 9 }] }, first.state);
  assert.deepEqual(kinds(r), ["open:restarts:neural-portal"]);
});

test("a container pinned at 100% CPU is reported after three checks, a spike is not", () => {
  const busy = (cpu) => ({ ...ok, containers: [{ name: "na-1fa728f0", state: "Up 3 hours", cpu }] });
  let r = evaluate(busy(102));
  r = evaluate(busy(5), r.state); // a spike that ends resets the count
  assert.deepEqual(kinds(r), []);
  r = evaluate(busy(101), r.state);
  r = evaluate(busy(102), r.state);
  assert.deepEqual(kinds(r), []);
  r = evaluate(busy(100), r.state);
  assert.deepEqual(kinds(r), ["open:container-cpu:na-1fa728f0"]);
  assert.match(r.events[0].text, /na-1fa728f0 has been at 100% CPU/);
  r = evaluate(busy(3), r.state);
  assert.deepEqual(kinds(r), ["resolved:container-cpu:na-1fa728f0"]);
});

test("a container stuck restarting is reported", () => {
  const r = evaluate({ ...ok, containers: [{ name: "na-ab12cd34", state: "Restarting (1) 4 seconds ago", cpu: 0 }] });
  assert.deepEqual(kinds(r), ["open:container-state:na-ab12cd34"]);
});
