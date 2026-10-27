import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const saas = join(here, "..");
const read = (...p) => readFileSync(join(...p), "utf8");
const require = createRequire(import.meta.url);

test("every customer container has hard limits and rotating logs", () => {
  const compose = read(saas, "worker", "compose.yaml");
  // worker and bridge each need a memory ceiling, no swap, a CPU share and a process cap
  for (const key of ["mem_limit:", "memswap_limit:", "cpus:", "pids_limit:"]) {
    assert.equal((compose.match(new RegExp(key, "g")) || []).length, 2, `${key} must be set on both services`);
  }
  assert.match(compose, /max-size: "10m"/);
  assert.match(compose, /max-file: "3"/);
  assert.match(compose, /mem_limit: 1g/, "the worker is stopped at 1 GiB, not allowed to eat the host");
});

test("pm2 definitions run node directly with a memory ceiling, for both roles", () => {
  const load = (role) => {
    process.env.NA_ROLE = role;
    delete require.cache[require.resolve("./ecosystem.config.cjs")];
    return require("./ecosystem.config.cjs").apps;
  };
  const cell = load("cell");
  assert.deepEqual(cell.map((a) => a.name), ["neural-saas-cell"]);
  const mother = load("mother");
  assert.deepEqual(mother.map((a) => a.name), ["neural-saas-edge", "neural-portal"]);
  for (const app of [...cell, ...mother]) {
    assert.equal(app.interpreter, "none", `${app.name}: pm2's wrapper would never start the server`);
    assert.ok(app.max_memory_restart, `${app.name} needs a memory ceiling`);
    assert.ok(app.max_restarts > 0 && app.restart_delay > 0, `${app.name} must not restart in a tight loop`);
    assert.equal(JSON.stringify(app).includes("SECRET"), false, "no secrets in the pm2 file");
  }
  delete process.env.NA_ROLE;
});

test("the nginx files rate-limit sign-in routes, pass the visitor's address, and keep placeholders", () => {
  const site = read(here, "nginx", "portal.conf.tmpl");
  assert.match(site, /__DOMAIN__/);
  assert.match(site, /__PORT__/);
  assert.match(site, /limit_req zone=na_auth/);
  assert.match(site, /code\|restore\|verify\|challenge\|open\|wallets/);
  assert.match(read(here, "nginx", "neural-proxy.conf"), /proxy_set_header X-Real-IP \$remote_addr/);
  assert.match(read(here, "nginx", "limits.conf"), /limit_req_zone \$binary_remote_addr zone=na_auth/);
});

test("the infra scripts are valid bash and refuse bad input before changing anything", () => {
  const scripts = readdirSync(here).filter((f) => f.endsWith(".sh"));
  assert.deepEqual(scripts.sort(), ["bootstrap.sh", "inventory.sh", "restore-apps.sh"]);
  for (const f of scripts) assert.equal(spawnSync("bash", ["-n", join(here, f)], { encoding: "utf8" }).status, 0, f);
  const boot = (args) => spawnSync("bash", [join(here, "bootstrap.sh"), ...args], { encoding: "utf8" }).stderr;
  const t = `0x${"a".repeat(40)}`;
  assert.match(boot([]), /--role/);
  assert.match(boot(["--role", "mother"]), /--domain is required/);
  assert.match(boot(["--role", "mother", "--domain", "x.io", "--email", "a@b.c", "--treasury", "nope"]), /0x BSC fee wallet/);
  assert.match(boot(["--role", "mother", "--domain", "x.io", "--email", "a@b.c", "--treasury", t, "--ssh-key", "garbage"]), /public key/);
  assert.match(boot(["--role", "cell"]), /join-mother options/);
});

test("a dry run lists every step and changes nothing", () => {
  const out = spawnSync("bash", [join(here, "bootstrap.sh"), "--role", "mother", "--domain", "portal.example.com", "--email", "o@e.com", "--treasury", `0x${"a".repeat(40)}`, "--dry-run"], { encoding: "utf8" }).stdout;
  for (const step of ["System packages", "Node 22 and pm2", "Code:", "Mother: config, build, pm2", "nginx and HTTPS", "Host watchdog"]) assert.match(out, new RegExp(step));
  assert.match(out, /certbot --nginx -d portal\.example\.com/);
  assert.match(out, /NA_ROLE=mother pm2 start saas\/infra\/ecosystem\.config\.cjs/);
});

test("restore-apps and inventory do nothing without being asked", () => {
  assert.match(spawnSync("bash", [join(here, "restore-apps.sh")], { encoding: "utf8" }).stderr, /rebuild-\*\.tgz/);
  assert.match(read(here, "restore-apps.sh"), /dry run/);
  assert.match(read(here, "inventory.sh"), /changes nothing/i);
});
