"use client";

import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Layers, Loader2, ArrowDownRight } from "lucide-react";
import { cn, formatUsd, formatPct, formatTradePrice, formatTokenQty } from "@/lib/utils";
import type { Position } from "@/lib/mock-data";

function tokenHue(symbol: string): string {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) % 360;
  return `hsl(${h} 28% 46%)`;
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n));
}

function positionValueUsd(pos: Position): number {
  if (pos.currentPrice > 0 && pos.amount > 0) return pos.amount * pos.currentPrice;
  return 0;
}

/** Entry sits at 50%. Left half is the SL run, right half is the TP run. */
function exitMarkerPct(pos: Position): number {
  const sl = pos.stopLossPrice;
  const tp = pos.takeProfitPrice;
  const entry = pos.entryPrice;
  const current = pos.currentPrice;
  if (sl == null || tp == null || !(entry > 0) || !(current > 0)) return 50;
  if (current >= entry) {
    const run = tp - entry;
    return clampPct(50 + 50 * (run > 0 ? (current - entry) / run : 0));
  }
  const run = entry - sl;
  return clampPct(50 + 50 * (run > 0 ? (current - entry) / run : 0));
}

function ExitLevels({ pos }: { pos: Position }) {
  const slDist = pos.distanceToStopPct;
  const tpDist = pos.distanceToTakeProfitPct;
  if (
    pos.stopLossPrice == null ||
    pos.takeProfitPrice == null ||
    slDist == null ||
    tpDist == null
  ) {
    return <span className="text-text-muted text-[10px]">—</span>;
  }

  const slHit = slDist <= 0;
  const trailArmed = Boolean(pos.trailingArmed) || tpDist <= 0;
  const trailDist = pos.distanceToTrailPct;
  const trailHit = trailArmed && trailDist != null && trailDist <= 0;
  const slNear = !slHit && slDist <= 2;
  const inProfit = pos.currentPrice >= pos.entryPrice;
  const markerPct = exitMarkerPct(pos);
  const fillLeft = Math.min(50, markerPct);
  const fillWidth = Math.abs(markerPct - 50);
  const rightPrice = trailArmed && pos.trailStopPrice != null ? pos.trailStopPrice : pos.takeProfitPrice;
  const rightLabel = trailArmed
    ? trailHit
      ? "TRAIL HIT"
      : trailDist != null
        ? `TRAIL ${trailDist.toFixed(1)}%`
        : "TRAIL"
    : `TP ${tpDist.toFixed(1)}%`;
  const rightTitle = trailArmed
    ? `Trail stop @ ${formatTradePrice(rightPrice)}${pos.peakPnlPct != null ? ` · peak +${pos.peakPnlPct.toFixed(1)}%` : ""}`
    : `Arm trail @ ${formatTradePrice(pos.takeProfitPrice)} · ${tpDist.toFixed(1)}% to arm`;

  return (
    <div className="flex flex-col gap-1 min-w-[108px]">
      <div className="flex justify-between gap-2 text-[9px] uppercase tracking-wide">
        <span
          className={cn(
            "tabular-nums font-semibold",
            slHit ? "text-danger" : slNear ? "text-amber-400" : "text-text-muted"
          )}
          title={`Stop @ ${formatTradePrice(pos.stopLossPrice)} · ${slDist.toFixed(1)}% of price left`}
        >
          SL {slHit ? "HIT" : `${slDist.toFixed(1)}%`}
        </span>
        <span
          className={cn(
            "tabular-nums font-semibold",
            trailHit ? "text-warning" : trailArmed ? "text-neon" : "text-text-muted"
          )}
          title={rightTitle}
        >
          {rightLabel}
        </span>
      </div>
      <div
        className="relative h-1.5 rounded-full bg-surface-overlay"
        title={`Entry ${formatTradePrice(pos.entryPrice)} · Now ${formatTradePrice(pos.currentPrice)}`}
      >
        <div className="absolute inset-0 rounded-full overflow-hidden">
          <div className="absolute inset-y-0 left-0 w-1/2 bg-danger/20" />
          <div className="absolute inset-y-0 right-0 w-1/2 bg-neon/15" />
          {fillWidth > 0.3 && (
            <div
              className={cn(
                "absolute inset-y-0 transition-[left,width] duration-500",
                inProfit ? "bg-neon/55" : "bg-danger/55"
              )}
              style={{ left: `${fillLeft}%`, width: `${fillWidth}%` }}
            />
          )}
        </div>
        <div
          className="absolute top-0 h-full w-px bg-text-muted/80"
          style={{ left: "50%" }}
          title="Entry"
        />
        <div
          className={cn(
            "absolute top-1/2 -translate-y-1/2 size-2 rounded-full border border-background shadow-sm transition-[left] duration-500",
            inProfit ? "bg-neon" : "bg-danger"
          )}
          style={{ left: `calc(${markerPct}% - 4px)` }}
        />
      </div>
      <div className="flex justify-between text-[8px] text-text-muted tabular-nums">
        <span>{formatTradePrice(pos.stopLossPrice)}</span>
        <span>{formatTradePrice(rightPrice)}</span>
      </div>
    </div>
  );
}

