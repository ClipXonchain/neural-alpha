"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  Wallet,
  Copy,
  Check,
  RefreshCw,
  ExternalLink,
  ArrowDownToLine,
  Coins,
  TrendingUp,
  TrendingDown,
  KeyRound,
  Loader2,
  ShieldAlert,
  EyeOff,
} from "lucide-react";
import { cn, formatUsd, formatMetric, shortenHash } from "@/lib/utils";
import type { WalletSnapshot } from "@/lib/agent-api";

interface WalletPanelProps {
  wallet: WalletSnapshot | null;
  connected: boolean;
  onSync: () => Promise<{ usdtBalance: number; synced: boolean }>;
  readOnly?: boolean;
  ownerWallet?: string | null;
  /** When set, owner can export the trading wallet seed phrase */
  agentId?: string;
}

export function WalletPanel({
  wallet,
  connected,
  onSync,
  readOnly,
  ownerWallet,
  agentId,
}: WalletPanelProps) {
  const [copied, setCopied] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);

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
      setActionMsg(r.synced ? `Synced ${formatUsd(r.usdtBalance)} USDT` : "Sync skipped (mock bridge)");
    } catch (e) {
      setActionMsg(String(e));
    } finally {
      setSyncing(false);
    }
  };

  const handleBackup = async () => {
    if (!agentId) return;
    const ok = window.confirm(
      "Reveal the trading wallet private key?\n\nAnyone with this key can move all funds. Only continue on a private device."
    );
    if (!ok) return;

    setBackupBusy(true);
    setBackupError(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/backup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Backup failed");
      setPrivateKey(data.privateKey as string);
    } catch (e) {
      setBackupError(e instanceof Error ? e.message : String(e));
    } finally {
      setBackupBusy(false);
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
            Agent Wallet
          </h3>
        </div>
        <span
          className="text-[10px] font-bold px-2 py-0.5 rounded uppercase bg-neon/10 text-neon border border-neon/20"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          live
        </span>
      </div>

      {!connected && (
        <p className="text-xs text-warning mb-4" style={{ fontFamily: "var(--font-mono)" }}>
          Agent not connected: check deployment status in My Agents
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
            Waiting for self-custodial wallet unlock…
          </p>
        )}
        {wallet && (
          <p className="text-[10px] text-text-muted mt-1.5" style={{ fontFamily: "var(--font-mono)" }}>
            {wallet.walletState} · {wallet.walletMode}
          </p>
        )}
        {ownerWallet && (
          <p className="text-[10px] text-text-muted mt-1.5" style={{ fontFamily: "var(--font-mono)" }}>
            Owner: {ownerWallet.slice(0, 6)}…{ownerWallet.slice(-4)}
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

      {/* Token holdings: scanned via Binance Web3 public API */}
      <TokenHoldings positions={wallet?.binancePositions} />

      {/* Deposit instructions: hidden on public/read-only deployments */}
      {!readOnly && (
        <div className="rounded-lg border border-cyan/15 bg-cyan/5 p-3 mb-4">
          <div className="flex items-start gap-2">
            <ArrowDownToLine className="size-4 text-cyan shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-text-primary mb-1">Fund your agent</p>
              <p className="text-[11px] text-text-secondary leading-relaxed">
                Send <strong className="text-neon">USDT</strong> on BSC to the address above, then click
                Sync Balance. Keep some <strong>BNB</strong> for gas.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        {!readOnly && (
          <button
            onClick={handleSync}
            disabled={!connected || syncing}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-neon/10 text-neon border border-neon/20 hover:bg-neon/20 disabled:opacity-40 transition-colors"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            <RefreshCw className={cn("size-3.5", syncing && "animate-spin")} />
            Sync Balance
          </button>
        )}

        {!readOnly && agentId && (
          <button
            onClick={handleBackup}
            disabled={backupBusy}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-warning/10 text-warning border border-warning/25 hover:bg-warning/20 disabled:opacity-40 transition-colors"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {backupBusy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <KeyRound className="size-3.5" />
            )}
            Backup key
          </button>
        )}

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

      {backupError && (
        <p className="text-[10px] text-danger mt-3 font-mono">{backupError}</p>
      )}

      {privateKey && (
        <div className="mt-4 rounded-xl border border-warning/40 bg-warning/10 p-3">
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="flex items-start gap-2">
              <ShieldAlert className="size-3.5 text-warning shrink-0 mt-0.5" />
              <p className="text-[11px] text-warning font-semibold">
                Private key: store offline & never share
              </p>
            </div>
            <button
              type="button"
              onClick={() => setPrivateKey(null)}
              className="text-text-muted hover:text-cyan"
              title="Hide private key"
            >
              <EyeOff className="size-3.5" />
            </button>
          </div>
          <code
            className="block break-all rounded bg-void/50 border border-border-dim px-2 py-2 font-mono text-[10px] text-text-primary mb-2"
          >
            {privateKey}
          </code>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(privateKey);
              setKeyCopied(true);
              setTimeout(() => setKeyCopied(false), 2000);
            }}
            className="flex items-center gap-1 text-[10px] text-cyan font-mono"
          >
            {keyCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {keyCopied ? "Copied" : "Copy private key"}
          </button>
        </div>
      )}

      {actionMsg && (
        <p className="text-[10px] text-text-secondary mt-3" style={{ fontFamily: "var(--font-mono)" }}>
          {actionMsg}
        </p>
      )}
    </motion.div>
  );
}

type BinancePosition = NonNullable<WalletSnapshot["binancePositions"]>[number];

/** Match backend / portfolio MIN_POSITION_VALUE_USD: hide dust & airdrop spam. */
const DUST_THRESHOLD_USD = 1;

function TokenHoldings({ positions }: { positions?: BinancePosition[] }) {
  if (!positions || positions.length === 0) return null;

  const withValue = positions.map((p) => ({
    ...p,
    valueUsd: p.valueUsd > 0 ? p.valueUsd : p.remainQty * p.price,
  }));
  const sorted = [...withValue].sort((a, b) => b.valueUsd - a.valueUsd);
  const visible = sorted.filter((p) => p.valueUsd >= DUST_THRESHOLD_USD);
  const dustCount = sorted.length - visible.length;
  const totalUsd = visible.reduce((sum, p) => sum + p.valueUsd, 0);

  return (
    <div className="rounded-lg bg-surface-overlay/40 p-3 mb-4">
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-1.5">
          <Coins className="size-3.5 text-cyan" />
          <p className="text-[10px] text-text-muted uppercase tracking-wider">
            Token Holdings
          </p>
        </div>
        <span
          className="text-[10px] text-text-secondary tabular-nums font-semibold"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {formatUsd(totalUsd)}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        {visible.map((p) => {
          const up = p.percentChange24h >= 0;
          return (
            <div
              key={`${p.symbol}-${p.contractAddress}`}
              className="flex items-center justify-between gap-2 py-1 border-b border-border-dim/40 last:border-b-0"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="text-[12px] font-semibold text-text-primary truncate max-w-[110px]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {p.symbol}
                </span>
                <span
                  className="text-[10px] text-text-muted tabular-nums"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {formatMetric(p.remainQty, 4)}
                </span>
              </div>
              <div className="flex items-center gap-2.5 shrink-0">
                <span
                  className={cn(
                    "flex items-center gap-0.5 text-[10px] tabular-nums",
                    up ? "text-neon" : "text-danger"
                  )}
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {up ? <TrendingUp className="size-2.5" /> : <TrendingDown className="size-2.5" />}
                  {Math.abs(p.percentChange24h).toFixed(1)}%
                </span>
                <span
                  className="text-[11px] text-text-primary tabular-nums font-semibold w-12 text-right"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {formatUsd(p.valueUsd)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {dustCount > 0 && (
        <p
          className="text-[9px] text-text-muted mt-2"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          +{dustCount} dust/spam token{dustCount > 1 ? "s" : ""} hidden (&lt; $1)
        </p>
      )}
    </div>
  );
}
