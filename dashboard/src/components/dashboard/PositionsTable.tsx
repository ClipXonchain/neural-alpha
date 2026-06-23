"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Layers, ExternalLink } from "lucide-react";
import { cn, formatUsd, formatPct, formatTradePrice } from "@/lib/utils";
import type { Position } from "@/lib/mock-data";

const TOKEN_COLORS: Record<string, string> = {
  ETH: "#627eea",
  LINK: "#2a5ada",
  AVAX: "#e84142",
  AAVE: "#b6509e",
  DOT: "#e6007a",
  UNI: "#ff007a",
  DOGE: "#c3a634",
  ADA: "#0033ad",
};

export function PositionsTable({ positions }: { positions: Position[] }) {
  const totalValue = positions.reduce(
    (sum, p) => sum + p.amount * p.currentPrice,
    0
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.4 }}
      className="glass-raised rounded-xl p-5"
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

      {/* Allocation bar */}
      <div className="flex h-2 rounded-full overflow-hidden mb-4 gap-0.5">
        {positions.map((pos) => (
          <motion.div
            key={pos.symbol}
            initial={{ width: 0 }}
            animate={{ width: `${pos.weight}%` }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            className="rounded-full"
            style={{ backgroundColor: TOKEN_COLORS[pos.symbol] || "#8b949e" }}
          />
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-text-muted text-[10px] uppercase tracking-wider">
              <th className="text-left pb-3 pr-4">Token</th>
              <th className="text-right pb-3 pr-4">Amount</th>
              <th className="text-right pb-3 pr-4">Entry</th>
              <th className="text-right pb-3 pr-4">Current</th>
              <th className="text-right pb-3 pr-4">PnL</th>
              <th className="text-right pb-3">Weight</th>
            </tr>
          </thead>
          <tbody>
            <AnimatePresence>
              {positions.map((pos, i) => (
                <motion.tr
                  key={pos.symbol}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.5 + i * 0.08 }}
                  className="border-t border-border-dim hover:bg-surface-overlay/50 transition-colors"
                >
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      <div
                        className="size-2 rounded-full"
                        style={{
                          backgroundColor:
                            TOKEN_COLORS[pos.symbol] || "#8b949e",
                        }}
                      />
                      <span className="font-semibold text-text-primary">
                        {pos.symbol}
                      </span>
                    </div>
                  </td>
                  <td className="text-right py-3 pr-4 text-text-secondary tabular-nums">
                    {pos.amount.toFixed(4)}
                  </td>
                  <td className="text-right py-3 pr-4 text-text-secondary tabular-nums">
                    {formatTradePrice(pos.entryPrice)}
                  </td>
                  <td className="text-right py-3 pr-4 text-text-primary tabular-nums">
                    {formatTradePrice(pos.currentPrice)}
                  </td>
                  <td className="text-right py-3 pr-4">
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
                  </td>
                  <td className="text-right py-3">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-12 h-1.5 rounded-full bg-surface-overlay overflow-hidden">
                        <motion.div
                          className="h-full rounded-full"
                          initial={{ width: 0 }}
                          animate={{ width: `${pos.weight}%` }}
                          transition={{ duration: 0.6, delay: 0.6 + i * 0.1 }}
                          style={{
                            backgroundColor:
                              TOKEN_COLORS[pos.symbol] || "#8b949e",
                          }}
                        />
                      </div>
                      <span className="text-text-secondary tabular-nums w-9 text-right">
                        {pos.weight.toFixed(1)}%
                      </span>
                    </div>
                  </td>
                </motion.tr>
              ))}
            </AnimatePresence>
          </tbody>
        </table>
      </div>
    </motion.div>
  );
}