function PositionPnl({ pos }: { pos: Position }) {
  if (pos.entryUnknown) {
    return <span className="text-[11px] text-text-muted">—</span>;
  }
  return (
    <div className="flex flex-col items-end">
      <span
        className={cn(
          "font-semibold tabular-nums",
          pos.pnl >= 0 ? "text-neon" : "text-danger"
        )}
      >
        {pos.pnl >= 0 ? "+" : ""}
        {formatUsd(pos.pnl)}
      </span>
      <span
        className={cn(
          "text-[10px] tabular-nums",
          pos.pnlPct >= 0 ? "text-neon/60" : "text-danger/60"
        )}
      >
        {formatPct(pos.pnlPct)}
      </span>
    </div>
  );
}

function SellButton({
  pos,
  valueUsd,
  connected,
  selling,
  blocked,
  fullWidth,
  onSell,
}: {
  pos: Position;
  valueUsd: number;
  connected: boolean;
  selling: boolean;
  blocked: boolean;
  fullWidth?: boolean;
  onSell: (symbol: string, amount: number) => void;
}) {
  const valueLabel = valueUsd > 0 ? formatUsd(valueUsd) : null;
  return (
    <button
      type="button"
      disabled={!connected || blocked}
      onClick={() => onSell(pos.symbol, pos.amount)}
      title={
        connected
          ? `Sell all ${pos.symbol}${valueLabel ? ` · ${valueLabel}` : ""} (1% slippage)`
          : "Agent offline"
      }
      className={cn(
        "inline-flex items-center justify-center gap-1.5 min-h-10 px-3 py-2 rounded-md text-[10px] font-semibold uppercase tracking-wide transition-colors border",
        fullWidth && "w-full",
        selling
          ? "bg-danger/15 text-danger border-danger/25 cursor-wait"
          : connected && !blocked
            ? "bg-danger/10 text-danger border-danger/20 hover:bg-danger/20"
            : "bg-surface-overlay/40 text-text-muted border-border-dim cursor-not-allowed opacity-50"
      )}
      style={{ fontFamily: "var(--font-mono)" }}
    >
      {selling ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <ArrowDownRight className="size-3" />
      )}
      <span>Sell</span>
      {valueLabel && <span className="tabular-nums normal-case">{valueLabel}</span>}
    </button>
  );
}

interface PositionsTableProps {
  positions: Position[];
  /** Hide sell actions on public/read-only deployments. */
  readOnly?: boolean;
  connected?: boolean;
  onSell?: (symbol: string) => Promise<void>;
}

