import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { COLUMNS as TENANT_STORE_COLUMNS, ORDER_COLUMNS } from "./store.mjs";

/**
 * Copies SaaS user records into Neon schema `saas_backup`.
 * Local sqlite stays the live store. The founder trading tables
 * (public trades, nav_snapshots, chain_syncs, agent_state) are left
 * to neural-alpha/src/db/neon-backup.ts and are never written here.
 */

export const DEFAULT_BACKUP_INTERVAL_MS = 60 * 60 * 1000;
export const CHANGE_DEBOUNCE_MS = 1000;
const MAX_BOOK_FILE_BYTES = 1_000_000;
const BOOK_FILES = ["external-flows.json", "position-entries.json"];
const TENANT_SKIP = new Set(["agent_api_secret"]);
const USER_RECORD_METHODS = ["insert", "update", "insertOrder", "updateOrder", "replacePendingQuote", "adoptHost"];
const TABLES = new Set([
  "tenants",
  "orders",
  "tenant_trades",
  "tenant_nav_snapshots",
  "tenant_chain_syncs",
  "tenant_agent_state",
  "tenant_files",
]);

export const TENANT_COLUMNS = TENANT_STORE_COLUMNS.filter((column) => !TENANT_SKIP.has(column));
export const ORDER_BACKUP_COLUMNS = [...ORDER_COLUMNS];

const TRADE_COLUMNS = [
  "host_id",
  "tenant_id",
  "local_id",
  "order_id",
  "symbol",
  "side",
  "amount_usd",
  "from_token",
  "to_token",
  "from_amount",
  "to_amount",
  "price_usd",
  "tx_hash",
  "status",
  "error_message",
  "twak_response",
  "realized_pnl",
  "created_at",
  "confirmed_at",
  "wallet_address",
  "updated_at",
];
const NAV_COLUMNS = [
  "host_id",
  "tenant_id",
  "local_id",
  "cycle_id",
  "timestamp",
  "cash_usd",
  "gas_usd",
  "positions_json",
  "total_nav_usd",
  "peak_nav_usd",
  "drawdown_pct",
  "total_pnl_usd",
  "total_pnl_pct",
  "mode",
  "realized_pnl",
  "daily_pnl",
  "positions_count",
  "total_trades",
  "today_trades",
  "win_rate",
  "fear_greed",
  "emergency_mode",
];
const SYNC_COLUMNS = [
  "host_id",
  "tenant_id",
  "local_id",
  "timestamp",
  "holdings_json",
  "usdt_balance",
  "positions_added",
  "positions_removed",
  "gas_symbol",
  "gas_amount",
  "gas_usd",
];
const STATE_COLUMNS = ["host_id", "tenant_id", "key", "value_json", "updated_at"];
const FILE_COLUMNS = ["host_id", "tenant_id", "name", "body"];

export function backupIntervalMs(env = process.env) {
  const raw = env.SAAS_NEON_BACKUP_INTERVAL_MS || env.NEON_BACKUP_INTERVAL_MS || "";
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : DEFAULT_BACKUP_INTERVAL_MS;
}

