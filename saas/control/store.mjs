import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const COLUMNS = [
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
  "access_code_hash",
  "agent_api_secret",
  "payment_asset",
  "payment_tx",
  "agent_name",
  "paid_until",
  "order_id",
  "paid_amount",
  "overpaid_amount",
  "buys_halted",
  "x402_per_day",
  "cmc_x402",
  "studio_x402",
  "telegram_chat_id",
  "telegram_code_hash",
  "telegram_code_expires",
  "cancel_at_period_end",
  "reminder_stage",
  "alerts_json",
  "image_tag",
  "created_at",
  "updated_at",
];

export const ORDER_COLUMNS = [
  "id",
  "host_id",
  "status",
  "asset",
  "risk_preset",
  "position_usd",
  "x402_per_day",
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
  "pending_access_code",
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
    ["access_code_hash", "TEXT"],
    ["agent_api_secret", "TEXT"],
    ["payment_asset", "TEXT"],
    ["payment_tx", "TEXT"],
    ["agent_name", "TEXT"],
    ["paid_until", "TEXT"],
    ["order_id", "TEXT"],
    ["paid_amount", "TEXT"],
    ["overpaid_amount", "TEXT"],
    ["buys_halted", "INTEGER DEFAULT 0"],
    ["x402_per_day", "INTEGER"],
    // Paid signal sources the customer can switch off; null or 1 means on.
    ["cmc_x402", "INTEGER DEFAULT 1"],
    ["studio_x402", "INTEGER DEFAULT 1"],
    ["telegram_chat_id", "TEXT"],
    ["telegram_code_hash", "TEXT"],
    ["telegram_code_expires", "TEXT"],
    ["cancel_at_period_end", "INTEGER DEFAULT 0"],
    ["reminder_stage", "TEXT"],
    ["alerts_json", "TEXT"],
    ["image_tag", "TEXT"],
  ]) {
    const cols = db.prepare("PRAGMA table_info(tenants)").all();
    if (!cols.some((col) => col.name === name)) db.exec(`ALTER TABLE tenants ADD COLUMN ${name} ${ddl}`);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tenants_payment_tx ON tenants(payment_tx) WHERE payment_tx IS NOT NULL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tenants_access_hash ON tenants(access_token_hash) WHERE access_token_hash IS NOT NULL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tenants_access_code ON tenants(access_code_hash) WHERE access_code_hash IS NOT NULL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tenants_telegram_code ON tenants(telegram_code_hash) WHERE telegram_code_hash IS NOT NULL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tenants_telegram_chat ON tenants(telegram_chat_id) WHERE telegram_chat_id IS NOT NULL");

  // Signed-in browsers (a hash each, never the token) and the wallets allowed to sign in.
  // The wallet is only an identity: it cannot move funds or trade.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS sessions_tenant ON sessions(tenant_id)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_wallets (
      tenant_id TEXT NOT NULL,
      address TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, address)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS tenant_wallets_address ON tenant_wallets(address)");

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
      pending_access_code TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  {
    const orderCols = db.prepare("PRAGMA table_info(orders)").all();
    if (!orderCols.some((col) => col.name === "pending_access_code")) {
      db.exec("ALTER TABLE orders ADD COLUMN pending_access_code TEXT");
    }
    if (!orderCols.some((col) => col.name === "position_usd")) {
      db.exec("ALTER TABLE orders ADD COLUMN position_usd REAL");
    }
    if (!orderCols.some((col) => col.name === "x402_per_day")) {
      db.exec("ALTER TABLE orders ADD COLUMN x402_per_day INTEGER");
    }
  }
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
    findByAccessCodeHash(hash) {
      return db.prepare(`SELECT ${COLUMNS.join(", ")} FROM tenants WHERE access_code_hash = ?`).get(hash) ?? null;
    },
    findByTelegramCodeHash(hash) {
      return db.prepare(`SELECT ${COLUMNS.join(", ")} FROM tenants WHERE telegram_code_hash = ?`).get(hash) ?? null;
    },
    findByTelegramChat(chatId) {
      return db.prepare(`SELECT ${COLUMNS.join(", ")} FROM tenants WHERE telegram_chat_id = ?`).get(String(chatId)) ?? null;
    },
    findBySessionHash(hash) {
      return (
        db
          .prepare(`SELECT ${COLUMNS.map((c) => `t.${c}`).join(", ")} FROM sessions s JOIN tenants t ON t.id = s.tenant_id WHERE s.token_hash = ?`)
          .get(hash) ?? null
      );
    },
    /**
     * Records a signed-in browser. A tenant keeps at most `cap` of them, counting the
     * original purchase token as the oldest; the oldest is dropped to make room.
     */
    addSession(tenantId, hash, stamp, cap = 3) {
      const legacy = Boolean(this.get(tenantId)?.access_token_hash);
      const rows = db.prepare("SELECT token_hash FROM sessions WHERE tenant_id = ? ORDER BY created_at, rowid").all(tenantId);
      let total = rows.length + (legacy ? 1 : 0);
      let usedLegacy = legacy;
      let next = 0;
      while (total >= cap && total > 0) {
        if (usedLegacy) {
          db.prepare("UPDATE tenants SET access_token_hash = NULL WHERE id = ?").run(tenantId);
          usedLegacy = false;
        } else {
          db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(rows[next++].token_hash);
        }
        total -= 1;
      }
      db.prepare("INSERT OR REPLACE INTO sessions (token_hash, tenant_id, created_at) VALUES (?, ?, ?)").run(hash, tenantId, stamp);
    },
    sessionCount(tenantId) {
      const n = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE tenant_id = ?").get(tenantId).n;
      return n + (this.get(tenantId)?.access_token_hash ? 1 : 0);
    },
    /** Signs out every browser except the one whose token hash is `keepHash`. */
    revokeSessionsExcept(tenantId, keepHash) {
      db.prepare("DELETE FROM sessions WHERE tenant_id = ? AND token_hash != ?").run(tenantId, keepHash);
      const legacy = this.get(tenantId)?.access_token_hash;
      if (legacy && legacy !== keepHash) db.prepare("UPDATE tenants SET access_token_hash = NULL WHERE id = ?").run(tenantId);
    },
    listWallets(tenantId) {
      return db.prepare("SELECT address FROM tenant_wallets WHERE tenant_id = ? ORDER BY created_at, rowid").all(tenantId).map((r) => r.address);
    },
    addWallet(tenantId, address, stamp, cap = 3) {
      const have = this.listWallets(tenantId);
      if (have.includes(address)) return have;
      if (have.length >= cap) throw Object.assign(new Error(`an agent can have at most ${cap} login wallets`), { status: 409 });
      db.prepare("INSERT INTO tenant_wallets (tenant_id, address, created_at) VALUES (?, ?, ?)").run(tenantId, address, stamp);
      return [...have, address];
    },
    removeWallet(tenantId, address) {
      return db.prepare("DELETE FROM tenant_wallets WHERE tenant_id = ? AND address = ?").run(tenantId, address).changes > 0;
    },
    tenantIdsByWallet(address) {
      return db.prepare("SELECT DISTINCT tenant_id FROM tenant_wallets WHERE address = ?").all(address).map((r) => r.tenant_id);
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
        "access_code_hash",
        "payment_asset",
        "payment_tx",
        "paid_until",
        "order_id",
        "paid_amount",
        "overpaid_amount",
        "buys_halted",
        "x402_per_day",
        "cmc_x402",
        "studio_x402",
        "telegram_chat_id",
        "telegram_code_hash",
        "telegram_code_expires",
        "cancel_at_period_end",
        "reminder_stage",
        "alerts_json",
        "image_tag",
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
        "pending_access_code",
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
    replacePendingQuote(id, expectedDisplay, patch) {
      const allowed = ["amount_display", "amount_wei", "tail", "price_usd", "expires_at", "updated_at"];
      const keys = allowed.filter((key) => patch[key] !== undefined);
      if (keys.length === 0) return null;
      const result = db.prepare(
        `UPDATE orders SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ? AND status = 'pending' AND amount_display = ?`,
      ).run(...keys.map((key) => patch[key]), id, expectedDisplay);
      return result.changes === 1 ? this.getOrder(id) : null;
    },
    /** A consistent copy of the whole control database, safe to take while it is in use. */
    snapshot(file) {
      db.prepare("VACUUM INTO ?").run(file);
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