export function PositionsTable({
  positions,
  readOnly = false,
  connected = false,
  onSell,
}: PositionsTableProps) {
  const [sellingSymbol, setSellingSymbol] = useState<string | null>(null);
  const [sellError, setSellError] = useState<string | null>(null);

  const handleSell = useCallback(
    async (symbol: string, amount: number) => {
      if (!onSell || sellingSymbol) return;
      const pos = positions.find((p) => p.symbol === symbol);
      const value = pos ? positionValueUsd(pos) : 0;
      const qtyLabel = `${formatTokenQty(amount)} ${symbol}`;
      const ok = window.confirm(
        `Sell entire ${symbol} position (${qtyLabel}${value > 0 ? ` · ${formatUsd(value)}` : ""})?\n\nThis submits an on-chain swap at 1% max slippage.`
      );
      if (!ok) return;

      setSellError(null);
      setSellingSymbol(symbol);
      try {
        await onSell(symbol);
      } catch (err) {
        setSellError(err instanceof Error ? err.message : String(err));
      } finally {
        setSellingSymbol(null);
      }
    },
    [onSell, sellingSymbol, positions]
  );

  const showActions = !readOnly && !!onSell;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.4 }}
      className="glass-raised rounded-xl p-3 sm:p-5 min-w-0"
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Layers className="size-4 text-cyan" />
          <h3
            className="text-sm font-semibold tracking-wide uppercase"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Open Positions
          </h3>
        </div>
        <span className="text-xs font-mono text-text-secondary">
          {positions.length} active
        </span>
      </div>

      {sellError && (
        <p className="mb-3 text-[10px] font-mono text-danger">{sellError}</p>
      )}

      <div className="flex h-2 rounded-full overflow-hidden mb-4 gap-0.5">
        {positions.map((pos) => (
          <motion.div
            key={pos.symbol}
            initial={{ width: 0 }}
            animate={{ width: `${pos.weight}%` }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            className="rounded-full"
            style={{ backgroundColor: tokenHue(pos.symbol) }}
          />
        ))}
      </div>

      {positions.length === 0 ? (
        <p className="py-8 text-center text-xs font-mono text-text-muted">No open positions</p>
      ) : (
        <>
          <div className="md:hidden flex flex-col gap-2">
            {positions.map((pos) => {
              const valueUsd = positionValueUsd(pos);
              return (
                <div
                  key={pos.symbol}
                  className="rounded-lg border border-border-dim bg-surface-overlay/30 p-3"
                >
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <div
                        className="size-2 rounded-full shrink-0"
                        style={{ backgroundColor: tokenHue(pos.symbol) }}
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-text-primary truncate">
                          {pos.symbol}
                        </p>
                        <p className="text-[10px] font-mono text-text-muted tabular-nums">
                          {formatTokenQty(pos.amount)} · {pos.weight.toFixed(1)}%
                        </p>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[9px] uppercase tracking-wider text-text-muted font-mono">
                        Total value
                      </p>
                      <p className="text-base font-bold text-text-primary tabular-nums font-mono">
                        {valueUsd > 0 ? formatUsd(valueUsd) : "—"}
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-[11px] font-mono mb-3">
                    <div>
                      <p className="text-[9px] uppercase text-text-muted">Entry</p>
                      <p className="tabular-nums text-text-secondary">
                        {pos.entryUnknown ? "—" : formatTradePrice(pos.entryPrice)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[9px] uppercase text-text-muted">Current</p>
                      <p className="tabular-nums text-text-primary">
                        {formatTradePrice(pos.currentPrice)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[9px] uppercase text-text-muted">PnL</p>
                      <PositionPnl pos={pos} />
                    </div>
                  </div>
                  <div className="mb-3">
                    <ExitLevels pos={pos} />
                  </div>
                  {showActions && (
                    <SellButton
                      pos={pos}
                      valueUsd={valueUsd}
                      connected={connected}
                      selling={sellingSymbol === pos.symbol}
                      blocked={sellingSymbol !== null}
                      fullWidth
                      onSell={handleSell}
                    />
                  )}
                </div>
              );
            })}
          </div>

          <div className="hidden md:block table-scroll">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-text-muted text-[10px] uppercase tracking-wider">
                  <th className="text-left pb-3 pr-4">Token</th>
                  <th className="text-right pb-3 pr-4" title="Live USD value · token quantity below">
                    Total value
                  </th>
                  <th className="text-right pb-3 pr-4" title="Fixed at buy execution — not live price">
                    Entry
                  </th>
                  <th className="text-right pb-3 pr-4">Current</th>
                  <th className="text-right pb-3 pr-4">PnL</th>
                  <th className="text-right pb-3 pr-4">SL / TP</th>
                  <th className="text-right pb-3 pr-4">Weight</th>
                  {showActions && <th className="text-right pb-3">Action</th>}
                </tr>
              </thead>
              <tbody>
                <AnimatePresence>
                  {positions.map((pos) => {
                    const valueUsd = positionValueUsd(pos);
                    return (
                    <motion.tr
                      key={pos.symbol}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.15 }}
                      className="border-t border-border-dim hover:bg-surface-overlay/50 transition-colors"
                    >
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-2">
                          <div
                            className="size-2 rounded-full"
                            style={{ backgroundColor: tokenHue(pos.symbol) }}
                          />
                          <span className="font-semibold text-text-primary">
                            {pos.symbol}
                          </span>
                        </div>
                      </td>
                      <td
                        className="text-right py-3 pr-4"
                        title={`${formatTokenQty(pos.amount)} ${pos.symbol}`}
                      >
                        <div className="flex flex-col items-end">
                          <span className="font-semibold text-text-primary tabular-nums">
                            {valueUsd > 0 ? formatUsd(valueUsd) : "—"}
                          </span>
                          <span className="text-[10px] text-text-muted tabular-nums">
                            {formatTokenQty(pos.amount)} {pos.symbol}
                          </span>
                        </div>
                      </td>
                      <td
                        className="text-right py-3 pr-4 text-text-secondary tabular-nums"
                        title={
                          pos.entryUnknown
                            ? "Entry pending — resync agent or wait for trade history"
                            : pos.entryFromTrades
                              ? "Entry from confirmed buy trades"
                              : "Entry price"
                        }
                      >
                        {pos.entryUnknown ? (
                          <span className="text-text-muted">—</span>
                        ) : (
                          formatTradePrice(pos.entryPrice)
                        )}
                      </td>
                      <td className="text-right py-3 pr-4 text-text-primary tabular-nums">
                        {formatTradePrice(pos.currentPrice)}
                      </td>
                      <td className="text-right py-3 pr-4">
                        <PositionPnl pos={pos} />
                      </td>
                      <td className="text-right py-3 pr-4">
                        <div className="flex justify-end">
                          <ExitLevels pos={pos} />
                        </div>
                      </td>
                      <td className="text-right py-3 pr-4">
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-12 h-1.5 rounded-full bg-surface-overlay overflow-hidden">
                            <motion.div
                              className="h-full rounded-full"
                              initial={{ width: 0 }}
                              animate={{ width: `${pos.weight}%` }}
                              transition={{ duration: 0.3 }}
                              style={{ backgroundColor: tokenHue(pos.symbol) }}
                            />
                          </div>
                          <span className="text-text-secondary tabular-nums w-9 text-right">
                            {pos.weight.toFixed(1)}%
                          </span>
                        </div>
                      </td>
                      {showActions && (
                        <td className="text-right py-3">
                          <SellButton
                            pos={pos}
                            valueUsd={valueUsd}
                            connected={connected}
                            selling={sellingSymbol === pos.symbol}
                            blocked={sellingSymbol !== null}
                            onSell={handleSell}
                          />
                        </td>
                      )}
                    </motion.tr>
                    );
                  })}
                </AnimatePresence>
              </tbody>
            </table>
          </div>
        </>
      )}
    </motion.div>
  );
}
