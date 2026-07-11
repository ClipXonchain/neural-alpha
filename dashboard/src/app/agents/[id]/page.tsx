"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Header } from "@/components/dashboard/Header";
import { AutonomousPanel } from "@/components/dashboard/AutonomousPanel";
import { MetricCards } from "@/components/dashboard/MetricCards";
import { PositionsTable } from "@/components/dashboard/PositionsTable";
import { TradeHistory } from "@/components/dashboard/TradeHistory";
import { SignalMonitor } from "@/components/dashboard/SignalMonitor";
import { RiskPanel } from "@/components/dashboard/RiskPanel";
import { ActivityFeed } from "@/components/dashboard/ActivityFeed";
import { WalletPanel } from "@/components/dashboard/WalletPanel";
import { AgentSettingsPanel } from "@/components/dashboard/AgentSettingsPanel";
import { CommandPanel } from "@/components/dashboard/CommandPanel";
import { useAgentConnection } from "@/hooks/useAgentConnection";
import { useAuthWallet, useReadOnly } from "@/hooks/useReadOnly";
import { setActiveAgentId, blacklistToken, unblacklistToken, startAgentProcess } from "@/lib/agent-api";
import { ArrowLeft, Loader2, Power } from "lucide-react";
import { agentUniverseLabel, resolveAgentUniverse } from "@/lib/agent-universe";

const EquityChart = dynamic(
  () => import("@/components/dashboard/EquityChart").then((m) => m.EquityChart),
  { ssr: false }
);
const AllocationChart = dynamic(
  () => import("@/components/dashboard/AllocationChart").then((m) => m.AllocationChart),
  { ssr: false }
);

