"use client";

import Image from "next/image";
import { Info } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ClipxApp } from "@/components/clipx/ClipxApp";
import type { SignalSwitches } from "@/components/dashboard/AgentControls";
import { useAgentConnection } from "@/hooks/useAgentConnection";
import { blacklistToken, setAgentApiBase, unblacklistToken } from "@/lib/agent-api";

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
          <p style={{ color: "#7e8a97", fontSize: 12 }}>Connecting to your agent…</p>
        </div>
      </main>
    </div>
  );
}

function switchesOf(tenant: unknown): SignalSwitches | null {
  if (!tenant || typeof tenant !== "object") return null;
  const t = tenant as { cmc_x402?: number | null; studio_x402?: number | null };
  // Null means a row from before the switch existed, which runs with both on.
  return { cmc: t.cmc_x402 !== 0, studio: t.studio_x402 !== 0 };
}

/** The same desk as neuralalpha.io, pointed at this customer's container and wallet. */
export function CustomerDashboard() {
  setAgentApiBase("/api/portal/agent");
  useEffect(() => () => setAgentApiBase(null), []);
  const [signals, setSignals] = useState<SignalSwitches | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/portal/session", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const next = switchesOf(data?.tenant);
        if (alive && next) setSignals(next);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const saveSignals = useCallback(async (patch: Partial<SignalSwitches>) => {
    const res = await fetch("/api/portal/act", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "signals", body: patch }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: String(data?.error || "Could not save") };
    const next = switchesOf(data?.tenant);
    if (next) setSignals(next);
    return { ok: true };
  }, []);
  const {
    connected,
    loading,
    state,
    wallet,
    walletChecked,
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
      walletChecked={walletChecked}
      connected={connected}
      error={error}
      readOnly={false}
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
      onResync={handleResync}
      onSell={handleSellPosition}
      onSave={handleSaveConfig}
      onBlacklist={async (symbol) => { await blacklistToken(symbol); }}
      onUnblacklist={async (symbol) => { await unblacklistToken(symbol); }}
      allowAccessCode
      signals={signals ? { value: signals, onChange: saveSignals } : null}
    />
  );
}
