"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { AgentState } from "@/lib/mock-data";
import type { WalletSnapshot, LogEntry, Track1Snapshot } from "@/lib/agent-api";
import { logEntryToActivity } from "@/lib/brain-narrative";
import {
  checkAgentConnection,
  fetchAgentState,
  fetchWallet,
  fetchLogs,
  subscribeAgentEvents,
  startAgent,
  stopAgent,
  resyncAgent,
  syncWallet,
  sendCommand,
} from "@/lib/agent-api";
import { mapTrack1ToDashboard, enrichStateWithWallet, mergeWalletLiveIntoSignals } from "@/lib/map-agent-state";

function offlineMessage(): string {
  return "Agent process is offline: start it to resume trading.";
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
  const sseUnsubRef = useRef<(() => void) | undefined>(undefined);
  const logsRef = useRef<LogEntry[]>([]);

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
      /* agent wallet may be unavailable */
    }
  }, []);

  const bootstrapLive = useCallback(async () => {
    const [snap, logs] = await Promise.all([
      fetchAgentState(),
      fetchLogs().catch(() => [] as LogEntry[]),
    ]);
    logsRef.current = logs;
    setState(mapTrack1ToDashboard(snap, logs));
    setBridgeSource(snap.bridgeSource || "agent");
    setAgentConfig(snap.config);
    setError(null);
    await refreshWallet();

    sseUnsubRef.current?.();
    sseUnsubRef.current = subscribeAgentEvents(
      (liveSnap) => {
        setState((prev) => {
          const next = enrichStateWithWallet(
            mapTrack1ToDashboard(liveSnap, logsRef.current),
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
        logsRef.current = [logEntry, ...logsRef.current].slice(0, 200);
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
  }, [refreshWallet]);

  useEffect(() => {
    let cancelled = false;
    let walletPoll: ReturnType<typeof setInterval> | undefined;

    (async () => {
      const ok = await checkAgentConnection();
      if (cancelled) return;
      setConnected(ok);
      connectedRef.current = ok;

      if (ok) {
        try {
          await bootstrapLive();
          let pollCount = 0;
          walletPoll = setInterval(() => {
            pollCount++;
            void refreshWallet();
            if (pollCount >= 6 && walletPoll) {
              clearInterval(walletPoll);
              walletPoll = setInterval(() => {
                void refreshWallet();
              }, 30000);
            }
          }, 5000);
        } catch (e) {
          if (cancelled) return;
          setError(String(e));
          setState(null);
        }
      } else {
        setState(null);
        setError(offlineMessage());
      }

      setLoading(false);
    })();

    return () => {
      cancelled = true;
      sseUnsubRef.current?.();
      if (walletPoll) clearInterval(walletPoll);
    };
  }, [bootstrapLive, refreshWallet]);

  // Retry when the agent was down on first load: reconnect without full page reload.
  useEffect(() => {
    if (connected) return;
    const retry = setInterval(async () => {
      const ok = await checkAgentConnection();
      if (!ok) return;
      connectedRef.current = true;
      setConnected(true);
      setError(null);
      try {
        await bootstrapLive();
      } catch (e) {
        setError(String(e));
      }
    }, 10_000);
    return () => clearInterval(retry);
  }, [connected, bootstrapLive]);

  const handleStart = useCallback(async () => {
    if (!connectedRef.current) {
      throw new Error("Agent offline: start the agent process first.");
    }
    await startAgent();
    const snap = await fetchAgentState();
    setState(enrichStateWithWallet(mapTrack1ToDashboard(snap), walletRef.current?.binancePositions));
  }, []);

  const handleStop = useCallback(async () => {
    if (!connectedRef.current) return;
    await stopAgent();
    setState((prev) => (prev ? { ...prev, status: "paused" } : prev));
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

  const handleSellPosition = useCallback(
    async (symbol: string) => {
      if (!connectedRef.current) {
        throw new Error("Agent offline: start the agent first.");
      }
      const result = await sendCommand(`sell all ${symbol}`);
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
    handleSellPosition,
    refreshWallet,
    reconnect: async () => {
      const ok = await checkAgentConnection();
      if (!ok) return false;
      connectedRef.current = true;
      setConnected(true);
      setError(null);
      try {
        await bootstrapLive();
        return true;
      } catch (e) {
        setError(String(e));
        return false;
      }
    },
  };
}
