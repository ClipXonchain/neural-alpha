import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const COLUMNS = [
  "id",
  "host_id",
  "status",
  "container_name",
  "data_dir",
  "risk_preset",
  "agent_mode",
  "max_position_usd",
  "max_drawdown_pct",
  "max_trade_usd",
  "trade_interval_ms",
  "wallet_address",
  "access_token_hash",
  "agent_api_secret",
  "payment_asset",
  "payment_tx",
  "agent_name",
  "paid_until",
  "order_id",
  "paid_amount",
  "overpaid_amount",
  "buys_halted",
  "created_at",
  "updated_at",
];

const ORDER_COLUMNS = [
  "id",
  "host_id",
  "status",
  "asset",
  "risk_preset",
  "agent_name",
  "tenant_id",
  "treasury_address",
  "token_contract",
  "price_usd",
  "amount_display",
  "amount_wei",
  "tail",
  "payment_tx",
  "paid_amount_wei",
  "overpaid_wei",
  "payer_address",
  "confirmations",
  "claim_secret_hash",
  "pending_access_token",
  "expires_at",
  "created_at",
  "updated_at",
];

export function openStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      status TEXT NOT NULL,
      container_name TEXT NOT NULL UNIQUE,
      data_dir TEXT NOT NULL UNIQUE,
      risk_preset TEXT NOT NULL,
      agent_mode TEXT NOT NULL,
      max_position_usd REAL NOT NULL,
      max_drawdown_pct REAL NOT NULL,
      max_trade_usd REAL NOT NULL,
      trade_interval_ms INTEGER NOT NULL,
      wallet_address TEXT,
      access_token_hash TEXT,
      agent_api_secret TEXT,
      payment_asset TEXT,
      payment_tx TEXT,
      agent_name TEXT,
      paid_until TEXT,
      order_id TEXT,
      paid_amount TEXT,
      overpaid_amount TEXT,
      buys_halted INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  for (const [name, ddl] of [
    ["access_token_hash", "TEXT"],
    ["agent_api_secret", "TEXT"],
    ["payment_asset", "TEXT"],
    ["payment_tx", "TEXT"],
    ["agent_name", "TEXT"],
    ["paid_until", "TEXT"],
    ["order_id", "TEXT"],
    ["paid_amount", "TEXT"],
    ["overpaid_amount", "TEXT"],
    ["buys_halted", "INTEGER DEFAULT 0"],
  ]) {
    const cols = db.prepare("PRAGMA table_info(tenants)").all();
    if (!cols.some((col) => col.name === name)) db.exec(`ALTER TABLE tenants ADD COLUMN ${name} ${ddl}`);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tenants_payment_tx ON tenants(payment_tx) WHERE payment_tx IS NOT NULL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tenants_access_hash ON tenants(access_token_hash) WHERE access_token_hash IS NOT NULL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      status TEXT NOT NULL,
      asset TEXT NOT NULL,
      risk_preset TEXT NOT NULL,
      agent_name TEXT,
      tenant_id TEXT,
      treasury_address TEXT NOT NULL,
      token_contract TEXT NOT NULL,
      price_usd REAL NOT NULL,
      amount_display TEXT NOT NULL,
      amount_wei TEXT NOT NULL,
      tail INTEGER NOT NULL,
      payment_tx TEXT,
      paid_amount_wei TEXT,
      overpaid_wei TEXT,
      payer_address TEXT,
      confirmations INTEGER,
      claim_secret_hash TEXT,
      pending_access_token TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_tx ON orders(payment_tx) WHERE payment_tx IS NOT NULL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS cluster_nodes (
      host_id TEXT PRIMARY KEY,
      base_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS watcher_state (
      host_id TEXT PRIMARY KEY,
      last_scanned_block TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  return {
    list() {
      return db.prepare(`SELECT ${COLUMNS.join(", ")} FROM tenants ORDER BY created_at`).all();
    },
    get(id) {
      return db.prepare(`SELECT ${COLUMNS.join(", ")} FROM tenants WHERE id = ?`).get(id) ?? null;
    },
    findByAccessHash(hash) {
      return db.prepare(`SELECT ${COLUMNS.join(", ")} FROM tenants WHERE access_token_hash = ?`).get(hash) ?? null;
    },
    findByPaymentTx(tx) {
      const tenantHit = db.prepare(`SELECT id FROM tenants WHERE payment_tx = ?`).get(tx) ?? null;
      if (tenantHit) return tenantHit;
      return db.prepare(`SELECT id FROM orders WHERE payment_tx = ? AND status = 'paid'`).get(tx) ?? null;
    },
    insert(row) {
      const keys = COLUMNS;
      db.prepare(`INSERT INTO tenants (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(
        ...keys.map((key) => row[key] ?? null),
      );
      return this.get(row.id);
    },
    update(id, patch) {
      const allowed = [
        "status",
        "risk_preset",
        "agent_mode",
        "max_position_usd",
        "max_drawdown_pct",
        "max_trade_usd",
        "trade_interval_ms",
        "wallet_address",
        "agent_name",
        "access_token_hash",
        "payment_asset",
        "payment_tx",
        "paid_until",
        "order_id",
        "paid_amount",
        "overpaid_amount",
        "buys_halted",
        "host_id",
        "updated_at",
      ];
      const keys = allowed.filter((key) => patch[key] !== undefined);
      if (keys.length === 0) return this.get(id);
      db.prepare(`UPDATE tenants SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`).run(
        ...keys.map((key) => patch[key]),
        id,
      );
      return this.get(id);
    },
    listOrders() {
      return db.prepare(`SELECT ${ORDER_COLUMNS.join(", ")} FROM orders ORDER BY created_at DESC`).all();
    },
    getOrder(id) {
      return db.prepare(`SELECT ${ORDER_COLUMNS.join(", ")} FROM orders WHERE id = ?`).get(id) ?? null;
    },
    insertOrder(row) {
      const keys = ORDER_COLUMNS;
      db.prepare(`INSERT INTO orders (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(
        ...keys.map((key) => row[key] ?? null),
      );
      return this.getOrder(row.id);
    },
    updateOrder(id, patch) {
      const allowed = [
        "status",
        "tenant_id",
        "payment_tx",
        "paid_amount_wei",
        "overpaid_wei",
        "payer_address",
        "confirmations",
        "pending_access_token",
        "updated_at",
      ];
      const keys = allowed.filter((key) => patch[key] !== undefined);
      if (keys.length === 0) return this.getOrder(id);
      db.prepare(`UPDATE orders SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`).run(
        ...keys.map((key) => patch[key]),
        id,
      );
      return this.getOrder(id);
    },
    listNodes() {
      return db.prepare(`SELECT host_id, base_url, status, updated_at FROM cluster_nodes ORDER BY host_id`).all();
    },
    upsertNode({ hostId, baseUrl, status = "active", updatedAt }) {
      db.prepare(`
        INSERT INTO cluster_nodes (host_id, base_url, status, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(host_id) DO UPDATE SET
          base_url = excluded.base_url,
          status = excluded.status,
          updated_at = excluded.updated_at
      `).run(hostId, baseUrl, status, updatedAt);
      return db.prepare(`SELECT host_id, base_url, status, updated_at FROM cluster_nodes WHERE host_id = ?`).get(hostId);
    },
    removeNode(hostId) {
      return db.prepare(`DELETE FROM cluster_nodes WHERE host_id = ?`).run(hostId).changes;
    },
    getWatcherCursor(hostId) {
      return db.prepare("SELECT last_scanned_block FROM watcher_state WHERE host_id = ?").get(hostId)?.last_scanned_block ?? null;
    },
    setWatcherCursor(hostId, blockNumber, updatedAt = new Date().toISOString()) {
      db.prepare(`
        INSERT INTO watcher_state (host_id, last_scanned_block, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(host_id) DO UPDATE SET
          last_scanned_block = excluded.last_scanned_block,
          updated_at = excluded.updated_at
      `).run(hostId, String(blockNumber), updatedAt);
    },
    adoptHost(hostId, updatedAt) {
      const result = db.prepare(`UPDATE tenants SET host_id = ?, updated_at = ?`).run(hostId, updatedAt);
      db.prepare(`UPDATE orders SET host_id = ?, updated_at = ?`).run(hostId, updatedAt);
      return result.changes;
    },
    close() {
      db.close();
    },
  };
}
