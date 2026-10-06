"use client";

import Image from "next/image";
import { Info } from "lucide-react";
import { ClipxApp } from "@/components/clipx/ClipxApp";
import { useAgentConnection } from "@/hooks/useAgentConnection";
import { useReadOnly } from "@/hooks/useReadOnly";
import { blacklistToken, unblacklistToken } from "@/lib/agent-api";

function DashboardSkeleton() {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <Image className="brand-logo" src="/brand/neural-alpha-logo.png" alt="Neural Alpha" width={960} height={300} priority sizes="208px" style={{ width: "100%", height: "auto" }} />
        </div>
        <div className="sidebar-bottom">
          <a className="about-link" href="/about">
            <Info size={18} />
            <span>About</span>
          </a>
        </div>
      </aside>
      <main className="main">
        <header className="topbar" />
        <div className="page">
          <p style={{ color: "#7e8a97", fontSize: 12 }}>Connecting to agent…</p>
        </div>
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

  if (loading || !state) return <DashboardSkeleton />;

  return (
    <ClipxApp
      state={state}
      wallet={wallet}
      connected={connected}
      error={error}
      readOnly={readOnly}
      config={agentConfig ? {
        mode: agentConfig.mode || state.mode,
        initialDepositUsd: agentConfig.initialDepositUsd ?? 2000,
        maxPositionSizeUsd: agentConfig.maxPositionSizeUsd ?? 250,
        slippageTolerance: agentConfig.slippageTolerance ?? 1,
        minGasReserveUsd: agentConfig.minGasReserveUsd ?? 1.5,
        maxPortfolioTokens: agentConfig.maxPortfolioTokens ?? 4,
        baseCurrency: agentConfig.baseCurrency,
        swapCurrencies: agentConfig.swapCurrencies,
        stopLossPct: agentConfig.stopLossPct ?? state.stopLossPct ?? 8,
        takeProfitPct: agentConfig.takeProfitPct ?? state.takeProfitPct ?? 14,
        trailingGivebackPct: agentConfig.trailingGivebackPct ?? state.trailingGivebackPct ?? 1,
      } : null}
      onStart={handleStart}
      onStop={handleStop}
      onSync={handleSyncWallet}
      onSignin={handleWalletSignin}
      onVerify={handleWalletVerify}
      onResync={readOnly ? undefined : handleResync}
      onSell={readOnly ? undefined : handleSellPosition}
      onSave={handleSaveConfig}
      onBlacklist={readOnly ? undefined : async (symbol) => { await blacklistToken(symbol); }}
      onUnblacklist={readOnly ? undefined : async (symbol) => { await unblacklistToken(symbol); }}
    />
  );
}
