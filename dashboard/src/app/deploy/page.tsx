"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createWalletClient,
  createPublicClient,
  custom,
  http,
  parseEther,
  type Address,
  type Hash,
} from "viem";
import { bsc } from "viem/chains";
import { useAuthWallet } from "@/hooks/useReadOnly";
import {
  AGENT_UNIVERSE_OPTIONS,
  DEFAULT_AGENT_UNIVERSE,
  agentUniverseLabel,
  type AgentUniverse,
} from "@/lib/agent-universe";
import {
  ArrowLeft,
  Bot,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Rocket,
  ShieldAlert,
  Layers,
  Combine,
  Wallet,
  CandlestickChart,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

function AlphaSign({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center font-semibold leading-none select-none",
        className
      )}
      aria-hidden
    >
      α
    </span>
  );
}

const UNIVERSE_ICONS: Record<Exclude<AgentUniverse, "alpha">, LucideIcon> = {
  spot: Layers,
  both: Combine,
  bstocks: CandlestickChart,
};

const UNIVERSE_ACCENT: Record<AgentUniverse, string> = {
  spot: "text-cyan",
  alpha: "text-warning",
  both: "text-neon",
  bstocks: "text-warning",
};

const UNIVERSE_RING: Record<AgentUniverse, string> = {
  spot: "border-cyan/40 bg-cyan/8",
  alpha: "border-warning/40 bg-warning/8",
  both: "border-neon/40 bg-neon/8",
  bstocks: "border-warning/40 bg-warning/8",
};

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function namePlaceholder(universe: AgentUniverse) {
  if (universe === "spot") return "My Spot Bot";
  if (universe === "alpha") return "My Alpha Bot";
  if (universe === "bstocks") return "My bStocks Bot";
  return "My Trading Agent";
}