export function safeError(err) {
  const text = err instanceof Error ? err.message : String(err);
  return text
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://[redacted]")
    .replace(/(password|secret)[=:][^\s&'"]+/gi, "$1=[redacted]")
    .replace(/\b[a-f0-9]{64}\b/gi, "[redacted]")
    .replace(/\b[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}\b/g, "[redacted]");
}

export function saasBackupSchemaStatements() {
  return [
    `CREATE SCHEMA IF NOT EXISTS saas_backup`,
    `CREATE TABLE IF NOT EXISTS saas_backup.tenants (
      id TEXT PRIMARY KEY,
      host_id TEXT,
      status TEXT,
      container_name TEXT,
      data_dir TEXT,
      risk_preset TEXT,
      agent_mode TEXT,
      max_position_usd DOUBLE PRECISION,
      max_drawdown_pct DOUBLE PRECISION,
      max_trade_usd DOUBLE PRECISION,
      trade_interval_ms INTEGER,
      wallet_address TEXT,
      access_token_hash TEXT,
      access_code_hash TEXT,
      payment_asset TEXT,
      payment_tx TEXT,
      agent_name TEXT,
      paid_until TEXT,
      order_id TEXT,
      paid_amount TEXT,
      overpaid_amount TEXT,
      buys_halted INTEGER,
      x402_per_day INTEGER,
      created_at TEXT,
      updated_at TEXT,
      backed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS saas_backup.orders (
      id TEXT PRIMARY KEY,
      host_id TEXT,
      status TEXT,
      asset TEXT,
      risk_preset TEXT,
      position_usd DOUBLE PRECISION,
      x402_per_day INTEGER,
      agent_name TEXT,
      tenant_id TEXT,
      treasury_address TEXT,
      token_contract TEXT,
      price_usd DOUBLE PRECISION,
      amount_display TEXT,
      amount_wei TEXT,
      tail INTEGER,
      payment_tx TEXT,
      paid_amount_wei TEXT,
      overpaid_wei TEXT,
      payer_address TEXT,
      confirmations INTEGER,
      claim_secret_hash TEXT,
      pending_access_token TEXT,
      pending_access_code TEXT,
      expires_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      backed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS saas_backup.tenant_trades (
      host_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      local_id BIGINT,
      order_id TEXT NOT NULL,
      symbol TEXT,
      side TEXT,
      amount_usd DOUBLE PRECISION,
      from_token TEXT,
      to_token TEXT,
      from_amount TEXT,
      to_amount TEXT,
      price_usd DOUBLE PRECISION,
      tx_hash TEXT,
      status TEXT,
      error_message TEXT,
      twak_response TEXT,
      realized_pnl DOUBLE PRECISION,
      created_at TEXT,
      confirmed_at TEXT,
      wallet_address TEXT,
      updated_at TEXT,
      backed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (host_id, tenant_id, order_id)
    )`,
    `CREATE TABLE IF NOT EXISTS saas_backup.tenant_nav_snapshots (
      host_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      local_id BIGINT NOT NULL,
      cycle_id INTEGER,
      timestamp TEXT,
      cash_usd DOUBLE PRECISION,
      gas_usd DOUBLE PRECISION,
      positions_json TEXT,
      total_nav_usd DOUBLE PRECISION,
      peak_nav_usd DOUBLE PRECISION,
      drawdown_pct DOUBLE PRECISION,
      total_pnl_usd DOUBLE PRECISION,
      total_pnl_pct DOUBLE PRECISION,
      mode TEXT,
      realized_pnl DOUBLE PRECISION,
      daily_pnl DOUBLE PRECISION,
      positions_count INTEGER,
      total_trades INTEGER,
      today_trades INTEGER,
      win_rate DOUBLE PRECISION,
      fear_greed INTEGER,
      emergency_mode INTEGER,
      backed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (host_id, tenant_id, local_id)
    )`,
    `CREATE TABLE IF NOT EXISTS saas_backup.tenant_chain_syncs (
      host_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      local_id BIGINT NOT NULL,
      timestamp TEXT,
      holdings_json TEXT,
      usdt_balance DOUBLE PRECISION,
      positions_added TEXT,
      positions_removed TEXT,
      gas_symbol TEXT,
      gas_amount DOUBLE PRECISION,
      gas_usd DOUBLE PRECISION,
      backed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (host_id, tenant_id, local_id)
    )`,
    `CREATE TABLE IF NOT EXISTS saas_backup.tenant_agent_state (
      host_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT,
      updated_at TEXT,
      backed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (host_id, tenant_id, key)
    )`,
    `CREATE TABLE IF NOT EXISTS saas_backup.tenant_files (
      host_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      body TEXT,
      backed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (host_id, tenant_id, name)
    )`,
  ];
}

function disabledBackup() {
  return {
    enabled: false,
    started: Promise.resolve(),
    kick() {},
    async stop() {},
    async runOnce() {},
  };
}

function defaultLog(message, level = "warn") {
  if (level === "info") console.log(message);
  else console.warn(message);
}

async function closePool(pool) {
  try {
    await pool?.end?.();
  } catch {
    // The pool is already closed or Neon is unreachable.
  }
}

async function defaultPool(databaseUrl) {
  const { Pool } = await import("@neondatabase/serverless");
  return new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    max: 1,
  });
}

function columnListOk(columns) {
  return columns.every((column) => /^[a-z0-9_]+$/.test(column));
}

