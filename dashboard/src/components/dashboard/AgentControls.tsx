"use client";

import { useState, useEffect, useCallback, useId, useMemo, useRef, type ReactNode } from "react";
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useSpring, useTransform } from "framer-motion";
import {
  AlertTriangle,
  Bell,
  BrainCircuit,
  CalendarClock,
  Check,
  Copy,
  Download,
  ExternalLink,
  KeyRound,
  MonitorSmartphone,
  Trash2,
  Wallet,
  Fuel,
  Globe2,
  Layers,
  Loader2,
  Rocket,
  RotateCcw,
  Scale,
  Send,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Target,
  WifiOff,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface DeskConfig {
  mode: string;
  maxPositionSizeUsd: number;
  slippageTolerance: number;
  minGasReserveUsd: number;
  maxPortfolioTokens: number;
  baseCurrency: string;
  swapCurrencies?: string[];
  stopLossPct?: number;
  takeProfitPct?: number;
  trailingGivebackPct?: number;
  initialDepositUsd?: number;
}

/** Paid x402 signal sources a hosted customer can switch on or off. */
export interface SignalSwitches {
  cmc: boolean;
  studio: boolean;
}

export interface SignalControls {
  value: SignalSwitches;
  onChange: (patch: Partial<SignalSwitches>) => Promise<{ ok: boolean; error?: string }>;
}

/** Hosted customers only: where the subscription stands, and the Telegram link. */
export interface AccountControls {
  subscription: {
    stage: "active" | "grace" | "lapsed" | "unknown";
    daysLeft: number | null;
    endsAt: string | null;
    graceEndsAt: string | null;
    cancelling: boolean;
  };
  telegramLinked: boolean;
  /** Wallets that can sign in without the access code (identity only: no funds, no trading). */
  loginWallets: string[];
  signedInBrowsers: number;
  onLinkWallet: () => Promise<{ ok: boolean; error?: string }>;
  onUnlinkWallet: (address: string) => Promise<{ ok: boolean; error?: string }>;
  onNewAccessCode: () => Promise<{ ok: boolean; code?: string; error?: string }>;
  onSignOutOthers: () => Promise<{ ok: boolean; error?: string }>;
  onRenew: () => void;
  onCancel: (undo: boolean) => Promise<{ ok: boolean; error?: string }>;
  onTelegramCode: () => Promise<{ ok: boolean; code?: string; deepLink?: string; expiresAt?: string; error?: string }>;
  onTelegramUnlink: () => Promise<{ ok: boolean; error?: string }>;
  /** Re-reads the account; called while a Telegram code is waiting to be used. */
  onRefresh: () => Promise<void>;
}

interface Form {
  deposit: number;
  maxPos: number;
  maxPositions: number;
  stopLoss: number;
  takeProfit: number;
  trailGiveback: number;
  slippage: number;
  gasReserve: number;
}

const DEFAULTS: Form = {
  deposit: 2000,
  maxPos: 250,
  maxPositions: 4,
  stopLoss: 8,
  takeProfit: 14,
  trailGiveback: 1,
  slippage: 1,
  gasReserve: 1.5,
};

function fromConfig(c: DeskConfig): Form {
  return {
    deposit: c.initialDepositUsd ?? DEFAULTS.deposit,
    maxPos: c.maxPositionSizeUsd,
    maxPositions: c.maxPortfolioTokens,
    stopLoss: c.stopLossPct ?? DEFAULTS.stopLoss,
    takeProfit: c.takeProfitPct ?? DEFAULTS.takeProfit,
    trailGiveback: c.trailingGivebackPct ?? DEFAULTS.trailGiveback,
    slippage: c.slippageTolerance,
    gasReserve: c.minGasReserveUsd,
  };
}

type Tone = "green" | "blue" | "amber" | "red";

/** One tap sets the six trading numbers; deposit and gas reserve stay as they are. */
const PROFILES: {
  id: string;
  name: string;
  tag: string;
  icon: LucideIcon;
  tone: Tone;
  values: Pick<Form, "maxPos" | "maxPositions" | "stopLoss" | "takeProfit" | "trailGiveback" | "slippage">;
}[] = [
  { id: "cautious", name: "Cautious", tag: "Protect capital first", icon: Shield, tone: "blue", values: { maxPos: 50, maxPositions: 2, stopLoss: 5, takeProfit: 10, trailGiveback: 0.5, slippage: 0.5 } },
  { id: "balanced", name: "Balanced", tag: "Steady, even growth", icon: Scale, tone: "green", values: { maxPos: 100, maxPositions: 3, stopLoss: 8, takeProfit: 14, trailGiveback: 1, slippage: 1 } },
  { id: "active", name: "Active", tag: "Chase bigger moves", icon: Rocket, tone: "amber", values: { maxPos: 250, maxPositions: 6, stopLoss: 12, takeProfit: 20, trailGiveback: 2, slippage: 2 } },
];

const TONE: Record<Tone, { text: string; fill: string; glow: string; tile: string }> = {
  green: { text: "text-[#2fd98a]", fill: "#12b264", glow: "rgba(18,178,100,.20)", tile: "from-[#12b264] to-[#0b7a45]" },
  blue: { text: "text-[#61b0ff]", fill: "#3b9eff", glow: "rgba(59,158,255,.20)", tile: "from-[#3b9eff] to-[#2467c9]" },
  amber: { text: "text-[#f5b942]", fill: "#f5b942", glow: "rgba(245,185,66,.18)", tile: "from-[#f5b942] to-[#c9871c]" },
  red: { text: "text-[#ff6b79]", fill: "#ff4d5e", glow: "rgba(255,77,94,.18)", tile: "from-[#ff4d5e] to-[#c92d3f]" },
};

function snap(value: number, step: number): number {
  const decimals = step < 1 ? (String(step).split(".")[1]?.length ?? 1) : 0;
  return Number((Math.round(value / step) * step).toFixed(decimals));
}

function clamp(value: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(value)) return min;
  return snap(Math.min(max, Math.max(min, value)), step);
}

