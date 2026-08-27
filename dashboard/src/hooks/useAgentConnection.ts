"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { AgentState } from "@/lib/mock-data";
import type { WalletSnapshot, LogEntry, Track1Snapshot } from "@/lib/agent-api";
import { logEntryToActivity } from "@/lib/brain-narrative";
import {
  fetchAgentState,
  fetchWallet,
  fetchLogs,
  subscribeAgentEvents,
  startAgent,
  stopAgent,
  resyncAgent,
  syncWallet,
  registerCompetition,
  startWalletSignin,
  verifyWalletSignin,
  saveAgentConfig,
  sellPosition,
} from "@/lib/agent-api";
import { mapTrack1ToDashboard, enrichStateWithWallet, mergeWalletLiveIntoSignals } from "@/lib/map-agent-state";
import { generateOfflineState } from "@/lib/mock-data";

function offlineMessage(): string {
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      return "Agent offline — start the agent with: npm run dev";
    }
  }
  return "Agent API unreachable — reconnecting automatically…";
}

export function useAgentConnection() {
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<AgentState | null>(null);
  const [wallet, setWallet] = useState<WalletSnapshot | null>(null);
  const [bridgeSource, setBridgeSource] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [agentConfig, setAgentConfig] = useState<Track1Snapshot["config"] | null>(null);
  const connectedRef = useRef(false);
  const walletRef = useRef<WalletSnapshot | null>(null);
  const [boot, setBoot] = useState(0);

  const refreshWallet = useCallback(async () => {
    if (!connectedRef.current) return;
    try {
      const w = await fetchWallet();
      setWallet(w);
      walletRef.current = w;
      setState((prev) =>
        prev
          ? mergeWalletLiveIntoSignals(
              enrichStateWithWallet(prev, w?.binancePositions),
              w?.binancePositions
            )
          : prev
      );
    } catch {
      /* wallet cache may still be warming */
    }
  }, []);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let cancelled = false;
    let walletPoll: ReturnType<typeof setInterval> | undefined;

    (async () => {
      try {
        const [snap, logs] = await Promise.all([
          fetchAgentState(),
          fetchLogs().catch(() => [] as LogEntry[]),
        ]);
        if (cancelled) return;
        setConnected(true);
        connectedRef.current = true;
        setState(mapTrack1ToDashboard(snap, logs));
        setBridgeSource(snap.bridgeSource || "agent");
        setAgentConfig(snap.config);
        setError(null);
        setLoading(false);
        void refreshWallet();

        let pollCount = 0;
        walletPoll = setInterval(() => {
          pollCount++;
          void refreshWallet();
          if (pollCount >= 6 && walletPoll) {
            clearInterval(walletPoll);
            walletPoll = setInterval(() => { void refreshWallet(); }, 30000);
          }
        }, 5000);

        unsub = subscribeAgentEvents(
          (liveSnap) => {
            setConnected(true);
            connectedRef.current = true;
            setError(null);
            setState((prev) => {
              const next = enrichStateWithWallet(
                mapTrack1ToDashboard(liveSnap, logs),
                walletRef.current?.binancePositions
              );
              if (prev && next.activity.length <= 1) {
                next.activity = prev.activity;
              }
              return next;
            });
            setBridgeSource(liveSnap.bridgeSource || "agent");
            setAgentConfig(liveSnap.config);
          },
          (logEntry) => {
            setState((prev) => {
              if (!prev) return prev;
              const newItem = logEntryToActivity(
                logEntry,
                `${logEntry.timestamp}-${Math.random().toString(36).slice(2, 6)}`
              );
              if (!newItem) return prev;
              const activity = [newItem, ...prev.activity].slice(0, 120);
              return { ...prev, activity };
            });
          }
        );
      } catch (e) {
        if (cancelled) return;
        setConnected(false);
        connectedRef.current = false;
        setError(e instanceof Error ? e.message : offlineMessage());
        setState(generateOfflineState());
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      unsub?.();
      if (walletPoll) clearInterval(walletPoll);
    };
  }, [refreshWallet, boot]);

  // Retry when the agent was down on first load (e.g. PM2 restart) — no full reload.
  useEffect(() => {
    if (connected || loading) return;
    const retry = setInterval(() => {
      void fetchAgentState()
        .then(() => setBoot((n) => n + 1))
        .catch(() => undefined);
    }, 5_000);
    return () => clearInterval(retry);
  }, [connected, loading]);

  const handleStart = useCallback(async () => {
    if (connectedRef.current) {
      await startAgent();
      const snap = await fetchAgentState();
      setState(enrichStateWithWallet(mapTrack1ToDashboard(snap), walletRef.current?.binancePositions));
    } else {
      setState((prev) =>
        prev ? { ...prev, status: "running" } : prev
      );
    }
  }, []);

  const handleStop = useCallback(async () => {
    if (connectedRef.current) {
      await stopAgent();
      setState((prev) => (prev ? { ...prev, status: "paused" } : prev));
    } else {
      setState((prev) => (prev ? { ...prev, status: "paused" } : prev));
    }
  }, []);

  const handleSyncWallet = useCallback(async () => {
    const result = await syncWallet();
    await refreshWallet();
    const snap = await fetchAgentState();
    setState(enrichStateWithWallet(mapTrack1ToDashboard(snap), walletRef.current?.binancePositions));
    return result;
  }, [refreshWallet]);

  const handleResync = useCallback(async () => {
    if (!connectedRef.current) return;
    await resyncAgent();
    await refreshWallet();
    const snap = await fetchAgentState();
    setState((prev) => {
      const next = enrichStateWithWallet(
        mapTrack1ToDashboard(snap),
        walletRef.current?.binancePositions
      );
      if (prev) next.activity = prev.activity;
      return next;
    });
  }, [refreshWallet]);

  const handleRegister = useCallback(async () => {
    const result = await registerCompetition();
    await refreshWallet();
    return result;
  }, [refreshWallet]);

  const handleWalletSignin = useCallback(async () => {
    return startWalletSignin();
  }, []);

  const handleWalletVerify = useCallback(
    async (qrCodeId: string) => {
      const result = await verifyWalletSignin(qrCodeId);
      await refreshWallet();
      return result;
    },
    [refreshWallet]
  );

  const handleSaveConfig = useCallback(
    async (updates: Record<string, unknown>) => {
      const result = await saveAgentConfig(updates);
      if (result.ok && result.config) setAgentConfig(result.config);
      return result;
    },
    []
  );

  const handleSellPosition = useCallback(
    async (symbol: string) => {
      if (!connectedRef.current) {
        throw new Error("Agent offline — start the agent first.");
      }
      const result = await sellPosition(symbol);
      if (!result.ok) {
        throw new Error(result.message || `Failed to sell ${symbol}`);
      }
      await resyncAgent();
      await refreshWallet();
      const snap = await fetchAgentState();
      setState((prev) => {
        const next = enrichStateWithWallet(
          mapTrack1ToDashboard(snap),
          walletRef.current?.binancePositions
        );
        if (prev) next.activity = prev.activity;
        return next;
      });
    },
    [refreshWallet]
  );

  return {
    connected,
    loading,
    state,
    wallet,
    bridgeSource,
    agentConfig,
    error,
    handleStart,
    handleStop,
    handleSyncWallet,
    handleResync,
    handleRegister,
    handleWalletSignin,
    handleWalletVerify,
    handleSaveConfig,
    handleSellPosition,
    refreshWallet,
  };
}