function upsertStatement(table, columns, conflict) {
  if (!TABLES.has(table) || !columnListOk(columns) || !columnListOk(conflict)) {
    throw new Error("refusing to build a backup statement");
  }
  for (const column of conflict) {
    if (!columns.includes(column)) throw new Error(`backup conflict column ${column} missing from ${table}`);
  }
  const updates = columns
    .filter((column) => !conflict.includes(column))
    .map((column) => `${column} = EXCLUDED.${column}`);
  updates.push("backed_up_at = NOW()");
  const values = columns.map((_, index) => `$${index + 1}`).join(", ");
  return `INSERT INTO saas_backup.${table} (${columns.join(", ")}) VALUES (${values}) ON CONFLICT (${conflict.join(", ")}) DO UPDATE SET ${updates.join(", ")}`;
}

async function upsertAll(pool, table, columns, conflict, rows) {
  if (rows.length === 0) return 0;
  const sql = upsertStatement(table, columns, conflict);
  for (const row of rows) {
    await pool.query(sql, columns.map((column) => row[column] ?? null));
  }
  return rows.length;
}

async function ensureSchema(pool) {
  for (const statement of saasBackupSchemaStatements()) {
    await pool.query(statement);
  }
}

function toBackupRow(row, columns) {
  const copy = {};
  for (const column of columns) copy[column] = row?.[column] ?? null;
  return copy;
}

export function customerBookUsesSharedNeonBackup(dataDir) {
  if (!dataDir) return false;
  const envPath = join(dataDir, "tenant.env");
  if (!existsSync(envPath)) return false;
  let text = "";
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    return false;
  }
  return /^[ \t]*DATABASE_URL=\S+/m.test(text);
}

function firstExisting(paths) {
  return paths.find((path) => existsSync(path)) || null;
}

const SQLITE_BOOK_TABLES = new Set(["trades", "nav_snapshots", "chain_syncs", "agent_state"]);

function readRows(db, table) {
  if (!SQLITE_BOOK_TABLES.has(table)) return [];
  const found = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!found) return [];
  return db.prepare(`SELECT * FROM ${table}`).all();
}

function mapTrade(row, hostId, tenantId) {
  if (row.order_id == null || row.order_id === "") return null;
  return {
    host_id: hostId,
    tenant_id: tenantId,
    local_id: row.id ?? null,
    order_id: String(row.order_id),
    symbol: row.symbol ?? null,
    side: row.side ?? null,
    amount_usd: row.amount_usd ?? null,
    from_token: row.from_token ?? null,
    to_token: row.to_token ?? null,
    from_amount: row.from_amount ?? null,
    to_amount: row.to_amount ?? null,
    price_usd: row.price_usd ?? null,
    tx_hash: row.tx_hash ?? null,
    status: row.status ?? null,
    error_message: row.error_message ?? null,
    twak_response: row.twak_response ?? null,
    realized_pnl: row.realized_pnl ?? null,
    created_at: row.created_at ?? null,
    confirmed_at: row.confirmed_at ?? null,
    wallet_address: row.wallet_address ?? null,
    updated_at: row.updated_at ?? null,
  };
}

function mapNav(row, hostId, tenantId) {
  if (row.id == null) return null;
  return {
    host_id: hostId,
    tenant_id: tenantId,
    local_id: Number(row.id),
    cycle_id: row.cycle_id ?? null,
    timestamp: row.timestamp ?? null,
    cash_usd: row.cash_usd ?? null,
    gas_usd: row.gas_usd ?? null,
    positions_json: row.positions_json ?? null,
    total_nav_usd: row.total_nav_usd ?? null,
    peak_nav_usd: row.peak_nav_usd ?? null,
    drawdown_pct: row.drawdown_pct ?? null,
    total_pnl_usd: row.total_pnl_usd ?? null,
    total_pnl_pct: row.total_pnl_pct ?? null,
    mode: row.mode ?? null,
    realized_pnl: row.realized_pnl ?? null,
    daily_pnl: row.daily_pnl ?? null,
    positions_count: row.positions_count ?? null,
    total_trades: row.total_trades ?? null,
    today_trades: row.today_trades ?? null,
    win_rate: row.win_rate ?? null,
    fear_greed: row.fear_greed ?? null,
    emergency_mode: row.emergency_mode ?? null,
  };
}

