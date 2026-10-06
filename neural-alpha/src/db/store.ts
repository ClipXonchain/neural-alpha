import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Pool } from "@neondatabase/serverless";
import type { PortfolioSnapshot, TradeOrder, TradeResult } from "../utils/types.js";
import { isPaperTxHash } from "../execution/executor.js";
import { logger } from "../utils/logger.js";
import {
  classifyAssetTrade,
  dedupeAndCleanTradeResults,
} from "../utils/trade-dedupe.js";
import {
  backupIntervalMs,
  importNeonIntoSqliteIfEmpty,
  neonSchemaSql,
  scheduleNeonBackup,
} from "./neon-backup.js";

export interface ChainSyncRecord {
  holdings: Record<string, number>;
  usdtBalance: number;
  positionsAdded: string[];
  positionsRemoved: string[];
  gas?: { symbol: string; amount: number; valueUsd: number };
}

export interface NavPeakState {
  peakNavUsd: number;
  initialNavUsd: number;
  baselineInitialized: boolean;
  dayStartNavUsd?: number;
  dayStartUtcDate?: string;
}

/** Persisted cost basis per open symbol — survives agent restarts. */
export interface PositionEntryRecord {
  avgEntryPrice: number;
  peakPnlPct?: number;
}

export type PositionEntriesState = Record<string, PositionEntryRecord>;

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function positionEntriesFile(sqlitePath: string): string {
  return join(dirname(sqlitePath), "position-entries.json");
}

type Sql = SQLInputValue;

