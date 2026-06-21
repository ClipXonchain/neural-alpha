"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  Wallet,
  Copy,
  Check,
  RefreshCw,
  Shield,
  Smartphone,
  ExternalLink,
  ArrowDownToLine,
} from "lucide-react";
import { cn, formatUsd, formatMetric, shortenHash } from "@/lib/utils";
import type { WalletSnapshot } from "@/lib/agent-api";

interface WalletPanelProps {
  wallet: WalletSnapshot | null;
  mode: "live" | "paper";
  connected: boolean;
  onSync: () => Promise<{ usdtBalance: number; synced: boolean }>;
  onRegister: () => Promise<Record<string, unknown>>;
  onSwitchMode: (mode: "local" | "walletconnect") => Promise<Record<string, unknown>>;
}

export function WalletPanel({
  wallet,
  mode,
  connected,
  onSync,
  onRegister,
  onSwitchMode,
}: WalletPanelProps) {
  const [copied, setCopied] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const copyAddress = () => {
    if (!wallet?.address) return;
    navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSync = async () => {
    setSyncing(true);
    setActionMsg(null);
    try {
      const r = await onSync();
      setActionMsg(r.synced ? `Synced ${formatUsd(r.usdtBalance)} USDT` : "Sync skipped (paper/mock)");
    } catch (e) {
      setActionMsg(String(e));
    } finally {
      setSyncing(false);
    }
  };

  const handleRegister = async () => {
    setRegistering(true);
    setActionMsg(null);
    try {
      await onRegister();
      setActionMsg("Registration submitted on BSC");
    } catch (e) {
      setActionMsg(String(e));
    } finally {
      setRegistering(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.25 }}
      className="glass-raised rounded-xl p-5"
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center size-7 rounded-lg bg-cyan/8">
            <Wallet className="size-3.5 text-cyan" />
          </div>
          <h3
            className="text-sm font-semibold tracking-wide uppercase"
            style={{ fontFamily: "var(--font-display)" }}
          >
            TWAK Wallet
          </h3>
        </div>
        <span
          className={cn(
            "text-[10px] font-bold px-2 py-0.5 rounded uppercase",
            mode === "live"
              ? "bg-neon/10 text-neon border border-neon/20"
              : "bg-warning/10 text-warning border border-warning/20"
          )}
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {mode} mode
        </span>
      </div>

      {!connected && (
        <p className="text-xs text-warning mb-4" style={{ fontFamily: "var(--font-mono)" }}>
          Agent not connected — restart with <code className="text-neon">npm run dev</code>
        </p>
      )}

      {/* Address */}
      <div className="rounded-lg bg-surface-overlay/60 p-3 mb-4">
        <p className="text-[10px] text-text-muted uppercase tracking-wider mb-1.5">
          Agent Wallet (BSC)
        </p>
        {wallet?.address ? (
          <div className="flex items-center justify-between gap-2">
            <code
              className="text-xs text-text-primary truncate"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {wallet.address}
            </code>
            <button
              onClick={copyAddress}
              className="shrink-0 flex items-center gap-1 text-[10px] text-cyan hover:text-neon transition-colors"
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        ) : (
          <p className="text-xs text-text-muted" style={{ fontFamily: "var(--font-mono)" }}>
            Connect TWAK MCP (`twak serve`) to bind wallet
          </p>
        )}
        {wallet && (
          <p className="text-[10px] text-text-muted mt-1.5" style={{ fontFamily: "var(--font-mono)" }}>
            {wallet.walletState} · {wallet.walletMode}
          </p>
        )}
      </div>

      {/* Balances */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="rounded-lg bg-surface-overlay/40 p-3">
          <p className="text-[10px] text-text-muted mb-1">USDT (trading)</p>
          <p
            className="text-lg font-bold text-neon tabular-nums"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {wallet ? formatUsd(wallet.usdtBalance) : "—"}
          </p>
        </div>
        <div className="rounded-lg bg-surface-overlay/40 p-3">
          <p className="text-[10px] text-text-muted mb-1">BNB (gas)</p>
          <p
            className="text-lg font-bold text-text-primary tabular-nums"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {wallet ? formatMetric(wallet.bnbBalance, 4) : "—"}
          </p>
        </div>
      </div>

      {/* Deposit instructions */}
      <div className="rounded-lg border border-cyan/15 bg-cyan/5 p-3 mb-4">
        <div className="flex items-start gap-2">
          <ArrowDownToLine className="size-4 text-cyan shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-semibold text-text-primary mb-1">Fund your agent</p>
            <p className="text-[11px] text-text-secondary leading-relaxed">
              Send <strong className="text-neon">USDT</strong> on BSC to the address above, then click
              Sync Balance. Keep some <strong>BNB</strong> for gas. Set{" "}
              <code className="text-cyan">AGENT_MODE=live</code> in .env for real swaps via TWAK.
            </p>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={handleSync}
          disabled={!connected || syncing}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-neon/10 text-neon border border-neon/20 hover:bg-neon/20 disabled:opacity-40 transition-colors"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          <RefreshCw className={cn("size-3.5", syncing && "animate-spin")} />
          Sync Balance
        </button>

        <button
          onClick={() => onSwitchMode("walletconnect")}
          disabled={!connected}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-surface-overlay text-text-secondary border border-border-dim hover:text-text-primary disabled:opacity-40 transition-colors"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          <Smartphone className="size-3.5" />
          Trust Wallet
        </button>

        <button
          onClick={handleRegister}
          disabled={!connected || registering || wallet?.registered}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-cyan/10 text-cyan border border-cyan/20 hover:bg-cyan/20 disabled:opacity-40 transition-colors"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          <Shield className="size-3.5" />
          {wallet?.registered ? "Registered" : "Register Competition"}
        </button>

        {wallet?.address && (
          <a
            href={`https://bscscan.com/address/${wallet.address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs text-text-muted hover:text-cyan transition-colors"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            BSCScan <ExternalLink className="size-3" />
          </a>
        )}
      </div>

      {actionMsg && (
        <p className="text-[10px] text-text-secondary mt-3" style={{ fontFamily: "var(--font-mono)" }}>
          {actionMsg}
        </p>
      )}

      <p className="text-[9px] text-text-muted mt-3 leading-relaxed">
        Self-custody: all trades signed locally via TWAK. Keys never leave your wallet.
        Optional phone signing via Trust Wallet (WalletConnect).
      </p>
    </motion.div>
  );
}
