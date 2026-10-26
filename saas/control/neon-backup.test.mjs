import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  TENANT_COLUMNS,
  attachSaasBackup,
  backupIntervalMs,
  backupSaasUsers,
  createBackupController,
  customerBookUsesSharedNeonBackup,
  safeError,
  watchUserRecords,
} from "./neon-backup.mjs";
import { COLUMNS, openStore } from "./store.mjs";

const SECRET = "secret-api-key-should-not-upload";
const CURSOR = "cursor-value-do-not-upload";
const SHARED_ORDER = "shared-book-order-should-stay-local";
const ENV_SENTINEL = "not-a-real-key-sentinel";
const FAKE_URL_HOST = "backup-test.invalid";

function fakePool(queries, onQuery) {
  return {
    async query(sql, params) {
      if (onQuery) await onQuery(sql, params);
      queries.push({ sql: String(sql), params: params || [] });
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  };
}

function writesSharedTradingTable(sql) {
  return /\b(?:INTO|UPDATE|TABLE(?: IF NOT EXISTS)?)\s+(?:public\.)?(?:trades|nav_snapshots|chain_syncs|agent_state)\b/i.test(sql);
}

function paramsInclude(queries, needle) {
  return queries.some((query) =>
    (query.params || []).some((value) => value === needle || (typeof value === "string" && value.includes(needle))),
  );
}

function tenantRow(overrides = {}) {
  const now = "2026-10-26T12:00:00.000Z";
  return {
    id: "abcd1234",
    host_id: "box-a",
    status: "running",
    container_name: "na-abcd1234",
    data_dir: "/tmp/na-missing-customer-book",
    risk_preset: "100",
    agent_mode: "paper",
    max_position_usd: 100,
    max_drawdown_pct: 0,
    max_trade_usd: 100,
    trade_interval_ms: 300000,
    wallet_address: "0xabc0000000000000000000000000000000000001",
    access_token_hash: "hash-token",
    access_code_hash: "hash-code",
    agent_api_secret: SECRET,
    payment_asset: "USDT",
    payment_tx: `0x${"ab".repeat(32)}`,
    agent_name: "alpha.ai",
    paid_until: "2026-11-26T12:00:00.000Z",
    order_id: "ord_test",
    paid_amount: "15.184",
    overpaid_amount: "0",
    buys_halted: 0,
    x402_per_day: 2,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function orderRow(overrides = {}) {
  const now = "2026-10-26T12:00:00.000Z";
  return {
    id: "ord_test",
    host_id: "box-a",
    status: "paid",
    asset: "USDT",
    risk_preset: "100",
    position_usd: 100,
    x402_per_day: 2,
    agent_name: "alpha.ai",
    tenant_id: "abcd1234",
    treasury_address: "0x2222222222222222222222222222222222222222",
    token_contract: "0x55d398326f99059ff775485246999027b3197955",
    price_usd: 15,
    amount_display: "15.184",
    amount_wei: "15184000000000000000",
    tail: 184,
    payment_tx: `0x${"ab".repeat(32)}`,
    paid_amount_wei: "15184000000000000000",
    overpaid_wei: "0",
    payer_address: "0x9999999999999999999999999999999999999999",
    confirmations: 15,
    claim_secret_hash: "hash-claim",
    pending_access_token: "pending-token",
    pending_access_code: "ABCD-EFGH-JKLM-NPQR",
    expires_at: "2026-10-26T12:10:00.000Z",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function writeCustomerBook(dataDir, { orderId = "cust-order-1", sharedUrl = false, stateKey = "nav_peak" } = {}) {
  const book = join(dataDir, "book");
  mkdirSync(book, { recursive: true });
  if (sharedUrl) {
    writeFileSync(
      join(dataDir, "tenant.env"),
      `API_SECRET=${ENV_SENTINEL}\nDATABASE_URL=postgres://${FAKE_URL_HOST}/neondb\n`,
      { mode: 0o600 },
    );
  }
  writeFileSync(join(book, "external-flows.json"), "{\"kept\":\"flow-file\"}\n");
  const db = new DatabaseSync(join(book, "neural-alpha.sqlite"));
  db.exec(`
    CREATE TABLE trades (
      id INTEGER PRIMARY KEY,
      order_id TEXT,
      symbol TEXT,
      side TEXT,
      amount_usd REAL,
      from_token TEXT,
      to_token TEXT,
      status TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE agent_state (
      key TEXT PRIMARY KEY,
      value_json TEXT,
      updated_at TEXT
    );
    CREATE TABLE backup_cursor (
      name TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE nav_snapshots (
      id INTEGER PRIMARY KEY,
      timestamp TEXT,
      cash_usd REAL,
      gas_usd REAL,
      positions_json TEXT,
      total_nav_usd REAL,
      peak_nav_usd REAL,
      drawdown_pct REAL,
      mode TEXT
    );
    CREATE TABLE chain_syncs (
      id INTEGER PRIMARY KEY,
      timestamp TEXT,
      holdings_json TEXT,
      usdt_balance REAL,
      positions_added TEXT,
      positions_removed TEXT
    );
  `);
  db.prepare(
    `INSERT INTO trades (order_id, symbol, side, amount_usd, from_token, to_token, status, created_at, updated_at)
     VALUES (?, 'NVDAB', 'buy', 10, 'USDT', 'NVDAB', 'confirmed', '2026-10-26T12:00:00.000Z', '2026-10-26T12:00:00.000Z')`,
  ).run(orderId);
  db.prepare("INSERT INTO agent_state (key, value_json, updated_at) VALUES (?, '{\"peakNavUsd\":10}', '2026-10-26T12:00:00.000Z')").run(stateKey);
  db.prepare("INSERT INTO backup_cursor (name, value) VALUES ('trades', ?)").run(CURSOR);
  db.prepare(
    `INSERT INTO nav_snapshots (timestamp, cash_usd, gas_usd, positions_json, total_nav_usd, peak_nav_usd, drawdown_pct, mode)
     VALUES ('2026-10-26T12:00:00.000Z', 10, 0, '[]', 10, 10, 0, 'paper')`,
  ).run();
  db.prepare(
    `INSERT INTO chain_syncs (timestamp, holdings_json, usdt_balance, positions_added, positions_removed)
     VALUES ('2026-10-26T12:00:00.000Z', '{}', 10, '[]', '[]')`,
  ).run();
  db.close();
}

test("tenant backup keeps user fields and drops the agent API secret", () => {
  assert.equal(TENANT_COLUMNS.includes("agent_api_secret"), false);
  assert.equal(TENANT_COLUMNS.includes("access_code_hash"), true);
  assert.equal(TENANT_COLUMNS.includes("access_token_hash"), true);
  assert.equal(TENANT_COLUMNS.includes("wallet_address"), true);
  assert.equal(TENANT_COLUMNS.includes("payment_tx"), true);
  for (const column of COLUMNS) {
    if (column === "agent_api_secret") continue;
    assert.equal(TENANT_COLUMNS.includes(column), true);
  }
});

test("backup interval defaults to one hour", () => {
  assert.equal(backupIntervalMs({}), 60 * 60 * 1000);
  assert.equal(backupIntervalMs({ NEON_BACKUP_INTERVAL_MS: "120000" }), 120000);
  assert.equal(backupIntervalMs({ SAAS_NEON_BACKUP_INTERVAL_MS: "180000", NEON_BACKUP_INTERVAL_MS: "120000" }), 180000);
  assert.equal(backupIntervalMs({ NEON_BACKUP_INTERVAL_MS: "1000" }), 60 * 60 * 1000);
});

test("backup errors do not include the database url or access material", () => {
  const redacted = safeError(
    new Error(
      `fail postgres://user:super-secret-password@ep.${FAKE_URL_HOST}/neondb?sslmode=require ABCD-EFGH-JKLM-NPQR ${"ab".repeat(32)}`,
    ),
  );
  assert.equal(redacted.includes("super-secret-password"), false);
  assert.equal(redacted.includes(FAKE_URL_HOST), false);
  assert.equal(redacted.includes("ABCD-EFGH-JKLM-NPQR"), false);
  assert.equal(redacted.includes("ab".repeat(32)), false);
  assert.match(redacted, /\[redacted\]/);
});

test("control records and an uncovered customer book upsert into saas_backup", async () => {
  const root = mkdtempSync(join(tmpdir(), "na-backup-"));
  const dataDir = join(root, "abcd1234");
  writeCustomerBook(dataDir);
  const store = openStore(join(root, "control.sqlite"));
  const queries = [];
  try {
    store.insert(tenantRow({ data_dir: dataDir }));
    store.insertOrder(orderRow());
    const pool = fakePool(queries);
    await backupSaasUsers({ store, pool, log() {} });
    store.update("abcd1234", { status: "paused", updated_at: "2026-10-26T13:00:00.000Z" });
    store.updateOrder("ord_test", { confirmations: 20, updated_at: "2026-10-26T13:00:00.000Z" });
    await backupSaasUsers({ store, pool, log() {} });
  } finally {
    store.close();
  }

  assert.equal(queries.some((query) => query.sql.includes("CREATE SCHEMA IF NOT EXISTS saas_backup")), true);
  assert.equal(queries.some((query) => writesSharedTradingTable(query.sql)), false);
  assert.equal(queries.some((query) => query.sql.includes("agent_api_secret")), false);
  assert.equal(queries.some((query) => query.sql.includes("backup_cursor")), false);
  assert.equal(paramsInclude(queries, SECRET), false);
  assert.equal(paramsInclude(queries, CURSOR), false);

  const tenantWrites = queries.filter((query) => query.sql.startsWith("INSERT INTO saas_backup.tenants"));
  assert.equal(tenantWrites.length, 2);
  assert.equal(tenantWrites.every((query) => query.sql.includes("ON CONFLICT (id) DO UPDATE")), true);
  assert.equal(tenantWrites[0].params[0], tenantWrites[1].params[0]);
  assert.equal(tenantWrites[0].params.includes("running"), true);
  assert.equal(tenantWrites[1].params.includes("paused"), true);
  assert.equal(tenantWrites[0].params.includes("hash-code"), true);
  assert.equal(tenantWrites[0].params.includes("0xabc0000000000000000000000000000000000001"), true);

  const orderWrites = queries.filter((query) => query.sql.startsWith("INSERT INTO saas_backup.orders"));
  assert.equal(orderWrites.length, 2);
  assert.equal(orderWrites.every((query) => query.sql.includes("ON CONFLICT (id) DO UPDATE")), true);
  assert.equal(orderWrites[0].params[0], "ord_test");
  assert.equal(orderWrites[1].params[0], "ord_test");
  assert.equal(orderWrites[0].sql.includes("payer_address"), true);
  assert.equal(orderWrites[0].sql.includes("pending_access_code"), true);
  assert.equal(orderWrites[0].sql.includes("claim_secret_hash"), true);
  assert.equal(orderWrites[0].sql.includes("payment_tx"), true);
  assert.equal(orderWrites[1].params.includes(20), true);

  const tradeWrites = queries.filter((query) => query.sql.startsWith("INSERT INTO saas_backup.tenant_trades"));
  assert.equal(tradeWrites.length, 2);
  assert.equal(tradeWrites[0].sql.includes("ON CONFLICT (host_id, tenant_id, order_id)"), true);
  assert.equal(tradeWrites[0].params.includes("cust-order-1"), true);
  assert.equal(tradeWrites[0].params.includes("abcd1234"), true);

  const stateWrite = queries.find((query) => query.sql.startsWith("INSERT INTO saas_backup.tenant_agent_state"));
  assert.equal(Boolean(stateWrite), true);
  assert.equal(stateWrite.params.includes("nav_peak"), true);
  const navWrite = queries.find((query) => query.sql.startsWith("INSERT INTO saas_backup.tenant_nav_snapshots"));
  assert.equal(Boolean(navWrite), true);
  assert.equal(navWrite.params.includes("paper"), true);
  const syncWrite = queries.find((query) => query.sql.startsWith("INSERT INTO saas_backup.tenant_chain_syncs"));
  assert.equal(Boolean(syncWrite), true);
  const fileWrite = queries.find((query) => query.sql.startsWith("INSERT INTO saas_backup.tenant_files"));
  assert.equal(Boolean(fileWrite), true);
  assert.equal(fileWrite.params.includes("external-flows.json"), true);
  assert.equal(fileWrite.params.includes("flow-file") || paramsInclude(queries, "flow-file"), true);

  for (const query of queries) {
    if (!query.sql.startsWith("INSERT")) continue;
    const placeholders = query.sql.match(/\$\d+/g) || [];
    assert.equal(placeholders.length, query.params.length);
  }
});

test("a customer book already covered by the agent backup is not copied again", async () => {
  const root = mkdtempSync(join(tmpdir(), "na-backup-shared-"));
  const dataDir = join(root, "abcd1234");
  writeCustomerBook(dataDir, { orderId: SHARED_ORDER, sharedUrl: true, stateKey: "founder-key-should-stay-local" });
  const queries = [];
  await backupSaasUsers({
    store: {
      list: () => [tenantRow({ data_dir: dataDir })],
      listOrders: () => [orderRow()],
    },
    pool: fakePool(queries),
    log() {},
  });
  assert.equal(queries.some((query) => query.sql.startsWith("INSERT INTO saas_backup.tenant_trades")), false);
  assert.equal(queries.some((query) => query.sql.startsWith("INSERT INTO saas_backup.tenant_nav_snapshots")), false);
  assert.equal(queries.some((query) => query.sql.startsWith("INSERT INTO saas_backup.tenant_chain_syncs")), false);
  assert.equal(queries.some((query) => query.sql.startsWith("INSERT INTO saas_backup.tenant_agent_state")), false);
  assert.equal(paramsInclude(queries, SHARED_ORDER), false);
  assert.equal(paramsInclude(queries, "founder-key-should-stay-local"), false);
  assert.equal(paramsInclude(queries, ENV_SENTINEL), false);
  assert.equal(paramsInclude(queries, FAKE_URL_HOST), false);
  assert.equal(paramsInclude(queries, "tenant.env"), false);
  assert.equal(paramsInclude(queries, "flow-file"), true);
  assert.equal(queries.some((query) => query.sql.startsWith("INSERT INTO saas_backup.orders")), true);
  assert.equal(queries.some((query) => writesSharedTradingTable(query.sql)), false);
});

test("a tenant env counts as covered only when the database url is set", () => {
  const root = mkdtempSync(join(tmpdir(), "na-backup-env-"));
  assert.equal(customerBookUsesSharedNeonBackup(root), false);
  writeFileSync(join(root, "tenant.env"), `API_SECRET=${ENV_SENTINEL}\nDATABASE_URL=\n`);
  assert.equal(customerBookUsesSharedNeonBackup(root), false);
  writeFileSync(join(root, "tenant.env"), `DATABASE_URL=postgres://${FAKE_URL_HOST}/neondb\n`);
  assert.equal(customerBookUsesSharedNeonBackup(root), true);
});

test("a missing neon url logs once and does not open a pool", async () => {
  const logs = [];
  let opened = false;
  const attached = await attachSaasBackup({
    store: { list() { return []; }, listOrders() { return []; } },
    databaseUrl: "  ",
    createPool() {
      opened = true;
      return fakePool([]);
    },
    log: (message) => logs.push(message),
  });
  attached.kick();
  await attached.runOnce();
  await attached.stop();
  assert.equal(attached.enabled, false);
  assert.equal(opened, false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /unset/);
  assert.equal(logs[0].includes("postgres://"), false);
});

test("neon connection failures are redacted and checkout is not required", async () => {
  const logs = [];
  const attached = await attachSaasBackup({
    store: { list() { return []; }, listOrders() { return []; } },
    databaseUrl: `postgres://user:super-secret-password@ep.${FAKE_URL_HOST}/neondb`,
    createPool() {
      throw new Error(`password authentication failed for postgres://user:super-secret-password@ep.${FAKE_URL_HOST}/neondb`);
    },
    log: (message) => logs.push(message),
  });
  await attached.stop();
  const text = logs.join("\n");
  assert.equal(attached.enabled, false);
  assert.match(text, /unavailable/);
  assert.equal(text.includes("super-secret-password"), false);
  assert.equal(text.includes(FAKE_URL_HOST), false);
});

test("a failed backup is logged and the next pass upserts", async () => {
  const logs = [];
  const queries = [];
  let attempts = 0;
  const controller = createBackupController({
    startImmediately: false,
    intervalMs: 60 * 60 * 1000,
    debounceMs: 0,
    log: (message) => logs.push(message),
    run: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error(`connect ECONNREFUSED postgres://user:super-secret-password@ep.${FAKE_URL_HOST}/neondb`);
      }
      await backupSaasUsers({
        store: {
          list: () => [tenantRow()],
          listOrders: () => [orderRow()],
        },
        pool: fakePool(queries),
        log: (message) => logs.push(message),
      });
    },
  });
  try {
    await controller.runOnce();
    assert.equal(attempts, 1);
    assert.equal(queries.length, 0);
    assert.match(logs.join("\n"), /failed/i);
    assert.equal(logs.join("\n").includes("super-secret-password"), false);
    assert.equal(logs.join("\n").includes(FAKE_URL_HOST), false);
    await controller.runOnce();
    assert.equal(queries.some((query) => query.sql.includes("saas_backup.tenants") && query.sql.includes("ON CONFLICT")), true);
  } finally {
    controller.stop();
  }
});

test("order and tenant changes schedule one backup", async () => {
  const root = mkdtempSync(join(tmpdir(), "na-backup-watch-"));
  const store = openStore(join(root, "control.sqlite"));
  let runs = 0;
  const controller = createBackupController({
    run: async () => {
      runs += 1;
    },
    intervalMs: 60 * 60 * 1000,
    debounceMs: 40,
    startImmediately: false,
    log() {},
  });
  try {
    watchUserRecords(store, () => controller.kick());
    store.insert(tenantRow({ data_dir: join(root, "abcd1234") }));
    store.insertOrder(orderRow());
    store.update("abcd1234", { status: "paused", updated_at: "2026-10-26T13:00:00.000Z" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(runs, 1);
  } finally {
    controller.stop();
    store.close();
  }
});

test("attach starts a backup without printing the connection string", async () => {
  const queries = [];
  const logs = [];
  let ended = false;
  const pool = fakePool(queries);
  pool.end = async () => {
    ended = true;
  };
  const attached = await attachSaasBackup({
    store: { list: () => [], listOrders: () => [] },
    databaseUrl: `postgres://user:super-secret-password@${FAKE_URL_HOST}/neondb`,
    createPool: async () => pool,
    intervalMs: 60 * 60 * 1000,
    log: (message) => logs.push(message),
  });
  try {
    await attached.started;
    assert.equal(attached.enabled, true);
    assert.equal(queries.some((query) => query.sql === "SELECT 1"), true);
    assert.equal(queries.some((query) => query.sql.includes("CREATE SCHEMA IF NOT EXISTS saas_backup")), true);
    assert.equal(logs.some((message) => message.includes("stored 0 tenants, 0 orders, 0 customer books")), true);
    assert.equal(logs.some((message) => message.includes("super-secret-password") || message.includes(FAKE_URL_HOST)), false);
  } finally {
    await attached.stop();
  }
  assert.equal(ended, true);
});
