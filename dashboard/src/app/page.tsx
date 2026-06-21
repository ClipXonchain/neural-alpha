"use client";

import { useState, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "framer-motion";
import { Header } from "@/components/dashboard/Header";
import { MetricCards } from "@/components/dashboard/MetricCards";
import { PositionsTable } from "@/components/dashboard/PositionsTable";
import { TradeHistory } from "@/components/dashboard/TradeHistory";
import { SignalMonitor } from "@/components/dashboard/SignalMonitor";
import { RiskPanel } from "@/components/dashboard/RiskPanel";
import { ActivityFeed } from "@/components/dashboard/ActivityFeed";
import { WalletPanel } from "@/components/dashboard/WalletPanel";
import { AgentControls } from "@/components/dashboard/AgentControls";
import { useAgentConnection } from "@/hooks/useAgentConnection";

const EquityChart = dynamic(
  () => import("@/components/dashboard/EquityChart").then((m) => m.EquityChart),
  { ssr: false }
);
const DrawdownChart = dynamic(
  () => import("@/components/dashboard/DrawdownChart").then((m) => m.DrawdownChart),
  { ssr: false }
);

const BOOT_LINES = [
  "> Initializing Neural Alpha v1.0...",
  "> Loading eligible BEP-20 token list (149 tokens)...",
  "> Connecting to CMC Agent Hub...",
  "> TWAK local signing — self-custody active",
  "> Strategy engine: RSI + MACD + EMA + BB + F&G + news",
  "> Risk guardrails: 25% max drawdown, 10 daily trades",
  "> BSC chain — competition contract verified",
  "> ██████████████████████████████ ONLINE",
];

function BootSequence({ onComplete }: { onComplete: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    let idx = 0;
    const interval = setInterval(() => {
      if (idx >= BOOT_LINES.length) {
        clearInterval(interval);
        setTimeout(() => onCompleteRef.current(), 600);
        return;
      }
      setLines((prev) => [...prev, BOOT_LINES[idx++]]);
    }, 180);
    return () => clearInterval(interval);
  }, []);

  return (
    <motion.div
      className="fixed inset-0 z-[100] bg-void flex items-center justify-center"
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5 }}
    >
      <div className="max-w-xl w-full px-8 font-mono text-xs leading-6">
        <h1
          className="text-3xl font-bold text-neon text-glow-neon mb-8"
          style={{ fontFamily: "var(--font-display)" }}
        >
          NEURAL ALPHA
        </h1>
        {lines.map((line, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            className={
              line?.includes("ONLINE")
                ? "text-neon font-bold text-glow-neon mt-2"
                : "text-text-secondary"
            }
          >
            {line}
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}

export default function DashboardPage() {
  const [booting, setBooting] = useState(true);
  const {
    connected,
    loading,
    state,
    wallet,
    agentConfig,
    error,
    handleStop,
    handleSyncWallet,
    handleRegister,
    handleSwitchWallet,
    handleSaveConfig,
  } = useAgentConnection();

  if (loading || !state) {
    return (
      <div className="min-h-screen bg-void flex items-center justify-center">
        <p className="text-sm font-mono text-text-muted animate-pulse">
          Connecting to agent...
        </p>
      </div>
    );
  }

  return (
    <>
      <AnimatePresence>
        {booting && <BootSequence onComplete={() => setBooting(false)} />}
      </AnimatePresence>

      {!booting && (
        <div className="min-h-screen grid-bg scanlines relative">
          <div className="pointer-events-none fixed inset-0 z-0">
            <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] rounded-full bg-neon/[0.02] blur-[120px]" />
            <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] rounded-full bg-cyan/[0.02] blur-[120px]" />
          </div>

          <div className="relative z-10">
            <Header
              state={state}
              onToggle={handleStop}
              connected={connected}
              error={error}
            />

            <main className="px-4 md:px-6 py-4 flex flex-col gap-4 max-w-[1600px] mx-auto">
              {!connected && error && (
                <div className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-2 text-xs font-mono text-warning">
                  {error}
                </div>
              )}

              <MetricCards state={state} />

              {/* Charts row */}
              <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
                <EquityChart state={state} />
                <DrawdownChart state={state} />
              </div>

              {/* Trades + Live Logs — main monitoring area */}
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <TradeHistory trades={state.trades} />
                <ActivityFeed activity={state.activity} />
              </div>

              {/* Wallet + Risk */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <WalletPanel
                  wallet={wallet}
                  mode={state.mode}
                  connected={connected}
                  onSync={handleSyncWallet}
                  onRegister={handleRegister}
                  onSwitchMode={handleSwitchWallet}
                />
                <RiskPanel state={state} />
              </div>

              {/* Signals + Positions */}
              <SignalMonitor signals={state.signals} />
              <PositionsTable positions={state.positions} />

              {/* Agent Controls */}
              <AgentControls
                connected={connected}
                config={agentConfig ? {
                  mode: agentConfig.mode || state.mode,
                  maxPositionSizeUsd: agentConfig.maxPositionSizeUsd ?? 100,
                  tradeIntervalMs: agentConfig.tradeIntervalMs ?? 300000,
                  maxDrawdownPct: agentConfig.maxDrawdownPct,
                  slippageTolerance: agentConfig.slippageTolerance ?? 1.5,
                  maxDailyTrades: agentConfig.maxDailyTrades,
                  maxPortfolioTokens: agentConfig.maxPortfolioTokens ?? 5,
                  baseCurrency: agentConfig.baseCurrency,
                } : null}
                onSave={handleSaveConfig}
              />

              <footer className="flex flex-wrap items-center justify-between gap-2 py-4 border-t border-border-dim text-[10px] font-mono text-text-muted">
                <span>Neural Alpha</span>
                <div className="flex items-center gap-4">
                  <span>{connected ? "Live agent" : "Demo"}</span>
                  <span>TWAK self-custody</span>
                  <span>CMC data</span>
                </div>
              </footer>
            </main>
          </div>
        </div>
      )}
    </>
  );
}
