"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  History,
  ExternalLink,
  ArrowUpRight,
  CheckCircle2,
  Clock,
} from "lucide-react";
import { cn, formatUsd, formatTokenQty, formatTradePrice, timeAgo, shortenHash } from "@/lib/utils";
import type { Trade } from "@/lib/mock-data";

function isBinanceAggregateHash(txHash: string | undefined): boolean {
  return txHash?.startsWith("binance-web3-") ?? false;
}

/** Dollars the agent paid, dollars it received, and realized PnL (sold − cost). */
type TradeLegs = {
  bought: number | null;
  sold: number | null;
  pnl: number | null;
  /** Realized return on the cost basis, in percent. */
  returnPct: number | null;
};

function tradeLegs(trade: Trade): TradeLegs {
  if (trade.side === "buy") {
    return { bought: trade.total, sold: null, pnl: null, returnPct: null };
  }
  if (trade.pnl === undefined || !Number.isFinite(trade.pnl)) {
    return { bought: null, sold: trade.total, pnl: null, returnPct: null };
  }
  const sold = trade.total;
  const pnl = trade.pnl;
  const bought = Math.round((sold - pnl) * 100) / 100;
  return {
    bought,
    sold,
    pnl,
    returnPct: bought > 0 ? (pnl / bought) * 100 : null,
  };
}

type TradeLedgerRow = {
  id: string;
  symbol: string;
  status: "open" | "closed";
  amount: number;
  entryPrice: number | null;
  exitPrice: number | null;
  timestamp: number;
  legs: TradeLegs;
  txTrade: Trade;
};

type OpenLot = {
  trade: Trade;
  remainingAmount: number;
  remainingCost: number;
};

/**
 * Convert raw buy/sell events into position lifecycle rows. A completed
 * position appears once: SYMBOL → BOUGHT → SOLD → PNL → closing transaction.
 * Remaining buy lots are collapsed into one OPEN row per symbol.
 */
function buildLedgerRows(trades: Trade[]): TradeLedgerRow[] {
  const lots = new Map<string, OpenLot[]>();
  const closed: TradeLedgerRow[] = [];
  const chronological = [...trades].sort((a, b) => a.timestamp - b.timestamp);

  for (const trade of chronological) {
    if (trade.side === "buy") {
      const symbolLots = lots.get(trade.symbol) ?? [];
      symbolLots.push({
        trade,
        remainingAmount: trade.amount,
        remainingCost: trade.total,
      });
      lots.set(trade.symbol, symbolLots);
      continue;
    }

    const symbolLots = lots.get(trade.symbol) ?? [];
    let quantityLeft = trade.amount;
    let matchedCost = 0;

    while (quantityLeft > 0 && symbolLots.length > 0) {
      const lot = symbolLots[0];
      const quantity = Math.min(quantityLeft, lot.remainingAmount);
      const fraction = lot.remainingAmount > 0 ? quantity / lot.remainingAmount : 0;
      matchedCost += lot.remainingCost * fraction;
      lot.remainingAmount -= quantity;
      lot.remainingCost -= lot.remainingCost * fraction;
      quantityLeft -= quantity;
      if (lot.remainingAmount <= 1e-10) symbolLots.shift();
    }

    const pnl =
      trade.pnl !== undefined && Number.isFinite(trade.pnl)
        ? trade.pnl
        : matchedCost > 0
          ? trade.total - matchedCost
          : null;
    const bought =
      pnl != null
        ? Math.round((trade.total - pnl) * 100) / 100
        : matchedCost > 0
          ? Math.round(matchedCost * 100) / 100
          : null;

    closed.push({
      id: `closed-${trade.id}`,
      symbol: trade.symbol,
      status: "closed",
      amount: trade.amount,
      entryPrice: bought != null && trade.amount > 0 ? bought / trade.amount : null,
      exitPrice: trade.price,
      timestamp: trade.timestamp,
      legs: {
        bought,
        sold: trade.total,
        pnl,
        returnPct: bought != null && bought > 0 && pnl != null ? (pnl / bought) * 100 : null,
      },
      txTrade: trade,
    });
  }

  const open: TradeLedgerRow[] = [];
  for (const [symbol, symbolLots] of lots) {
    if (symbolLots.length === 0) continue;
    const amount = symbolLots.reduce((sum, lot) => sum + lot.remainingAmount, 0);
    const bought = symbolLots.reduce((sum, lot) => sum + lot.remainingCost, 0);
    const latest = symbolLots.reduce((last, lot) =>
      lot.trade.timestamp > last.trade.timestamp ? lot : last
    );
    open.push({
      id: `open-${symbol}`,
      symbol,
      status: "open",
      amount,
      entryPrice: amount > 0 ? bought / amount : null,
      exitPrice: null,
      timestamp: latest.trade.timestamp,
      legs: { bought, sold: null, pnl: null, returnPct: null },
      txTrade: latest.trade,
    });
  }

  return [...closed, ...open].sort((a, b) => b.timestamp - a.timestamp);
}