function mapSync(row, hostId, tenantId) {
  if (row.id == null) return null;
  return {
    host_id: hostId,
    tenant_id: tenantId,
    local_id: Number(row.id),
    timestamp: row.timestamp ?? null,
    holdings_json: row.holdings_json ?? null,
    usdt_balance: row.usdt_balance ?? null,
    positions_added: row.positions_added ?? null,
    positions_removed: row.positions_removed ?? null,
    gas_symbol: row.gas_symbol ?? null,
    gas_amount: row.gas_amount ?? null,
    gas_usd: row.gas_usd ?? null,
  };
}

function mapState(row, hostId, tenantId) {
  if (!row.key) return null;
  return {
    host_id: hostId,
    tenant_id: tenantId,
    key: String(row.key),
    value_json: row.value_json ?? null,
    updated_at: row.updated_at ?? null,
  };
}

function readSqliteBook(sqlitePath, hostId, tenantId) {
  const db = new DatabaseSync(sqlitePath, { readOnly: true, timeout: 5000 });
  try {
    return {
      trades: readRows(db, "trades").map((row) => mapTrade(row, hostId, tenantId)).filter(Boolean),
      nav: readRows(db, "nav_snapshots").map((row) => mapNav(row, hostId, tenantId)).filter(Boolean),
      syncs: readRows(db, "chain_syncs").map((row) => mapSync(row, hostId, tenantId)).filter(Boolean),
      state: readRows(db, "agent_state").map((row) => mapState(row, hostId, tenantId)).filter(Boolean),
    };
  } finally {
    db.close();
  }
}

function readBookFiles(bookDir, tenant, log) {
  const files = [];
  for (const name of BOOK_FILES) {
    const path = join(bookDir, name);
    if (!existsSync(path)) continue;
    try {
      if (statSync(path).size > MAX_BOOK_FILE_BYTES) {
        log(`SaaS Neon backup skipped oversized customer file ${tenant.id} ${name}`, "warn");
        continue;
      }
      files.push({
        host_id: tenant.host_id,
        tenant_id: tenant.id,
        name,
        body: readFileSync(path, "utf8"),
      });
    } catch (err) {
      log(`SaaS Neon backup skipped customer file ${tenant.id} ${name}: ${safeError(err)}`, "warn");
    }
  }
  return files;
}

function loadTenantBook(tenant, log) {
  if (!tenant?.id || !tenant.data_dir) return null;
  const bookDir = join(tenant.data_dir, "book");
  const files = readBookFiles(bookDir, tenant, log);
  let tables = null;
  if (!customerBookUsesSharedNeonBackup(tenant.data_dir)) {
    const sqlitePath = firstExisting([
      join(bookDir, "neural-alpha.sqlite"),
      join(tenant.data_dir, "neural-alpha.sqlite"),
    ]);
    if (sqlitePath) tables = readSqliteBook(sqlitePath, tenant.host_id, tenant.id);
  }
  const hasRows = tables && (tables.trades.length || tables.nav.length || tables.syncs.length || tables.state.length);
  if (!hasRows && files.length === 0) return null;
  return {
    trades: tables?.trades || [],
    nav: tables?.nav || [],
    syncs: tables?.syncs || [],
    state: tables?.state || [],
    files,
  };
}

async function backupTenantBooks(pool, tenants, log) {
  let books = 0;
  for (const tenant of tenants) {
    let payload;
    try {
      payload = loadTenantBook(tenant, log);
    } catch (err) {
      log(`SaaS Neon backup skipped customer book ${tenant?.id || "unknown"}: ${safeError(err)}`, "warn");
      continue;
    }
    if (!payload) continue;
    try {
      await ensureSchema(pool);
      await upsertAll(pool, "tenant_trades", TRADE_COLUMNS, ["host_id", "tenant_id", "order_id"], payload.trades);
      await upsertAll(pool, "tenant_nav_snapshots", NAV_COLUMNS, ["host_id", "tenant_id", "local_id"], payload.nav);
      await upsertAll(pool, "tenant_chain_syncs", SYNC_COLUMNS, ["host_id", "tenant_id", "local_id"], payload.syncs);
      await upsertAll(pool, "tenant_agent_state", STATE_COLUMNS, ["host_id", "tenant_id", "key"], payload.state);
      await upsertAll(pool, "tenant_files", FILE_COLUMNS, ["host_id", "tenant_id", "name"], payload.files);
      books += 1;
    } catch (err) {
      log(`SaaS Neon backup skipped customer book ${tenant.id}: ${safeError(err)}`, "warn");
    }
  }
  return books;
}

