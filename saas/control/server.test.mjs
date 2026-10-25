import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, createHandler } from "./server.mjs";
import { openStore } from "./store.mjs";

function fakeDocker() {
  const containers = new Set();
  return {
    containers,
    async ensureNetwork() {},
    async ensureImage() {},
    async up(tenant) {
      containers.add(tenant.containerName || tenant.project);
    },
    async stop(tenant) {
      containers.delete(tenant.containerName || tenant.project);
    },
    async start(tenant) {
      containers.add(tenant.containerName || tenant.project);
    },
    async down(tenant) {
      containers.delete(tenant.containerName || tenant.project);
    },
    async signin() {
      return { qrCodeId: "qr-1", pairingCode: "4455", urlForWeb: "https://example.test/pair" };
    },
    async verify() {
      return { ok: true };
    },
    async walletAddress() {
      return "0xabc";
    },
    async listContainers() {
      return [...containers];
    },
  };
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    server,
    url: `http://127.0.0.1:${port}`,
  };
}

async function call(base, path, opts = {}) {
  const response = await fetch(`${base}${path}`, {
    method: opts.method || "GET",
    headers: {
      authorization: "Bearer test-secret",
      ...(opts.body ? { "content-type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

test("each customer gets a separate container and the third is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "na-control-"));
  const config = loadConfig({
    CONTROL_API_SECRET: "test-secret",
    SAAS_DATA_ROOT: root,
    SAAS_DB_PATH: join(root, "control.sqlite"),
    SAAS_HOST_ID: "box-a",
    SAAS_MAX_TENANTS: "2",
    SAAS_HOST_RAM_MB: "16384",
  });
  const store = openStore(config.dbPath);
  const docker = fakeDocker();
  const { server, url } = await listen(createHandler({ store, docker, config }));
  try {
    const first = await call(url, "/tenants", { method: "POST" });
    const second = await call(url, "/tenants", { method: "POST" });
    const third = await call(url, "/tenants", { method: "POST" });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(third.status, 409);
    assert.notEqual(first.body.tenant.container_name, second.body.tenant.container_name);
    assert.notEqual(first.body.tenant.data_dir, second.body.tenant.data_dir);
    const env = readFileSync(join(first.body.tenant.data_dir, "tenant.env"), "utf8");
    assert.match(env, /MAX_POSITION_SIZE_USD=50/);
    assert.match(env, /DISABLE_DRAWDOWN_LIMIT=false/);
    assert.match(env, /TRADE_INTERVAL_MS=300000/);

    const live = await call(url, `/tenants/${first.body.tenant.id}/mode`, {
      method: "POST",
      body: { mode: "live" },
    });
    assert.equal(live.status, 409);

    const pair = await call(url, `/tenants/${first.body.tenant.id}/pair/verify`, {
      method: "POST",
      body: { qrCodeId: "qr-1" },
    });
    assert.equal(pair.body.tenant.wallet_address, "0xabc");
    const allowed = await call(url, `/tenants/${first.body.tenant.id}/mode`, {
      method: "POST",
      body: { mode: "live" },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.tenant.agent_mode, "live");

    const cap = await call(url, "/capacity");
    assert.equal(cap.body.maxTenants, 2);
    assert.equal(cap.body.running, 2);
    assert.ok(cap.body.estimatedUsePerMin <= cap.body.upstreamBudgetPerMin);
  } finally {
    server.close();
    store.close();
  }
});
