import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Pool } from "@neondatabase/serverless";
import { logger } from "../utils/logger.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CAMPAIGN_STATE_FILE = join(PKG_ROOT, "data/campaign-state.json");
const BATCH = 200;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_CATCHUP_MS = 15_000;

type Sql = SQLInputValue;

function all<T>(db: DatabaseSync, sql: string, ...params: Sql[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function get<T>(db: DatabaseSync, sql: string, ...params: Sql[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

function cursor(db: DatabaseSync, name: string): string | null {
  return get<{ value: string }>(db, `SELECT value FROM backup_cursor WHERE name = ?`, name)?.value ?? null;
}

function setCursor(db: DatabaseSync, name: string, value: string) {
  db.prepare(
    `INSERT INTO backup_cursor (name, value) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value`
  ).run(name, value);
}

export function backupIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const n = parseInt(env.NEON_BACKUP_INTERVAL_MS || "", 10);
  return Number.isFinite(n) && n >= 60_000 ? n : DEFAULT_INTERVAL_MS;
}

function iso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  return text.length > 0 ? text : null;
}

function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

/** Copy Neon into an empty SQLite file once, so an existing deployment keeps its history. */
export async function importNeonIntoSqliteIfEmpty(db: DatabaseSync, pool: Pool): Promise<boolean> {
  if (cursor(db, "neon_import_complete") === "1") return false;
  const counts = get<{ trades: number; navs: number; syncs: number; state: number }>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM trades) AS trades,
       (SELECT COUNT(*) FROM nav_snapshots) AS navs,
       (SELECT COUNT(*) FROM chain_syncs) AS syncs,
       (SELECT COUNT(*) FROM agent_state) AS state`
  );
  if ((counts?.trades ?? 0) + (counts?.navs ?? 0) + (counts?.syncs ?? 0) + (counts?.state ?? 0) > 0) {
    setCursor(db, "neon_import_complete", "1");
    return false;
  }

  const trades = await pool.query(`
    SELECT order_id, symbol, side, amount_usd, from_token, to_token, from_amount, to_amount,
           price_usd, tx_hash, status, error_message, twak_response, realized_pnl,
           created_at, confirmed_at, wallet_address
    FROM trades
    ORDER BY id
  `);
  const navs = await pool.query(`
    SELECT id, cycle_id, timestamp, cash_usd, gas_usd, positions_json, total_nav_usd,
           peak_nav_usd, drawdown_pct, total_pnl_usd, total_pnl_pct, mode,
           realized_pnl, daily_pnl, positions_count, total_trades, today_trades,
           win_rate, fear_greed, emergency_mode
    FROM nav_snapshots
    ORDER BY id
  `);
  const syncs = await pool.query(`
    SELECT id, timestamp, holdings_json, usdt_balance, positions_added, positions_removed,
           gas_symbol, gas_amount, gas_usd
    FROM chain_syncs
    ORDER BY id
  `);
  const state = await pool.query(`SELECT key, value_json, updated_at FROM agent_state`);

  const insertTrade = db.prepare(`
    INSERT INTO trades (
      order_id, symbol, side, amount_usd, from_token, to_token, from_amount, to_amount,
      price_usd, tx_hash, status, error_message, twak_response, realized_pnl,
      created_at, confirmed_at, wallet_address, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(order_id) DO NOTHING
  `);
  const insertNav = db.prepare(`
    INSERT INTO nav_snapshots (
      id, cycle_id, timestamp, cash_usd, gas_usd, positions_json, total_nav_usd,
      peak_nav_usd, drawdown_pct, total_pnl_usd, total_pnl_pct, mode,
      realized_pnl, daily_pnl, positions_count, total_trades, today_trades,
      win_rate, fear_greed, emergency_mode
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO NOTHING
  `);
  const insertSync = db.prepare(`
    INSERT INTO chain_syncs (
      id, timestamp, holdings_json, usdt_balance, positions_added, positions_removed,
      gas_symbol, gas_amount, gas_usd
    ) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO NOTHING
  `);
  const insertState = db.prepare(`
    INSERT INTO agent_state (key, value_json, updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `);

  db.exec("BEGIN");
  try {
    for (const row of trades.rows as Record<string, unknown>[]) {
      insertTrade.run(
        String(row.order_id),
        String(row.symbol),
        String(row.side),
        Number(row.amount_usd),
        String(row.from_token),
        String(row.to_token),
        row.from_amount == null ? null : String(row.from_amount),
        row.to_amount == null ? null : String(row.to_amount),
        row.price_usd == null ? null : Number(row.price_usd),
        row.tx_hash == null ? null : String(row.tx_hash),
        String(row.status),
        row.error_message == null ? null : String(row.error_message),
        row.twak_response == null ? null : jsonText(row.twak_response),
        row.realized_pnl == null ? null : Number(row.realized_pnl),
        iso(row.created_at) ?? new Date().toISOString(),
        iso(row.confirmed_at),
        row.wallet_address == null ? null : String(row.wallet_address),
        iso(row.confirmed_at) ?? iso(row.created_at) ?? new Date().toISOString()
      );
    }
    for (const row of navs.rows as Record<string, unknown>[]) {
      insertNav.run(
        Number(row.id),
        row.cycle_id == null ? null : Number(row.cycle_id),
        iso(row.timestamp) ?? new Date().toISOString(),
        Number(row.cash_usd),
        Number(row.gas_usd ?? 0),
        jsonText(row.positions_json ?? []),
        Number(row.total_nav_usd),
        Number(row.peak_nav_usd),
        Number(row.drawdown_pct),
        row.total_pnl_usd == null ? null : Number(row.total_pnl_usd),
        row.total_pnl_pct == null ? null : Number(row.total_pnl_pct),
        String(row.mode ?? "live"),
        row.realized_pnl == null ? null : Number(row.realized_pnl),
        row.daily_pnl == null ? null : Number(row.daily_pnl),
        row.positions_count == null ? null : Number(row.positions_count),
        row.total_trades == null ? null : Number(row.total_trades),
        row.today_trades == null ? null : Number(row.today_trades),
        row.win_rate == null ? null : Number(row.win_rate),
        row.fear_greed == null ? null : Number(row.fear_greed),
        row.emergency_mode == null ? null : row.emergency_mode ? 1 : 0
      );
    }
    for (const row of syncs.rows as Record<string, unknown>[]) {
      insertSync.run(
        Number(row.id),
        iso(row.timestamp) ?? new Date().toISOString(),
        jsonText(row.holdings_json ?? {}),
        Number(row.usdt_balance),
        jsonText(row.positions_added ?? []),
        jsonText(row.positions_removed ?? []),
        row.gas_symbol == null ? null : String(row.gas_symbol),
        row.gas_amount == null ? null : Number(row.gas_amount),
        row.gas_usd == null ? null : Number(row.gas_usd)
      );
    }
    for (const row of state.rows as Record<string, unknown>[]) {
      insertState.run(
        String(row.key),
        jsonText(row.value_json),
        iso(row.updated_at) ?? new Date().toISOString()
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  await pool.query(`UPDATE nav_snapshots SET local_id = id WHERE local_id IS NULL`);
  await pool.query(`UPDATE chain_syncs SET local_id = id WHERE local_id IS NULL`);

  const tradeTail = get<{ updated_at: string; id: number }>(
    db,
    `SELECT updated_at, id FROM trades ORDER BY updated_at DESC, id DESC LIMIT 1`
  );
  const navTail = get<{ id: number }>(db, `SELECT MAX(id) AS id FROM nav_snapshots`);
  const syncTail = get<{ id: number }>(db, `SELECT MAX(id) AS id FROM chain_syncs`);
  if (tradeTail) setCursor(db, "trades", JSON.stringify({ updatedAt: tradeTail.updated_at, id: tradeTail.id }));
  setCursor(db, "nav_snapshots", String(navTail?.id ?? 0));
  setCursor(db, "chain_syncs", String(syncTail?.id ?? 0));
  setCursor(db, "neon_import_complete", "1");
  setCursor(db, "last_backup_finished_at", String(Date.now()));

  logger.info("Imported Neon history into SQLite", {
    trades: trades.rows.length,
    navSnapshots: navs.rows.length,
    chainSyncs: syncs.rows.length,
    stateKeys: state.rows.length,
  });
  return true;
}

function mirrorCampaignFile(db: DatabaseSync) {
  if (!existsSync(CAMPAIGN_STATE_FILE)) return;
  try {
    const raw = readFileSync(CAMPAIGN_STATE_FILE, "utf8");
    JSON.parse(raw);
    db.prepare(
      `INSERT INTO agent_state (key, value_json, updated_at)
       VALUES ('campaign_state', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).run(raw);
  } catch (err) {
    logger.warn("Skipped campaign-state.json during Neon backup", { error: String(err) });
  }
}

async function pushTrades(db: DatabaseSync, pool: Pool): Promise<number> {
  const saved = cursor(db, "trades");
  const mark = saved ? (JSON.parse(saved) as { updatedAt: string; id: number }) : { updatedAt: "", id: 0 };
  let pushed = 0;
  for (;;) {
    const rows = all<Record<string, unknown>>(
      db,
      `SELECT * FROM trades
       WHERE updated_at > ? OR (updated_at = ? AND id > ?)
       ORDER BY updated_at, id
       LIMIT ?`,
      mark.updatedAt,
      mark.updatedAt,
      mark.id,
      BATCH
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      await pool.query(
        `INSERT INTO trades (
          order_id, symbol, side, amount_usd,
          from_token, to_token, from_amount, to_amount,
          price_usd, tx_hash, status, error_message,
          twak_response, realized_pnl, created_at, confirmed_at, wallet_address
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17)
        ON CONFLICT (order_id) DO UPDATE SET
          to_amount = EXCLUDED.to_amount,
          price_usd = EXCLUDED.price_usd,
          tx_hash = EXCLUDED.tx_hash,
          status = EXCLUDED.status,
          error_message = EXCLUDED.error_message,
          twak_response = EXCLUDED.twak_response,
          realized_pnl = EXCLUDED.realized_pnl,
          confirmed_at = EXCLUDED.confirmed_at,
          wallet_address = COALESCE(EXCLUDED.wallet_address, trades.wallet_address)`,
        [
          row.order_id,
          row.symbol,
          row.side,
          row.amount_usd,
          row.from_token,
          row.to_token,
          row.from_amount,
          row.to_amount,
          row.price_usd,
          row.tx_hash,
          row.status,
          row.error_message,
          row.twak_response,
          row.realized_pnl,
          row.created_at,
          row.confirmed_at,
          row.wallet_address,
        ]
      );
      mark.updatedAt = String(row.updated_at);
      mark.id = Number(row.id);
      pushed++;
    }
    setCursor(db, "trades", JSON.stringify(mark));
    if (rows.length < BATCH) break;
  }
  return pushed;
}

async function pushNav(db: DatabaseSync, pool: Pool): Promise<number> {
  let after = Number(cursor(db, "nav_snapshots") || "0");
  let pushed = 0;
  for (;;) {
    const rows = all<Record<string, unknown>>(
      db,
      `SELECT * FROM nav_snapshots WHERE id > ? ORDER BY id LIMIT ?`,
      after,
      BATCH
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      await pool.query(
        `INSERT INTO nav_snapshots (
          local_id, cycle_id, timestamp, cash_usd, gas_usd, positions_json,
          total_nav_usd, peak_nav_usd, drawdown_pct, total_pnl_usd, total_pnl_pct, mode,
          realized_pnl, daily_pnl, positions_count, total_trades, today_trades,
          win_rate, fear_greed, emergency_mode
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        ON CONFLICT (local_id) DO NOTHING`,
        [
          row.id,
          row.cycle_id,
          row.timestamp,
          row.cash_usd,
          row.gas_usd,
          row.positions_json,
          row.total_nav_usd,
          row.peak_nav_usd,
          row.drawdown_pct,
          row.total_pnl_usd,
          row.total_pnl_pct,
          row.mode,
          row.realized_pnl,
          row.daily_pnl,
          row.positions_count,
          row.total_trades,
          row.today_trades,
          row.win_rate,
          row.fear_greed,
          row.emergency_mode == null ? null : Number(row.emergency_mode) === 1,
        ]
      );
      after = Number(row.id);
      pushed++;
    }
    setCursor(db, "nav_snapshots", String(after));
    if (rows.length < BATCH) break;
  }
  return pushed;
}

async function pushChainSyncs(db: DatabaseSync, pool: Pool): Promise<number> {
  let after = Number(cursor(db, "chain_syncs") || "0");
  let pushed = 0;
  for (;;) {
    const rows = all<Record<string, unknown>>(
      db,
      `SELECT * FROM chain_syncs WHERE id > ? ORDER BY id LIMIT ?`,
      after,
      BATCH
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      await pool.query(
        `INSERT INTO chain_syncs (
          local_id, timestamp, holdings_json, usdt_balance,
          positions_added, positions_removed, gas_symbol, gas_amount, gas_usd
        ) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (local_id) DO NOTHING`,
        [
          row.id,
          row.timestamp,
          row.holdings_json,
          row.usdt_balance,
          parseJson<string[]>(row.positions_added, []),
          parseJson<string[]>(row.positions_removed, []),
          row.gas_symbol,
          row.gas_amount,
          row.gas_usd,
        ]
      );
      after = Number(row.id);
      pushed++;
    }
    setCursor(db, "chain_syncs", String(after));
    if (rows.length < BATCH) break;
  }
  return pushed;
}

async function pushAgentState(db: DatabaseSync, pool: Pool): Promise<number> {
  const rows = all<{ key: string; value_json: string; updated_at: string }>(
    db,
    `SELECT key, value_json, updated_at FROM agent_state`
  );
  for (const row of rows) {
    await pool.query(
      `INSERT INTO agent_state (key, value_json, updated_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = EXCLUDED.updated_at`,
      [row.key, row.value_json, row.updated_at]
    );
  }
  return rows.length;
}

export async function backupSqliteToNeon(db: DatabaseSync, pool: Pool): Promise<void> {
  mirrorCampaignFile(db);
  const trades = await pushTrades(db, pool);
  const navSnapshots = await pushNav(db, pool);
  const chainSyncs = await pushChainSyncs(db, pool);
  const stateKeys = await pushAgentState(db, pool);
  setCursor(db, "last_backup_finished_at", String(Date.now()));
  logger.info("SQLite backed up to Neon", { trades, navSnapshots, chainSyncs, stateKeys });
}

export function scheduleNeonBackup(db: DatabaseSync, pool: Pool): () => void {
  const interval = backupIntervalMs();
  const last = Number(cursor(db, "last_backup_finished_at") || "0");
  const initialDelay = last > 0
    ? Math.max(5_000, interval - (Date.now() - last))
    : FIRST_CATCHUP_MS;

  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const arm = (delay: number) => {
    timer = setTimeout(() => {
      void tick();
    }, delay);
    timer.unref?.();
  };

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await backupSqliteToNeon(db, pool);
    } catch (err) {
      logger.warn("SQLite → Neon backup failed", { error: String(err) });
    } finally {
      running = false;
      if (!stopped) arm(interval);
    }
  };

  arm(initialDelay);
  logger.info("Neon backup scheduled", {
    intervalMs: interval,
    firstRunInMs: initialDelay,
  });

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export function neonSchemaSql(): string {
  return readFileSync(resolve(import.meta.dirname, "schema.sql"), "utf8");
}
