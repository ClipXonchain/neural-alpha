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
      created_at TEXT NOT NULL,
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
    insert(row) {
      const keys = COLUMNS.filter((key) => key !== "wallet_address");
      db.prepare(
        `INSERT INTO tenants (${keys.join(", ")}, wallet_address) VALUES (${keys.map(() => "?").join(", ")}, ?)`,
      ).run(...keys.map((key) => row[key]), row.wallet_address ?? null);
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
    adoptHost(hostId, updatedAt) {
      const result = db.prepare(`UPDATE tenants SET host_id = ?, updated_at = ?`).run(hostId, updatedAt);
      return result.changes;
    },
    close() {
      db.close();
    },
  };
}
