"use client";

import { AnimatedNumber } from "@/components/portal/animated-number";
import { AssetLogo, PaymentMethodSelector } from "@/components/portal/payment-selector";
import { AnimatePresence, motion } from "framer-motion";
import Image from "next/image";
import { ArrowDownLeft, ArrowRight, Check, ChevronLeft, CircleHelp, Copy, CreditCard, LockKeyhole, QrCode, ShieldCheck, WalletCards, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Order = {
  id: string;
  hostId: string;
  asset: string;
  amountDisplay: string;
  treasuryAddress: string;
  tokenContract: string;
  expiresAt: string;
  priceUsd: number;
  status?: string;
  paymentTx?: string | null;
  paidAmountDisplay?: string | null;
  confirmations?: number | null;
  createdAt?: string;
  updatedAt?: string;
};

type Tenant = {
  container_name?: string;
  status?: string;
  agent_mode?: string;
  payment_asset?: string;
  host_id?: string;
  paid_until?: string | null;
  wallet_address?: string | null;
  risk_preset?: string;
  buys_halted?: number;
};

type Holding = { symbol?: string; valueUsd?: number };
type Trade = { side?: string; symbol?: string; usd?: number; pnl?: number | null; tx?: string };
type Book = {
  navUsd?: number;
  cashUsd?: number;
  dailyPnlUsd?: number;
  realizedPnlUsd?: number;
  trades?: number;
  wins?: number;
  losses?: number;
  holdings?: Holding[];
  recent?: Trade[];
};

type Step = "quote" | "pay" | "check" | "confirmed" | "agent";
type PaymentChannel = "crypto" | "card" | "binance";
type EthereumProvider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

const ASSETS = [
  { id: "USDT", label: "USDT", detail: "BEP-20" },
  { id: "USDC", label: "USDC", detail: "BEP-20" },
  { id: "BNB", label: "BNB", detail: "Native" },
  { id: "U", label: "U", detail: "BEP-20" },
  { id: "USD1", label: "USD1", detail: "BEP-20" },
];

const CAPS = [
  { id: "cautious", label: "Cautious", detail: "$50 automatic buy · $15 off-hours max" },
  { id: "normal", label: "Normal", detail: "$100 automatic buy · $25 off-hours max" },
  { id: "active", label: "Active", detail: "$250 automatic buy · $40 off-hours max" },
];

const SHIFT = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] as const } },
  exit: { opacity: 0, y: -10, transition: { duration: 0.2 } },
};