const GLASS =
  "border border-white/[0.08] bg-[linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.012))] shadow-[inset_0_1px_0_rgba(255,255,255,.06),0_18px_40px_-24px_rgba(0,0,0,.8)] backdrop-blur-sm";

function RangeField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
  unit,
  tone = "blue",
  disabled,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  unit?: "USD" | "%";
  tone?: Tone;
  disabled?: boolean;
}) {
  const id = useId();
  const t = TONE[tone];
  const [typed, setTyped] = useState<string | null>(null);
  const pct = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
  const shown = typed ?? String(value);
  const edge = (n: number) => (unit === "USD" ? `$${n.toLocaleString("en-US")}` : unit === "%" ? `${n}%` : String(n));

  return (
    <div className={cn("min-w-0", disabled && "opacity-70")}>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <label htmlFor={id} className="block text-[13px] font-medium text-[#e4eaef]">
            {label}
          </label>
          <p className="m-0 mt-0.5 truncate text-[11.5px] text-[#7e8a97]">{hint}</p>
        </div>
        <div className={cn("flex shrink-0 items-baseline gap-0.5 rounded-lg px-2 py-1 font-[family-name:var(--mono)] transition-colors focus-within:bg-white/[0.06] hover:bg-white/[0.04]", t.text)}>
          {unit === "USD" && <span className="text-[15px] font-semibold opacity-70">$</span>}
          <input
            id={id}
            type="text"
            inputMode="decimal"
            disabled={disabled}
            value={shown}
            style={{ width: `${Math.max(1, shown.length) + 0.2}ch` }}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              setTyped(e.target.value);
              const n = parseFloat(e.target.value);
              if (Number.isFinite(n)) onChange(n);
            }}
            onBlur={() => {
              onChange(clamp(value, min, max, step));
              setTyped(null);
            }}
            className="bg-transparent text-right text-[22px] font-semibold leading-none tabular-nums text-inherit outline-none"
          />
          {unit === "%" && <span className="text-[15px] font-semibold opacity-70">%</span>}
        </div>
      </div>
      <input
        type="range"
        aria-label={`${label} slider`}
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, value))}
        disabled={disabled}
        onChange={(e) => onChange(clamp(parseFloat(e.target.value), min, max, step))}
        className="na-range mt-3.5"
        style={{
          background: `linear-gradient(90deg, ${t.fill} ${pct}%, rgba(255,255,255,.08) ${pct}%)`,
          ["--thumb" as string]: t.fill,
        }}
      />
      <div className="mt-1.5 flex justify-between font-[family-name:var(--mono)] text-[10px] text-[#56616d]">
        <span>{edge(min)}</span>
        <span>{edge(max)}</span>
      </div>
    </div>
  );
}

function Panel({
  icon: Icon,
  title,
  subtitle,
  aside,
  children,
  delay = 0,
  className,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  aside?: ReactNode;
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.section
      initial={reduce ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: reduce ? 0 : delay, ease: [0.22, 1, 0.36, 1] }}
      className={cn("min-w-0 rounded-[18px] p-5", GLASS, className)}
    >
      <header className="mb-5 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/[0.06] text-[#cfd8df] ring-1 ring-white/[0.08]">
            <Icon className="size-[18px]" />
          </span>
          <div className="min-w-0">
            <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-white">{title}</h2>
            <p className="m-0 mt-0.5 text-[12px] leading-snug text-[#7e8a97]">{subtitle}</p>
          </div>
        </div>
        {aside}
      </header>
      {children}
    </motion.section>
  );
}

const fmtUsd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const fmtInt = (n: number) => String(Math.round(n));
const fmtStop = (n: number) => `−${n.toFixed(Number.isInteger(Math.round(n * 10) / 10) ? 0 : 1)}%`;
const fmtR = (n: number) => `${n.toFixed(1)}R`;

function Counter({ value, format }: { value: number; format: (n: number) => string }) {
  const reduce = useReducedMotion();
  const target = useMotionValue(value);
  const spring = useSpring(target, { stiffness: 170, damping: 22 });
  const text = useTransform(spring, format);
  useEffect(() => {
    target.set(value);
    if (reduce) spring.jump(value);
  }, [value, reduce, target, spring]);
  return <motion.span>{text}</motion.span>;
}

function Stat({ label, value, format, tone }: { label: string; value: number; format: (n: number) => string; tone: Tone }) {
  return (
    <div className="min-w-0 rounded-2xl bg-black/25 px-4 py-3 ring-1 ring-white/[0.06] backdrop-blur-sm">
      <p className="m-0 text-[10.5px] font-medium uppercase tracking-[0.14em] text-[#7e8a97]">{label}</p>
      <p className={cn("m-0 mt-1.5 truncate font-[family-name:var(--mono)] text-[24px] font-semibold leading-8 tabular-nums transition-colors duration-500", TONE[tone].text)}>
        <Counter value={value} format={format} />
      </p>
    </div>
  );
}

function Switch({
  checked,
  busy,
  disabled,
  onChange,
  labelledBy,
}: {
  checked: boolean;
  busy?: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  labelledBy: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-8 w-[58px] shrink-0 items-center rounded-full p-1 ring-1 transition-colors duration-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2fd98a] disabled:cursor-not-allowed",
        checked ? "justify-end bg-[linear-gradient(135deg,#1fd98a,#0f9d5a)] ring-[#2fd98a]/40 shadow-[0_0_24px_-4px_rgba(31,217,138,.55)]" : "justify-start bg-white/[0.07] ring-white/[0.1]",
        disabled && !busy && "opacity-60"
      )}
    >
      <motion.span layout transition={{ type: "spring", stiffness: 700, damping: 38 }} className="grid size-6 place-items-center rounded-full bg-white shadow-[0_2px_8px_rgba(0,0,0,.4)]">
        {busy ? <Loader2 className="size-3.5 animate-spin text-[#0a6b3d]" /> : checked ? <Check className="size-3.5 text-[#0a6b3d]" strokeWidth={3} /> : null}
      </motion.span>
    </button>
  );
}