function formatSignedUsd(value: number): string {
  if (value > 0) return `+${formatUsd(value)}`;
  return formatUsd(value);
}

function formatSignedPct(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

type Ledger = {
  count: number;
  buyCount: number;
  sellCount: number;
  bought: number;
  sold: number;
  pnl: number;
  closed: number;
  wins: number;
  winRate: number;
};

function summarize(trades: Trade[]): Ledger {
  let bought = 0;
  let sold = 0;
  let pnl = 0;
  let closed = 0;
  let wins = 0;
  let buyCount = 0;
  let sellCount = 0;

  for (const trade of trades) {
    const legs = tradeLegs(trade);
    if (trade.side === "buy") {
      buyCount += 1;
      bought += legs.bought ?? 0;
    } else {
      sellCount += 1;
      sold += legs.sold ?? 0;
      if (legs.pnl != null) {
        closed += 1;
        pnl += legs.pnl;
        if (legs.pnl >= 0) wins += 1;
      }
    }
  }

  return {
    count: trades.length,
    buyCount,
    sellCount,
    bought,
    sold,
    pnl,
    closed,
    wins,
    winRate: closed > 0 ? (wins / closed) * 100 : 0,
  };
}

/**
 * One grid for the column header and every row, so every lifecycle remains on
 * one line. Small screens scroll the table horizontally instead of changing
 * its meaning or moving Bought/Sold/PnL onto a second row.
 */
const LEDGER =
  "grid min-w-0 grid-cols-[minmax(92px,1.25fr)_repeat(3,minmax(58px,0.85fr))_40px] items-center gap-x-1 px-2 sm:min-w-[720px] sm:grid-cols-[minmax(180px,1.4fr)_repeat(3,minmax(6.5rem,0.85fr))_9rem] sm:gap-x-3 sm:px-3";

const MONO = { fontFamily: "var(--font-mono)" } as const;

function StatLabel({ children }: { children: string }) {
  return (
    <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-text-muted" style={MONO}>
      {children}
    </p>
  );
}

function StatTile({
  label,
  value,
  sub,
  tone = "neutral",
  title,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "neutral" | "profit" | "loss";
  title?: string;
}) {
  return (
    <div
      className={cn(
        "relative min-w-0 overflow-hidden rounded-xl border px-3.5 py-3 sm:px-4",
        tone === "profit" && "border-neon/20 bg-gradient-to-br from-neon/[0.09] to-transparent",
        tone === "loss" && "border-danger/25 bg-gradient-to-br from-danger/[0.10] to-transparent",
        tone === "neutral" && "border-border-dim bg-void/40"
      )}
      title={title}
    >
      <StatLabel>{label}</StatLabel>
      <p
        className={cn(
          "mt-1.5 truncate text-lg font-semibold tabular-nums sm:text-xl",
          tone === "profit" && "text-neon",
          tone === "loss" && "text-danger",
          tone === "neutral" && "text-text-primary"
        )}
        style={MONO}
      >
        {value}
      </p>
      <p className="mt-0.5 truncate text-[11px] text-text-muted" style={MONO}>
        {sub}
      </p>
    </div>
  );
}

function TradeSummary({ ledger }: { ledger: Ledger }) {
  const profit = ledger.pnl >= 0;
  const hasCloses = ledger.closed > 0;

  return (
    <div className="mb-5 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
      <StatTile
        label="Bought"
        value={formatUsd(ledger.bought)}
        sub={`${ledger.buyCount} buys · spent`}
        title="Total dollars the agent paid across all buys"
      />
      <StatTile
        label="Sold"
        value={formatUsd(ledger.sold)}
        sub={`${ledger.sellCount} sells · received`}
        title="Total dollars the agent received across all sells"
      />
      <StatTile
        label="Realized PnL"
        value={formatSignedUsd(ledger.pnl)}
        sub={hasCloses ? "closed trades only" : "no closes yet"}
        tone={hasCloses ? (profit ? "profit" : "loss") : "neutral"}
        title="Cash received on sales minus what those tokens cost. Open buys are not counted."
      />
      <div className="relative min-w-0 overflow-hidden rounded-xl border border-border-dim bg-void/40 px-3.5 py-3 sm:px-4">
        <StatLabel>Win rate</StatLabel>
        <p className="mt-1.5 truncate text-lg font-semibold tabular-nums text-text-primary sm:text-xl" style={MONO}>
          {hasCloses ? `${ledger.winRate.toFixed(0)}%` : "—"}
        </p>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-overlay">
          <div
            className={cn("h-full rounded-full", ledger.winRate >= 50 ? "bg-neon" : "bg-warning")}
            style={{ width: `${hasCloses ? Math.min(100, ledger.winRate) : 0}%` }}
          />
        </div>
        <p className="mt-1.5 truncate text-[11px] text-text-muted" style={MONO}>
          {hasCloses ? `${ledger.wins} of ${ledger.closed} closes` : "waiting on first sell"}
        </p>
      </div>
    </div>
  );
}

function TradeTx({ trade }: { trade: Trade }) {
  const isBinanceAggregate = isBinanceAggregateHash(trade.txHash);
  const txUrl =
    trade.txHash &&
    trade.txHash !== "pending" &&
    !isBinanceAggregate &&
    /^0x[a-fA-F0-9]{40,}$/.test(trade.txHash)
      ? `https://bscscan.com/tx/${trade.txHash}`
      : null;

  const chip = "inline-flex items-center justify-center gap-1.5 min-h-7 px-1.5 py-1 rounded-md text-[10px] sm:min-h-8 sm:px-2";

  if (txUrl) {
    return (
      <a
        href={txUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          chip,
          "bg-surface-overlay/70 text-text-muted hover:text-cyan hover:bg-cyan/10 transition-colors"
        )}
        style={MONO}
      >
        <CheckCircle2 className="size-3 text-neon" />
        <span className="hidden sm:inline">{shortenHash(trade.txHash)}</span>
        <ExternalLink className="hidden size-2.5 sm:block" />
      </a>
    );
  }

  if (isBinanceAggregate) {
    return (
      <span
        className={cn(chip, "bg-cyan/8 text-cyan/90 ring-1 ring-cyan/15")}
        style={MONO}
        title="Aggregate buy/sell stats from Binance Web3 (not a single tx hash)"
      >
        <CheckCircle2 className="size-3" />
        <span className="hidden sm:inline">Binance Web3</span>
      </span>
    );
  }

  return (
    <span className={cn(chip, "bg-surface-overlay/40 text-text-muted")} style={MONO}>
      <Clock className="size-3 text-warning" />
      <span className="hidden sm:inline">pending</span>
    </span>
  );
}

