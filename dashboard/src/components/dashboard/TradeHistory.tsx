"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  History,
  ExternalLink,
  ArrowUpRight,
  ArrowDownRight,
  TrendingUp,
  TrendingDown,
  CheckCircle2,
  Clock,
} from "lucide-react";
import { cn, formatUsd, formatTokenQty, formatTradePrice, timeAgo, shortenHash } from "@/lib/utils";
import type { Trade } from "@/lib/mock-data";

function TradeSummary({ trades }: { trades: Trade[] }) {
  const totalTrades = trades.length;
  const buys = trades.filter((t) => t.side === "buy");
  const sells = trades.filter((t) => t.side === "sell");
  const tradesWithPnl = trades.filter((t) => t.pnl !== undefined);
  const totalPnl = tradesWithPnl.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const wins = tradesWithPnl.filter((t) => (t.pnl ?? 0) >= 0).length;
  const winRate = tradesWithPnl.length > 0 ? (wins / tradesWithPnl.length) * 100 : 0;
  const totalVolume = trades.reduce((sum, t) => sum + t.total, 0);

  return (
    <div className="grid grid-cols-4 gap-3 mb-4">
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
          Realized PnL
        </p>
        <p
          className={cn(
            "text-sm font-bold tabular-nums",
            totalPnl >= 0 ? "text-neon" : "text-danger"
          )}
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {totalPnl >= 0 ? "+" : ""}
          {formatUsd(totalPnl)}
        </p>
      </div>
      <div className="rounded-lg bg-surface-overlay/40 p-2.5 text-center">
        <p
          className="text-[9px] text-text-muted uppercase tracking-wider mb-1"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Win Rate
        </p>
        <p
          className={cn(
            "text-sm font-bold tabular-nums",
            winRate >= 50 ? "text-neon" : "text-warning"
          )}
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {winRate.toFixed(0)}%
        </p>
        <p className="text-[9px] text-text-muted mt-0.5" style={{ fontFamily: "var(--font-mono)" }}>
          {wins}/{tradesWithPnl.length} closed
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

function TradeRow({ trade, index }: { trade: Trade; index: number }) {
  const isBuy = trade.side === "buy";
  const hasPnl = trade.pnl !== undefined;
  const isProfit = (trade.pnl ?? 0) >= 0;
  const isBinanceAggregate = trade.txHash?.startsWith("binance-web3-") ?? false;
  const txUrl =
    trade.txHash &&
    trade.txHash !== "pending" &&
    !isBinanceAggregate &&
    /^0x[a-fA-F0-9]{40,}$/.test(trade.txHash)
      ? `https://bscscan.com/tx/${trade.txHash}`
      : null;

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.15 }}
      className={cn(
        "flex items-center gap-3 py-3 px-3 rounded-lg group",
        "hover:bg-surface-overlay/50 transition-colors",
        "border-b border-border-dim/50 last:border-b-0"
      )}
    >
      {/* Side indicator */}
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

      {/* Main info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
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
          {hasPnl && (
            <span
              className={cn(
                "text-[10px] font-semibold px-1.5 py-0.5 rounded flex items-center gap-0.5",
                isProfit
                  ? "bg-neon/10 text-neon"
                  : "bg-danger/10 text-danger"
              )}
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {isProfit ? (
                <TrendingUp className="size-2.5" />
              ) : (
                <TrendingDown className="size-2.5" />
              )}
              {isProfit ? "+" : ""}
              {formatUsd(trade.pnl!)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-text-muted" style={{ fontFamily: "var(--font-mono)" }}>
          <span className="tabular-nums">
            {formatTokenQty(trade.amount)} {trade.symbol} @ {formatTradePrice(trade.price)}
          </span>
          <span className="text-border-glow">•</span>
          <span className="tabular-nums">
            {isBuy ? "Spent" : "Received"}: {formatUsd(trade.total)}
          </span>
          <span className="text-border-glow">•</span>
          <span className="flex items-center gap-1">
            <Clock className="size-2.5" />
            {timeAgo(trade.timestamp)}
          </span>
        </div>
      </div>

      {/* Tx hash */}
      <div className="shrink-0 flex items-center gap-2">
        {txUrl ? (
          <a
            href={txUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] bg-surface-overlay/60 text-text-muted hover:text-cyan hover:bg-cyan/5 transition-colors"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            <CheckCircle2 className="size-3 text-neon" />
            {shortenHash(trade.txHash)}
            <ExternalLink className="size-2.5" />
          </a>
        ) : isBinanceAggregate ? (
          <span
            className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] bg-cyan/5 text-cyan/80 border border-cyan/10"
            style={{ fontFamily: "var(--font-mono)" }}
            title="Aggregate buy/sell stats from Binance Web3 (not a single tx hash)"
          >
            <CheckCircle2 className="size-3" />
            Binance Web3
          </span>
        ) : (
          <span
            className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] bg-surface-overlay/40 text-text-muted"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            <Clock className="size-3 text-warning" />
            pending
          </span>
        )}
      </div>
    </motion.div>
  );
}

export function TradeHistory({ trades }: { trades: Trade[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = trades.filter((t) => !t.txHash?.startsWith("binance-web3-"));
  const displayTrades = showAll ? visible : visible.slice(0, 8);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.45 }}
      className="glass-raised rounded-xl p-5"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center size-7 rounded-lg bg-cyan/8">
            <History className="size-3.5 text-cyan" />
          </div>
          <h3
            className="text-sm font-semibold tracking-wide uppercase"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Recent Trades
          </h3>
        </div>
        <span
          className="text-[10px] text-text-muted tabular-nums"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {visible.length} total
        </span>
      </div>

      {/* Summary stats */}
      {visible.length > 0 && <TradeSummary trades={visible} />}

      {/* Trade list */}
      <div className="flex flex-col">
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
            {displayTrades.map((trade, i) => (
              <TradeRow key={trade.id} trade={trade} index={i} />
            ))}
          </AnimatePresence>
        )}
      </div>

      {/* Show more/less */}
      {visible.length > 8 && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="w-full mt-3 py-2 rounded-lg text-[10px] font-semibold text-text-secondary hover:text-text-primary bg-surface-overlay/40 hover:bg-surface-overlay/70 transition-colors border border-border-dim"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {showAll ? `Show less` : `Show all ${visible.length} trades`}
        </button>
      )}
    </motion.div>
  );
}