function SignalCard({
  icon: Icon,
  title,
  body,
  checked,
  busy,
  disabled,
  onChange,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  checked: boolean;
  busy: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  const id = useId();
  return (
    <motion.div
      layout
      className={cn(
        "relative flex min-w-0 flex-col gap-4 overflow-hidden rounded-2xl p-4 ring-1 transition-colors duration-500",
        checked ? "bg-[radial-gradient(420px_circle_at_0%_0%,rgba(18,178,100,.16),transparent_65%)] ring-[#2fd98a]/25" : "bg-black/20 ring-white/[0.07]"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span
          className={cn(
            "grid size-11 place-items-center rounded-xl text-white shadow-lg transition-all duration-500",
            checked ? "bg-gradient-to-br from-[#1fd98a] to-[#0b7a45] shadow-[#12b264]/30" : "bg-white/[0.07] text-[#8b97a3] shadow-none"
          )}
        >
          <Icon className="size-5" />
        </span>
        <Switch checked={checked} busy={busy} disabled={disabled} onChange={onChange} labelledBy={id} />
      </div>
      <div className="min-w-0">
        <p id={id} className="m-0 text-[14.5px] font-semibold text-white">
          {title}
        </p>
        <p className="m-0 mt-1.5 text-[12.5px] leading-[1.6] text-[#8b97a3]">{body}</p>
      </div>
      <p className={cn("m-0 flex items-center gap-1.5 text-[11px] font-medium", checked ? "text-[#2fd98a]" : "text-[#687581]")}>
        <span className={cn("size-1.5 rounded-full", checked ? "animate-pulse bg-[#2fd98a]" : "bg-[#56616d]")} />
        {checked ? "Active — paid from your wallet" : "Off — not used or paid for"}
      </p>
    </motion.div>
  );
}

function SignalsPanel({ controls, disabled }: { controls: SignalControls; disabled: boolean }) {
  const [pending, setPending] = useState<keyof SignalSwitches | null>(null);
  const [optimistic, setOptimistic] = useState<SignalSwitches>(controls.value);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    if (!pending) setOptimistic(controls.value);
  }, [controls.value, pending]);

  const toggle = async (key: keyof SignalSwitches, next: boolean) => {
    const before = optimistic;
    setOptimistic({ ...before, [key]: next });
    setPending(key);
    setNote(null);
    const result = await controls.onChange({ [key]: next }).catch((e) => ({ ok: false, error: String(e) }));
    setPending(null);
    if (result.ok) {
      setNote({ text: "Saved. Your agent restarts with this change in about a minute.", ok: true });
    } else {
      setOptimistic(before);
      setNote({ text: result.error || "Could not save", ok: false });
    }
  };

  const on = Number(optimistic.cmc) + Number(optimistic.studio);

  return (
    <Panel
      icon={Sparkles}
      title="Signal sources"
      subtitle="Paid research layered on top of Binance prices and technicals. Switch each one on or off."
      aside={
        <span className="shrink-0 rounded-full bg-white/[0.06] px-3 py-1.5 font-[family-name:var(--mono)] text-[11px] text-[#cfd8df] ring-1 ring-white/[0.08]">
          {on} of 2 on
        </span>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <SignalCard
          icon={Globe2}
          title="CoinMarketCap macro"
          body="One paid check a day (the minimum) of global market metrics and upcoming macro events. Position size scales down around big announcements."
          checked={optimistic.cmc}
          busy={pending === "cmc"}
          disabled={disabled || pending !== null}
          onChange={(next) => toggle("cmc", next)}
        />
        <SignalCard
          icon={BrainCircuit}
          title="Agent Studio research"
          body="Optional and off by default. Adds BNB Chain Agent Studio stock analysis on the names your agent is watching, at extra cost per call."
          checked={optimistic.studio}
          busy={pending === "studio"}
          disabled={disabled || pending !== null}
          onChange={(next) => toggle("studio", next)}
        />
      </div>
      <p className="m-0 mt-4 flex items-start gap-2 text-[12px] leading-relaxed text-[#7e8a97]">
        <Zap className="mt-0.5 size-3.5 shrink-0 text-[#f4c22b]" />
        <span>
          Each call is paid from your Agentic Wallet with <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-[family-name:var(--mono)] text-[11px] text-[#cfd8df]">baw x402</code>. Gasless, no API key.
          {on === 0 ? " With both off, the agent trades on Binance price and technicals only." : ""}
        </span>
      </p>
      <AnimatePresence>
        {note && (
          <motion.p
            role="status"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className={cn("m-0 mt-3 flex items-center gap-1.5 overflow-hidden text-[12px]", note.ok ? "text-[#2fd98a]" : "text-[#ff6b79]")}
          >
            {note.ok ? <Check className="size-3.5 shrink-0" /> : <AlertTriangle className="size-3.5 shrink-0" />}
            {note.text}
          </motion.p>
        )}
      </AnimatePresence>
    </Panel>
  );
}

function ExitMap({ stopLoss, takeProfit, giveback }: { stopLoss: number; takeProfit: number; giveback: number }) {
  const span = stopLoss + takeProfit;
  const slShare = span > 0 ? (stopLoss / span) * 100 : 50;
  const trailShare = takeProfit > 0 ? Math.min(100 - slShare, (giveback / takeProfit) * (100 - slShare)) : 0;
  const spring = { type: "spring" as const, stiffness: 260, damping: 32 };

  return (
    <div className="rounded-2xl bg-black/25 px-4 pb-3.5 pt-5 ring-1 ring-white/[0.06]">
      <div className="relative h-3 rounded-full bg-white/[0.06]">
        <motion.div className="absolute inset-y-0 left-0 rounded-l-full bg-gradient-to-r from-[#c92d3f] to-[#ff4d5e]" animate={{ width: `${slShare}%` }} transition={spring} />
        <motion.div className="absolute inset-y-0 right-0 rounded-r-full bg-gradient-to-r from-[#0b7a45] to-[#2fd98a]" animate={{ width: `${100 - slShare}%` }} transition={spring} />
        <motion.div
          className="absolute inset-y-0 right-0 rounded-r-full bg-[repeating-linear-gradient(135deg,rgba(255,255,255,.4)_0_3px,transparent_3px_6px)]"
          animate={{ width: `${trailShare}%` }}
          transition={spring}
        />
        <motion.span
          className="absolute top-1/2 h-7 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_4px_rgba(9,11,13,.9),0_0_16px_rgba(255,255,255,.4)]"
          animate={{ left: `${slShare}%` }}
          transition={spring}
        />
      </div>
      <div className="mt-3.5 flex items-start justify-between gap-2 font-[family-name:var(--mono)] text-[11px]">
        <span className="text-[#ff6b79]">−{stopLoss}% stop</span>
        <span className="text-[#7e8a97]">entry</span>
        <span className="text-right text-[#2fd98a]">+{takeProfit}% arms trail</span>
      </div>
    </div>
  );
}

function fmtDate(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
}

function SubscriptionPanel({ account, disabled }: { account: AccountControls; disabled: boolean }) {
  const s = account.subscription;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const tone: Tone = s.stage === "active" ? "green" : s.stage === "grace" ? "amber" : s.stage === "lapsed" ? "red" : "blue";
  const label = s.stage === "active" ? (s.cancelling ? "Ending" : "Active") : s.stage === "grace" ? "Grace period" : s.stage === "lapsed" ? "Paused buys" : "Unknown";
  const detail =
    s.stage === "active"
      ? s.cancelling
        ? `Ends ${fmtDate(s.endsAt)}. It will not renew.`
        : `${s.daysLeft} day${s.daysLeft === 1 ? "" : "s"} left. Renew any time; the new month is added after this one.`
      : s.stage === "grace"
        ? `Your month ended. The agent keeps trading until ${fmtDate(s.graceEndsAt)}, then new buys stop.`
        : s.stage === "lapsed"
          ? "New buys are stopped. Open positions stay and their exits still run. Renew to start buying again."
          : "No paid period on this agent yet.";

  const toggleCancel = async () => {
    setBusy(true);
    setError("");
    const r = await account.onCancel(s.cancelling).catch((e) => ({ ok: false, error: String(e) }));
    setBusy(false);
    if (!r.ok) setError(r.error || "Could not save");
  };

  return (
    <Panel
      icon={CalendarClock}
      title="Subscription"
      subtitle="Your agent's paid month."
      delay={0.04}
      aside={
        <span className={cn("shrink-0 rounded-full px-3 py-1.5 text-[11px] font-semibold ring-1", {
          "bg-[rgba(18,178,100,.12)] text-[#2fd98a] ring-[#2fd98a]/30": tone === "green",
          "bg-[rgba(245,185,66,.12)] text-[#f5b942] ring-[#f5b942]/30": tone === "amber",
          "bg-[rgba(255,77,94,.12)] text-[#ff6b79] ring-[#ff6b79]/30": tone === "red",
          "bg-[rgba(59,158,255,.12)] text-[#61b0ff] ring-[#61b0ff]/30": tone === "blue",
        })}>
          {label}
        </span>
      }
    >
      <p className="m-0 text-[13px] leading-relaxed text-[#9aa6b2]">{detail}</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={account.onRenew}
          disabled={disabled}
          className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-[linear-gradient(135deg,#1fd98a,#0f9d5a)] px-5 text-[13px] font-semibold text-[#00160d] shadow-[0_8px_24px_-6px_rgba(31,217,138,.5)] transition hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
        >
          Renew
        </button>
        {s.stage !== "unknown" && s.stage !== "lapsed" && (
          <button
            type="button"
            onClick={toggleCancel}
            disabled={disabled || busy}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl px-3 text-[13px] text-[#8b97a3] transition hover:bg-white/[0.06] hover:text-white disabled:opacity-50"
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {s.cancelling ? "Keep my subscription" : "Don't renew"}
          </button>
        )}
      </div>
      {error && <p role="alert" className="m-0 mt-3 text-[12px] text-[#ff6b79]">{error}</p>}
    </Panel>
  );
}

function TelegramPanel({ account, disabled }: { account: AccountControls; disabled: boolean }) {
  const [issued, setIssued] = useState<{ code: string; deepLink: string; expiresAt: string } | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const ref = useRef(account);
  ref.current = account;
  const linked = account.telegramLinked;

  useEffect(() => {
    if (!issued || linked) return;
    const tick = () => setLeft(Math.max(0, Math.round((Date.parse(issued.expiresAt) - Date.now()) / 1000)));
    tick();
    const clock = window.setInterval(tick, 1000);
    const poll = window.setInterval(() => void ref.current.onRefresh(), 3000);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(poll);
    };
  }, [issued, linked]);

  useEffect(() => {
    if (linked) setIssued(null);
  }, [linked]);

  const make = async () => {
    setBusy(true);
    setError("");
    const r = await account.onTelegramCode().catch((e) => ({ ok: false, error: String(e) }) as Awaited<ReturnType<AccountControls["onTelegramCode"]>>);
    setBusy(false);
    if (r.ok && r.code && r.deepLink && r.expiresAt) setIssued({ code: r.code, deepLink: r.deepLink, expiresAt: r.expiresAt });
    else setError(r.error || "Could not make a code");
  };
  const unlink = async () => {
    setBusy(true);
    setError("");
    const r = await account.onTelegramUnlink().catch((e) => ({ ok: false, error: String(e) }));
    setBusy(false);
    if (!r.ok) setError(r.error || "Could not unlink");
  };
  const copy = () => {
    if (!issued) return;
    void navigator.clipboard?.writeText(issued.code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  const expired = Boolean(issued) && left === 0;

  return (
    <Panel
      icon={Bell}
      title="Telegram alerts"
      subtitle="Trades, problems and your renewal date, sent to your phone."
      delay={0.08}
      aside={
        <span className={cn("shrink-0 rounded-full px-3 py-1.5 text-[11px] font-semibold ring-1", linked ? "bg-[rgba(18,178,100,.12)] text-[#2fd98a] ring-[#2fd98a]/30" : "bg-white/[0.06] text-[#9aa6b2] ring-white/[0.08]")}>
          {linked ? "Linked" : "Not linked"}
        </span>
      }
    >
      {linked ? (
        <>
          <p className="m-0 text-[13px] leading-relaxed text-[#9aa6b2]">
            You will hear about every trade, any time your agent has a problem, and before your subscription ends. Send <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-[family-name:var(--mono)] text-[11px] text-[#cfd8df]">/status</code> to the bot any time.
          </p>
          <button
            type="button"
            onClick={unlink}
            disabled={disabled || busy}
            className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-xl px-3 text-[13px] text-[#8b97a3] transition hover:bg-white/[0.06] hover:text-white disabled:opacity-50"
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            Unlink this chat
          </button>
        </>
      ) : issued && !expired ? (
        <div>
          <p className="m-0 text-[12.5px] text-[#9aa6b2]">Open the bot and send this code. It works once.</p>
          <div className="mt-3 flex items-center gap-2">
            <span className="flex-1 rounded-xl bg-black/30 px-4 py-3 text-center font-[family-name:var(--mono)] text-[22px] font-semibold tracking-[0.25em] text-[#2fd98a] ring-1 ring-white/[0.08]">
              {issued.code}
            </span>
            <button type="button" onClick={copy} aria-label="Copy code" className="grid size-12 place-items-center rounded-xl bg-white/[0.06] text-[#cfd8df] ring-1 ring-white/[0.08] transition hover:bg-white/[0.1]">
              {copied ? <Check className="size-4 text-[#2fd98a]" /> : <Copy className="size-4" />}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <a
              href={issued.deepLink}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-[linear-gradient(135deg,#3b9eff,#2467c9)] px-5 text-[13px] font-semibold text-white transition hover:brightness-110"
            >
              <Send className="size-4" /> Open Telegram <ExternalLink className="size-3.5 opacity-70" />
            </a>
            <span className="inline-flex items-center gap-2 text-[12px] text-[#7e8a97]">
              <Loader2 className="size-3.5 animate-spin" /> Waiting for you · {mmss}
            </span>
          </div>
        </div>
      ) : (
        <>
          <p className="m-0 text-[13px] leading-relaxed text-[#9aa6b2]">
            {expired ? "That code expired. Make a new one." : "Link the Neural Alpha bot once and it messages you about trades, problems and renewals."}
          </p>
          <button
            type="button"
            onClick={make}
            disabled={disabled || busy}
            className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-xl bg-[linear-gradient(135deg,#3b9eff,#2467c9)] px-5 text-[13px] font-semibold text-white transition hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Link Telegram
          </button>
        </>
      )}
      {error && <p role="alert" className="m-0 mt-3 text-[12px] text-[#ff6b79]">{error}</p>}
    </Panel>
  );
}

function SignInPanel({ account }: { account: AccountControls }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(key);
    setError("");
    const r = await fn().catch((e) => ({ ok: false, error: String(e) }));
    setBusy("");
    if (!r.ok) setError(r.error || "That did not work");
  };
  const makeCode = async () => {
    setBusy("code");
    setError("");
    const r = await account.onNewAccessCode().catch((e) => ({ ok: false, error: String(e) }) as Awaited<ReturnType<AccountControls["onNewAccessCode"]>>);
    setBusy("");
    if (r.ok && r.code) setCode(r.code);
    else setError(r.error || "Could not make a code");
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([`Neural Alpha access code\n\n${code}\n\nKeep this somewhere safe. It opens your agent from any browser.\n`], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "neural-alpha-access-code.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  const copy = () =>
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  const row = "flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-black/20 px-4 py-3 ring-1 ring-white/[0.06]";
  const ghost = "inline-flex min-h-9 items-center gap-2 rounded-xl px-3 text-[12.5px] text-[#9aa6b2] transition hover:bg-white/[0.06] hover:text-white disabled:opacity-50";

  return (
    <Panel icon={KeyRound} title="Sign-in and recovery" subtitle="Three ways back into your agent if you lose your code." delay={0.1}>
      <div className="grid gap-3">
        <div className={row}>
          <div className="min-w-0">
            <p className="m-0 text-[13px] font-medium text-white">Access code</p>
            <p className="m-0 mt-0.5 text-[12px] text-[#7e8a97]">Opens your agent from any browser. A new code replaces the old one.</p>
          </div>
          <button type="button" onClick={makeCode} disabled={busy === "code"} className={ghost + " bg-white/[0.06]"}>
            {busy === "code" && <Loader2 className="size-3.5 animate-spin" />} Make a new code
          </button>
          {code && (
            <div className="flex w-full flex-wrap items-center gap-2">
              <span className="rounded-lg bg-black/30 px-3 py-2 font-[family-name:var(--mono)] text-[17px] font-semibold tracking-[0.12em] text-[#2fd98a] ring-1 ring-white/[0.08]">{code}</span>
              <button type="button" onClick={copy} aria-label="Copy code" className="grid size-9 place-items-center rounded-lg bg-white/[0.06] text-[#cfd8df] ring-1 ring-white/[0.08]">{copied ? <Check className="size-4 text-[#2fd98a]" /> : <Copy className="size-4" />}</button>
              <button type="button" onClick={download} className={ghost}><Download className="size-3.5" /> Download</button>
              <p className="m-0 w-full text-[11.5px] text-[#7e8a97]">Shown once. Save it now.</p>
            </div>
          )}
        </div>

        <div className={row}>
          <div className="min-w-0 basis-[260px] flex-1">
            <p className="m-0 flex items-center gap-2 text-[13px] font-medium text-white"><Wallet className="size-3.5 text-[#61b0ff]" /> Login wallets</p>
            <p className="m-0 mt-0.5 text-[12px] leading-5 text-[#7e8a97]">
              Link a browser wallet to sign in without the code. It only signs a message: it cannot move funds, trade, or see your Binance wallet. Up to 3.
            </p>
          </div>
          <button type="button" onClick={() => run("link", account.onLinkWallet)} disabled={busy === "link" || account.loginWallets.length >= 3} className={ghost + " bg-white/[0.06]"}>
            {busy === "link" ? <Loader2 className="size-3.5 animate-spin" /> : <Wallet className="size-3.5" />} Link a wallet
          </button>
          {account.loginWallets.length > 0 && (
            <ul className="m-0 grid w-full list-none gap-2 p-0">
              {account.loginWallets.map((w) => (
                <li key={w} className="flex items-center justify-between gap-3 rounded-lg bg-black/25 px-3 py-2">
                  <span className="font-[family-name:var(--mono)] text-[12.5px] text-[#cfd8df]">{short(w)}</span>
                  <button type="button" aria-label={`Remove ${short(w)}`} onClick={() => run(`rm-${w}`, () => account.onUnlinkWallet(w))} disabled={busy === `rm-${w}`} className={ghost}>
                    {busy === `rm-${w}` ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />} Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={row}>
          <div className="min-w-0">
            <p className="m-0 flex items-center gap-2 text-[13px] font-medium text-white"><MonitorSmartphone className="size-3.5 text-[#9aa6b2]" /> Signed-in browsers</p>
            <p className="m-0 mt-0.5 text-[12px] text-[#7e8a97]">{account.signedInBrowsers} of 3 in use. Signing in on a new device does not sign out the others.</p>
          </div>
          <button type="button" onClick={() => run("out", account.onSignOutOthers)} disabled={busy === "out" || account.signedInBrowsers <= 1} className={ghost + " bg-white/[0.06]"}>
            {busy === "out" && <Loader2 className="size-3.5 animate-spin" />} Sign out other browsers
          </button>
        </div>
      </div>
      {error && <p role="alert" className="m-0 mt-3 text-[12px] text-[#ff6b79]">{error}</p>}
    </Panel>
  );
}

export interface AgentControlsProps {
  connected: boolean;
  config: DeskConfig | null;
  onSave: (updates: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  /** Hosted customers only: per-tenant paid signal switches. */
  signals?: SignalControls | null;
  /** Hosted customers only: subscription and Telegram. */
  account?: AccountControls | null;
}

export function AgentControls({ connected, config, onSave, signals, account }: AgentControlsProps) {
  const reduce = useReducedMotion();
  const [form, setForm] = useState<Form>(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  // Re-sync only when a new config arrives, never over unsaved edits.
  useEffect(() => {
    if (config && !dirtyRef.current) setForm(fromConfig(config));
  }, [config]);

  useEffect(() => {
    if (!message?.ok) return;
    const t = window.setTimeout(() => setMessage(null), 3500);
    return () => window.clearTimeout(t);
  }, [message]);

  const set = useCallback((patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
    setMessage(null);
  }, []);

  const profile = useMemo(
    () => PROFILES.find((p) => (Object.keys(p.values) as (keyof typeof p.values)[]).every((k) => form[k] === p.values[k])) ?? null,
    [form]
  );
  const rewardRisk = form.stopLoss > 0 ? form.takeProfit / form.stopLoss : 0;

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const result = await onSave({
        initialDepositUsd: clamp(form.deposit, 10, 1_000_000, 10),
        maxPositionSizeUsd: clamp(form.maxPos, 5, 10000, 5),
        maxPortfolioTokens: clamp(form.maxPositions, 1, 20, 1),
        slippageTolerance: clamp(form.slippage, 0.1, 10, 0.1),
        minGasReserveUsd: clamp(form.gasReserve, 0.5, 50, 0.5),
        stopLossPct: clamp(form.stopLoss, 1, 40, 0.5),
        takeProfitPct: clamp(form.takeProfit, 1, 200, 0.5),
        trailingActivatePct: clamp(form.takeProfit, 1, 200, 0.5),
        trailingGivebackPct: clamp(form.trailGiveback, 0.1, 10, 0.1),
        autoExitEnabled: true,
      });
      if (result.ok) {
        setMessage({ text: "Applied. Takes effect on the next check.", ok: true });
        setDirty(false);
      } else {
        setMessage({ text: result.error || "Failed to save", ok: false });
      }
    } catch (e) {
      setMessage({ text: String(e), ok: false });
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    if (config) setForm(fromConfig(config));
    setDirty(false);
    setMessage(null);
  };

  const quote = (config?.swapCurrencies || ["USDT"]).join(" / ");
  const live = (config?.mode || "paper").toLowerCase() === "live";
  const off = !connected;
  const rrTone: Tone = rewardRisk >= 1.5 ? "green" : rewardRisk >= 1 ? "amber" : "red";

  return (
    <div className="relative mx-auto flex w-full min-w-0 max-w-[1180px] flex-col gap-5">
      <div aria-hidden className="pointer-events-none absolute -inset-x-10 -top-10 h-[420px] bg-[radial-gradient(520px_circle_at_12%_0%,rgba(18,178,100,.12),transparent_70%),radial-gradient(520px_circle_at_88%_0%,rgba(59,158,255,.11),transparent_70%)]" />

      <AnimatePresence initial={false}>
        {off && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="relative overflow-hidden">
            <div className="flex items-center gap-3 rounded-2xl bg-[rgba(245,185,66,.08)] px-4 py-3 text-[12.5px] text-[#f5b942] ring-1 ring-[rgba(245,185,66,.22)]">
              <WifiOff className="size-4 shrink-0" />
              Your agent is offline. Trading settings unlock when it reconnects. Subscription, Telegram and paid signals still work.
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.section
        initial={reduce ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className={cn("relative isolate overflow-hidden rounded-[22px] p-5 sm:p-6", GLASS)}
      >
        <motion.div
          key={profile?.id ?? "custom"}
          aria-hidden
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8 }}
          className="pointer-events-none absolute inset-0 -z-10"
          style={{ background: `radial-gradient(560px circle at 0% 0%, ${TONE[profile?.tone ?? "blue"].glow}, transparent 65%), radial-gradient(420px circle at 100% 100%, ${TONE[profile?.tone ?? "blue"].glow}, transparent 70%)` }}
        />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#7e8a97]">Trading profile</p>
            <motion.h1
              key={profile?.id ?? "custom"}
              initial={reduce ? false : { opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              className="m-0 mt-1.5 bg-gradient-to-r from-white to-[#9fb3c2] bg-clip-text text-[30px] font-semibold leading-none tracking-[-0.035em] text-transparent"
            >
              {profile ? profile.name : "Custom"}
            </motion.h1>
            <p className="m-0 mt-2 max-w-[44ch] text-[13px] leading-relaxed text-[#8b97a3]">
              {profile ? profile.tag + "." : "Your own mix of size, exits and execution."} Pick a profile, then fine-tune below.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] ring-1",
                live ? "bg-[rgba(18,178,100,.12)] text-[#2fd98a] ring-[#2fd98a]/30" : "bg-[rgba(59,158,255,.12)] text-[#61b0ff] ring-[#61b0ff]/30"
              )}
            >
              <span className={cn("size-1.5 rounded-full", live ? "animate-pulse bg-[#2fd98a]" : "bg-[#61b0ff]")} />
              {live ? "Live" : "Paper"}
            </span>
            <span className="rounded-full bg-white/[0.06] px-3 py-1.5 font-[family-name:var(--mono)] text-[11px] text-[#cfd8df] ring-1 ring-white/[0.08]">{quote}</span>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <Stat label="Per buy" value={form.maxPos} format={fmtUsd} tone="blue" />
          <Stat label="Open names" value={form.maxPositions} format={fmtInt} tone="blue" />
          <Stat label="Stop-loss" value={form.stopLoss} format={fmtStop} tone="red" />
          <Stat label="Reward / risk" value={rewardRisk} format={fmtR} tone={rrTone} />
        </div>
      </motion.section>

      {account && (
        <div className="grid min-w-0 gap-5 xl:grid-cols-2">
          <SubscriptionPanel account={account} disabled={false} />
          <TelegramPanel account={account} disabled={false} />
        </div>
      )}
      {account && <SignInPanel account={account} />}

      <div className={cn("grid min-w-0 gap-5", signals && "xl:grid-cols-2")}>
      <Panel icon={Layers} title="Risk profile" subtitle="One tap sets size, names, stop, trail and slippage together." delay={0.05}>
        <div role="radiogroup" aria-label="Risk profile" className="grid gap-3 sm:grid-cols-3">
          {PROFILES.map((p) => {
            const active = profile?.id === p.id;
            const t = TONE[p.tone];
            const Icon = p.icon;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={off}
                onClick={() => set(p.values)}
                className="group relative min-w-0 rounded-2xl p-4 text-left outline-none transition-transform duration-200 focus-visible:ring-2 focus-visible:ring-white/40 enabled:hover:-translate-y-0.5 enabled:active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-70"
              >
                <span className="absolute inset-0 rounded-2xl bg-black/20 ring-1 ring-white/[0.07] transition-colors group-enabled:group-hover:ring-white/[0.16]" />
                {active && (
                  <motion.span
                    layoutId="profile-ring"
                    className="absolute inset-0 rounded-2xl ring-2"
                    style={{ background: `radial-gradient(320px circle at 0% 0%, ${t.glow}, transparent 70%)`, ["--tw-ring-color" as string]: t.fill }}
                    transition={{ type: "spring", stiffness: 420, damping: 36 }}
                  />
                )}
                <span className="relative block">
                  <span className="flex items-center justify-between">
                    <span className={cn("grid size-10 place-items-center rounded-xl bg-gradient-to-br text-white shadow-lg", t.tile)}>
                      <Icon className="size-[18px]" />
                    </span>
                    <span className={cn("grid size-5 place-items-center rounded-full transition-all", active ? "scale-100 bg-white text-black opacity-100" : "scale-75 opacity-0")}>
                      <Check className="size-3" strokeWidth={3.5} />
                    </span>
                  </span>
                  <span className="mt-3.5 block text-[15px] font-semibold text-white">{p.name}</span>
                  <span className="mt-0.5 block text-[12px] text-[#7e8a97]">{p.tag}</span>
                  <span className={cn("mt-3 block font-[family-name:var(--mono)] text-[11.5px] leading-[1.6]", t.text)}>
                    <span className="block">${p.values.maxPos} per buy</span>
                    <span className="block opacity-75">
                      {p.values.maxPositions} names · −{p.values.stopLoss}% stop
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </Panel>

      {/* Paid-call switches and Telegram go to the control plane, not the agent, so they stay usable while the agent is down. */}
      {signals && <SignalsPanel controls={signals} disabled={false} />}
      </div>

      <div className="mt-1 flex items-center gap-2.5 px-1">
        <SlidersHorizontal className="size-4 text-[#7e8a97]" />
        <h2 className="m-0 text-[13px] font-semibold uppercase tracking-[0.16em] text-[#9aa6b2]">Fine-tune</h2>
        <span className="h-px flex-1 bg-gradient-to-r from-white/[0.1] to-transparent" />
      </div>

      <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Panel icon={Layers} title="Position" subtitle="Balance and size per name." delay={0.1}>
          <div className="grid gap-7">
            <RangeField label="Start deposit" hint="USDT you fund, plus gas" value={form.deposit} onChange={(v) => set({ deposit: v })} min={10} max={20000} step={10} unit="USD" tone="blue" disabled={off} />
            <RangeField label="Max per buy" hint="largest single order" value={form.maxPos} onChange={(v) => set({ maxPos: v })} min={5} max={1000} step={5} unit="USD" tone="blue" disabled={off} />
            <RangeField label="Open names" hint="held at the same time" value={form.maxPositions} onChange={(v) => set({ maxPositions: v })} min={1} max={20} step={1} tone="blue" disabled={off} />
          </div>
        </Panel>

        <Panel
          icon={Target}
          title="Exits"
          subtitle="Cut losers, trail winners."
          delay={0.15}
          aside={
            <motion.span
              key={rewardRisk.toFixed(1)}
              initial={reduce ? false : { scale: 0.8, opacity: 0.5 }}
              animate={{ scale: 1, opacity: 1 }}
              className={cn("shrink-0 rounded-full px-3 py-1.5 font-[family-name:var(--mono)] text-[12px] font-semibold ring-1", {
                "bg-[rgba(18,178,100,.12)] text-[#2fd98a] ring-[#2fd98a]/30": rrTone === "green",
                "bg-[rgba(245,185,66,.12)] text-[#f5b942] ring-[#f5b942]/30": rrTone === "amber",
                "bg-[rgba(255,77,94,.12)] text-[#ff6b79] ring-[#ff6b79]/30": rrTone === "red",
              })}
              title="Reward to risk"
            >
              {rewardRisk.toFixed(1)}R
            </motion.span>
          }
        >
          <ExitMap stopLoss={form.stopLoss} takeProfit={form.takeProfit} giveback={form.trailGiveback} />
          <div className="mt-6 grid gap-7">
            <RangeField label="Stop-loss" hint="sell if it falls this far" value={form.stopLoss} onChange={(v) => set({ stopLoss: v })} min={1} max={40} step={0.5} unit="%" tone="red" disabled={off} />
            <RangeField label="Arm trail" hint="gain that starts trailing" value={form.takeProfit} onChange={(v) => set({ takeProfit: v })} min={1} max={100} step={0.5} unit="%" tone="green" disabled={off} />
            <RangeField label="Trail drop" hint="sell this far below the peak" value={form.trailGiveback} onChange={(v) => set({ trailGiveback: v })} min={0.1} max={10} step={0.1} unit="%" tone="green" disabled={off} />
          </div>
        </Panel>

        <Panel icon={Fuel} title="Execution" subtitle="Swap tolerance and gas." delay={0.2} className="md:col-span-2 xl:col-span-1">
          <div className="grid gap-7">
            <RangeField label="Slippage" hint="max price move on a swap" value={form.slippage} onChange={(v) => set({ slippage: v })} min={0.1} max={10} step={0.1} unit="%" tone="amber" disabled={off} />
            <RangeField label="Gas reserve" hint="kept in BNB, never traded" value={form.gasReserve} onChange={(v) => set({ gasReserve: v })} min={0.5} max={50} step={0.5} unit="USD" tone="amber" disabled={off} />
          </div>
        </Panel>
      </div>

      <div className="pointer-events-none sticky bottom-4 z-10 h-0">
        <AnimatePresence>
          {(dirty || message) && (
            <motion.div
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 420, damping: 34 }}
              className="pointer-events-auto absolute bottom-0 left-1/2 flex w-[min(640px,100%)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-2xl bg-[rgba(14,16,18,.82)] px-4 py-3 text-[13px] shadow-[0_24px_60px_rgba(0,0,0,.6)] ring-1 ring-white/[0.1] backdrop-blur-xl"
            >
              <span
                role="status"
                aria-live="polite"
                className={cn("flex min-w-0 flex-1 items-center gap-2", message ? (message.ok ? "text-[#2fd98a]" : "text-[#ff6b79]") : "text-[#cfd8df]")}
              >
                {message ? (
                  message.ok ? <Check className="size-4 shrink-0" /> : <AlertTriangle className="size-4 shrink-0" />
                ) : (
                  <span className="size-2 shrink-0 rounded-full bg-[#f5b942] shadow-[0_0_0_4px_rgba(245,185,66,.14)]" />
                )}
                <span className="truncate">{message ? message.text : "Unsaved changes"}</span>
              </span>
              {dirty && (
                <button type="button" onClick={reset} className="inline-flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-[#8b97a3] transition hover:bg-white/[0.06] hover:text-white">
                  <RotateCcw className="size-3.5" /> Reset
                </button>
              )}
              {dirty && (
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={off || saving}
                  className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-[linear-gradient(135deg,#1fd98a,#0f9d5a)] px-5 font-semibold text-[#00160d] shadow-[0_8px_24px_-6px_rgba(31,217,138,.6)] transition hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
                >
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" strokeWidth={3} />}
                  {saving ? "Applying" : "Apply changes"}
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