type MoneyKind = "bought" | "sold" | "pnl";

/**
 * Bare number, right-aligned. The leg that describes what the row *did* is
 * bright; the derived leg (cost basis on a sell) is muted. PnL is a soft pill
 * with the return % underneath.
 */
function MoneyCell({
  label,
  kind,
  legs,
  status,
}: {
  label: string;
  kind: MoneyKind;
  legs: TradeLegs;
  status: TradeLedgerRow["status"];
}) {
  const value = kind === "bought" ? legs.bought : kind === "sold" ? legs.sold : legs.pnl;
  const empty = value == null;

  const hint =
    kind === "bought"
      ? status === "open"
        ? "Dollars paid for this open position"
        : "Cost basis of the position that was sold"
      : kind === "sold"
        ? "Dollars the agent received"
        : "Sold minus cost. Positive means the sale cleared more than it cost.";

  return (
    <div className="min-w-0 text-right" title={`${label}: ${hint}`}>
      {empty ? (
        <p className="text-[13px] text-text-muted/30" style={MONO}>
          —
        </p>
      ) : kind === "pnl" ? (
        <div className="flex flex-col items-end">
          <span
            className={cn(
              "inline-flex w-fit items-center rounded-md px-0.5 py-0.5 text-[10px] font-semibold tabular-nums sm:px-1.5 sm:text-[12px]",
              value >= 0 ? "bg-neon/10 text-neon" : "bg-danger/10 text-danger"
            )}
            style={MONO}
          >
            {formatSignedUsd(value)}
          </span>
          {legs.returnPct != null && (
            <span
              className={cn(
                "mt-0.5 hidden px-1.5 text-[10px] tabular-nums sm:block",
                value >= 0 ? "text-neon/65" : "text-danger/65"
              )}
              style={MONO}
            >
              {formatSignedPct(legs.returnPct)}
            </span>
          )}
        </div>
      ) : (
        <p
          className={cn(
            "truncate text-[10px] tabular-nums sm:text-[13px]",
            (kind === "bought" && status === "open") || kind === "sold"
              ? "font-semibold text-text-primary"
              : "font-medium text-text-muted"
          )}
          style={MONO}
        >
          {formatUsd(value)}
        </p>
      )}
    </div>
  );
}

