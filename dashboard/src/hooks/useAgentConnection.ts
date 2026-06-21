"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { AgentState } from "@/lib/mock-data";
import type { WalletSnapshot, LogEntry, Track1Snapshot } from "@/lib/agent-api";
import {
  checkAgentConnection,
  fetchAgentState,
  fetchWallet,
  fetchLogs,
  subscribeAgentEvents,
  stopAgent,
  syncWallet,
  registerCompetition,
  switchWalletMode,
  saveAgentConfig,
} from "@/lib/agent-api";
import { mapTrack1ToDashboard } from "@/lib/map-agent-state";
import { generateMockState } from "@/lib/mock-data";

export function useAgentConnection() {
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<AgentState | null>(null);
  const [wallet, setWallet] = useState<WalletSnapshot | null>(null);
  const [bridgeSource, setBridgeSource] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [agentConfig, setAgentConfig] = useState<Track1Snapshot["config"] | null>(null);
  const connectedRef = useRef(false);

  const refreshWallet = useCallback(async () => {
    if (!connectedRef.current) return;
    try {
      const w = await fetchWallet();
      setWallet(w);
    } catch { /* agent may not have TWAK */ }
  }, []);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      const ok = await checkAgentConnection();
      if (cancelled) return;
      setConnected(ok);
      connectedRef.current = ok;

      if (ok) {
        try {
          const [snap, logs] = await Promise.all([
            fetchAgentState(),
            fetchLogs().catch(() => []),
          ]);
          if (cancelled) return;
          setState(mapTrack1ToDashboard(snap, logs));
          setBridgeSource(snap.bridgeSource || "agent");
          setAgentConfig(snap.config);
          await refreshWallet();

          unsub = subscribeAgentEvents(
            (liveSnap) => {
              setState((prev) => {
                const next = mapTrack1ToDashboard(liveSnap, logs);
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
                const newItem = {
                  id: `${logEntry.timestamp}-${Math.random().toString(36).slice(2, 6)}`,
                  timestamp: new Date(logEntry.timestamp).getTime(),
                  type: (["trade", "signal", "risk", "error"].includes(logEntry.level)
                    ? logEntry.level
                    : "info") as "trade" | "signal" | "risk" | "info" | "error",
                  message: logEntry.event,
                  detail: logEntry.data ? JSON.stringify(logEntry.data) : logEntry.txHash,
                };
                const activity = [newItem, ...prev.activity].slice(0, 200);
                return { ...prev, activity };
              });
            }
          );
        } catch (e) {
          if (cancelled) return;
          setError(String(e));
          setState(generateMockState());
        }
      } else {
        setState(generateMockState());
        setError("Agent offline — showing demo data. Start with: npm run dev");
      }

      setLoading(false);
    })();

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [refreshWallet]);

  const handleStop = useCallback(async () => {
    if (connectedRef.current) {
      await stopAgent();
      setState((prev) => (prev ? { ...prev, status: "paused" } : prev));
    } else {
      setState((prev) =>
        prev ? { ...prev, status: prev.status === "running" ? "paused" : "running" } : prev
      );
    }
  }, []);

  const handleSyncWallet = useCallback(async () => {
    const result = await syncWallet();
    await refreshWallet();
    const snap = await fetchAgentState();
    setState(mapTrack1ToDashboard(snap));
    return result;
  }, [refreshWallet]);

  const handleRegister = useCallback(async () => {
    const result = await registerCompetition();
    await refreshWallet();
    return result;
  }, [refreshWallet]);

  const handleSwitchWallet = useCallback(
    async (mode: "local" | "walletconnect") => {
      const result = await switchWalletMode(mode);
      await refreshWallet();
      return result;
    },
    [refreshWallet]
  );

  const handleSaveConfig = useCallback(
    async (updates: Record<string, unknown>) => {
      return saveAgentConfig(updates);
    },
    []
  );

  return {
    connected,
    loading,
    state,
    wallet,
    bridgeSource,
    agentConfig,
    error,
    handleStop,
    handleSyncWallet,
    handleRegister,
    handleSwitchWallet,
    handleSaveConfig,
    refreshWallet,
  };
}