export default function DeployPage() {
  const { wallet, loading: authLoading } = useAuthWallet();
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [agentUniverse, setAgentUniverse] =
    useState<AgentUniverse>(DEFAULT_AGENT_UNIVERSE);
  const [feeBnb, setFeeBnb] = useState("0.01");
  const [treasury, setTreasury] = useState<string | null>(null);
  const [skipFee, setSkipFee] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paidFeeTxHash, setPaidFeeTxHash] = useState<string | null>(null);
  const [manualFeeTxHash, setManualFeeTxHash] = useState("");
  const [copied, setCopied] = useState<"seed" | "secret" | null>(null);
  const [savedSeed, setSavedSeed] = useState(false);
  const [result, setResult] = useState<{
    agentId: string;
    tradingWallet: string | null;
    apiSecret: string;
    mnemonic: string;
    agentUniverse: AgentUniverse;
  } | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!wallet) router.replace("/login");
  }, [wallet, authLoading, router]);

  useEffect(() => {
    fetch("/api/agents/deploy")
      .then((r) => r.json())
      .then((d: { feeBnb?: string; treasury?: string | null; skipFee?: boolean }) => {
        if (d.feeBnb) setFeeBnb(d.feeBnb);
        setTreasury(d.treasury ?? null);
        setSkipFee(!!d.skipFee);
      })
      .catch(() => undefined);
  }, []);

  const copyText = async (text: string, kind: "seed" | "secret") => {
    await navigator.clipboard.writeText(text);
    setCopied(kind);
    setTimeout(() => setCopied(null), 2000);
  };

  const deploy = async () => {
    setBusy(true);
    setError(null);
    try {
      let feeTxHash = `0x${"0".repeat(64)}`;

      if (!skipFee && treasury && window.ethereum && wallet) {
        // Reuse a fee tx already paid this session / pasted from BscScan
        const existing =
          paidFeeTxHash ||
          (manualFeeTxHash.trim().match(/^0x[a-fA-F0-9]{64}$/)
            ? manualFeeTxHash.trim()
            : null);

        if (existing) {
          feeTxHash = existing;
          setPaidFeeTxHash(existing);
        } else {
          await window.ethereum
            .request({
              method: "wallet_switchEthereumChain",
              params: [{ chainId: "0x38" }],
            })
            .catch(() => null);

          const walletClient = createWalletClient({
            chain: bsc,
            transport: custom(window.ethereum),
          });
          feeTxHash = await walletClient.sendTransaction({
            account: wallet as Address,
            to: treasury as Address,
            value: parseEther(feeBnb),
            chain: bsc,
          });
          setPaidFeeTxHash(feeTxHash);
        }

        // Wait until BSC confirms before calling the API (avoids TransactionNotFoundError)
        const publicClient = createPublicClient({
          chain: bsc,
          transport: custom(window.ethereum),
        });
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: feeTxHash as Hash,
          confirmations: 1,
          timeout: 120_000,
          pollingInterval: 1_500,
        });
        if (receipt.status !== "success") {
          throw new Error(
            "Fee transaction failed on-chain — check BscScan and try again"
          );
        }
      }

      const res = await fetch("/api/agents/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: displayName || undefined,
          feeTxHash,
          agentUniverse,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Deploy failed");
      if (!data.mnemonic) {
        throw new Error(
          "Deploy succeeded but seed phrase was not returned: contact support"
        );
      }

      setResult({
        agentId: data.agent.id,
        tradingWallet: data.agent.trading_wallet,
        apiSecret: data.apiSecret,
        mnemonic: data.mnemonic,
        agentUniverse,
      });
      setPaidFeeTxHash(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (authLoading || !wallet) {
    return (
      <div className="min-h-screen bg-void flex items-center justify-center">
        <Loader2 className="size-6 text-neon animate-spin" />
      </div>
    );
  }

  if (result) {
    const words = result.mnemonic.trim().split(/\s+/);
    return (
      <div className="min-h-screen bg-void deploy-atmosphere px-4 py-8 md:py-12">
        <div className="deploy-panel mx-auto w-full max-w-5xl">
          <header className="mb-8 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex size-11 items-center justify-center rounded-2xl border border-neon/30 bg-neon/10">
                <Bot className="size-5 text-neon" />
              </div>
              <div>
                <p
                  className="text-base font-bold tracking-tight text-text-primary"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  Neural Alpha
                </p>
                <p className="text-[11px] font-mono uppercase tracking-[0.18em] text-neon mt-0.5">
                  Deploy complete
                </p>
              </div>
            </div>
          </header>

          <div className="rounded-3xl border border-neon/25 bg-surface-raised overflow-hidden shadow-[0_32px_100px_-48px_rgba(0,0,0,0.95)]">
            <div className="border-b border-border-dim px-6 md:px-10 py-8 bg-gradient-to-r from-neon/12 via-transparent to-cyan/5">
              <div className="flex items-center gap-2 mb-3">
                <span className="inline-flex size-6 items-center justify-center rounded-full bg-neon text-void">
                  <Check className="size-3.5" strokeWidth={3} />
                </span>
                <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-neon">
                  Agent provisioned
                </p>
              </div>
              <h1
                className="text-3xl md:text-4xl font-bold text-text-primary tracking-tight"
                style={{ fontFamily: "var(--font-display)" }}
              >
                Your agent is live
              </h1>
              <p className="mt-3 text-sm md:text-base text-text-secondary leading-relaxed max-w-2xl">
                Fund the trading wallet with USDT (BSC) and a little BNB for gas.
                Back up the seed before you leave: it is shown once.
              </p>
            </div>

            <div className="p-6 md:p-10 grid grid-cols-1 lg:grid-cols-5 gap-6 md:gap-8">
              <div className="lg:col-span-2 space-y-3">
                <div className="rounded-2xl border border-border-dim bg-void/50 px-4 py-4">
                  <p className="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5">
                    Type
                  </p>
                  <p className="text-base font-semibold text-text-primary">
                    {agentUniverseLabel(result.agentUniverse)}
                  </p>
                </div>
                <div className="rounded-2xl border border-border-dim bg-void/50 px-4 py-4">
                  <p className="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5">
                    Agent ID
                  </p>
                  <p className="text-xs font-mono text-text-primary break-all leading-relaxed">
                    {result.agentId}
                  </p>
                </div>
                <div className="rounded-2xl border border-border-dim bg-void/50 px-4 py-4">
                  <p className="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5">
                    Trading wallet
                  </p>
                  <p className="text-xs font-mono text-text-primary break-all leading-relaxed">
                    {result.tradingWallet}
                  </p>
                </div>
              </div>

              <div className="lg:col-span-3 space-y-4">
                <div className="rounded-2xl border border-warning/35 bg-warning/8 p-5 md:p-6">
                  <div className="flex items-start gap-3 mb-4">
                    <ShieldAlert className="size-5 text-warning shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-warning">
                        Wallet backup · 12-word seed
                      </p>
                      <p className="text-xs text-text-secondary mt-1.5 leading-relaxed">
                        Write these words offline. Anyone with them can drain the
                        wallet. We never email this.
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 mb-4">
                    {words.map((w, i) => (
                      <div
                        key={`${i}-${w}`}
                        className="rounded-xl bg-void/70 border border-border-dim px-3 py-2.5 font-mono text-xs text-text-primary"
                      >
                        <span className="text-text-muted mr-1.5 tabular-nums">
                          {i + 1}.
                        </span>
                        {w}
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => copyText(result.mnemonic, "seed")}
                    className="inline-flex items-center gap-1.5 text-xs text-cyan hover:text-neon transition-colors font-mono"
                  >
                    {copied === "seed" ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                    {copied === "seed" ? "Copied to clipboard" : "Copy seed phrase"}
                  </button>
                </div>

                <label className="flex items-start gap-3 cursor-pointer rounded-2xl border border-border-dim bg-surface-overlay/40 px-4 py-4 hover:border-border-glow transition-colors">
                  <input
                    type="checkbox"
                    checked={savedSeed}
                    onChange={(e) => setSavedSeed(e.target.checked)}
                    className="mt-0.5 size-4 accent-[var(--color-neon)]"
                  />
                  <span className="text-sm text-text-secondary leading-relaxed">
                    I have written down my seed phrase and stored it somewhere safe
                  </span>
                </label>

                <details className="group rounded-2xl border border-border-dim bg-void/40">
                  <summary className="cursor-pointer list-none px-4 py-3.5 flex items-center gap-2 text-xs font-mono text-text-muted hover:text-text-secondary">
                    <KeyRound className="size-3.5" />
                    API secret (optional ops key)
                    <span className="ml-auto text-text-muted group-open:rotate-90 transition-transform">
                      ›
                    </span>
                  </summary>
                  <div className="px-4 pb-4 flex items-start justify-between gap-2">
                    <p className="font-mono text-[11px] break-all text-text-muted leading-relaxed">
                      {result.apiSecret}
                    </p>
                    <button
                      type="button"
                      onClick={() => copyText(result.apiSecret, "secret")}
                      className="shrink-0 text-cyan hover:text-neon"
                      aria-label="Copy API secret"
                    >
                      {copied === "secret" ? (
                        <Check className="size-3.5" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                    </button>
                  </div>
                </details>

                {savedSeed ? (
                  <Link
                    href={`/agents/${result.agentId}`}
                    className="flex items-center justify-center gap-2 w-full px-5 py-4 rounded-2xl bg-neon text-void text-base font-semibold hover:brightness-110 transition-[filter]"
                  >
                    <Rocket className="size-4" />
                    Open agent dashboard
                  </Link>
                ) : (
                  <button
                    type="button"
                    disabled
                    className="w-full px-5 py-4 rounded-2xl bg-surface-overlay text-text-muted border border-border-dim font-semibold text-sm opacity-60 cursor-not-allowed"
                  >
                    Confirm seed backup to continue
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const selected = AGENT_UNIVERSE_OPTIONS.find((o) => o.id === agentUniverse);

  return (
    <div className="min-h-screen bg-void deploy-atmosphere px-4 py-8 md:py-12">
      <div className="deploy-panel mx-auto w-full max-w-6xl">
        <header className="mb-8 md:mb-10 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-2xl border border-neon/30 bg-neon/10">
              <Bot className="size-5 text-neon" />
            </div>
            <div>
              <p
                className="text-base md:text-lg font-bold tracking-tight text-text-primary leading-none"
                style={{ fontFamily: "var(--font-display)" }}
              >
                Neural Alpha
              </p>
              <p className="text-[11px] font-mono text-text-muted mt-1.5 uppercase tracking-[0.18em]">
                Deploy console
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/profile"
              className="hidden sm:inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-cyan transition-colors font-mono"
            >
              <ArrowLeft className="size-3.5" />
              My agents
            </Link>
            <div className="flex items-center gap-2 rounded-full border border-border-dim bg-surface/80 px-3 py-2">
              <Wallet className="size-3.5 text-cyan" />
              <span className="text-xs font-mono text-text-secondary">
                {shortAddr(wallet)}
              </span>
            </div>
          </div>
        </header>

        <div className="rounded-3xl border border-border-dim bg-surface-raised overflow-hidden shadow-[0_32px_100px_-48px_rgba(0,0,0,0.95)]">
          <div className="grid grid-cols-1 lg:grid-cols-12 min-h-[640px]">
            {/* Left rail */}
            <aside className="lg:col-span-4 border-b lg:border-b-0 lg:border-r border-border-dim bg-void/35 px-6 md:px-8 py-8 md:py-10 flex flex-col">
              <div className="flex items-center gap-2 mb-4">
                <span className="h-px w-8 bg-neon/70" />
                <p className="text-[11px] font-mono uppercase tracking-[0.22em] text-neon">
                  Step 01 · Provision
                </p>
              </div>
              <h1
                className="text-3xl md:text-[2.35rem] font-bold text-text-primary tracking-tight leading-[1.1]"
                style={{ fontFamily: "var(--font-display)" }}
              >
                Deploy your
                <span className="block text-neon mt-1">trading agent</span>
              </h1>
              <p className="mt-4 text-sm md:text-[15px] text-text-secondary leading-relaxed">
                Choose a universe, name the agent, then pay a small BNB fee for an
                isolated self-custodial wallet on BNB Smart Chain.
              </p>

              <div className="mt-8 space-y-3">
                {[
                  "Self-custodial keystore (seed shown once)",
                  "Isolated process + API secret",
                  "Live Binance Web3 aggregator swaps on BSC",
                ].map((line) => (
                  <div
                    key={line}
                    className="flex items-start gap-2.5 text-sm text-text-secondary"
                  >
                    <span className="mt-1.5 size-1.5 rounded-full bg-neon shrink-0" />
                    <span>{line}</span>
                  </div>
                ))}
              </div>

              <div className="mt-auto pt-10">
                <div className="rounded-2xl border border-border-dim bg-surface-raised/80 p-5">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <p className="text-[10px] font-mono uppercase tracking-[0.16em] text-text-muted">
                      Deploy fee
                    </p>
                    <p className="text-xl font-bold tabular-nums text-neon">
                      {feeBnb}
                      <span className="text-sm font-normal text-text-muted ml-1">
                        BNB
                      </span>
                    </p>
                  </div>
                  {treasury && (
                    <p className="text-[11px] font-mono text-text-muted truncate mb-2">
                      Treasury · {shortAddr(treasury)}
                    </p>
                  )}
                  <p className="text-xs text-text-secondary leading-relaxed">
                    Selected:{" "}
                    <span className={cn("font-semibold", UNIVERSE_ACCENT[agentUniverse])}>
                      {agentUniverseLabel(agentUniverse)}
                    </span>
                    {selected ? ` · ${selected.tagline}` : null}
                  </p>
                </div>
              </div>
            </aside>

            {/* Main stage */}
            <div className="lg:col-span-8 p-6 md:p-8 lg:p-10 deploy-stagger flex flex-col gap-8">
              <section>
                <div className="flex items-end justify-between gap-3 mb-4">
                  <div>
                    <p className="text-[11px] font-mono uppercase tracking-[0.16em] text-text-muted mb-1">
                      Agent category
                    </p>
                    <p className="text-sm text-text-secondary">
                      What this agent is allowed to trade
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 md:gap-4">
                  {AGENT_UNIVERSE_OPTIONS.map((opt) => {
                    const isSelected = agentUniverse === opt.id;
                    const Icon =
                      opt.id === "alpha" ? null : UNIVERSE_ICONS[opt.id];
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setAgentUniverse(opt.id)}
                        data-selected={isSelected}
                        className={cn(
                          "deploy-universe group relative flex flex-col text-left rounded-2xl border p-5 min-h-[148px] transition-all duration-200",
                          isSelected
                            ? UNIVERSE_RING[opt.id]
                            : "bg-surface-overlay/40 border-border-dim hover:border-cyan/35 hover:bg-surface-overlay/70"
                        )}
                      >
                        <div className="flex items-start justify-between gap-3 mb-3">
                          <span
                            className={cn(
                              "flex size-11 shrink-0 items-center justify-center rounded-xl border transition-colors",
                              isSelected
                                ? "border-current/30 bg-void/40"
                                : "border-border-dim bg-void/40 text-text-muted group-hover:text-cyan"
                            )}
                          >
                            {opt.id === "alpha" ? (
                              <AlphaSign
                                className={cn(
                                  "text-[22px]",
                                  isSelected ? UNIVERSE_ACCENT[opt.id] : undefined
                                )}
                              />
                            ) : (
                              Icon && (
                                <Icon
                                  className={cn(
                                    "size-5",
                                    isSelected && UNIVERSE_ACCENT[opt.id]
                                  )}
                                />
                              )
                            )}
                          </span>
                          <span
                            className={cn(
                              "deploy-universe-check flex size-6 shrink-0 items-center justify-center rounded-full border",
                              isSelected
                                ? "border-neon bg-neon text-void opacity-100 scale-100"
                                : "border-border-glow"
                            )}
                          >
                            <Check className="size-3.5" strokeWidth={3} />
                          </span>
                        </div>
                        <span className="flex items-center gap-2 flex-wrap">
                          <span className="text-base font-semibold text-text-primary">
                            {opt.label}
                          </span>
                          {opt.id === "both" && (
                            <span className="text-[9px] font-bold uppercase tracking-wide text-neon bg-neon/12 border border-neon/20 px-1.5 py-0.5 rounded">
                              Recommended
                            </span>
                          )}
                        </span>
                        <span
                          className={cn(
                            "mt-1 block text-xs font-mono",
                            isSelected
                              ? UNIVERSE_ACCENT[opt.id]
                              : "text-text-secondary"
                          )}
                        >
                          {opt.tagline}
                        </span>
                        <span className="mt-2 block text-[12px] text-text-muted leading-snug">
                          {opt.detail}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="grid grid-cols-1 md:grid-cols-5 gap-4 items-end">
                <div className="md:col-span-3">
                  <label
                    htmlFor="agent-display-name"
                    className="block text-[11px] font-mono uppercase tracking-[0.16em] text-text-muted mb-2"
                  >
                    Display name
                  </label>
                  <input
                    id="agent-display-name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder={namePlaceholder(agentUniverse)}
                    className="w-full px-4 py-3.5 rounded-2xl bg-void/60 border border-border-dim text-sm md:text-base text-text-primary placeholder:text-text-muted/70 outline-none focus:border-neon/45 focus:ring-1 focus:ring-neon/20 transition-shadow"
                  />
                </div>
                <div className="md:col-span-2 rounded-2xl border border-border-dim bg-void/45 px-4 py-3.5">
                  <p className="text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1">
                    After deploy
                  </p>
                  <p className="text-xs text-text-secondary leading-relaxed">
                    You receive a 12-word seed for the agent wallet. Keep it offline.
                  </p>
                </div>
              </section>

              {error && (
                <div
                  role="alert"
                  className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3.5 text-sm font-mono text-danger leading-relaxed"
                >
                  {error}
                </div>
              )}

              {!skipFee && treasury && (
                <div className="rounded-2xl border border-border-dim bg-void/40 px-4 py-3">
                  <label
                    htmlFor="fee-tx-hash"
                    className="block text-[10px] font-mono uppercase tracking-wider text-text-muted mb-1.5"
                  >
                    Already paid? Paste fee tx hash (optional)
                  </label>
                  <input
                    id="fee-tx-hash"
                    value={manualFeeTxHash || paidFeeTxHash || ""}
                    onChange={(e) => {
                      setManualFeeTxHash(e.target.value.trim());
                      setPaidFeeTxHash(null);
                    }}
                    placeholder="0x…"
                    className="w-full px-3 py-2 rounded-xl bg-void/60 border border-border-dim text-xs font-mono text-text-primary placeholder:text-text-muted/70 outline-none focus:border-neon/45"
                  />
                </div>
              )}

              <div className="mt-auto flex flex-col sm:flex-row gap-3 sm:items-center pt-2">
                <button
                  type="button"
                  onClick={deploy}
                  disabled={busy}
                  className="flex-1 flex items-center justify-center gap-2 px-5 py-4 rounded-2xl bg-neon text-void text-base font-semibold hover:brightness-110 disabled:opacity-50 disabled:hover:brightness-100 transition-[filter,opacity]"
                >
                  {busy ? (
                    <Loader2 className="size-5 animate-spin" />
                  ) : (
                    <Rocket className="size-5" />
                  )}
                  {busy
                    ? "Confirming fee & deploying…"
                    : paidFeeTxHash || manualFeeTxHash.match(/^0x[a-fA-F0-9]{64}$/)
                      ? `Finish deploy ${agentUniverseLabel(agentUniverse)}`
                      : `Pay & deploy ${agentUniverseLabel(agentUniverse)}`}
                </button>
                <Link
                  href="/profile"
                  className="sm:hidden flex items-center justify-center gap-1.5 text-xs text-text-muted hover:text-cyan transition-colors font-mono py-2"
                >
                  <ArrowLeft className="size-3.5" />
                  My agents
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
