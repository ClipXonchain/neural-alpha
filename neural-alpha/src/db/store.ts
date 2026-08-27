import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "@neondatabase/serverless";
import type { PortfolioSnapshot, TradeOrder, TradeResult } from "../utils/types.js";
import { isPaperTxHash } from "../execution/executor.js";
import { logger } from "../utils/logger.js";
import {
  classifyAssetTrade,
  dedupeAndCleanTradeResults,
} from "../utils/trade-dedupe.js";

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
const LOCAL_ENTRIES_FILE = join(PKG_ROOT, "data/position-entries.json");

function readLocalPositionEntries(): PositionEntriesState | null {
  try {
    if (!existsSync(LOCAL_ENTRIES_FILE)) return null;
    const raw = JSON.parse(readFileSync(LOCAL_ENTRIES_FILE, "utf8")) as PositionEntriesState;
    if (!raw || typeof raw !== "object") return null;
    return raw;
  } catch (err) {
    logger.warn("Could not read data/position-entries.json", { error: String(err) });
    return null;
  }
}

function writeLocalPositionEntries(entries: PositionEntriesState) {
  try {
    if (Object.keys(entries).length === 0) {
      const existing = readLocalPositionEntries();
      if (existing && Object.keys(existing).length > 0) return;
    }
    mkdirSync(dirname(LOCAL_ENTRIES_FILE), { recursive: true });
    writeFileSync(LOCAL_ENTRIES_FILE, JSON.stringify(entries, null, 2));
  } catch (err) {
    logger.warn("Could not write data/position-entries.json", { error: String(err) });
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

async function deleteOtherRowsForTxHash(
  pool: Pool,
  txHash: string | undefined,
  keepOrderId: string,
  side?: string
): Promise<void> {
  if (!txHash || !ON_CHAIN_TX.test(txHash)) return;
  if (side === "buy" || side === "sell") {
    await pool.query(
      `DELETE FROM trades
       WHERE LOWER(tx_hash) = LOWER($1)
         AND order_id <> $2
         AND side = $3`,
      [txHash, keepOrderId, side]
    );
    return;
  }
  await pool.query(
    `DELETE FROM trades
     WHERE LOWER(tx_hash) = LOWER($1)
       AND order_id <> $2`,
    [txHash, keepOrderId]
  );
}

/**
 * Optional Neon Postgres persistence layer.
 * Gracefully no-ops when DATABASE_URL is unset.
 */
export class AgentStore {
  private pool: Pool | null = null;
  readonly enabled: boolean;

  constructor() {
    const url = process.env.DATABASE_URL?.trim();
    this.enabled = !!url;
    if (url) this.pool = new Pool({ connectionString: url });
  }

  async init(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      const schemaPath = resolve(import.meta.dirname, "schema.sql");
      const schema = readFileSync(schemaPath, "utf8");
      await this.pool.query(schema);
      logger.info("Neon database connected — persistence enabled");
      return true;
    } catch (err) {
      logger.warn("Neon init failed — running without DB persistence", { error: String(err) });
      return false;
    }
  }

  async saveTrade(
    order: TradeOrder,
    result: TradeResult,
    mode: string,
    twakResponse?: Record<string, unknown> | null,
    walletAddress?: string | null
  ): Promise<void> {
    if (!this.pool) return;
    try {
      const status = tradeStatus(result, mode);
      await deleteOtherRowsForTxHash(this.pool, result.txHash, result.orderId, order.side);
      await this.pool.query(
        `INSERT INTO trades (
          order_id, symbol, side, amount_usd,
          from_token, to_token, from_amount, to_amount,
          price_usd, tx_hash, status, error_message,
          twak_response, realized_pnl, confirmed_at, wallet_address
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
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
          walletAddress ? walletAddress.toLowerCase() : null,
        ]
      );
    } catch (err) {
      logger.warn("Failed to persist trade", { orderId: result.orderId, error: String(err) });
    }
  }

  /** Remove Binance aggregates only when a real 0x hash exists for the same symbol+side. */
  async deleteBinanceAggregateTrades(walletAddress: string): Promise<number> {
    if (!this.pool) return 0;
    try {
      const { rowCount } = await this.pool.query(
        `DELETE FROM trades t
         WHERE t.tx_hash LIKE 'binance-web3-%'
           AND LOWER(t.wallet_address) = $1
           AND EXISTS (
             SELECT 1 FROM trades r
             WHERE LOWER(r.wallet_address) = $1
               AND r.tx_hash ~ '^0x[0-9a-fA-F]{64}$'
               AND UPPER(r.symbol) = UPPER(t.symbol)
               AND r.side = t.side
           )`,
        [walletAddress.toLowerCase()]
      );
      return rowCount ?? 0;
    } catch (err) {
      logger.warn("Failed to delete Binance aggregate trades", { error: String(err) });
      return 0;
    }
  }

  /** Persist a trade reconstructed from on-chain transfer history (idempotent). */
  async saveChainTrade(trade: TradeResult, walletAddress: string): Promise<void> {
    if (!this.pool || !trade.txHash) return;
    const side = classifyAssetTrade(trade.fromToken, trade.toToken);
    if (!side) return;
    const symbol = side === "buy" ? trade.toToken : trade.fromToken;
    const fromAmt = parseFloat(trade.fromAmount) || 0;
    const toAmt = parseFloat(trade.toAmount ?? "") || 0;
    const amountUsd = side === "buy" ? fromAmt : toAmt || fromAmt * (trade.priceAtExecution || 0);

    try {
      await deleteOtherRowsForTxHash(this.pool, trade.txHash, trade.orderId, side);
      await this.pool.query(
        `INSERT INTO trades (
          order_id, symbol, side, amount_usd,
          from_token, to_token, from_amount, to_amount,
          price_usd, tx_hash, status, confirmed_at, wallet_address, realized_pnl
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'confirmed',$11,$12,$13)
        ON CONFLICT (order_id) DO UPDATE SET
          from_amount = EXCLUDED.from_amount,
          to_amount = EXCLUDED.to_amount,
          amount_usd = EXCLUDED.amount_usd,
          price_usd = EXCLUDED.price_usd,
          tx_hash = EXCLUDED.tx_hash,
          confirmed_at = EXCLUDED.confirmed_at,
          wallet_address = COALESCE(EXCLUDED.wallet_address, trades.wallet_address),
          realized_pnl = COALESCE(EXCLUDED.realized_pnl, trades.realized_pnl)`,
        [
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
          trade.realizedPnl ?? null,
        ]
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
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO nav_snapshots (
          cycle_id, cash_usd, gas_usd, positions_json,
          total_nav_usd, peak_nav_usd, drawdown_pct,
          total_pnl_usd, total_pnl_pct, mode,
          realized_pnl, daily_pnl, positions_count,
          total_trades, today_trades, win_rate,
          fear_greed, emergency_mode
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          cycleId,
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
          stats?.emergencyMode ?? null,
        ]
      );
    } catch (err) {
      logger.warn("Failed to persist NAV snapshot", { cycleId, error: String(err) });
    }
  }

  async saveChainSync(record: ChainSyncRecord): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO chain_syncs (
          holdings_json, usdt_balance,
          positions_added, positions_removed,
          gas_symbol, gas_amount, gas_usd
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          JSON.stringify(record.holdings),
          record.usdtBalance,
          record.positionsAdded,
          record.positionsRemoved,
          record.gas?.symbol ?? null,
          record.gas?.amount ?? null,
          record.gas?.valueUsd ?? null,
        ]
      );
    } catch (err) {
      logger.warn("Failed to persist chain sync", { error: String(err) });
    }
  }

  async saveNavState(state: NavPeakState): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO agent_state (key, value_json, updated_at)
         VALUES ('nav_peak', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
        [JSON.stringify(state)]
      );
    } catch (err) {
      logger.warn("Failed to persist NAV state", { error: String(err) });
    }
  }

  async loadNavState(): Promise<NavPeakState | null> {
    if (!this.pool) return null;
    try {
      const { rows } = await this.pool.query<{ value_json: NavPeakState }>(
        `SELECT value_json FROM agent_state WHERE key = 'nav_peak' LIMIT 1`
      );
      return rows[0]?.value_json ?? null;
    } catch (err) {
      logger.warn("Failed to load NAV state from Neon", { error: String(err) });
      return null;
    }
  }

  /** Last recorded NAV strictly before `beforeMs` (used as yesterday's close). */
  async loadLastNavBefore(beforeMs: number): Promise<number | null> {
    if (!this.pool || !Number.isFinite(beforeMs) || beforeMs <= 0) return null;
    try {
      const { rows } = await this.pool.query<{ total_nav_usd: number }>(
        `SELECT total_nav_usd FROM nav_snapshots
         WHERE timestamp < $1 AND total_nav_usd > 0
         ORDER BY timestamp DESC
         LIMIT 1`,
        [new Date(beforeMs).toISOString()]
      );
      const nav = rows[0]?.total_nav_usd;
      return nav != null && nav > 0 ? nav : null;
    } catch (err) {
      logger.warn("Failed to load yesterday NAV from Neon", { error: String(err) });
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
    if (!this.pool) return [];
    try {
      const params: (string | number)[] = [limit];
      let walletClause = "";
      if (walletAddress) {
        params.push(walletAddress.toLowerCase());
        walletClause = ` AND LOWER(wallet_address) = $${params.length}`;
      }
      const { rows } = await this.pool.query<TradeRow>(
        `SELECT order_id, from_token, to_token, from_amount, to_amount,
                price_usd, tx_hash, realized_pnl, confirmed_at, created_at
         FROM trades
         WHERE status IN ('confirmed', 'paper')${walletClause}
         ORDER BY COALESCE(confirmed_at, created_at) DESC
         LIMIT $1`,
        params
      );
      return mapTradeRows(rows);
    } catch (err) {
      logger.warn("Failed to load trades from Neon", { error: String(err) });
      return [];
    }
  }

  /** Distinct buy-side tokens from confirmed trades — used to re-probe wallet balances. */
  async loadTradedSymbols(walletAddress?: string | null): Promise<string[]> {
    if (!this.pool) return [];
    try {
      const params: string[] = [];
      let walletClause = "";
      if (walletAddress) {
        params.push(walletAddress.toLowerCase());
        walletClause = ` AND LOWER(wallet_address) = $${params.length}`;
      }
      const { rows } = await this.pool.query<{ symbol: string }>(
        `SELECT DISTINCT UPPER(to_token) AS symbol
         FROM trades
         WHERE status = 'confirmed'
           AND side = 'buy'${walletClause}
         ORDER BY symbol`,
        params
      );
      return rows.map((r) => r.symbol).filter(Boolean);
    } catch (err) {
      logger.warn("Failed to load traded symbols from Neon", { error: String(err) });
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
    if (!this.pool) return [];
    try {
      const params: (string | number)[] = [maxRows];
      let walletClause = "";
      if (walletAddress) {
        params.push(walletAddress.toLowerCase());
        walletClause = ` AND LOWER(wallet_address) = $${params.length}`;
      }
      const { rows } = await this.pool.query<TradeRow>(
        `SELECT order_id, from_token, to_token, from_amount, to_amount,
                price_usd, tx_hash, realized_pnl, confirmed_at, created_at
         FROM trades
         WHERE status IN ('confirmed', 'paper')${walletClause}
         ORDER BY COALESCE(confirmed_at, created_at) ASC
         LIMIT $1`,
        params
      );
      return mapTradeRows(rows);
    } catch (err) {
      logger.warn("Failed to load full trade history from Neon", { error: String(err) });
      return [];
    }
  }

  async savePositionEntries(entries: PositionEntriesState): Promise<void> {
    writeLocalPositionEntries(entries);
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO agent_state (key, value_json, updated_at)
         VALUES ('position_entries', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
        [JSON.stringify(entries)]
      );
    } catch (err) {
      logger.warn("Failed to persist position entries", { error: String(err) });
    }
  }

  async loadPositionEntries(): Promise<PositionEntriesState | null> {
    const local = readLocalPositionEntries();
    if (!this.pool) return local;
    try {
      const { rows } = await this.pool.query<{ value_json: PositionEntriesState }>(
        `SELECT value_json FROM agent_state WHERE key = 'position_entries' LIMIT 1`
      );
      const neon = rows[0]?.value_json ?? null;
      return neon && Object.keys(neon).length > 0 ? neon : local;
    } catch (err) {
      logger.warn("Failed to load position entries from Neon", { error: String(err) });
      return local;
    }
  }

  async saveUserBlacklist(symbols: string[]): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO agent_state (key, value_json, updated_at)
         VALUES ('user_token_blacklist', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
        [JSON.stringify({ symbols })]
      );
    } catch (err) {
      logger.warn("Failed to persist user token blacklist", { error: String(err) });
    }
  }

  async loadUserBlacklist(): Promise<string[]> {
    if (!this.pool) return [];
    try {
      const { rows } = await this.pool.query<{ value_json: { symbols?: string[] } }>(
        `SELECT value_json FROM agent_state WHERE key = 'user_token_blacklist' LIMIT 1`
      );
      const list = rows[0]?.value_json?.symbols;
      return Array.isArray(list) ? list.map((s) => String(s).toUpperCase()) : [];
    } catch (err) {
      logger.warn("Failed to load user token blacklist", { error: String(err) });
      return [];
    }
  }

  /** Last persisted on-chain holdings snapshot (may include tokens purged from memory). */
  async loadLastChainSyncHoldings(): Promise<string[]> {
    if (!this.pool) return [];
    try {
      const { rows } = await this.pool.query<{ holdings_json: Record<string, number> }>(
        `SELECT holdings_json FROM chain_syncs
         ORDER BY created_at DESC LIMIT 1`
      );
      const holdings = rows[0]?.holdings_json;
      return holdings ? Object.keys(holdings) : [];
    } catch (err) {
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
  if (store.enabled) await store.init();
  return store;
}
