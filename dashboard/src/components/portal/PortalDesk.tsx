"use client";

import { AssetLogo, PaymentMethodSelector } from "@/components/portal/payment-selector";
import { RainbowButton } from "@/components/portal/rainbow-button";
import { TreasuryQr } from "@/components/portal/treasury-qr";
import { REQUIRED_CONFIRMATIONS, softwareFeeDisplay } from "@/lib/software-fee";
import { AnimatePresence, motion } from "framer-motion";
import Image from "next/image";
import { ArrowRight, Check, ChevronLeft, CircleHelp, Copy, CreditCard, LockKeyhole, QrCode, ShieldCheck, WalletCards, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

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
  requiredConfirmations?: number | null;
  createdAt?: string;
  updatedAt?: string;
};

type Tenant = {
  id?: string;
  container_name?: string;
  status?: string;
  agent_mode?: string;
  payment_asset?: string;
  host_id?: string;
  paid_until?: string | null;
  wallet_address?: string | null;
  risk_preset?: string;
  max_position_usd?: number;
  x402_per_day?: number;
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

type Step = "quote" | "pay" | "confirmed" | "agent";
type PaymentChannel = "crypto" | "card" | "binance";

const POSITION_SIZES = [
  { id: "100", usdt: 100 },
  { id: "250", usdt: 250 },
  { id: "500", usdt: 500 },
] as const;

const SIZE_CHOICES = [
  ...POSITION_SIZES.map((size) => ({ id: size.id, figure: String(size.usdt), unit: "USDT" })),
  { id: "custom", figure: "Custom", unit: "" },
];

const X402_PER_DAY = 2;
const MAX_CUSTOM_USDT = 10_000;

function PositionSizeCard({
  preset,
  customSize,
  onPreset,
  onCustom,
  showSave,
  saving,
  onSave,
  kicker,
}: {
  preset: string;
  customSize: string;
  onPreset: (id: string) => void;
  onCustom: (value: string) => void;
  showSave: boolean;
  saving: boolean;
  onSave: () => void;
  kicker: ReactNode;
}) {
  const customInputRef = useRef<HTMLInputElement>(null);
  const choiceRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const customOn = preset === "custom";

  function onChoiceKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const key = event.key;
    const last = SIZE_CHOICES.length - 1;
    let next = index;
    if (key === "ArrowRight" || key === "ArrowDown") next = index === last ? 0 : index + 1;
    else if (key === "ArrowLeft" || key === "ArrowUp") next = index === 0 ? last : index - 1;
    else if (key === "Home") next = 0;
    else if (key === "End") next = last;
    else return;
    event.preventDefault();
    onPreset(SIZE_CHOICES[next].id);
    choiceRefs.current[next]?.focus();
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-white/[0.09] bg-[#101316] shadow-[0_24px_80px_rgba(0,0,0,.25)]">
      <div className="border-b border-white/[0.07] px-5 py-4">
        <p className="text-[10px] uppercase tracking-[.2em] text-[#728087]">{kicker}</p>
        <h3 id="position-size-label" className="mt-1.5 text-lg font-medium tracking-[-0.03em]">Maximum position size</h3>
        <p className="mt-1 text-sm text-[#839197]">Cap for one position. Swaps use USDT.</p>
      </div>
      <div className="p-4">
        <div
          role="radiogroup"
          aria-labelledby="position-size-label"
          className="grid grid-cols-4 gap-1 rounded-xl border border-white/[0.08] bg-[#080b0d] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
        >
          {SIZE_CHOICES.map((choice, index) => {
            const on = preset === choice.id;
            return (
              <button
                key={choice.id}
                ref={(node) => {
                  choiceRefs.current[index] = node;
                }}
                type="button"
                role="radio"
                aria-checked={on}
                aria-controls={choice.id === "custom" && customOn ? "custom-position-usdt" : undefined}
                tabIndex={on ? 0 : -1}
                onClick={() => {
                  onPreset(choice.id);
                  if (choice.id === "custom") window.setTimeout(() => customInputRef.current?.focus(), 40);
                }}
                onKeyDown={(event) => onChoiceKeyDown(event, index)}
                className={`relative flex h-[64px] min-w-0 flex-col items-center justify-center rounded-[10px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#42da99]/70 ${on ? "" : "hover:bg-white/[0.035]"}`}
              >
                {on ? (
                  <motion.span
                    layoutId="position-size-plate"
                    aria-hidden
                    className="absolute inset-0 rounded-[10px] border border-[#18cf7a] bg-[#143024] shadow-[inset_0_1px_0_rgba(66,218,153,0.28)]"
                    transition={{ type: "spring", stiffness: 460, damping: 34, mass: 0.75 }}
                  />
                ) : null}
                <span className={`relative font-mono font-medium leading-none tabular-nums transition-colors ${choice.id === "custom" ? "text-[12.5px] tracking-[-0.02em]" : "text-[15px] tracking-[-0.04em]"} ${on ? "text-[#edf3f3]" : "text-[#8b989e]"}`}>
                  {choice.figure}
                </span>
                {choice.unit ? (
                  <span className={`relative mt-1 font-mono text-[9px] uppercase tracking-[0.16em] transition-colors ${on ? "text-[#42da99]" : "text-[#5d6b70]"}`}>
                    {choice.unit}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <AnimatePresence initial={false}>
          {customOn ? (
            <motion.div
              key="custom-size"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden"
            >
              <label htmlFor="custom-position-usdt" className="mt-3 flex items-center gap-3 rounded-xl border border-[#18cf7a]/70 bg-[#080b0d] px-3.5 shadow-[inset_0_1px_0_rgba(66,218,153,0.18)]">
                <input
                  ref={customInputRef}
                  id="custom-position-usdt"
                  aria-label="Custom position size in USDT"
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  max={MAX_CUSTOM_USDT}
                  step="0.01"
                  placeholder="Amount"
                  value={customSize}
                  onFocus={() => onPreset("custom")}
                  onChange={(event) => {
                    onPreset("custom");
                    onCustom(event.target.value);
                  }}
                  className="h-12 min-w-0 flex-1 bg-transparent font-mono text-[22px] tabular-nums tracking-[-0.04em] text-[#edf3f3] outline-none [appearance:textfield] placeholder:text-[15px] placeholder:tracking-normal placeholder:text-[#546168] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span className="shrink-0 font-mono text-[11px] tracking-[0.18em] text-[#42da99]">USDT</span>
              </label>
            </motion.div>
          ) : null}
        </AnimatePresence>
        {showSave ? (
          <RainbowButton className="mt-4 w-full" disabled={saving} onClick={onSave}>
            {saving ? "Saving…" : "Save position size"}
          </RainbowButton>
        ) : null}
      </div>
    </div>
  );
}

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

function maskContract(address: string) {
  const value = String(address || "");
  if (value.length < 12) return value;
  return `${value.slice(0, 6)}${"*".repeat(8)}${value.slice(-4)}`;
}

function ChainWatch({ order }: { order: Order }) {
  const required = Number(order.requiredConfirmations) > 0 ? Number(order.requiredConfirmations) : REQUIRED_CONFIRMATIONS;
  const reported = typeof order.confirmations === "number" && Number.isFinite(order.confirmations) ? order.confirmations : null;
  const seen = Boolean(order.paymentTx);
  const fraction = seen && reported != null ? Math.max(0, Math.min(1, reported / required)) : null;
  const complete = reported != null && reported >= required;
  const shown = reported == null ? 0 : Math.min(reported, required);
  const label = !seen
    ? `Watching BNB Smart Chain for the exact ${order.amountDisplay} ${order.asset} transfer`
    : reported == null
      ? "Transfer seen on BNB Smart Chain. Waiting for the confirmation count."
      : `${shown} of ${required} network confirmations`;
  const title = !seen
    ? "Watching BNB Smart Chain"
    : reported == null
      ? "Transfer seen"
      : `${shown} / ${required} confirmations`;
  const detail = !seen
    ? `Looking for the exact ${order.amountDisplay} ${order.asset} transfer. Confirmation progress appears when it is included in a block.`
    : complete
      ? "Network confirmation is complete. This page opens your agent once the order is marked paid."
      : "The transfer is on BNB Smart Chain. It activates automatically once the required confirmations are in.";

  return (
    <div className="mt-6 flex items-center gap-4 rounded-xl border border-[#18cf7a]/20 bg-[#101316] p-4 sm:p-5" role="status" aria-live="polite" aria-label={label}>
      <ConfirmRing waiting={!seen} fraction={fraction} />
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-[.18em] text-[#42da99]">{seen ? "Network confirmation" : "Listening"}</p>
        <p className="mt-1 text-sm font-medium text-[#edf3f3]">{title}</p>
        <p className="mt-1 text-xs leading-5 text-[#8b989d]">{detail}</p>
      </div>
    </div>
  );
}

function ConfirmRing({ waiting, fraction }: { waiting: boolean; fraction: number | null }) {
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const shown = fraction == null ? 0.2 : Math.max(0.05, fraction);
  return (
    <motion.svg
      viewBox="0 0 64 64"
      className="h-14 w-14 shrink-0"
      aria-hidden
      animate={waiting ? { rotate: 360 } : { rotate: 0 }}
      transition={waiting ? { repeat: Infinity, duration: 4, ease: "linear" } : { duration: 0.35 }}
    >
      <circle cx="32" cy="32" r={radius} fill="none" stroke="rgba(24,207,122,0.16)" strokeWidth="4" />
      <circle
        cx="32"
        cy="32"
        r={radius}
        fill="none"
        stroke="#42da99"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={`${circumference * shown} ${circumference}`}
        transform="rotate(-90 32 32)"
      />
    </motion.svg>
  );
}

function splitAmount(display: string) {
  const [whole, fraction = ""] = String(display || "0").split(".");
  const digits = fraction.padEnd(3, "0");
  if (digits.length <= 3) return { whole, head: "", marker: digits };
  return { whole, head: digits.slice(0, -3), marker: digits.slice(-3) };
}

export function PortalDesk() {
  const [step, setStep] = useState<Step>("quote");
  const [booting, setBooting] = useState(true);
  const [asset, setAsset] = useState("USDT");
  const [channel, setChannel] = useState<PaymentChannel>("crypto");
  const [preset, setPreset] = useState("100");
  const [customSize, setCustomSize] = useState("");
  const [order, setOrder] = useState<Order | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [left, setLeft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [pairUrl, setPairUrl] = useState("");
  const [qr, setQr] = useState("");
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [bnbAmount, setBnbAmount] = useState(() => softwareFeeDisplay("BNB"));
  const [accessCode, setAccessCode] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | null>(null);

  const assets = useMemo(
    () => [
      { id: "USDT", label: "USDT", detail: softwareFeeDisplay("USDT") },
      { id: "USDC", label: "USDC", detail: softwareFeeDisplay("USDC") },
      { id: "BNB", label: "BNB", detail: bnbAmount },
      { id: "U", label: "U", detail: softwareFeeDisplay("U") },
      { id: "USD1", label: "USD1", detail: softwareFeeDisplay("USD1") },
    ],
    [bnbAmount],
  );

  useEffect(() => {
    let stop = false;
    fetch("/api/portal/pricing")
      .then((res) => res.json())
      .then((data) => {
        if (!stop && typeof data?.bnbAmountDisplay === "string" && data.bnbAmountDisplay) {
          setBnbAmount(data.bnbAmountDisplay);
        }
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, []);

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
          if (typeof checkout.accessCode === "string") setAccessCode(checkout.accessCode);
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
    const id = tenant?.risk_preset;
    if (!id) return;
    if (id === "100" || id === "250" || id === "500") {
      setPreset(id);
      return;
    }
    setPreset("custom");
    if (tenant?.max_position_usd != null && Number(tenant.max_position_usd) > 0) {
      setCustomSize(String(tenant.max_position_usd));
    }
  }, [tenant?.id, tenant?.risk_preset, tenant?.max_position_usd]);

  useEffect(() => {
    let stop = false;
    fetch("/api/portal/assets?v=2")
      .then((res) => res.json())
      .then((data) => {
        if (stop || !data?.assets) return;
        const next: Record<string, string> = {};
        for (const [symbol, row] of Object.entries(data.assets as Record<string, { icon?: string }>)) {
          if (row?.icon) next[symbol] = row.icon;
        }
        setIcons(next);
      })
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, []);

  useEffect(() => {
    if (!order?.id || step !== "pay") return;
    let stop = false;
    let reading = false;
    let advancing = false;
    const poll = async () => {
      if (reading || advancing) return;
      reading = true;
      try {
        const response = await fetch("/api/portal/order-status", { cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (stop || !response.ok) return;
        if (data.order?.amountDisplay) {
          setOrder((prev) =>
            prev?.id === data.order.id &&
            prev?.amountDisplay === data.order.amountDisplay &&
            prev?.expiresAt === data.order.expiresAt &&
            prev?.status === data.order.status &&
            prev?.paymentTx === data.order.paymentTx &&
            prev?.confirmations === data.order.confirmations
              ? prev
              : data.order,
          );
        }
        if (!data.activated) return;
        advancing = true;
        setTenant(data.tenant || null);
        if (typeof data.accessCode === "string") setAccessCode(data.accessCode);
        const live = await fetch("/api/portal/session", { cache: "no-store" }).then(readJson).catch(() => null);
        window.setTimeout(() => {
          if (stop) return;
          if (live?.tenant) setTenant(live.tenant);
          if (live?.state) setBook(live.state);
          setStep("confirmed");
          setError("");
        }, 700);
      } catch {
        // Keep polling until the watcher marks this exact transfer paid.
      } finally {
        reading = false;
      }
    };
    void poll();
    const delay = order.paymentTx && order.status === "pending" ? 2_000 : 5_000;
    const id = setInterval(poll, delay);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [order?.id, order?.paymentTx, order?.status, step]);

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
  const progress = step === "quote" ? 0.08 : step === "pay" ? 0.4 : step === "confirmed" ? 0.96 : 1;
  const confirmationDate = order?.updatedAt && Number.isFinite(Date.parse(order.updatedAt))
    ? new Date(order.updatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
    : "Just now";

  function sizePayload() {
    if (preset === "custom") {
      const positionUsd = Number(customSize);
      if (!Number.isFinite(positionUsd) || positionUsd <= 0 || positionUsd > MAX_CUSTOM_USDT) return null;
      return { preset: "custom", positionUsd, x402PerDay: X402_PER_DAY };
    }
    if (preset !== "100" && preset !== "250" && preset !== "500") return null;
    return { preset, x402PerDay: X402_PER_DAY };
  }

  async function lockQuote() {
    setError("");
    const size = sizePayload();
    if (!size) {
      setError("Enter a position size above 0 and at most 10,000 USDT.");
      return;
    }
    setBusy("lock");
    try {
      const data = await readJson(
        await fetch("/api/portal/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paymentAsset: asset, ...size }),
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

  async function enterAgent(data: { tenant?: Tenant | null }) {
    setTenant(data.tenant || null);
    const live = await fetch("/api/portal/session").then(readJson).catch(() => null);
    if (live?.tenant) setTenant(live.tenant);
    if (live?.state) setBook(live.state);
    setStep("agent");
  }

  async function openPaidWallet() {
    setError("");
    setBusy("wallet");
    try {
      const ethereum = (window as Window & { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
      if (!ethereum?.request) {
        throw new Error("Open the portal in the wallet that sent the payment, then try again.");
      }
      const challenge = await readJson(
        await fetch("/api/portal/challenge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ purpose: "login" }),
        }),
      );
      const accounts = (await ethereum.request({ method: "eth_requestAccounts" })) as string[];
      const account = accounts?.[0];
      if (!account) throw new Error("No wallet account was selected.");
      const signature = (await ethereum.request({
        method: "personal_sign",
        params: [String(challenge.message), account],
      })) as string;
      const data = await readJson(
        await fetch("/api/portal/restore", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ signature }),
        }),
      );
      if (!data.tenant && Array.isArray(data.agents)) {
        throw new Error("This wallet paid for more than one agent. Open one with its access code.");
      }
      await enterAgent(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the paid agent");
    } finally {
      setBusy("");
    }
  }

  async function openWithCode() {
    setError("");
    setBusy("code");
    try {
      const data = await readJson(
        await fetch("/api/portal/code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: codeInput }),
        }),
      );
      await enterAgent(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the agent");
    } finally {
      setBusy("");
    }
  }

  async function freshCode() {
    setError("");
    setBusy("fresh-code");
    try {
      const data = await readJson(await fetch("/api/portal/access-code", { method: "POST" }));
      if (typeof data.accessCode === "string") setAccessCode(data.accessCode);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create an access code");
    } finally {
      setBusy("");
    }
  }

  async function savePosition() {
    const size = sizePayload();
    if (!size) {
      setError("Enter a position size above 0 and at most 10,000 USDT.");
      return;
    }
    await act("risk", size);
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
        setPairUrl(String(data.urlForWeb || data.url || ""));
        setQr(String(data.qrCodeId || ""));
      } else {
        if (op === "pair-verify") {
          setPairCode("");
          setPairUrl("");
          setQr("");
        }
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

  function showToast(message: string) {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2200);
  }

  function copyWithSelection(value: string) {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("copy failed");
  }

  async function copy(value: string, message?: string) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else copyWithSelection(value);
    } catch {
      try {
        copyWithSelection(value);
      } catch {
        setError("Copy is unavailable in this browser.");
        return;
      }
    }
    setError("");
    if (message) showToast(message);
  }

  const panel = "rounded-2xl border border-white/[0.09] bg-[#101316] shadow-[0_24px_80px_rgba(0,0,0,.25)]";
  const buttonQuiet = "inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.035] px-5 text-sm font-medium text-[#dce4e9] transition hover:border-white/20 hover:bg-white/[0.07]";
  const progressLabels = ["Plan", "Payment", "Activate"];

  return (
    <div className="min-h-screen bg-[#080b0d] text-[#edf3f3] selection:bg-[#18cf7a]/30">
      {toast ? <div role="status" className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border border-[#18cf7a]/35 bg-[#10211a] px-4 py-2.5 text-sm text-[#d7f8e8] shadow-[0_12px_40px_rgba(0,0,0,.45)]">{toast}</div> : null}
      <div className="mx-auto max-w-[1280px] px-5 pb-20 sm:px-8">
        <div className="flex h-[76px] items-center justify-between">
          <a href="/portal" aria-label="Neural Alpha home"><Image src="/brand/neural-alpha-logo.png" alt="Neural Alpha" width={174} height={50} priority className="h-auto w-[148px] sm:w-[168px]" /></a>
          <div className="flex items-center gap-3 sm:gap-6">
            {step === "agent" ? <button className={buttonQuiet + " min-h-9 px-3 text-xs"} onClick={() => setStep("quote")}>Account</button> : step === "confirmed" ? <button className={buttonQuiet + " min-h-9 px-3 text-xs"} onClick={() => setStep("agent")}>Open workspace</button> : <a href="#access-code" className="inline-flex items-center gap-2 text-xs text-[#aab6bc] transition hover:text-white"><LockKeyhole size={14} /> <span className="hidden sm:inline">Access code</span><span className="sm:hidden">Sign in</span></a>}
          </div>
        </div>

        <main className="pt-7 sm:pt-10">
        <div className="mb-8 flex items-center justify-end gap-2 border-b border-white/[0.07] pb-5 sm:gap-3">
            {progressLabels.map((label, index) => { const active = progress >= [0, 0.4, 0.72][index]; return <div key={label} className="flex items-center gap-2 text-[10px] sm:text-xs"><span className={`grid h-6 w-6 place-items-center rounded-full border ${active ? "border-[#18cf7a]/50 bg-[#18cf7a]/10 text-[#18cf7a]" : "border-white/10 text-[#647177]"}`}>{progress > [0.08, 0.4, 0.72][index] ? <Check size={12} /> : index + 1}</span><span className={active ? "text-[#c8d2d5]" : "hidden text-[#647177] sm:inline"}>{label}</span>{index < 2 ? <span className="mx-0.5 h-px w-3 bg-white/10 sm:w-7" /> : null}</div>; })}
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
                <div className="mb-6 flex items-start justify-between gap-4"><div><p className="text-[10px] font-semibold uppercase tracking-[.2em] text-[#6f7e83]">01 <span className="mx-1 text-[#384448]">/</span> Select payment</p><h2 className="mt-2 text-2xl font-medium tracking-[-.03em]">Start your subscription</h2><p className="mt-1.5 text-sm text-[#839197]">30 days of a dedicated Neural Alpha agent</p></div><span className="shrink-0 rounded-lg border border-[#18cf7a]/25 bg-[#18cf7a]/[0.07] px-2.5 py-1.5 text-right font-mono leading-tight"><span className="block text-sm font-medium tracking-[-.02em] text-[#42da99]">$15</span><span className="mt-0.5 block text-[10px] uppercase tracking-[.14em] text-[#96a3a8]">for 30 days</span></span></div>
                <div className="grid grid-cols-3 gap-2.5">
                  {([{ id: "crypto", title: "Crypto", sub: "BSC network", icon: WalletCards, ready: true }, { id: "card", title: "Card", sub: "Coming soon", icon: CreditCard, ready: false }, { id: "binance", title: "Binance Pay", sub: "Coming soon", icon: QrCode, ready: false }] as const).map((option) => { const Icon = option.icon; const selected = channel === option.id; return <button key={option.id} type="button" onClick={() => setChannel(option.id)} aria-pressed={selected} className={`relative flex min-h-[92px] flex-col items-start justify-between rounded-xl border p-3.5 text-left transition sm:p-4 ${selected ? "border-[#18cf7a]/55 bg-[#18cf7a]/[0.07]" : "border-white/[0.08] bg-white/[0.025] hover:border-white/20"}`}><span className="flex w-full items-center justify-between"><Icon size={18} className={selected ? "text-[#42da99]" : "text-[#95a2a7]"} />{!option.ready ? <span className="rounded-full bg-white/[0.06] px-1.5 py-1 text-[8px] font-semibold uppercase tracking-wide text-[#738187] sm:text-[9px]">Soon</span> : selected ? <Check size={14} className="text-[#42da99]" /> : null}</span><span><span className="block text-xs font-medium sm:text-sm">{option.title}</span><span className="mt-0.5 block text-[10px] text-[#7f8d92] sm:text-[11px]">{option.sub}</span></span></button>; })}
                </div>
                {channel === "crypto" ? <div className="mt-7"><PaymentMethodSelector label="Pay with a BSC asset" methods={assets} selectedId={asset} onSelectionChange={setAsset} layout="row" icons={icons} /></div> : <div className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]"><div className="rounded-xl border border-[#e6b45b]/20 bg-[#e6b45b]/[0.055] p-4 text-sm text-[#c0b49a]"><p className="font-medium text-[#e3cb9e]">{channel === "card" ? "Card payments are not available yet." : "Binance Pay is not connected yet."}</p><p className="mt-1 text-xs leading-5 text-[#938b79]">Choose Crypto to continue securely on BNB Smart Chain. No card details are collected here.</p></div>{channel === "card" ? <div aria-label="Card checkout preview only; card payments are not available" className="relative min-h-[122px] overflow-hidden rounded-xl border border-white/10 bg-gradient-to-br from-[#213e36] via-[#172923] to-[#101617] p-4"><div className="absolute -right-9 -top-12 h-36 w-36 rounded-full border border-white/[0.08]"/><div className="absolute -right-2 -top-5 h-28 w-28 rounded-full border border-white/[0.07]"/><p className="relative text-[9px] font-semibold uppercase tracking-[.18em] text-[#9fb9ae]">Card checkout preview</p><p className="relative mt-5 font-mono text-xs tracking-[.18em] text-white/80">•••• &nbsp; •••• &nbsp; •••• &nbsp; ••••</p><p className="relative mt-2 text-[9px] uppercase tracking-[.16em] text-[#8ba096]">Not available yet</p></div> : null}</div>}
                {error ? <p role="alert" className="mt-5 rounded-lg border border-[#ff6975]/20 bg-[#ff6975]/[0.06] px-3 py-2.5 text-sm text-[#ff8e97]">{error}</p> : null}
                <div className="mt-6 flex flex-col gap-3 border-t border-white/[0.07] pt-5 sm:flex-row sm:items-center sm:justify-between"><p className="flex items-center gap-2 text-[11px] text-[#78868b]"><LockKeyhole size={13} /> Secure, on-chain payment verification</p><RainbowButton className="w-full sm:w-auto" disabled={busy === "lock" || channel !== "crypto"} onClick={lockQuote}>{busy === "lock" ? "Preparing quote…" : <>Continue to payment <ArrowRight size={16} /></>}</RainbowButton></div>
                <div id="access-code" className="mt-5 border-t border-white/[0.07] pt-4"><label className="text-xs font-medium text-[#bac5c9]" htmlFor="access-code-input">Access code</label><div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"><input id="access-code-input" aria-label="Access code" className="h-11 min-w-0 rounded-lg border border-white/10 bg-[#0a0e10] px-3 font-mono text-sm tracking-[.08em] uppercase outline-none transition placeholder:text-[#546168] placeholder:tracking-normal placeholder:normal-case focus:border-[#18cf7a]/50" placeholder="ABCD-EFGH-JKLM-NPQR" value={codeInput} onChange={(e) => setCodeInput(e.target.value)} autoComplete="off" spellCheck={false} /><RainbowButton className="min-h-11 px-4 font-medium" disabled={busy === "code"} onClick={openWithCode}>{busy === "code" ? "Opening…" : "Open agent"}</RainbowButton></div><button type="button" className={buttonQuiet + " mt-3 w-full"} disabled={busy === "wallet"} onClick={openPaidWallet}>{busy === "wallet" ? "Waiting for the wallet…" : "Already paid? Open with that wallet"}</button></div>
              </section>
              <aside className="grid gap-4">
                <PositionSizeCard
                  preset={preset}
                  customSize={customSize}
                  onPreset={setPreset}
                  onCustom={setCustomSize}
                  showSave={Boolean(tenant)}
                  saving={busy === "risk"}
                  onSave={savePosition}
                  kicker={<>02 <span className="mx-1 text-[#384448]">/</span> Configure risk</>}
                />
                <div className="rounded-2xl border border-white/[0.07] bg-[#0d1113]/90 px-5 py-4"><div className="flex items-center gap-2 text-xs font-medium text-[#bac5c9]"><CircleHelp size={15} className="text-[#42da99]" /> What happens next?</div><ol className="mt-3 grid gap-2.5 text-[11px] leading-5 text-[#7f8c91]"><li className="flex gap-2"><span className="font-mono text-[#42da99]">01</span> Lock a 10-minute quote in your chosen asset.</li><li className="flex gap-2"><span className="font-mono text-[#42da99]">02</span> Send the exact amount to the treasury on BSC.</li><li className="flex gap-2"><span className="font-mono text-[#42da99]">03</span> The exact transfer is confirmed automatically.</li></ol></div>
              </aside>
            </div>
          </motion.div> : null}

          {step === "pay" && order ? <motion.div key="pay" {...SHIFT} className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_370px]">
            <section className={`${panel} p-5 sm:p-8`}><button type="button" onClick={() => setStep("quote")} className="mb-6 flex items-center gap-1 text-xs text-[#88969b] hover:text-white"><ChevronLeft size={15} /> Edit checkout</button><div className="flex items-center gap-3"><AssetLogo asset={order.asset} src={icons[order.asset]}/><div><p className="text-[10px] font-semibold uppercase tracking-[.2em] text-[#708087]">Payment details <span className="mx-1 text-[#384448]">/</span> {order.asset} on BSC</p><h1 className="mt-1 text-3xl font-medium tracking-[-.035em] sm:text-4xl">Send your payment</h1></div></div><p className="mt-3 text-sm text-[#839197]">Transfer the exact amount below to activate your agent.</p>
              <div className="mt-8 rounded-xl border border-[#18cf7a]/20 bg-[#18cf7a]/[0.045] p-5 sm:p-6"><p className="text-[10px] uppercase tracking-[.18em] text-[#7e8e93]">{order.paymentTx ? "Payment received · this quote is already paid" : `Exact amount · quote expires in ${left === "expired" ? "expired" : left || "10:00"}`}</p><p className="mt-3 flex flex-wrap items-baseline gap-3" aria-label={`${order.amountDisplay} ${order.asset}`}><span className="text-[56px] font-medium leading-none tracking-[-.055em] text-[#edf3f3] tabular-nums sm:text-[68px]">{amount.whole}{amount.head ? <span>.{amount.head}</span> : null}<span className="font-semibold text-[#42da99]">{amount.head ? amount.marker : `.${amount.marker}`}</span></span><span className="text-base text-[#94a1a6]">{order.asset}</span></p><p className="mt-2 text-[10px] leading-4 text-[#7e8e93]">{order.paymentTx ? "This transfer is already matched. Do not send it again. Open the agent with the same wallet that paid." : "The green digits are unique to this order. Send this exact amount so it can be verified automatically."}</p>{order.paymentTx ? <button type="button" className={buttonQuiet + " mt-4 w-full"} disabled={busy === "wallet"} onClick={openPaidWallet}>{busy === "wallet" ? "Waiting for the wallet…" : "Open with the wallet that paid"}</button> : null}<button type="button" className="mt-4 inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs text-[#c2cdd1] hover:bg-white/[0.06]" onClick={() => copy(order.amountDisplay)}><Copy size={13} /> Copy exact amount</button></div>
              <div className="mt-6 grid items-center gap-4 sm:grid-cols-[auto_minmax(0,1fr)]"><TreasuryQr value={order.treasuryAddress} /><div className="min-w-0"><div className="mb-2 flex items-center justify-between"><label className="text-xs font-medium text-[#bac5c9]">Treasury address</label><span className="text-[10px] uppercase tracking-wider text-[#728087]">BNB Smart Chain</span></div><div className="flex items-center gap-3 rounded-xl border border-white/10 bg-[#0a0e10] p-3.5"><button type="button" className="min-w-0 flex-1 break-all text-left font-mono text-[11px] leading-5 text-[#b9c5ca] transition hover:text-white sm:text-xs" onClick={() => copy(order.treasuryAddress, "Treasury address copied")}>{order.treasuryAddress}</button><button type="button" aria-label="Copy treasury address" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/10 text-[#42da99] hover:bg-white/[0.05]" onClick={() => copy(order.treasuryAddress, "Treasury address copied")}><Copy size={15} /></button></div></div></div>
              {order.asset !== "BNB" ? <div className="mt-4 flex items-center justify-between gap-3"><label className="shrink-0 text-xs font-medium text-[#bac5c9]">{order.asset} token contract</label><span className="min-w-0 truncate select-none font-mono text-[11px] tracking-wide text-[#849297]" title="Shown only so you can check the token. This is not a wallet to send to.">{maskContract(order.tokenContract)}</span></div> : null}
              <div className="mt-5 flex gap-3 rounded-xl border border-[#e6b45b]/15 bg-[#e6b45b]/[0.045] p-3.5 text-xs leading-5 text-[#b2a687]"><ShieldCheck size={16} className="mt-0.5 shrink-0 text-[#d3b264]" /><p>Send exactly <strong className="font-semibold text-[#d9c99f]">{order.amountDisplay} {order.asset}</strong> on <strong className="font-semibold text-[#d9c99f]">BNB Smart Chain</strong> from any wallet. This payment only activates the subscription. Trading funds go into the Agentic Wallet after the agent is ready. Other networks and other amounts cannot activate automatically.</p></div>
              {error ? <p role="alert" className="mt-5 text-sm text-[#ff8e97]">{error}</p> : null}<ChainWatch order={order} /><div className="mt-5"><button type="button" className={buttonQuiet} onClick={() => setStep("quote")}>Back</button></div>
            </section>
            <aside className={`${panel} p-5`}><p className="text-[10px] font-semibold uppercase tracking-[.2em] text-[#718087]">Order summary</p><div className="mt-5 flex justify-between border-b border-white/[0.07] pb-4 text-sm"><span className="text-[#87959a]">Neural Alpha · 30 days</span><span>{money(order.priceUsd)}</span></div><div className="mt-4 flex justify-between text-sm"><span className="text-[#87959a]">Network fee</span><span className="text-[#87959a]">Paid by sender</span></div><div className="mt-5 flex justify-between border-t border-white/[0.07] pt-4 text-sm font-medium"><span>Total due</span><span>{order.amountDisplay} {order.asset}</span></div><div className="mt-6 flex items-center gap-3 rounded-xl bg-white/[0.035] p-3.5"><div className="grid h-9 w-9 place-items-center rounded-lg bg-[#18cf7a]/10 text-[#42da99]"><LockKeyhole size={16} /></div><div><p className="text-xs font-medium">Protected checkout</p><p className="mt-0.5 text-[10px] text-[#78868b]">Receipt confirmed on-chain</p></div></div><p className="mt-4 text-[11px] leading-5 text-[#728087]">Your quote is unique to this order. Keep this page open until your transfer has been confirmed.</p></aside>
          </motion.div> : null}


          {step === "confirmed" ? <motion.div key="confirmed" {...SHIFT} className="mx-auto max-w-[760px]"><section className="overflow-hidden rounded-2xl border border-[#18cf7a]/20 bg-[#101614] shadow-[0_28px_90px_rgba(0,0,0,.3)]"><div className="relative overflow-hidden border-b border-dashed border-[#30423a] px-6 py-7 sm:px-9"><div className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full border border-[#18cf7a]/10"/><div className="relative flex items-start gap-4"><div className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-[#18cf7a]/25 bg-[#18cf7a]/10 text-[#42da99]"><Check size={23}/></div><div className="min-w-0 flex-1"><p className="text-[10px] font-semibold uppercase tracking-[.2em] text-[#42da99]">Payment confirmed</p><h1 className="mt-1.5 text-2xl font-medium tracking-[-.035em] sm:text-3xl">Your order is complete</h1><p className="mt-2 text-sm leading-6 text-[#8e9d98]">The payment has been matched to your quote and confirmed on BNB Smart Chain.</p></div><span className="hidden rounded-full border border-[#18cf7a]/20 bg-[#18cf7a]/[.06] px-3 py-1.5 font-mono text-[10px] text-[#42da99] sm:inline-flex">PAID</span></div></div><div className="grid gap-6 px-6 py-6 sm:grid-cols-[1fr_210px] sm:px-9"><div><p className="text-[9px] font-semibold uppercase tracking-[.18em] text-[#73827b]">Receipt</p><div className="mt-4 flex items-center gap-3"><AssetLogo asset={order?.asset || asset} src={icons[order?.asset || asset]}/><div><p className="text-[10px] text-[#84938d]">Received amount</p><p className="mt-0.5 font-mono text-lg font-medium text-[#edf5f0]">{order?.paidAmountDisplay || order?.amountDisplay || "—"} <span className="text-sm text-[#a7b3ad]">{order?.asset || asset}</span></p></div></div><dl className="mt-5 grid gap-3 border-t border-white/[.07] pt-4 text-xs"><div className="flex justify-between gap-4"><dt className="text-[#7f8d86]">Order reference</dt><dd className="font-mono text-[#c4cec8]">{order?.id || "—"}</dd></div><div className="flex justify-between gap-4"><dt className="text-[#7f8d86]">Plan</dt><dd className="text-right text-[#c4cec8]">Neural Alpha · 30 days</dd></div><div className="flex justify-between gap-4"><dt className="text-[#7f8d86]">Network</dt><dd className="text-[#c4cec8]">BNB Smart Chain</dd></div><div className="flex justify-between gap-4"><dt className="text-[#7f8d86]">Confirmed</dt><dd className="text-right text-[#c4cec8]">{confirmationDate}</dd></div><div className="flex justify-between gap-4"><dt className="text-[#7f8d86]">Confirmations</dt><dd className="font-mono text-[#42da99]">{order?.confirmations ?? 15} blocks</dd></div></dl>{order?.paymentTx && /^0x[a-fA-F0-9]{64}$/.test(order.paymentTx) ? <a href={`https://bscscan.com/tx/${order.paymentTx}`} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-2 text-[11px] text-[#42da99] hover:text-[#75efb3]">View transaction on BscScan <ArrowRight size={12}/></a> : null}</div><aside className="flex flex-col justify-between rounded-xl border border-white/[.07] bg-[#0b100e] p-4"><div><p className="text-[9px] font-semibold uppercase tracking-[.16em] text-[#75837d]">Next step</p><h2 className="mt-2 text-sm font-medium">Connect Binance</h2><p className="mt-1.5 text-[11px] leading-5 text-[#84918b]">Pair your Binance Agentic Wallet to let the agent begin operating.</p></div><div className="mt-6 rounded-lg border border-[#18cf7a]/15 bg-[#18cf7a]/[.045] p-3"><p className="text-[9px] uppercase tracking-[.15em] text-[#74827b]">Agent</p><p className="mt-1 font-mono text-sm text-[#cbd7d0]">{tenant?.container_name || "Provisioned"}</p><p className="mt-1 text-[10px] text-[#42da99]">{tenant?.status || "Ready"}</p></div></aside></div>{accessCode ? <div className="mx-6 mb-2 rounded-xl border border-[#18cf7a]/20 bg-[#18cf7a]/[0.05] px-4 py-3 sm:mx-9"><p className="text-[10px] uppercase tracking-[.16em] text-[#42da99]">Access code</p><div className="mt-1 flex items-center gap-3"><p className="font-mono text-xl tracking-[.14em] text-[#edf5f0]">{accessCode}</p><button type="button" aria-label="Copy access code" className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 text-[#42da99]" onClick={() => copy(accessCode)}><Copy size={14} /></button></div><p className="mt-1 text-[11px] text-[#8e9d98]">Save it. This opens the agent on another browser.</p></div> : null}<div className="flex flex-col gap-3 border-t border-white/[.07] px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-9"><p className="text-[10px] text-[#75827c]">Keep this receipt for your records.</p><RainbowButton onClick={() => setStep("agent")}>Continue to agent <ArrowRight size={15}/></RainbowButton></div></section></motion.div> : null}

          {step === "agent" ? <motion.div key="agent" {...SHIFT}>
            <section className="relative mb-6 overflow-hidden rounded-2xl border border-white/10 bg-[#0d1414] p-6 sm:p-8"><div className="pointer-events-none absolute -right-10 -top-28 h-72 w-72 rounded-full bg-[#18cf7a]/[0.08] blur-3xl"/><div className="relative flex flex-wrap items-start justify-between gap-5"><div><p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.2em] text-[#42da99]"><span className="h-1.5 w-1.5 rounded-full bg-[#42da99]"/> Your agent workspace</p><h1 className="mt-3 text-3xl font-medium tracking-[-.04em] sm:text-4xl">{tenant?.container_name || "Neural Alpha"}</h1><p className="mt-2 text-sm text-[#87959a]">{[tenant?.status, tenant?.agent_mode, tenant?.payment_asset].filter(Boolean).join(" · ")}{tenant?.paid_until ? ` · active through ${tenant.paid_until.slice(0, 10)}` : ""}</p>{accessCode ? <div className="mt-4"><p className="text-[10px] uppercase tracking-[.16em] text-[#7f8c91]">Access code</p><div className="mt-1 flex items-center gap-2"><p className="font-mono text-lg tracking-[.12em] text-[#edf3f3]">{accessCode}</p><button type="button" aria-label="Copy access code" className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 text-[#42da99]" onClick={() => copy(accessCode)}><Copy size={14} /></button></div><button type="button" className="mt-2 text-[11px] text-[#7f8c91] hover:text-white" disabled={busy === "fresh-code"} onClick={freshCode}>{busy === "fresh-code" ? "Replacing…" : "Replace this code"}</button></div> : <button type="button" className="mt-4 text-xs text-[#8d9a9f] hover:text-white" disabled={busy === "fresh-code"} onClick={freshCode}>{busy === "fresh-code" ? "Creating…" : "New access code"}</button>}</div><span className="rounded-full border border-[#18cf7a]/20 bg-[#18cf7a]/[0.07] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#42da99]">{tenant?.status || "Ready"}</span></div></section>
            {tenant?.agent_mode !== "live" ? <p className="mb-3 text-xs leading-5 text-[#87959a]">Paper balances. These amounts are simulated. They are not funds in your Binance wallet.</p> : null}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[["Portfolio value", book?.navUsd, "NAV"], ["Available cash", book?.cashUsd, "LIQUIDITY"], ["Today’s P&L", book?.dailyPnlUsd, "24 HOURS"], ["Realized P&L", book?.realizedPnlUsd, "ALL TIME"]].map(([label, value, tag]) => <div key={String(label)} className={`${panel} p-4 sm:p-5`}><p className="text-[9px] font-semibold uppercase tracking-[.17em] text-[#718087]">{tag}</p><p className="mt-2 text-xs text-[#92a0a5]">{label}</p><p className="mt-1 text-xl font-medium tabular-nums tracking-[-.03em] sm:text-2xl">{money(value)}</p></div>)}</div>
            <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_370px]"><section className={`${panel} p-5 sm:p-6`}><div className="flex items-center justify-between border-b border-white/[0.07] pb-4"><div><p className="text-[10px] font-semibold uppercase tracking-[.2em] text-[#718087]">Activity</p><h2 className="mt-1 text-lg font-medium">Recent trades</h2></div><span className="font-mono text-[10px] text-[#718087]">{book?.trades ?? 0} total</span></div><div className="mt-1">{(book?.recent || []).slice(0, 8).length ? (book?.recent || []).slice(0, 8).map((trade, i) => <div key={`${trade.symbol}-${i}`} className="flex items-center justify-between gap-4 border-b border-white/[0.055] py-3 last:border-0"><span className="flex items-center gap-3"><span className={`grid h-8 w-8 place-items-center rounded-lg text-[10px] font-semibold ${trade.side?.toLowerCase() === "sell" ? "bg-[#f06c72]/10 text-[#f08085]" : "bg-[#18cf7a]/10 text-[#42da99]"}`}>{trade.side?.slice(0, 1)}</span><span><span className="block text-sm font-medium">{trade.symbol || "—"}</span><span className="mt-0.5 block text-[10px] text-[#718087]">{trade.side || "Trade"}</span></span></span><span className="font-mono text-xs tabular-nums text-[#bac5c9]">{money(trade.usd)}</span></div>) : <div className="grid min-h-40 place-items-center text-center"><div><p className="text-sm text-[#a4b0b4]">No trades yet</p><p className="mt-1 text-xs text-[#6f7d82]">Your agent activity will appear here.</p></div></div>}</div></section>
              <div className="grid gap-4">
                <PositionSizeCard
                  preset={preset}
                  customSize={customSize}
                  onPreset={setPreset}
                  onCustom={setCustomSize}
                  showSave
                  saving={busy === "risk"}
                  onSave={savePosition}
                  kicker="Risk"
                />
                <div className={`${panel} p-5`}><p className="text-[10px] font-semibold uppercase tracking-[.2em] text-[#718087]">Wallet connection</p><h2 className="mt-1 text-lg font-medium">Binance Agentic Wallet</h2><p className="mt-2 break-all font-mono text-[11px] text-[#8b999e]">{tenant?.wallet_address || "Not paired yet"}</p>{pairUrl || pairCode ? <div className="mt-4 rounded-xl border border-[#18cf7a]/20 bg-[#18cf7a]/[0.05] p-4"><p className="text-[9px] uppercase tracking-[.17em] text-[#849397]">Scan with Binance</p>{pairUrl ? <div className="mt-3 flex justify-center"><TreasuryQr value={pairUrl} title="Binance Agentic Wallet sign-in QR" size={168} /></div> : null}<p className="mt-3 text-[10px] leading-4 text-[#78868b]">{pairUrl ? "Open the Binance app and scan this code, then confirm below." : "Enter this code in Binance, then confirm below."}</p>{pairCode ? <p className="mt-2 text-center font-mono text-sm tracking-[.2em] text-[#42da99]">{pairCode}</p> : null}</div> : null}<div className="mt-4 grid gap-2"><RainbowButton className="w-full" disabled={busy === "pair-start"} onClick={() => act("pair-start")}>{busy === "pair-start" ? "Requesting QR…" : pairUrl || pairCode ? "Refresh QR" : "Pair Binance wallet"}</RainbowButton>{qr ? <RainbowButton className="w-full" disabled={busy === "pair-verify"} onClick={() => act("pair-verify", { qrCodeId: qr })}>{busy === "pair-verify" ? "Confirming…" : "I confirmed in Binance"}</RainbowButton> : null}<button type="button" className={buttonQuiet + " w-full"} onClick={() => act(tenant?.status === "paused" ? "resume" : "pause")}>{tenant?.status === "paused" ? "Resume agent" : "Pause agent"}</button></div><div className="mt-5 flex items-start gap-2 border-t border-white/[0.07] pt-4 text-[10px] leading-5 text-[#748187]"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-[#42da99]"/> Your trading funds remain in your Binance wallet. Neural Alpha never takes custody.</div></div></div></div>
            {error ? <p role="alert" className="mt-4 text-sm text-[#ff8e97]">{error}</p> : null}
          </motion.div> : null}
        </AnimatePresence> : null}
        <footer className="mt-10 flex flex-col justify-between gap-3 border-t border-white/[0.07] pt-5 text-[10px] text-[#5f6d72] sm:flex-row sm:items-center"><span>© Neural Alpha · Autonomous bStock trading</span><span className="flex items-center gap-2"><ShieldCheck size={12} /> Payments verified on BNB Smart Chain</span></footer>
        </main>
      </div>
    </div>
  );
}
