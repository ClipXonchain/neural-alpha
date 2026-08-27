"use client";

import { Header } from "@/components/dashboard/Header";
import { AutonomousPanel } from "@/components/dashboard/AutonomousPanel";
import { MetricCards } from "@/components/dashboard/MetricCards";
import { PositionsTable } from "@/components/dashboard/PositionsTable";
import { TradeHistory } from "@/components/dashboard/TradeHistory";
import { SignalMonitor } from "@/components/dashboard/SignalMonitor";
import { ActivityFeed } from "@/components/dashboard/ActivityFeed";
import { WalletPanel } from "@/components/dashboard/WalletPanel";
import { AgentControls } from "@/components/dashboard/AgentControls";
import { useAgentConnection } from "@/hooks/useAgentConnection";
import { useReadOnly } from "@/hooks/useReadOnly";
import { blacklistToken, unblacklistToken } from "@/lib/agent-api";
import dynamic from "next/dynamic";

const EquityChart = dynamic(
  () => import("@/components/dashboard/EquityChart").then((m) => m.EquityChart),
  { ssr: false, loading: () => <div className="lg:col-span-3 min-h-[260px] rounded-xl bg-surface border border-border-dim" /> }
);
const AllocationChart = dynamic(
  () => import("@/components/dashboard/AllocationChart").then((m) => m.AllocationChart),
  { ssr: false, loading: () => <div className="lg:col-span-2 min-h-[260px] rounded-xl bg-surface border border-border-dim" /> }
);

function DashboardSkeleton() {
  const readOnly = useReadOnly();
  return (
    <div className="min-h-screen bg-void">
      <div className="h-[57px] border-b border-border-dim bg-surface" />
      <main className="px-4 md:px-6 py-4 flex flex-col gap-4 max-w-[1600px] mx-auto">
        {!readOnly && (
          <div className="h-16 rounded-xl bg-surface border border-border-dim animate-pulse" />
        )}
        <div className="flex gap-2 py-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-[52px] flex-1 rounded-lg bg-surface border border-border-dim animate-pulse" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <div className="lg:col-span-3 h-[260px] rounded-xl bg-surface border border-border-dim animate-pulse" />
          <div className="lg:col-span-2 h-[260px] rounded-xl bg-surface border border-border-dim animate-pulse" />
        </div>
        <div className="h-48 rounded-xl bg-surface border border-border-dim animate-pulse" />
        <p className="text-center text-xs font-mono text-text-muted">Connecting to agent…</p>
      </main>
    </div>
  );
}

export default function DashboardPage() {
  const readOnly = useReadOnly();
  const {
    connected,
    loading,
    state,
    wallet,
    agentConfig,
    error,
    handleStart,
    handleStop,
    handleSyncWallet,
    handleResync,
    handleWalletSignin,
    handleWalletVerify,
    handleSaveConfig,
    handleSellPosition,
  } = useAgentConnection();

  const home = loading || !state ? (
    <DashboardSkeleton />
  ) : (
    <>
      <Header
        state={state}
        onStart={handleStart}
        onStop={handleStop}
        connected={connected}
        error={error}
        readOnly={readOnly}
      />

      <main className="px-4 md:px-6 py-4 flex flex-col gap-4 max-w-[1600px] mx-auto">
        {!connected && error && (
          <div className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-2 text-xs font-mono text-warning">
            {error}
          </div>
        )}

        {!readOnly && <AutonomousPanel state={state} />}
        <MetricCards state={state} />

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <EquityChart state={state} />
          <AllocationChart state={state} onRefresh={readOnly ? undefined : handleResync} />
        </div>

        <PositionsTable
          positions={state.positions}
          readOnly={readOnly}
          connected={connected}
          onSell={readOnly ? undefined : handleSellPosition}
        />

        <SignalMonitor
          signals={state.signals}
          lastSignalRefreshAt={state.lastSignalRefreshAt}
          signalRefreshSec={state.signalRefreshSec ?? 10}
          session={state.sessionActive}
          readOnly={readOnly}
          onBlacklist={readOnly ? undefined : async (sym) => { await blacklistToken(sym); }}
          onUnblacklist={readOnly ? undefined : async (sym) => { await unblacklistToken(sym); }}
        />

        <TradeHistory trades={state.trades} />

        <WalletPanel
          wallet={wallet}
          mode={state.mode}
          connected={connected}
          onSync={handleSyncWallet}
          onSignin={handleWalletSignin}
          onVerify={handleWalletVerify}
          readOnly={readOnly}
        />

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <ActivityFeed activity={state.activity} />
          {!readOnly && (
            <AgentControls
              connected={connected}
              config={agentConfig ? {
                mode: agentConfig.mode || state.mode,
                maxPositionSizeUsd: agentConfig.maxPositionSizeUsd ?? 250,
                slippageTolerance: agentConfig.slippageTolerance ?? 1,
                minGasReserveUsd: agentConfig.minGasReserveUsd ?? 1.5,
                maxPortfolioTokens: agentConfig.maxPortfolioTokens ?? 4,
                baseCurrency: agentConfig.baseCurrency,
                swapCurrencies: agentConfig.swapCurrencies,
                stopLossPct: agentConfig.stopLossPct ?? state.stopLossPct ?? 8,
                takeProfitPct: agentConfig.takeProfitPct ?? state.takeProfitPct ?? 14,
              } : null}
              onSave={handleSaveConfig}
            />
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 py-4 border-t border-border-dim text-[10px] font-mono text-text-muted">
          <span>Neural Alpha</span>
          <div className="flex items-center gap-4">
            <span>{connected ? "Live agent" : "Offline"}</span>
            <span>bStock · BSC 56</span>
            <span>Agentic Wallet</span>
          </div>
        </footer>
      </main>
    </>
  );

  return (
    <div className="min-h-screen grid-bg scanlines relative">
      <div className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] rounded-full bg-neon/[0.02] blur-[120px]" />
        <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] rounded-full bg-cyan/[0.02] blur-[120px]" />
      </div>

      <div className="relative z-10">
        {home}
      </div>
    </div>
  );
}