async function readJson(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function money(n: unknown) {
  const val = Number(n) || 0;
  return (val < 0 ? "-$" : "$") + Math.abs(val).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function splitAmount(display: string) {
  const [whole, fraction = ""] = String(display || "0").split(".");
  return { whole: Number(whole) || 0, fraction };
}

export function PortalDesk() {
  const [step, setStep] = useState<Step>("quote");
  const [booting, setBooting] = useState(true);
  const [asset, setAsset] = useState("USDT");
  const [channel, setChannel] = useState<PaymentChannel>("crypto");
  const [preset, setPreset] = useState("cautious");
  const [order, setOrder] = useState<Order | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [hash, setHash] = useState("");
  const [left, setLeft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [checkAt, setCheckAt] = useState(0);
  const [pairCode, setPairCode] = useState("");
  const [qr, setQr] = useState("");
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreTx, setRestoreTx] = useState("");

  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const data = await readJson(await fetch("/api/portal/session"));
        if (stop) return;
        setTenant(data.tenant || null);
        setBook(data.state || null);
        setStep("agent");
      } catch {
        try {
          const checkout = await readJson(await fetch("/api/portal/order-status", { cache: "no-store" }));
          if (stop) return;
          if (checkout.order?.id) setOrder(checkout.order);
          if (checkout.activated) {
            const live = await fetch("/api/portal/session", { cache: "no-store" }).then(readJson).catch(() => null);
            if (stop) return;
            setTenant(checkout.tenant || live?.tenant || null);
            setBook(live?.state || null);
            setStep("confirmed");
          } else if (checkout.order?.status === "pending") {
            setStep("pay");
          }
        } catch {
          /* this browser has neither an active session nor an open order */
        }
      } finally {
        if (!stop) setBooting(false);
      }
    })();
    return () => {
      stop = true;
    };
  }, []);

  useEffect(() => {
    if (!order?.id || (step !== "pay" && step !== "check")) return;
    let stop = false;
    let reading = false;
    const poll = async () => {
      if (reading) return;
      reading = true;
      try {
        const response = await fetch("/api/portal/order-status", { cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (stop || !response.ok || !data.activated) return;
        setOrder(data.order || null);
        setTenant(data.tenant || null);
        const live = await fetch("/api/portal/session", { cache: "no-store" }).then(readJson).catch(() => null);
        if (stop) return;
        if (live?.tenant) setTenant(live.tenant);
        if (live?.state) setBook(live.state);
        setStep("confirmed");
        setError("");
      } catch {
        // Keep polling; the explicit transaction-hash path remains available.
      } finally {
        reading = false;
      }
    };
    void poll();
    const id = setInterval(poll, 5_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [order?.id, step]);

  useEffect(() => {
    if (!order?.expiresAt || step === "quote") return;
    const end = Date.parse(order.expiresAt);
    const tick = () => {
      const ms = end - Date.now();
      if (ms <= 0) {
        setLeft("expired");
        return;
      }
      const m = Math.floor(ms / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      setLeft(`${m}:${String(s).padStart(2, "0")}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [order?.expiresAt, step]);

  const amount = useMemo(() => splitAmount(order?.amountDisplay || "0"), [order?.amountDisplay]);
  const progress = step === "quote" ? 0.08 : step === "pay" ? 0.4 : step === "check" ? 0.72 : step === "confirmed" ? 0.96 : 1;
  const confirmationDate = order?.updatedAt && Number.isFinite(Date.parse(order.updatedAt))
    ? new Date(order.updatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
    : "Just now";

  async function lockQuote() {
    setError("");
    setBusy("lock");
    try {
      const data = await readJson(
        await fetch("/api/portal/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paymentAsset: asset, preset }),
        }),
      );
      setOrder(data.order);
      setStep("pay");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Quote failed");
    } finally {
      setBusy("");
    }
  }

  async function verify() {
    setError("");
    if (!/^0x[a-fA-F0-9]{64}$/.test(hash.trim())) {
      setCheckAt(1);
      setError("The hash must be 0x and 64 hex characters.");
      return;
    }
    setBusy("verify");
    setCheckAt(2);
    try {
      const data = await readJson(
        await fetch("/api/portal/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paymentTx: hash.trim() }),
        }),
      );
      setCheckAt(4);
      setOrder(data.order || order);
      setTenant(data.tenant || null);
      const live = await fetch("/api/portal/session").then(readJson).catch(() => null);
      if (live?.state) setBook(live.state);
      if (live?.tenant) setTenant(live.tenant);
      setStep("confirmed");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Verification failed";
      setCheckAt(/confirmation/i.test(message) ? 3 : 2);
      setError(message);
    } finally {
      setBusy("");
    }
  }

  async function restore() {
    setError("");
    const tx = restoreTx.trim().toLowerCase();
    const eth = (window as Window & { ethereum?: EthereumProvider }).ethereum;
    if (!eth) {
      setError("Open this page in the wallet that paid the fee.");
      return;
    }
    setBusy("restore");
    try {
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const account = accounts?.[0];
      if (!account) throw new Error("No account selected");
      const signature = (await eth.request({
        method: "personal_sign",
        params: [`Neural Alpha\n${tx}`, account],
      })) as string;
      const data = await readJson(
        await fetch("/api/portal/restore", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paymentTx: tx, signature }),
        }),
      );
      setTenant(data.tenant || null);
      const live = await fetch("/api/portal/session").then(readJson).catch(() => null);
      if (live?.tenant) setTenant(live.tenant);
      if (live?.state) setBook(live.state);
      setStep("agent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the agent");
    } finally {
      setBusy("");
    }
  }

  async function act(op: string, body?: unknown) {
    setError("");
    setBusy(op);
    try {
      const data = await readJson(
        await fetch("/api/portal/act", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op, body }),
        }),
      );
      if (op === "pair-start") {
        setPairCode(String(data.pairingCode || ""));
        setQr(String(data.qrCodeId || ""));
      } else {
        const live = await fetch("/api/portal/session").then(readJson);
        setTenant(live.tenant || null);
        setBook(live.state || null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy("");
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      setError("Copy is unavailable in this browser.");
    }
  }

  const panel = "rounded-2xl border border-white/[0.09] bg-[#101316] shadow-[0_24px_80px_rgba(0,0,0,.25)]";
  const buttonPrimary = "inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[#18cf7a] px-5 text-sm font-semibold text-[#03140b] transition hover:bg-[#37e28f] disabled:cursor-wait disabled:opacity-60";
  const buttonQuiet = "inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.035] px-5 text-sm font-medium text-[#dce4e9] transition hover:border-white/20 hover:bg-white/[0.07]";
  const progressLabels = ["Plan", "Payment", "Activate"];

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#080b0d] text-[#edf3f3] selection:bg-[#18cf7a]/30">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_18%_0%,rgba(13,111,75,.17),transparent_36%),radial-gradient(ellipse_at_92%_32%,rgba(30,99,121,.10),transparent_34%)]" />
      <header className="relative z-10 border-b border-white/[0.07] bg-[#080b0d]/85 backdrop-blur-xl">
        <div className="mx-auto flex h-[76px] max-w-[1280px] items-center justify-between px-5 sm:px-8">
          <a href="/portal" aria-label="Neural Alpha home"><Image src="/brand/neural-alpha-logo.png" alt="Neural Alpha" width={174} height={50} priority className="h-auto w-[148px] sm:w-[168px]" /></a>
          <div className="flex items-center gap-3 sm:gap-6">
            <span className="hidden items-center gap-2 text-xs text-[#8c999f] sm:flex"><span className="h-1.5 w-1.5 rounded-full bg-[#18cf7a] shadow-[0_0_10px_#18cf7a]" /> BNB Smart Chain</span>
            <span className="rounded-full border border-white/10 px-3 py-1.5 font-mono text-[10px] tracking-wide text-[#aab6bc]">CHAIN 56</span>
            {step === "agent" ? <button className={buttonQuiet + " min-h-9 px-3 text-xs"} onClick={() => setStep("quote")}>Account</button> : step === "confirmed" ? <button className={buttonQuiet + " min-h-9 px-3 text-xs"} onClick={() => setStep("agent")}>Open workspace</button> : <button className="inline-flex items-center gap-2 text-xs text-[#aab6bc] transition hover:text-white" onClick={() => setRestoreOpen((v) => !v)}><LockKeyhole size={14} /> <span className="hidden sm:inline">Already subscribed?</span><span className="sm:hidden">Sign in</span></button>}
          </div>
        </div>
      </header>

      <main className="relative mx-auto max-w-[1280px] px-5 pb-20 pt-7 sm:px-8 sm:pt-10">
        <div className="mb-8 flex items-center justify-between gap-4 border-b border-white/[0.07] pb-5">
          <div><p className="text-[10px] font-semibold uppercase tracking-[.23em] text-[#718087]">Customer portal <span className="px-1.5 text-[#3d494e]">/</span> {step === "agent" ? "Workspace" : step === "confirmed" ? "Order confirmed" : "Secure checkout"}</p><p className="mt-1.5 text-sm text-[#bec9cd]">{step === "agent" ? "Your autonomous trading desk" : step === "confirmed" ? "Payment received and verified" : "Configure your Neural Alpha agent"}</p></div>
          <div className="flex items-center gap-2 sm:gap-3">
            {progressLabels.map((label, index) => { const active = progress >= [0, 0.4, 0.72][index]; return <div key={label} className="flex items-center gap-2 text-[10px] sm:text-xs"><span className={`grid h-6 w-6 place-items-center rounded-full border ${active ? "border-[#18cf7a]/50 bg-[#18cf7a]/10 text-[#18cf7a]" : "border-white/10 text-[#647177]"}`}>{progress > [0.08, 0.4, 0.72][index] ? <Check size={12} /> : index + 1}</span><span className={active ? "text-[#c8d2d5]" : "hidden text-[#647177] sm:inline"}>{label}</span>{index < 2 ? <span className="mx-0.5 h-px w-3 bg-white/10 sm:w-7" /> : null}</div>; })}
          </div>
        </div>

        {booting ? <div className={`${panel} grid min-h-64 place-items-center text-sm text-[#8c999f]`}><span className="animate-pulse">Opening your workspace…</span></div> : null}
        {!booting ? <AnimatePresence mode="wait">
          {step === "quote" ? <motion.div key="quote" {...SHIFT}>
            <section className="relative mb-7 min-h-[260px] overflow-hidden rounded-2xl border border-white/10 bg-[#080d10] sm:min-h-[310px]">
              <Image src="/brand/na-hero-brain.png" alt="Neural Alpha autonomous trading system" fill priority sizes="(max-width: 1280px) 100vw, 1280px" className="object-cover object-center opacity-[0.82]" />
              <div className="absolute inset-0 bg-gradient-to-r from-[#080b0d] via-[#080b0d]/85 to-transparent sm:via-[#080b0d]/60" />
              <div className="relative flex min-h-[260px] max-w-[660px] flex-col justify-center px-6 py-8 sm:min-h-[310px] sm:px-10">
                <p className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.25em] text-[#42da99]"><span className="h-px w-6 bg-[#42da99]" /> Autonomous bStock trading</p>
                <h1 className="max-w-[12ch] text-[38px] font-medium leading-[1.03] tracking-[-.045em] sm:text-[54px]">An intelligent desk, <span className="text-[#aebbc0]">built around you.</span></h1>
                <p className="mt-4 max-w-[47ch] text-sm leading-6 text-[#a0adb2] sm:text-[15px]">Choose your operating limits and start your dedicated agent. Trading capital stays in your Binance wallet.</p>
                <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-[11px] text-[#9aa8ad]"><span className="flex items-center gap-1.5"><ShieldCheck size={14} className="text-[#42da99]" /> Non-custodial funds</span><span className="flex items-center gap-1.5"><Zap size={14} className="text-[#42da99]" /> Binance Agentic Wallet</span></div>
              </div>
            </section>

            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_370px]">
              <section className={`${panel} p-5 sm:p-7`}>
                <div className="mb-6 flex items-start justify-between gap-4"><div><p className="text-[10px] font-semibold uppercase tracking-[.2em] text-[#6f7e83]">01 <span className="mx-1 text-[#384448]">/</span> Select payment</p><h2 className="mt-2 text-2xl font-medium tracking-[-.03em]">Start your subscription</h2><p className="mt-1.5 text-sm text-[#839197]">30 days of a dedicated Neural Alpha agent</p></div><span className="rounded-lg border border-white/10 bg-white/[0.035] px-2.5 py-1.5 font-mono text-[10px] text-[#96a3a8]">30 DAYS</span></div>
                <div className="grid grid-cols-3 gap-2.5">
                  {([{ id: "crypto", title: "Crypto", sub: "BSC network", icon: WalletCards, ready: true }, { id: "card", title: "Card", sub: "Coming soon", icon: CreditCard, ready: false }, { id: "binance", title: "Binance Pay", sub: "Coming soon", icon: QrCode, ready: false }] as const).map((option) => { const Icon = option.icon; const selected = channel === option.id; return <button key={option.id} type="button" onClick={() => setChannel(option.id)} aria-pressed={selected} className={`relative flex min-h-[92px] flex-col items-start justify-between rounded-xl border p-3.5 text-left transition sm:p-4 ${selected ? "border-[#18cf7a]/55 bg-[#18cf7a]/[0.07]" : "border-white/[0.08] bg-white/[0.025] hover:border-white/20"}`}><span className="flex w-full items-center justify-between"><Icon size={18} className={selected ? "text-[#42da99]" : "text-[#95a2a7]"} />{!option.ready ? <span className="rounded-full bg-white/[0.06] px-1.5 py-1 text-[8px] font-semibold uppercase tracking-wide text-[#738187] sm:text-[9px]">Soon</span> : selected ? <Check size={14} className="text-[#42da99]" /> : null}</span><span><span className="block text-xs font-medium sm:text-sm">{option.title}</span><span className="mt-0.5 block text-[10px] text-[#7f8d92] sm:text-[11px]">{option.sub}</span></span></button>; })}
                </div>
                {channel === "crypto" ? <div className="mt-7"><PaymentMethodSelector label="Pay with a BSC asset" methods={ASSETS} selectedId={asset} onSelectionChange={setAsset} layout="row" /></div> : <div className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]"><div className="rounded-xl border border-[#e6b45b]/20 bg-[#e6b45b]/[0.055] p-4 text-sm text-[#c0b49a]"><p className="font-medium text-[#e3cb9e]">{channel === "card" ? "Card payments are not available yet." : "Binance Pay is not connected yet."}</p><p className="mt-1 text-xs leading-5 text-[#938b79]">Choose Crypto to continue securely on BNB Smart Chain. No card details are collected here.</p></div>{channel === "card" ? <div aria-label="Card checkout preview only; card payments are not available" className="relative min-h-[122px] overflow-hidden rounded-xl border border-white/10 bg-gradient-to-br from-[#213e36] via-[#172923] to-[#101617] p-4"><div className="absolute -right-9 -top-12 h-36 w-36 rounded-full border border-white/[0.08]"/><div className="absolute -right-2 -top-5 h-28 w-28 rounded-full border border-white/[0.07]"/><p className="relative text-[9px] font-semibold uppercase tracking-[.18em] text-[#9fb9ae]">Card checkout preview</p><p className="relative mt-5 font-mono text-xs tracking-[.18em] text-white/80">•••• &nbsp; •••• &nbsp; •••• &nbsp; ••••</p><p className="relative mt-2 text-[9px] uppercase tracking-[.16em] text-[#8ba096]">Not available yet</p></div> : null}</div>}
                {error ? <p role="alert" className="mt-5 rounded-lg border border-[#ff6975]/20 bg-[#ff6975]/[0.06] px-3 py-2.5 text-sm text-[#ff8e97]">{error}</p> : null}
                <div className="mt-6 flex flex-col gap-3 border-t border-white/[0.07] pt-5 sm:flex-row sm:items-center sm:justify-between"><p className="flex items-center gap-2 text-[11px] text-[#78868b]"><LockKeyhole size={13} /> Secure, on-chain payment verification</p><button type="button" className={buttonPrimary + " w-full sm:w-auto"} disabled={busy === "lock" || channel !== "crypto"} onClick={lockQuote}>{busy === "lock" ? "Preparing quote…" : <>Continue to payment <ArrowRight size={16} /></>}</button></div>
                <div className="mt-5 border-t border-white/[0.07] pt-4"><button type="button" className="flex items-center gap-2 text-xs text-[#8d9a9f] hover:text-white" onClick={() => setRestoreOpen((v) => !v)}><LockKeyhole size={13} /> Already paid? Restore your account <ArrowRight size={13} /></button>{restoreOpen ? <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]"><input aria-label="Fee transaction hash" className="h-11 min-w-0 rounded-lg border border-white/10 bg-[#0a0e10] px-3 font-mono text-xs outline-none transition placeholder:text-[#546168] focus:border-[#18cf7a]/50" placeholder="Paste your BSC payment transaction hash" value={restoreTx} onChange={(e) => setRestoreTx(e.target.value)} spellCheck={false} /><button type="button" className={buttonQuiet + " min-h-11"} disabled={busy === "restore"} onClick={restore}>{busy === "restore" ? "Confirm in wallet…" : "Sign in with wallet"}</button></div> : null}</div>
              </section>
              <aside className="grid gap-4">
                <div className={`${panel} overflow-hidden`}><div className="border-b border-white/[0.07] px-5 py-4"><p className="text-[10px] uppercase tracking-[.2em] text-[#728087]">02 <span className="mx-1 text-[#384448]">/</span> Configure risk</p><h3 className="mt-1.5 text-lg font-medium">Choose your buy limits</h3></div><div className="p-4"><PaymentMethodSelector label="Maximum new buy size" methods={CAPS} selectedId={preset} onSelectionChange={setPreset} /><div className="mt-4 rounded-lg border border-white/[0.07] bg-white/[0.025] px-3.5 py-3"><p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.13em] text-[#aebabe]"><CircleHelp size={13} className="text-[#42da99]"/> What does this limit mean?</p><p className="mt-2 text-[11px] leading-[1.65] text-[#9ba8ad]">This is the most the agent may spend on one automatic stock entry. It can spend less or skip a trade; the cap is a ceiling, not a target. During closed or overnight markets, a lower per-order cap applies, and the agent may open only one new position at a time. This is not your wallet balance, total portfolio value, or a loss limit. A holding can grow above its entry cap, and the agent can still sell the full holding.</p></div><div className="mt-3 rounded-lg bg-white/[0.035] px-3.5 py-3"><p className="text-[10px] font-semibold uppercase tracking-[.13em] text-[#748187]">Always in your control</p><p className="mt-1.5 text-xs leading-5 text-[#9ba8ad]">Pause the agent any time. Deposits and trading funds stay in your Binance wallet.</p></div></div></div>
                <div className="rounded-2xl border border-white/[0.07] bg-[#0d1113]/90 px-5 py-4"><div className="flex items-center gap-2 text-xs font-medium text-[#bac5c9]"><CircleHelp size={15} className="text-[#42da99]" /> What happens next?</div><ol className="mt-3 grid gap-2.5 text-[11px] leading-5 text-[#7f8c91]"><li className="flex gap-2"><span className="font-mono text-[#42da99]">01</span> Lock a 30-minute quote in your chosen asset.</li><li className="flex gap-2"><span className="font-mono text-[#42da99]">02</span> Send the exact amount to the treasury on BSC.</li><li className="flex gap-2"><span className="font-mono text-[#42da99]">03</span> Verify the receipt and pair your Binance wallet.</li></ol></div>
              </aside>
            </div>
          </motion.div> : null}

          {step === "pay" && order ? <motion.div key="pay" {...SHIFT} className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_370px]">
            <section className={`${panel} p-5 sm:p-8`}><button type="button" onClick={() => setStep("quote")} className="mb-6 flex items-center gap-1 text-xs text-[#88969b] hover:text-white"><ChevronLeft size={15} /> Edit checkout</button><div className="flex items-center gap-3"><AssetLogo asset={order.asset}/><div><p className="text-[10px] font-semibold uppercase tracking-[.2em] text-[#708087]">Payment details <span className="mx-1 text-[#384448]">/</span> {order.asset} on BSC</p><h1 className="mt-1 text-3xl font-medium tracking-[-.035em] sm:text-4xl">Send your payment</h1></div></div><p className="mt-3 text-sm text-[#839197]">Transfer the exact amount below to activate your agent.</p>
              <div className="mt-8 rounded-xl border border-[#18cf7a]/20 bg-[#18cf7a]/[0.045] p-5 sm:p-6"><p className="text-[10px] uppercase tracking-[.18em] text-[#7e8e93]">Exact amount · quote expires in {left === "expired" ? "expired" : left || "30:00"}</p><p className="mt-3 flex flex-wrap items-baseline gap-2"><AnimatedNumber value={amount.whole} className="text-[56px] font-medium leading-none tracking-[-.055em] sm:text-[68px]" /><span className="max-w-full break-all font-mono text-[23px] leading-tight text-[#42da99] sm:text-[28px]">.{amount.fraction || "000000"}</span><span className="text-base text-[#94a1a6]">{order.asset}</span></p><p className="mt-2 text-[10px] leading-4 text-[#7e8e93]">Includes a unique transfer marker worth less than $0.01.</p><button type="button" className="mt-4 inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs text-[#c2cdd1] hover:bg-white/[0.06]" onClick={() => copy(order.amountDisplay)}><Copy size={13} /> Copy exact amount</button></div>
              <div className="mt-6"><div className="mb-2 flex items-center justify-between"><label className="text-xs font-medium text-[#bac5c9]">Treasury address</label><span className="text-[10px] uppercase tracking-wider text-[#728087]">BNB Smart Chain</span></div><div className="flex items-center gap-3 rounded-xl border border-white/10 bg-[#0a0e10] p-3.5"><p className="min-w-0 flex-1 break-all font-mono text-[11px] leading-5 text-[#b9c5ca] sm:text-xs">{order.treasuryAddress}</p><button type="button" aria-label="Copy treasury address" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/10 text-[#42da99] hover:bg-white/[0.05]" onClick={() => copy(order.treasuryAddress)}><Copy size={15} /></button></div></div>
              {order.asset !== "BNB" ? <div className="mt-4"><div className="mb-2 flex items-center justify-between"><label className="text-xs font-medium text-[#bac5c9]">{order.asset} token contract</label><a href={`https://bscscan.com/token/${order.tokenContract}`} target="_blank" rel="noreferrer" className="text-[10px] text-[#42da99] hover:underline">Check on BscScan</a></div><div className="flex items-center gap-3 rounded-xl border border-white/10 bg-[#0a0e10] p-3"><p className="min-w-0 flex-1 break-all font-mono text-[10px] leading-5 text-[#849297]">{order.tokenContract}</p><button type="button" aria-label="Copy token contract" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-white/10 text-[#42da99] hover:bg-white/[0.05]" onClick={() => copy(order.tokenContract)}><Copy size={14} /></button></div></div> : null}
              <div className="mt-5 flex gap-3 rounded-xl border border-[#e6b45b]/15 bg-[#e6b45b]/[0.045] p-3.5 text-xs leading-5 text-[#b2a687]"><ShieldCheck size={16} className="mt-0.5 shrink-0 text-[#d3b264]" /><p>Send exactly <strong className="font-semibold text-[#d9c99f]">{order.amountDisplay} {order.asset}</strong> on <strong className="font-semibold text-[#d9c99f]">BNB Smart Chain</strong>. Other networks, short payments, and extra payments cannot activate automatically.</p></div>
              {error ? <p role="alert" className="mt-5 text-sm text-[#ff8e97]">{error}</p> : null}<div className="mt-7 flex flex-col gap-3 sm:flex-row"><button type="button" className={buttonPrimary + " flex-1"} onClick={() => { setError(""); setCheckAt(0); setStep("check"); }}>I’ve sent the payment <ArrowRight size={16} /></button><button type="button" className={buttonQuiet} onClick={() => setStep("quote")}>Back</button></div>
            </section>
            <aside className={`${panel} p-5`}><p className="text-[10px] font-semibold uppercase tracking-[.2em] text-[#718087]">Order summary</p><div className="mt-5 flex justify-between border-b border-white/[0.07] pb-4 text-sm"><span className="text-[#87959a]">Neural Alpha · 30 days</span><span>{money(order.priceUsd)}</span></div><div className="mt-4 flex justify-between text-sm"><span className="text-[#87959a]">Network fee</span><span className="text-[#87959a]">Paid by sender</span></div><div className="mt-5 flex justify-between border-t border-white/[0.07] pt-4 text-sm font-medium"><span>Total due</span><span>{order.amountDisplay} {order.asset}</span></div><div className="mt-6 flex items-center gap-3 rounded-xl bg-white/[0.035] p-3.5"><div className="grid h-9 w-9 place-items-center rounded-lg bg-[#18cf7a]/10 text-[#42da99]"><LockKeyhole size={16} /></div><div><p className="text-xs font-medium">Protected checkout</p><p className="mt-0.5 text-[10px] text-[#78868b]">Receipt confirmed on-chain</p></div></div><p className="mt-4 text-[11px] leading-5 text-[#728087]">Your quote is unique to this order. Keep this page open until your transfer has been confirmed.</p></aside>
          </motion.div> : null}

          {step === "check" ? <motion.div key="check" {...SHIFT} className="mx-auto max-w-[760px]"><section className={`${panel} p-5 sm:p-9`}><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-[#18cf7a]/20 bg-[#18cf7a]/[0.07] text-[#42da99]"><ArrowDownLeft size={23} /></div><h1 className="mt-5 text-center text-3xl font-medium tracking-[-.035em]">Verify your payment</h1><p className="mx-auto mt-2 max-w-[45ch] text-center text-sm leading-6 text-[#86949a]">Paste the transaction hash from your wallet. We’ll confirm it directly against BNB Smart Chain.</p><label className="mt-8 block text-xs font-medium text-[#bac5c9]" htmlFor="payment-hash">Transaction hash</label><input id="payment-hash" aria-label="Transaction hash" className="mt-2 h-12 w-full rounded-xl border border-white/10 bg-[#0a0e10] px-3.5 font-mono text-xs outline-none transition placeholder:text-[#526066] focus:border-[#18cf7a]/50" placeholder="0x…" value={hash} onChange={(e) => setHash(e.target.value)} spellCheck={false} /><ol className="mt-7 grid gap-0 sm:grid-cols-4">{["Hash received", "Receipt found", "15 confirmations", "Agent provisioned"].map((label, i) => { const state = checkAt > i + 1 ? "done" : checkAt === i + 1 ? "now" : "wait"; const bad = Boolean(error) && checkAt === i + 1; return <li key={label} className="flex items-center gap-2 border-l border-white/[0.08] py-2 pl-3 text-[11px] first:border-0 first:pl-0 sm:flex-col sm:items-start sm:border-l sm:py-0 sm:pl-3 sm:first:border-l sm:first:pl-3" style={{ color: bad ? "#ff6975" : state === "wait" ? "#637177" : state === "done" ? "#42da99" : "#dce4e7" }}><span className={`grid h-5 w-5 place-items-center rounded-full border ${state === "done" ? "border-[#18cf7a]/40 bg-[#18cf7a]/10" : "border-white/10"}`}>{state === "done" ? <Check size={11} /> : i + 1}</span>{label}</li>; })}</ol>{error ? <p role="alert" className="mt-5 rounded-lg bg-[#ff6975]/[0.06] px-3 py-2 text-sm text-[#ff8e97]">{error}</p> : null}<div className="mt-7 flex flex-col gap-3 sm:flex-row"><button type="button" className={buttonPrimary + " flex-1"} disabled={busy === "verify"} onClick={verify}>{busy === "verify" ? "Checking confirmations…" : "Verify transaction"} <ArrowRight size={15} /></button><button type="button" className={buttonQuiet} onClick={() => setStep("pay")}>Back to payment</button></div></section></motion.div> : null}

          {step === "confirmed" ? <motion.div key="confirmed" {...SHIFT} className="mx-auto max-w-[760px]"><section className="overflow-hidden rounded-2xl border border-[#18cf7a]/20 bg-[#101614] shadow-[0_28px_90px_rgba(0,0,0,.3)]"><div className="relative overflow-hidden border-b border-dashed border-[#30423a] px-6 py-7 sm:px-9"><div className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full border border-[#18cf7a]/10"/><div className="relative flex items-start gap-4"><div className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-[#18cf7a]/25 bg-[#18cf7a]/10 text-[#42da99]"><Check size={23}/></div><div className="min-w-0 flex-1"><p className="text-[10px] font-semibold uppercase tracking-[.2em] text-[#42da99]">Payment confirmed</p><h1 className="mt-1.5 text-2xl font-medium tracking-[-.035em] sm:text-3xl">Your order is complete</h1><p className="mt-2 text-sm leading-6 text-[#8e9d98]">The payment has been matched to your quote and confirmed on BNB Smart Chain.</p></div><span className="hidden rounded-full border border-[#18cf7a]/20 bg-[#18cf7a]/[.06] px-3 py-1.5 font-mono text-[10px] text-[#42da99] sm:inline-flex">PAID</span></div></div><div className="grid gap-6 px-6 py-6 sm:grid-cols-[1fr_210px] sm:px-9"><div><p className="text-[9px] font-semibold uppercase tracking-[.18em] text-[#73827b]">Receipt</p><div className="mt-4 flex items-center gap-3"><AssetLogo asset={order?.asset || asset}/><div><p className="text-[10px] text-[#84938d]">Received amount</p><p className="mt-0.5 font-mono text-lg font-medium text-[#edf5f0]">{order?.paidAmountDisplay || order?.amountDisplay || "—"} <span className="text-sm text-[#a7b3ad]">{order?.asset || asset}</span></p></div></div><dl className="mt-5 grid gap-3 border-t border-white/[.07] pt-4 text-xs"><div className="flex justify-between gap-4"><dt className="text-[#7f8d86]">Order reference</dt><dd className="font-mono text-[#c4cec8]">{order?.id || "—"}</dd></div><div className="flex justify-between gap-4"><dt className="text-[#7f8d86]">Plan</dt><dd className="text-right text-[#c4cec8]">Neural Alpha · 30 days</dd></div><div className="flex justify-between gap-4"><dt className="text-[#7f8d86]">Network</dt><dd className="text-[#c4cec8]">BNB Smart Chain</dd></div><div className="flex justify-between gap-4"><dt className="text-[#7f8d86]">Confirmed</dt><dd className="text-right text-[#c4cec8]">{confirmationDate}</dd></div><div className="flex justify-between gap-4"><dt className="text-[#7f8d86]">Confirmations</dt><dd className="font-mono text-[#42da99]">{order?.confirmations ?? 15} blocks</dd></div></dl>{order?.paymentTx && /^0x[a-fA-F0-9]{64}$/.test(order.paymentTx) ? <a href={`https://bscscan.com/tx/${order.paymentTx}`} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-2 text-[11px] text-[#42da99] hover:text-[#75efb3]">View transaction on BscScan <ArrowRight size={12}/></a> : null}</div><aside className="flex flex-col justify-between rounded-xl border border-white/[.07] bg-[#0b100e] p-4"><div><p className="text-[9px] font-semibold uppercase tracking-[.16em] text-[#75837d]">Next step</p><h2 className="mt-2 text-sm font-medium">Connect Binance</h2><p className="mt-1.5 text-[11px] leading-5 text-[#84918b]">Pair your Binance Agentic Wallet to let the agent begin operating.</p></div><div className="mt-6 rounded-lg border border-[#18cf7a]/15 bg-[#18cf7a]/[.045] p-3"><p className="text-[9px] uppercase tracking-[.15em] text-[#74827b]">Agent</p><p className="mt-1 font-mono text-sm text-[#cbd7d0]">{tenant?.container_name || "Provisioned"}</p><p className="mt-1 text-[10px] text-[#42da99]">{tenant?.status || "Ready"}</p></div></aside></div><div className="flex flex-col gap-3 border-t border-white/[.07] px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-9"><p className="text-[10px] text-[#75827c]">Keep this receipt for your records.</p><button type="button" className={buttonPrimary} onClick={() => setStep("agent")}>Continue to agent <ArrowRight size={15}/></button></div></section></motion.div> : null}

          {step === "agent" ? <motion.div key="agent" {...SHIFT}>
            <section className="relative mb-6 overflow-hidden rounded-2xl border border-white/10 bg-[#0d1414] p-6 sm:p-8"><div className="pointer-events-none absolute -right-10 -top-28 h-72 w-72 rounded-full bg-[#18cf7a]/[0.08] blur-3xl"/><div className="relative flex flex-wrap items-start justify-between gap-5"><div><p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.2em] text-[#42da99]"><span className="h-1.5 w-1.5 rounded-full bg-[#42da99]"/> Your agent workspace</p><h1 className="mt-3 text-3xl font-medium tracking-[-.04em] sm:text-4xl">{tenant?.container_name || "Neural Alpha"}</h1><p className="mt-2 text-sm text-[#87959a]">{[tenant?.status, tenant?.agent_mode, tenant?.payment_asset].filter(Boolean).join(" · ")}{tenant?.paid_until ? ` · active through ${tenant.paid_until.slice(0, 10)}` : ""}</p></div><span className="rounded-full border border-[#18cf7a]/20 bg-[#18cf7a]/[0.07] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#42da99]">{tenant?.status || "Ready"}</span></div></section>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[["Portfolio value", book?.navUsd, "NAV"], ["Available cash", book?.cashUsd, "LIQUIDITY"], ["Today’s P&L", book?.dailyPnlUsd, "24 HOURS"], ["Realized P&L", book?.realizedPnlUsd, "ALL TIME"]].map(([label, value, tag]) => <div key={String(label)} className={`${panel} p-4 sm:p-5`}><p className="text-[9px] font-semibold uppercase tracking-[.17em] text-[#718087]">{tag}</p><p className="mt-2 text-xs text-[#92a0a5]">{label}</p><p className="mt-1 text-xl font-medium tabular-nums tracking-[-.03em] sm:text-2xl">{money(value)}</p></div>)}</div>
            <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_370px]"><section className={`${panel} p-5 sm:p-6`}><div className="flex items-center justify-between border-b border-white/[0.07] pb-4"><div><p className="text-[10px] font-semibold uppercase tracking-[.2em] text-[#718087]">Activity</p><h2 className="mt-1 text-lg font-medium">Recent trades</h2></div><span className="font-mono text-[10px] text-[#718087]">{book?.trades ?? 0} total</span></div><div className="mt-1">{(book?.recent || []).slice(0, 8).length ? (book?.recent || []).slice(0, 8).map((trade, i) => <div key={`${trade.symbol}-${i}`} className="flex items-center justify-between gap-4 border-b border-white/[0.055] py-3 last:border-0"><span className="flex items-center gap-3"><span className={`grid h-8 w-8 place-items-center rounded-lg text-[10px] font-semibold ${trade.side?.toLowerCase() === "sell" ? "bg-[#f06c72]/10 text-[#f08085]" : "bg-[#18cf7a]/10 text-[#42da99]"}`}>{trade.side?.slice(0, 1)}</span><span><span className="block text-sm font-medium">{trade.symbol || "—"}</span><span className="mt-0.5 block text-[10px] text-[#718087]">{trade.side || "Trade"}</span></span></span><span className="font-mono text-xs tabular-nums text-[#bac5c9]">{money(trade.usd)}</span></div>) : <div className="grid min-h-40 place-items-center text-center"><div><p className="text-sm text-[#a4b0b4]">No trades yet</p><p className="mt-1 text-xs text-[#6f7d82]">Your agent activity will appear here.</p></div></div>}</div></section>
              <div className={`${panel} p-5`}><p className="text-[10px] font-semibold uppercase tracking-[.2em] text-[#718087]">Wallet connection</p><h2 className="mt-1 text-lg font-medium">Binance Agentic Wallet</h2><p className="mt-2 break-all font-mono text-[11px] text-[#8b999e]">{tenant?.wallet_address || "Not paired yet"}</p>{pairCode ? <div className="mt-4 rounded-xl border border-[#18cf7a]/20 bg-[#18cf7a]/[0.05] p-4"><p className="text-[9px] uppercase tracking-[.17em] text-[#849397]">Pairing code</p><p className="mt-2 font-mono text-2xl tracking-[.14em] text-[#42da99]">{pairCode}</p><p className="mt-1 text-[10px] text-[#78868b]">Enter this code in Binance, then confirm below.</p></div> : null}<div className="mt-4 grid gap-2"><button type="button" className={buttonPrimary + " w-full"} disabled={busy === "pair-start"} onClick={() => act("pair-start")}>{busy === "pair-start" ? "Requesting pairing code…" : pairCode ? "Refresh pairing code" : "Pair Binance wallet"}</button>{qr ? <button type="button" className={buttonQuiet + " w-full"} disabled={busy === "pair-verify"} onClick={() => act("pair-verify", { qrCodeId: qr })}>{busy === "pair-verify" ? "Confirming…" : "I confirmed in Binance"}</button> : null}<button type="button" className={buttonQuiet + " w-full"} onClick={() => act(tenant?.status === "paused" ? "resume" : "pause")}>{tenant?.status === "paused" ? "Resume agent" : "Pause agent"}</button></div><div className="mt-5 flex items-start gap-2 border-t border-white/[0.07] pt-4 text-[10px] leading-5 text-[#748187]"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-[#42da99]"/> Your trading funds remain in your Binance wallet. Neural Alpha never takes custody.</div></div></div>
            {error ? <p role="alert" className="mt-4 text-sm text-[#ff8e97]">{error}</p> : null}
          </motion.div> : null}
        </AnimatePresence> : null}
        <footer className="mt-10 flex flex-col justify-between gap-3 border-t border-white/[0.07] pt-5 text-[10px] text-[#5f6d72] sm:flex-row sm:items-center"><span>© Neural Alpha · Autonomous bStock trading</span><span className="flex items-center gap-2"><ShieldCheck size={12} /> Payments verified on BNB Smart Chain</span></footer>
      </main>
    </div>
  );
}
