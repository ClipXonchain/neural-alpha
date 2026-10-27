"use client";

import Image from "next/image";
import { Info } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ClipxApp } from "@/components/clipx/ClipxApp";
import type { AccountControls, SignalSwitches } from "@/components/dashboard/AgentControls";
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

type TenantView = {
  cmc_x402?: number | null;
  studio_x402?: number | null;
  telegram_linked?: boolean;
  subscription?: AccountControls["subscription"];
};

function switchesOf(t: TenantView | null): SignalSwitches | null {
  // Rows from before the switches existed ran both sources, so only an explicit 0 is off.
  // New customers are created with Agent Studio at 0: it is optional.
  return t ? { cmc: t.cmc_x402 !== 0, studio: t.studio_x402 !== 0 } : null;
}

async function post(op: string, body?: unknown) {
  const res = await fetch("/api/portal/act", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, body: body ?? {} }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data, error: res.ok ? undefined : String(data?.error || "Request failed") };
}

/** The same desk as neuralalpha.io, pointed at this customer's container and wallet. */
export function CustomerDashboard() {
  setAgentApiBase("/api/portal/agent");
  useEffect(() => () => setAgentApiBase(null), []);
  const [tenant, setTenant] = useState<TenantView | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/portal/session", { cache: "no-store" }).catch(() => null);
    const data = res && res.ok ? await res.json().catch(() => null) : null;
    if (data?.tenant) setTenant(data.tenant as TenantView);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signals = useMemo(() => {
    const value = switchesOf(tenant);
    if (!value) return null;
    return {
      value,
      onChange: async (patch: Partial<SignalSwitches>) => {
        const r = await post("signals", patch);
        if (r.ok && r.data?.tenant) setTenant(r.data.tenant as TenantView);
        return { ok: r.ok, error: r.error };
      },
    };
  }, [tenant]);

  const account = useMemo<AccountControls | null>(() => {
    if (!tenant?.subscription) return null;
    return {
      subscription: tenant.subscription,
      telegramLinked: Boolean(tenant.telegram_linked),
      onRenew: () => {
        window.location.href = "/portal?renew=1";
      },
      onCancel: async (undo) => {
        const r = await post("cancel", { undo });
        if (r.ok && r.data?.tenant) setTenant(r.data.tenant as TenantView);
        return { ok: r.ok, error: r.error };
      },
      onTelegramCode: async () => {
        const r = await post("telegram-code");
        return r.ok
          ? { ok: true, code: String(r.data.code), deepLink: String(r.data.deepLink), expiresAt: String(r.data.expiresAt) }
          : { ok: false, error: r.error };
      },
      onTelegramUnlink: async () => {
        const r = await post("telegram-unlink");
        if (r.ok && r.data?.tenant) setTenant(r.data.tenant as TenantView);
        return { ok: r.ok, error: r.error };
      },
      onRefresh: refresh,
    };
  }, [tenant, refresh]);

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
      signals={signals}
      account={account}
    />
  );
}
