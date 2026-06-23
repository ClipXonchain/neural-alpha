import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "@neondatabase/serverless";
import type { PortfolioSnapshot, TradeOrder, TradeResult } from "../utils/types.js";
import { isPaperTxHash } from "../execution/executor.js";
import { logger } from "../utils/logger.js";

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
      const { rows } = await this.pool.query<{
        order_id: string;
        from_token: string;
        to_token: string;
        from_amount: string | null;
        to_amount: string | null;
        price_usd: number | null;
        tx_hash: string | null;
        realized_pnl: number | null;
        created_at: string;
      }>(
        `SELECT order_id, from_token, to_token, from_amount, to_amount,
                price_usd, tx_hash, realized_pnl, created_at
         FROM trades
         WHERE status IN ('confirmed', 'paper')${walletClause}
         ORDER BY created_at DESC
         LIMIT $1`,
        params
      );
      return rows.map((r) => ({
        orderId: r.order_id,
        success: true,
        fromToken: r.from_token,
        toToken: r.to_token,
        fromAmount: String(r.from_amount ?? "0"),
        toAmount: r.to_amount ? String(r.to_amount) : undefined,
        priceAtExecution: Number(r.price_usd ?? 0),
        txHash: r.tx_hash ?? undefined,
        timestamp: new Date(r.created_at).getTime(),
        ...(r.realized_pnl != null ? { realizedPnl: r.realized_pnl } : {}),
      }));
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
