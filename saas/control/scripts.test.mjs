import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const saas = join(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = readdirSync(saas).filter((f) => f.endsWith(".sh"));

test("every operations script is valid bash", () => {
  assert.ok(scripts.length >= 5, "expected the join, link, wg, rollout and restore scripts");
  for (const f of scripts) {
    const r = spawnSync("bash", ["-n", join(saas, f)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test("scripts that take secrets or hosts refuse bad input before doing anything", () => {
  const run = (f, args) => spawnSync("bash", [join(saas, f), ...args], { encoding: "utf8" });
  assert.match(run("join-mother.sh", ["--secret", "x", "--treasury", "nope"]).stderr, /0x BSC address/);
  assert.match(run("join-mother.sh", ["--secret", "x", "--treasury", `0x${"a".repeat(40)}`, "--wireguard"]).stderr, /needs --mother-ssh/);
  assert.match(run("join-mother.sh", ["--secret", "x", "--treasury", `0x${"a".repeat(40)}`, "--backup-rsync", "--evil"]).stderr, /user@host:\/path/);
  assert.match(run("join-mother.sh", ["--secret", "x", "--treasury", `0x${"a".repeat(40)}`, "--backup-key", "short"]).stderr, /64 hex/);
  assert.match(run("restore-cell.sh", []).stderr, /usage/);
  assert.match(run("wg-link.sh", ["cell", "--iface", "eth0"]).stderr, /wg0|root/);
});