function all<T>(db: DatabaseSync, sql: string, ...params: Sql[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function get<T>(db: DatabaseSync, sql: string, ...params: Sql[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function resolveSqlitePath(explicit?: string): string {
  const raw = explicit?.trim() || process.env.SQLITE_PATH?.trim();
  if (raw) return resolve(raw);
  return join(PKG_ROOT, "data/neural-alpha.sqlite");
}

function readLocalPositionEntries(file: string): PositionEntriesState | null {
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, "utf8")) as PositionEntriesState;
    if (!raw || typeof raw !== "object") return null;
    return raw;
  } catch (err) {
    logger.warn("Could not read position-entries.json", { error: String(err), file });
    return null;
  }
}

function writeLocalPositionEntries(file: string, entries: PositionEntriesState) {
  try {
    if (Object.keys(entries).length === 0) {
      const existing = readLocalPositionEntries(file);
      if (existing && Object.keys(existing).length > 0) return;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(entries, null, 2));
  } catch (err) {
    logger.warn("Could not write position-entries.json", { error: String(err), file });
  }
}

export interface CycleStats {
  realizedPnl: number;
  dailyPnl: number;
  positionsCount: number;
  totalTrades: number;
  todayTrades: number;
  winRate: number;
  fearGreed: number | null;
  emergencyMode: boolean;
}

function tradeStatus(result: TradeResult, mode: string): string {
  if (!result.success) return "failed";
  if (mode === "paper" || isPaperTxHash(result.txHash)) return "paper";
  return "confirmed";
}

type TradeRow = {
  order_id: string;
  from_token: string;
  to_token: string;
  from_amount: string | null;
  to_amount: string | null;
  price_usd: number | null;
  tx_hash: string | null;
  realized_pnl: number | null;
  confirmed_at: string | null;
  created_at: string;
};

function mapTradeRows(rows: TradeRow[]): TradeResult[] {
  return dedupeAndCleanTradeResults(
    rows.map((r) => ({
      orderId: r.order_id,
      success: true,
      fromToken: r.from_token,
      toToken: r.to_token,
      fromAmount: String(r.from_amount ?? "0"),
      toAmount: r.to_amount ? String(r.to_amount) : undefined,
      priceAtExecution: Number(r.price_usd ?? 0),
      txHash: r.tx_hash ?? undefined,
      timestamp: new Date(r.confirmed_at ?? r.created_at).getTime(),
      ...(r.realized_pnl != null ? { realizedPnl: r.realized_pnl } : {}),
    }))
  );
}

const ON_CHAIN_TX = /^0x[a-fA-F0-9]{64}$/;

function deleteOtherRowsForTxHash(
  db: DatabaseSync,
  txHash: string | undefined,
  keepOrderId: string,
  side?: string
): void {
  if (!txHash || !ON_CHAIN_TX.test(txHash)) return;
  if (side === "buy" || side === "sell") {
    db.prepare(
      `DELETE FROM trades
       WHERE LOWER(tx_hash) = LOWER(?)
         AND order_id <> ?
         AND side = ?`
    ).run(txHash, keepOrderId, side);
    return;
  }
  db.prepare(
    `DELETE FROM trades
     WHERE LOWER(tx_hash) = LOWER(?)
       AND order_id <> ?`
  ).run(txHash, keepOrderId);
}

function parseState<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Local SQLite persistence. Neon is an optional hourly backup and is never
 * read on the trading path after the one-time import of an empty database.
 */
export class AgentStore {
  private db: DatabaseSync | null = null;
  private pool: Pool | null = null;
  private stopBackup: (() => void) | null = null;
  private _enabled = false;
  readonly sqlitePath: string;
  private readonly databaseUrl: string;

  constructor(opts?: { sqlitePath?: string; databaseUrl?: string }) {
    this.sqlitePath = resolveSqlitePath(opts?.sqlitePath);
    this.databaseUrl = (opts?.databaseUrl ?? process.env.DATABASE_URL ?? "").trim();
  }

  get enabled(): boolean {
    return this._enabled;
  }

  /** True when DATABASE_URL is set and the hourly Neon copy is scheduled. */
  get backupEnabled(): boolean {
    return this.pool != null;
  }

  async init(): Promise<boolean> {
    try {
      mkdirSync(dirname(this.sqlitePath), { recursive: true });
      this.db = new DatabaseSync(this.sqlitePath);
      const schema = readFileSync(resolve(import.meta.dirname, "schema.sqlite.sql"), "utf8");
      this.db.exec(schema);
      this._enabled = true;
      logger.info("SQLite database ready", { path: this.sqlitePath });
    } catch (err) {
      logger.warn("SQLite init failed — running without local persistence", { error: String(err) });
      this._enabled = false;
      return false;
    }

    if (this.databaseUrl) await this.attachNeonBackup();
    else logger.info("DATABASE_URL unset — Neon backup off");
    this.importPositionEntriesFile();
    return true;
  }

  close(): void {
    this.stopBackup?.();
    this.stopBackup = null;
    this.db?.close();
    this.db = null;
    this._enabled = false;
    void this.pool?.end();
    this.pool = null;
  }

  private async attachNeonBackup(): Promise<void> {
    if (!this.db) return;
    const pool = new Pool({ connectionString: this.databaseUrl });
    try {
      await pool.query(neonSchemaSql());
      const imported = await importNeonIntoSqliteIfEmpty(this.db, pool);
      this.pool = pool;
      this.stopBackup = scheduleNeonBackup(this.db, pool);
      logger.info("Neon backup attached", {
        intervalMs: backupIntervalMs(),
        importedExistingHistory: imported,
      });
    } catch (err) {
      logger.warn("Neon backup unavailable — SQLite remains the live database", {
        error: String(err),
      });
      await pool.end().catch(() => undefined);
    }
  }

  private importPositionEntriesFile(): void {
    if (!this.db) return;
    const existing = get<{ value_json: string }>(
      this.db,
      `SELECT value_json FROM agent_state WHERE key = 'position_entries' LIMIT 1`
    );
    const parsed = parseState<PositionEntriesState>(existing?.value_json);
    if (parsed && Object.keys(parsed).length > 0) return;
    const local = readLocalPositionEntries(positionEntriesFile(this.sqlitePath));
    if (!local || Object.keys(local).length === 0) return;
    this.writeAgentState("position_entries", local);
    logger.info("Imported position entries from JSON into SQLite", {
      symbols: Object.keys(local),
    });
  }

  private writeAgentState(key: string, value: unknown): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO agent_state (key, value_json, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`
    ).run(key, JSON.stringify(value));
  }

  private readAgentState<T>(key: string): T | null {
    if (!this.db) return null;
    const row = get<{ value_json: string }>(
      this.db,
      `SELECT value_json FROM agent_state WHERE key = ? LIMIT 1`,
      key
    );
    return parseState<T>(row?.value_json);
  }

  get isReady(): boolean {
    return !!this.db;
  }

  /** Small JSON blobs (research reports, daily reviews) in the agent_state table. */
  saveJsonState(key: string, value: unknown): void {
    try {
      this.writeAgentState(key, value);
    } catch (err) {
      logger.warn("Failed to persist agent state", { key, error: String(err) });
    }
  }

  loadJsonState<T>(key: string): T | null {
    try {
      return this.readAgentState<T>(key);
    } catch (err) {
      logger.warn("Failed to load agent state", { key, error: String(err) });
      return null;
    }
  }

  async saveTrade(
    order: TradeOrder,
    result: TradeResult,
    mode: string,
    twakResponse?: Record<string, unknown> | null,
    walletAddress?: string | null
  ): Promise<void> {
    if (!this.db) return;
    try {
      const status = tradeStatus(result, mode);
      deleteOtherRowsForTxHash(this.db, result.txHash, result.orderId, order.side);
      this.db.prepare(
        `INSERT INTO trades (
          order_id, symbol, side, amount_usd,
          from_token, to_token, from_amount, to_amount,
          price_usd, tx_hash, status, error_message,
          twak_response, realized_pnl, confirmed_at, wallet_address
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(order_id) DO UPDATE SET
          to_amount = excluded.to_amount,
          price_usd = excluded.price_usd,
          tx_hash = excluded.tx_hash,
          status = excluded.status,
          error_message = excluded.error_message,
          twak_response = excluded.twak_response,
          realized_pnl = excluded.realized_pnl,
          confirmed_at = excluded.confirmed_at,
          wallet_address = COALESCE(excluded.wallet_address, trades.wallet_address),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      ).run(
        result.orderId,
        order.symbol,
        order.side,
        order.amountUsd,
        result.fromToken,
        result.toToken,
        result.fromAmount ?? null,
        result.toAmount ?? null,
        result.priceAtExecution ?? null,
        result.txHash ?? null,
        status,
        result.error ?? null,
        twakResponse ? JSON.stringify(twakResponse) : null,
        result.realizedPnl ?? null,
        result.success ? new Date(result.timestamp).toISOString() : null,
        walletAddress ? walletAddress.toLowerCase() : null
      );
    } catch (err) {
      logger.warn("Failed to persist trade", { orderId: result.orderId, error: String(err) });
    }
  }

  /** Remove Binance Web3 summaries that a real on-chain tx has replaced. */
  async deleteBinanceAggregateTrades(walletAddress: string): Promise<number> {
    if (!this.db) return 0;
    try {
      const wallet = walletAddress.toLowerCase();
      const result = this.db.prepare(
        `DELETE FROM trades
         WHERE tx_hash LIKE 'binance-web3-%'
           AND LOWER(wallet_address) = ?
           AND EXISTS (
             SELECT 1 FROM trades AS r
             WHERE LOWER(r.wallet_address) = ?
               AND r.tx_hash LIKE '0x%'
               AND length(r.tx_hash) >= 42
               AND r.side = trades.side
               AND UPPER(r.symbol) = UPPER(trades.symbol)
           )`
      ).run(wallet, wallet);
      return Number(result.changes ?? 0);
    } catch (err) {
      logger.warn("Failed to delete Binance aggregate trades", { error: String(err) });
      return 0;
    }
  }

  /** Persist a trade reconstructed from on-chain transfer history (idempotent). */
  async saveChainTrade(trade: TradeResult, walletAddress: string): Promise<void> {
    if (!this.db || !trade.txHash) return;
    const side = classifyAssetTrade(trade.fromToken, trade.toToken);
    if (!side) return;
    const symbol = side === "buy" ? trade.toToken : trade.fromToken;
    const fromAmt = parseFloat(trade.fromAmount) || 0;
    const toAmt = parseFloat(trade.toAmount ?? "") || 0;
    const amountUsd = side === "buy" ? fromAmt : toAmt || fromAmt * (trade.priceAtExecution || 0);

    try {
      deleteOtherRowsForTxHash(this.db, trade.txHash, trade.orderId, side);
      this.db.prepare(
        `INSERT INTO trades (
          order_id, symbol, side, amount_usd,
          from_token, to_token, from_amount, to_amount,
          price_usd, tx_hash, status, confirmed_at, wallet_address, realized_pnl
        ) VALUES (?,?,?,?,?,?,?,?,?,?,'confirmed',?,?,?)
        ON CONFLICT(order_id) DO UPDATE SET
          from_amount = excluded.from_amount,
          to_amount = excluded.to_amount,
          amount_usd = excluded.amount_usd,
          price_usd = excluded.price_usd,
          tx_hash = excluded.tx_hash,
          confirmed_at = excluded.confirmed_at,
          wallet_address = COALESCE(excluded.wallet_address, trades.wallet_address),
          realized_pnl = COALESCE(excluded.realized_pnl, trades.realized_pnl),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      ).run(
        trade.orderId,
        symbol.toUpperCase(),
        side,
        amountUsd,
        trade.fromToken,
        trade.toToken,
        trade.fromAmount,
        trade.toAmount ?? null,
        trade.priceAtExecution ?? null,
        trade.txHash,
        new Date(trade.timestamp).toISOString(),
        walletAddress.toLowerCase(),
        trade.realizedPnl ?? null
      );
    } catch (err) {
      logger.warn("Failed to persist chain trade", { orderId: trade.orderId, error: String(err) });
    }
  }

  async saveNavSnapshot(
    snap: PortfolioSnapshot,
    cycleId: number,
    mode: string,
    peakNavUsd: number,
    stats?: CycleStats
  ): Promise<void> {
    if (!this.db) return;
    try {
      this.db.prepare(
        `INSERT INTO nav_snapshots (
          cycle_id, timestamp, cash_usd, gas_usd, positions_json,
          total_nav_usd, peak_nav_usd, drawdown_pct,
          total_pnl_usd, total_pnl_pct, mode,
          realized_pnl, daily_pnl, positions_count,
          total_trades, today_trades, win_rate,
          fear_greed, emergency_mode
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        cycleId,
        new Date(snap.timestamp || Date.now()).toISOString(),
        snap.cashUsd,
        snap.gasReserveUsd ?? 0,
        JSON.stringify(snap.positions),
        snap.totalValueUsd,
        peakNavUsd,
        snap.maxDrawdownPct,
        snap.totalPnl,
        snap.totalPnlPct,
        mode,
        stats?.realizedPnl ?? null,
        stats?.dailyPnl ?? null,
        stats?.positionsCount ?? null,
        stats?.totalTrades ?? null,
        stats?.todayTrades ?? null,
        stats?.winRate ?? null,
        stats?.fearGreed ?? null,
        stats?.emergencyMode == null ? null : stats.emergencyMode ? 1 : 0
      );
    } catch (err) {
      logger.warn("Failed to persist NAV snapshot", { cycleId, error: String(err) });
    }
  }

  async saveChainSync(record: ChainSyncRecord): Promise<void> {
    if (!this.db) return;
    try {
      this.db.prepare(
        `INSERT INTO chain_syncs (
          holdings_json, usdt_balance,
          positions_added, positions_removed,
          gas_symbol, gas_amount, gas_usd
        ) VALUES (?,?,?,?,?,?,?)`
      ).run(
        JSON.stringify(record.holdings),
        record.usdtBalance,
        JSON.stringify(record.positionsAdded),
        JSON.stringify(record.positionsRemoved),
        record.gas?.symbol ?? null,
        record.gas?.amount ?? null,
        record.gas?.valueUsd ?? null
      );
    } catch (err) {
      logger.warn("Failed to persist chain sync", { error: String(err) });
    }
  }

  async saveNavState(state: NavPeakState): Promise<void> {
    if (!this.db) return;
    try {
      this.writeAgentState("nav_peak", state);
    } catch (err) {
      logger.warn("Failed to persist NAV state", { error: String(err) });
    }
  }

  async loadNavState(): Promise<NavPeakState | null> {
    try {
      return this.readAgentState<NavPeakState>("nav_peak");
    } catch (err) {
      logger.warn("Failed to load NAV state from SQLite", { error: String(err) });
      return null;
    }
  }

  /** Persisted NAV curve since `sinceMs`, oldest first (equity chart after restart). */
  async loadNavHistory(
    sinceMs: number
  ): Promise<Array<{ timestamp: number; totalValueUsd: number; maxDrawdownPct: number }>> {
    if (!this.db) return [];
    try {
      const rows = this.db.prepare(
        `SELECT timestamp, total_nav_usd, drawdown_pct FROM nav_snapshots
         WHERE timestamp >= ? AND total_nav_usd > 0
         ORDER BY timestamp ASC`
      ).all(new Date(sinceMs).toISOString()) as Array<{
        timestamp: string;
        total_nav_usd: number;
        drawdown_pct: number | null;
      }>;
      return rows.map((r) => ({
        timestamp: Date.parse(r.timestamp),
        totalValueUsd: r.total_nav_usd,
        maxDrawdownPct: r.drawdown_pct ?? 0,
      }));
    } catch (err) {
      logger.warn("Failed to load NAV history from SQLite", { error: String(err) });
      return [];
    }
  }

  /** Last recorded NAV strictly before `beforeMs` (used as yesterday's close). */
  async loadLastNavBefore(beforeMs: number): Promise<number | null> {
    if (!this.db || !Number.isFinite(beforeMs) || beforeMs <= 0) return null;
    try {
      const row = get<{ total_nav_usd: number }>(
        this.db,
        `SELECT total_nav_usd FROM nav_snapshots
         WHERE timestamp < ? AND total_nav_usd > 0
         ORDER BY timestamp DESC
         LIMIT 1`,
        new Date(beforeMs).toISOString()
      );
      return row && row.total_nav_usd > 0 ? row.total_nav_usd : null;
    } catch (err) {
      logger.warn("Failed to load yesterday NAV from SQLite", { error: String(err) });
      return null;
    }
  }

  /**
   * Recent confirmed trades for dashboard/API fallback after restart.
   * Scoped to the active wallet so a shared DB doesn't surface other wallets'
   * activity. Legacy rows with a NULL wallet_address are excluded once a
   * wallet filter is supplied.
   */
  async loadRecentTrades(limit = 50, walletAddress?: string | null): Promise<TradeResult[]> {
    if (!this.db) return [];
    try {
      const params: Sql[] = [];
      let walletClause = "";
      if (walletAddress) {
        params.push(walletAddress.toLowerCase());
        walletClause = ` AND LOWER(wallet_address) = ?`;
      }
      params.push(limit);
      const rows = all<TradeRow>(
        this.db,
        `SELECT order_id, from_token, to_token, from_amount, to_amount,
                price_usd, tx_hash, realized_pnl, confirmed_at, created_at
         FROM trades
         WHERE status IN ('confirmed', 'paper')${walletClause}
         ORDER BY COALESCE(confirmed_at, created_at) DESC
         LIMIT ?`,
        ...params
      );
      return mapTradeRows(rows);
    } catch (err) {
      logger.warn("Failed to load trades from SQLite", { error: String(err) });
      return [];
    }
  }

  /** Distinct buy-side tokens from confirmed trades — used to re-probe wallet balances. */
  async loadTradedSymbols(walletAddress?: string | null): Promise<string[]> {
    if (!this.db) return [];
    try {
      const params: Sql[] = [];
      let walletClause = "";
      if (walletAddress) {
        params.push(walletAddress.toLowerCase());
        walletClause = ` AND LOWER(wallet_address) = ?`;
      }
      const rows = all<{ symbol: string }>(
        this.db,
        `SELECT DISTINCT UPPER(to_token) AS symbol
         FROM trades
         WHERE status = 'confirmed'
           AND side = 'buy'${walletClause}
         ORDER BY symbol`,
        ...params
      );
      return rows.map((r) => r.symbol).filter(Boolean);
    } catch (err) {
      logger.warn("Failed to load traded symbols from SQLite", { error: String(err) });
      return [];
    }
  }

  /**
   * Full confirmed trade history for cost-basis replay (oldest first).
   * Unlike loadRecentTrades, this is not capped — needed to recover entry
   * prices for positions opened before the most recent N swaps.
   */
  async loadAllTradesForCostBasis(
    walletAddress?: string | null,
    maxRows = 2000
  ): Promise<TradeResult[]> {
    if (!this.db) return [];
    try {
      const params: Sql[] = [];
      let walletClause = "";
      if (walletAddress) {
        params.push(walletAddress.toLowerCase());
        walletClause = ` AND LOWER(wallet_address) = ?`;
      }
      params.push(maxRows);
      const rows = all<TradeRow>(
        this.db,
        `SELECT order_id, from_token, to_token, from_amount, to_amount,
                price_usd, tx_hash, realized_pnl, confirmed_at, created_at
         FROM trades
         WHERE status IN ('confirmed', 'paper')${walletClause}
         ORDER BY COALESCE(confirmed_at, created_at) ASC
         LIMIT ?`,
        ...params
      );
      return mapTradeRows(rows);
    } catch (err) {
      logger.warn("Failed to load full trade history from SQLite", { error: String(err) });
      return [];
    }
  }

  async savePositionEntries(entries: PositionEntriesState): Promise<void> {
    writeLocalPositionEntries(positionEntriesFile(this.sqlitePath), entries);
    if (!this.db) return;
    try {
      this.writeAgentState("position_entries", entries);
    } catch (err) {
      logger.warn("Failed to persist position entries", { error: String(err) });
    }
  }

  async loadPositionEntries(): Promise<PositionEntriesState | null> {
    try {
      const stored = this.readAgentState<PositionEntriesState>("position_entries");
      if (stored && Object.keys(stored).length > 0) return stored;
    } catch (err) {
      logger.warn("Failed to load position entries from SQLite", { error: String(err) });
    }
    return readLocalPositionEntries(positionEntriesFile(this.sqlitePath));
  }

  async saveUserBlacklist(symbols: string[]): Promise<void> {
    if (!this.db) return;
    try {
      this.writeAgentState("user_token_blacklist", { symbols });
    } catch (err) {
      logger.warn("Failed to persist user token blacklist", { error: String(err) });
    }
  }

  async loadUserBlacklist(): Promise<string[]> {
    if (!this.db) return [];
    try {
      const stored = this.readAgentState<{ symbols?: string[] }>("user_token_blacklist");
      return Array.isArray(stored?.symbols) ? stored.symbols.map((s) => String(s).toUpperCase()) : [];
    } catch (err) {
      logger.warn("Failed to load user token blacklist from SQLite", { error: String(err) });
      return [];
    }
  }

  /** Last persisted on-chain holdings snapshot (may include tokens purged from memory). */
  async loadLastChainSyncHoldings(): Promise<string[]> {
    if (!this.db) return [];
    try {
      const row = get<{ holdings_json: string }>(
        this.db,
        `SELECT holdings_json FROM chain_syncs ORDER BY timestamp DESC LIMIT 1`
      );
      const holdings = parseState<Record<string, number>>(row?.holdings_json);
      return holdings ? Object.keys(holdings) : [];
    } catch (err) {
      logger.warn("Failed to load last chain sync from SQLite", { error: String(err) });
      return [];
    }
  }
}

/** Singleton store — initialized once at agent boot. */
let _store: AgentStore | null = null;

export function getAgentStore(): AgentStore {
  if (!_store) _store = new AgentStore();
  return _store;
}

export async function initAgentStore(): Promise<AgentStore> {
  const store = getAgentStore();
  if (!store.enabled) await store.init();
  return store;
}