function TradeTableHead() {
  const cell = "text-[8px] font-medium uppercase tracking-[0.08em] text-text-muted sm:text-[10px] sm:tracking-[0.14em]";
  return (
    <div className={cn("border-b border-border-dim pb-2.5", LEDGER)} style={MONO}>
      <span className={cell}>Trade</span>
      <span className={cn(cell, "text-right")}>Bought</span>
      <span className={cn(cell, "text-right")}>Sold</span>
      <span className={cn(cell, "text-right")}>PnL</span>
      <span className={cn(cell, "text-right")}>Tx</span>
    </div>
  );
}

function TradeRow({ row }: { row: TradeLedgerRow }) {
  const isOpen = row.status === "open";
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="group border-b border-border-dim/50 last:border-b-0"
    >
      <div className={cn("py-3 transition-colors hover:bg-white/[0.02]", LEDGER)}>
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={cn(
              "hidden size-8 shrink-0 items-center justify-center rounded-full sm:flex",
              isOpen ? "bg-cyan/10 text-cyan" : "bg-neon/10 text-neon"
            )}
          >
            {isOpen ? <ArrowUpRight className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
          </div>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <span
                className="truncate text-[11px] font-semibold text-text-primary sm:text-[14px]"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {row.symbol}
              </span>
              <span
                className={cn(
                  "hidden text-[9px] font-bold uppercase tracking-[0.12em] sm:inline",
                  isOpen ? "text-cyan" : "text-neon"
                )}
                style={MONO}
              >
                {row.status}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[8px] text-text-muted tabular-nums sm:text-[10px]" style={MONO}>
              {formatTokenQty(row.amount)}
              {row.entryPrice != null && <> @ {formatTradePrice(row.entryPrice)}</>}
              <span className="mx-1.5 text-border-glow">·</span>
              {timeAgo(row.timestamp)}
            </p>
          </div>
        </div>

        <MoneyCell label="Bought" kind="bought" legs={row.legs} status={row.status} />
        <MoneyCell label="Sold" kind="sold" legs={row.legs} status={row.status} />
        <MoneyCell label="PnL" kind="pnl" legs={row.legs} status={row.status} />

        <div className="flex justify-end">
          <TradeTx trade={row.txTrade} />
        </div>
      </div>
    </motion.div>
  );
}

export function TradeHistory({ trades }: { trades: Trade[] }) {
  const [showAll, setShowAll] = useState(false);
  // Hide Binance Web3 buy summaries when a real 0x hash exists; keep sell
  // aggregates so closed positions still appear until chain backfill lands.
  const visible = trades.filter(
    (t) => !isBinanceAggregateHash(t.txHash) || t.side === "sell"
  );
  const rows = buildLedgerRows(visible);
  const displayRows = showAll ? rows : rows.slice(0, 8);
  const ledger = summarize(visible);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.45 }}
      className="glass-raised rounded-xl p-3 sm:p-5 min-w-0"
    >
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-cyan/8">
            <History className="size-3.5 text-cyan" />
          </div>
          <h3
            className="truncate text-sm font-semibold uppercase tracking-wide"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Recent Trades
          </h3>
        </div>
        <span className="shrink-0 text-[10px] text-text-muted tabular-nums" style={MONO}>
          {ledger.closed} closed · {rows.filter((row) => row.status === "open").length} open
        </span>
      </div>

      {visible.length > 0 && <TradeSummary ledger={ledger} />}

      <div className="-mx-3 overflow-x-auto sm:-mx-5">
        <div className="min-w-0 px-3 sm:min-w-[720px] sm:px-5">
        {displayRows.length === 0 ? (
          <div className="flex items-center justify-center py-10">
            <span className="text-xs text-text-muted" style={MONO}>
              No trades executed yet
            </span>
          </div>
        ) : (
          <>
            <TradeTableHead />
            <AnimatePresence>
              {displayRows.map((row) => (
                <TradeRow key={row.id} row={row} />
              ))}
            </AnimatePresence>
          </>
        )}
        </div>
      </div>

      {rows.length > 8 && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          className="mt-3 min-h-10 w-full rounded-lg border border-border-dim bg-surface-overlay/40 py-2 text-[10px] font-semibold text-text-secondary transition-colors hover:bg-surface-overlay/70 hover:text-text-primary"
          style={MONO}
        >
          {showAll ? "Show less" : `Show all ${rows.length} positions`}
        </button>
      )}
    </motion.div>
  );
}