export default function AgentDashboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { wallet, loading: authLoading } = useAuthWallet();
  const [ownerWallet, setOwnerWallet] = useState<string | null>(null);
  const [metaLoading, setMetaLoading] = useState(true);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [agentUniverse, setAgentUniverse] = useState<string | null>(null);
  const [isOwnerKnown, setIsOwnerKnown] = useState(false);
  const [startingProcess, setStartingProcess] = useState(false);

  useEffect(() => {
    setActiveAgentId(id);
    return () => setActiveAgentId(null);
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    setMetaLoading(true);
    setIsOwnerKnown(false);

    fetch(`/api/agents/${id}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (r.status === 401 || r.status === 403) {
          return { forbidden: true as const };
        }
        if (!r.ok) throw new Error(d.error || "Failed to load agent");
        return {
          forbidden: false as const,
          agent: d.agent as {
            owner_wallet: string;
            display_name: string | null;
          },
        };
      })
      .then(async (result) => {
        if (cancelled) return;
        if (result.forbidden) {
          setOwnerWallet(null);
          setIsOwnerKnown(true); // known: not owner / not allowed
          return;
        }
        setOwnerWallet(result.agent.owner_wallet);
        setDisplayName(result.agent.display_name);
        setIsOwnerKnown(true);
        try {
          const cfgRes = await fetch(`/api/agents/${id}/config`);
          if (cfgRes.ok) {
            const cfgData = (await cfgRes.json()) as {
              config?: Record<string, string | null>;
            };
            const u = cfgData.config?.AGENT_UNIVERSE;
            if (u) setAgentUniverse(u);
          }
        } catch {
          /* optional */
        }
      })
      .catch((e) => {
        if (!cancelled) setMetaError(String(e));
      })
      .finally(() => {
        if (!cancelled) setMetaLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  const isOwner =
    !!wallet &&
    !!ownerWallet &&
    wallet.toLowerCase() === ownerWallet.toLowerCase();

  // Until ownership is resolved, treat as unknown (null) so we don't flash MONITORING
  const ownership: boolean | null = !isOwnerKnown
    ? null
    : isOwner
      ? true
      : false;

  const readOnly = useReadOnly({ isOwner: ownership });

  const {
    connected,
    loading,
    state,
    wallet: agentWallet,
    error,
    handleStart,
    handleStop,
    handleSyncWallet,
    handleResync,
    handleSellPosition,
    reconnect,
  } = useAgentConnection();

  if (authLoading || metaLoading || loading) {
    return (
      <div className="min-h-screen bg-void flex items-center justify-center flex-col gap-3">
        <Loader2 className="size-6 text-neon animate-spin" />
        <p className="text-xs font-mono text-text-muted">Loading agent {id.slice(0, 8)}…</p>
        {metaError && <p className="text-xs text-danger font-mono">{metaError}</p>}
      </div>
    );
  }

  if (!state) {
    return (
      <div className="min-h-screen bg-void grid-bg flex flex-col items-center justify-center gap-4 px-4">
        <p className="text-sm text-warning font-mono text-center max-w-md">
          {error || "Agent unavailable"}
        </p>
        {isOwner && !readOnly && (
          <button
            type="button"
            disabled={startingProcess}
            onClick={async () => {
              setStartingProcess(true);
              try {
                const result = await startAgentProcess(id);
                if (!result.ok) throw new Error(result.error);
                const live = await reconnect();
                if (!live) throw new Error("Process started but health check failed: wait and retry");
              } catch (e) {
                setMetaError(String(e));
              } finally {
                setStartingProcess(false);
              }
            }}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-semibold bg-neon/15 text-neon border border-neon/30 hover:bg-neon/25 disabled:opacity-40"
          >
            {startingProcess ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Power className="size-3.5" />
            )}
            {startingProcess ? "Starting agent…" : "Start agent process"}
          </button>
        )}
        <Link
          href="/profile"
          className="text-xs text-cyan hover:underline font-mono flex items-center gap-1"
        >
          <ArrowLeft className="size-3" /> Back to My Agents
        </Link>
        {metaError && <p className="text-xs text-danger font-mono">{metaError}</p>}
      </div>
    );
  }

  return (
    <div className="min-h-screen grid-bg scanlines relative">
      <div className="relative z-10">
        <div className="px-4 md:px-6 pt-3 max-w-[1600px] mx-auto flex items-center gap-3">
          <Link
            href="/profile"
            className="flex items-center gap-1 text-xs text-cyan hover:underline"
          >
            <ArrowLeft className="size-3" /> My agents
          </Link>
          <span className="text-xs text-text-muted font-mono">
            {displayName || `Agent ${id.slice(0, 8)}`}
            {agentUniverse && (
              <span className="ml-2 text-cyan">
                · {agentUniverseLabel(resolveAgentUniverse(agentUniverse))}
              </span>
            )}
            {ownerWallet && (
              <> · owner {ownerWallet.slice(0, 6)}…{ownerWallet.slice(-4)}</>
            )}
            {isOwner && (
              <span className="ml-2 text-neon">· you own this agent</span>
            )}
          </span>
        </div>

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

          <AutonomousPanel state={state} />
          <MetricCards state={state} />

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            <EquityChart state={state} />
            <AllocationChart state={state} onRefresh={readOnly ? undefined : handleResync} />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <TradeHistory trades={state.trades} />
            <ActivityFeed activity={state.activity} />
          </div>

          <PositionsTable
            positions={state.positions}
            readOnly={readOnly}
            connected={connected}
            onSell={readOnly ? undefined : handleSellPosition}
          />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <WalletPanel
              wallet={agentWallet}
              connected={connected}
              onSync={handleSyncWallet}
              readOnly={readOnly}
              ownerWallet={ownerWallet}
              agentId={isOwner ? id : undefined}
            />
            <RiskPanel state={state} />
          </div>

          <SignalMonitor
            signals={state.signals}
            lastSignalRefreshAt={state.lastSignalRefreshAt}
            signalRefreshSec={state.signalRefreshSec}
            readOnly={readOnly}
            onBlacklist={
              readOnly
                ? undefined
                : async (sym) => {
                    await blacklistToken(sym);
                  }
            }
            onUnblacklist={
              readOnly
                ? undefined
                : async (sym) => {
                    await unblacklistToken(sym);
                  }
            }
          />

          {!readOnly && (
            <AgentSettingsPanel agentId={id} connected={connected} />
          )}

          {!readOnly && <CommandPanel connected={connected} />}
        </main>
      </div>
    </div>
  );
}
