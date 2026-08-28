"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  History,
  ExternalLink,
  ArrowUpRight,
  ArrowDownRight,
  CheckCircle2,
  Clock,
} from "lucide-react";
import { cn, formatUsd, formatTokenQty, formatTradePrice, timeAgo, shortenHash } from "@/lib/utils";
import type { Trade } from "@/lib/mock-data";

function isBinanceAggregateHash(txHash: string | undefined): boolean {
  return txHash?.startsWith("binance-web3-") ?? false;
}

function TradeSummary({ trades }: { trades: Trade[] }) {
  const totalTrades = trades.length;
  const buys = trades.filter((t) => t.side === "buy");
  const sells = trades.filter((t) => t.side === "sell");
  const sellValue = sells.reduce((sum, t) => sum + t.total, 0);
  const totalVolume = trades.reduce((sum, t) => sum + t.total, 0);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 mb-4">
      <div className="rounded-lg bg-surface-overlay/40 p-2.5 text-center">
        <p
          className="text-[9px] text-text-muted uppercase tracking-wider mb-1"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Trades
        </p>
        <p
          className="text-sm font-bold text-text-primary tabular-nums"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {totalTrades}
        </p>
        <p className="text-[9px] text-text-muted mt-0.5" style={{ fontFamily: "var(--font-mono)" }}>
          {buys.length}B / {sells.length}S
        </p>
      </div>
      <div className="rounded-lg bg-surface-overlay/40 p-2.5 text-center">
        <p
          className="text-[9px] text-text-muted uppercase tracking-wider mb-1"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Sell value
        </p>
        <p
          className="text-sm font-bold text-text-primary tabular-nums"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {formatUsd(sellValue)}
        </p>
        <p className="text-[9px] text-text-muted mt-0.5" style={{ fontFamily: "var(--font-mono)" }}>
          {sells.length} sell{sells.length === 1 ? "" : "s"}
        </p>
      </div>
      <div className="rounded-lg bg-surface-overlay/40 p-2.5 text-center">
        <p
          className="text-[9px] text-text-muted uppercase tracking-wider mb-1"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Buy value
        </p>
        <p
          className="text-sm font-bold text-text-primary tabular-nums"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {formatUsd(buys.reduce((sum, t) => sum + t.total, 0))}
        </p>
        <p className="text-[9px] text-text-muted mt-0.5" style={{ fontFamily: "var(--font-mono)" }}>
          {buys.length} buy{buys.length === 1 ? "" : "s"}
        </p>
      </div>
      <div className="rounded-lg bg-surface-overlay/40 p-2.5 text-center">
        <p
          className="text-[9px] text-text-muted uppercase tracking-wider mb-1"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Volume
        </p>
        <p
          className="text-sm font-bold text-text-primary tabular-nums"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {formatUsd(totalVolume)}
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

  const chip =
    "inline-flex items-center gap-1.5 min-h-9 px-2.5 py-1.5 rounded text-[10px]";

  if (txUrl) {
    return (
      <a
        href={txUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          chip,
          "bg-surface-overlay/60 text-text-muted hover:text-cyan hover:bg-cyan/5 transition-colors"
        )}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        <CheckCircle2 className="size-3 text-neon" />
        {shortenHash(trade.txHash)}
        <ExternalLink className="size-2.5" />
      </a>
    );
  }

  if (isBinanceAggregate) {
    return (
      <span
        className={cn(chip, "bg-cyan/5 text-cyan/80 border border-cyan/10")}
        style={{ fontFamily: "var(--font-mono)" }}
        title="Aggregate buy/sell stats from Binance Web3 (not a single tx hash)"
      >
        <CheckCircle2 className="size-3" />
        Binance Web3
      </span>
    );
  }

  return (
    <span
      className={cn(chip, "bg-surface-overlay/40 text-text-muted")}
      style={{ fontFamily: "var(--font-mono)" }}
    >
      <Clock className="size-3 text-warning" />
      pending
    </span>
  );
}

function TradeRow({ trade }: { trade: Trade }) {
  const isBuy = trade.side === "buy";

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className={cn(
        "flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 py-3 px-2 sm:px-3 rounded-lg",
        "hover:bg-surface-overlay/50 transition-colors",
        "border-b border-border-dim/50 last:border-b-0"
      )}
    >
      <div className="flex items-start sm:items-center gap-3 min-w-0 flex-1">
        <div
          className={cn(
            "flex items-center justify-center size-8 rounded-lg shrink-0",
            isBuy ? "bg-neon/10" : "bg-danger/10"
          )}
        >
          {isBuy ? (
            <ArrowUpRight className="size-4 text-neon" />
          ) : (
            <ArrowDownRight className="size-4 text-danger" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={cn(
                "text-[10px] font-bold uppercase px-1.5 py-0.5 rounded",
                isBuy
                  ? "bg-neon/10 text-neon border border-neon/15"
                  : "bg-danger/10 text-danger border border-danger/15"
              )}
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {trade.side}
            </span>
            <span
              className="text-xs font-bold text-text-primary"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {trade.symbol}
            </span>
          </div>
          <div
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-text-muted mt-0.5"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            <span className="tabular-nums">
              {formatTokenQty(trade.amount)} {trade.symbol} @ {formatTradePrice(trade.price)}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="size-2.5" />
              {timeAgo(trade.timestamp)}
            </span>
          </div>
        </div>

        <div className="shrink-0 text-right">
          <p
            className="text-[9px] uppercase tracking-wider text-text-muted"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            Total value
          </p>
          <p
            className="text-sm font-bold text-text-primary tabular-nums"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {formatUsd(trade.total)}
          </p>
        </div>
      </div>

      <div className="pl-11 sm:pl-0 shrink-0">
        <TradeTx trade={trade} />
      </div>
    </motion.div>
  );
}

export function TradeHistory({ trades }: { trades: Trade[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = trades.filter((t) => !isBinanceAggregateHash(t.txHash));
  const displayTrades = showAll ? visible : visible.slice(0, 8);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.45 }}
      className="glass-raised rounded-xl p-3 sm:p-5 min-w-0"
    >
      <div className="flex items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex items-center justify-center size-7 rounded-lg bg-cyan/8 shrink-0">
            <History className="size-3.5 text-cyan" />
          </div>
          <h3
            className="text-sm font-semibold tracking-wide uppercase truncate"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Recent Trades
          </h3>
        </div>
        <span
          className="text-[10px] text-text-muted tabular-nums shrink-0"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {visible.length} total
        </span>
      </div>

      {visible.length > 0 && <TradeSummary trades={visible} />}

      <div className="flex flex-col min-w-0">
        {displayTrades.length === 0 ? (
          <div className="flex items-center justify-center py-10">
            <span
              className="text-xs text-text-muted"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              No trades executed yet
            </span>
          </div>
        ) : (
          <AnimatePresence>
            {displayTrades.map((trade) => (
              <TradeRow key={trade.id} trade={trade} />
            ))}
          </AnimatePresence>
        )}
      </div>

      {visible.length > 8 && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          className="w-full mt-3 min-h-10 py-2 rounded-lg text-[10px] font-semibold text-text-secondary hover:text-text-primary bg-surface-overlay/40 hover:bg-surface-overlay/70 transition-colors border border-border-dim"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {showAll ? `Show less` : `Show all ${visible.length} trades`}
        </button>
      )}
    </motion.div>
  );
}