export async function backupSaasUsers({ store, pool, log = () => {} }) {
  const tenants = (typeof store.list === "function" ? store.list() : []).map((row) => toBackupRow(row, TENANT_COLUMNS));
  const orders = (typeof store.listOrders === "function" ? store.listOrders() : []).map((row) =>
    toBackupRow(row, ORDER_BACKUP_COLUMNS),
  );
  await ensureSchema(pool);
  await upsertAll(pool, "tenants", TENANT_COLUMNS, ["id"], tenants);
  await upsertAll(pool, "orders", ORDER_BACKUP_COLUMNS, ["id"], orders);
  const books = await backupTenantBooks(pool, tenants, log);
  log(`SaaS Neon backup stored ${tenants.length} tenants, ${orders.length} orders, ${books} customer books`, "info");
  return { tenants: tenants.length, orders: orders.length, books };
}

export function createBackupController({
  run,
  intervalMs = DEFAULT_BACKUP_INTERVAL_MS,
  debounceMs = CHANGE_DEBOUNCE_MS,
  startImmediately = true,
  log = () => {},
  schedule = setTimeout,
  clear = clearTimeout,
}) {
  let stopped = false;
  let running = false;
  let rerun = false;
  let intervalTimer = null;
  let debounceTimer = null;

  const arm = () => {
    intervalTimer = schedule(() => {
      void runSafe().finally(() => {
        if (!stopped) arm();
      });
    }, intervalMs);
    intervalTimer.unref?.();
  };

  async function runSafe() {
    if (stopped) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      await run();
    } catch (err) {
      try {
        log(`SaaS Neon backup failed: ${safeError(err)}`, "warn");
      } catch {
        // Logging must not surface a backup failure on the checkout path.
      }
    } finally {
      running = false;
      if (!stopped && rerun) {
        rerun = false;
        await runSafe();
      }
    }
  }

  const kick = () => {
    if (stopped) return;
    if (debounceTimer) clear(debounceTimer);
    if (debounceMs <= 0) {
      void runSafe();
      return;
    }
    debounceTimer = schedule(() => {
      debounceTimer = null;
      void runSafe();
    }, debounceMs);
    debounceTimer.unref?.();
  };

  const started = startImmediately
    ? runSafe().finally(() => {
        if (!stopped) arm();
      })
    : Promise.resolve().then(() => {
        if (!stopped) arm();
      });

  return {
    enabled: true,
    started,
    kick,
    runOnce: runSafe,
    stop() {
      stopped = true;
      if (intervalTimer) clear(intervalTimer);
      if (debounceTimer) clear(debounceTimer);
      intervalTimer = null;
      debounceTimer = null;
    },
  };
}

export function watchUserRecords(store, onChange) {
  for (const name of USER_RECORD_METHODS) {
    const original = store[name];
    if (typeof original !== "function") continue;
    store[name] = function watched(...args) {
      const result = original.apply(this, args);
      try {
        onChange(name);
      } catch {
        // A backup hook must not break checkout or provisioning.
      }
      return result;
    };
  }
  return store;
}

export async function attachSaasBackup({
  store,
  databaseUrl,
  log = defaultLog,
  intervalMs,
  debounceMs,
  createPool,
  startImmediately = true,
} = {}) {
  const writeLog = typeof log === "function" ? log : defaultLog;
  const url = String(databaseUrl || "").trim();
  if (!url) {
    writeLog("TENANT_DATABASE_URL / DATABASE_URL unset — SaaS Neon backup off", "warn");
    return disabledBackup();
  }
  let pool;
  try {
    pool = createPool ? await createPool(url) : await defaultPool(url);
    if (typeof pool?.query !== "function") throw new Error("Neon pool has no query method");
    await pool.query("SELECT 1");
  } catch (err) {
    writeLog(`SaaS Neon backup unavailable — local control store remains live: ${safeError(err)}`, "warn");
    await closePool(pool);
    return disabledBackup();
  }
  const controller = createBackupController({
    intervalMs: intervalMs ?? backupIntervalMs(),
    debounceMs,
    startImmediately,
    log: writeLog,
    run: () => backupSaasUsers({ store, pool, log: writeLog }),
  });
  const stopController = controller.stop;
  controller.stop = () => {
    stopController();
    return closePool(pool);
  };
  return controller;
}
