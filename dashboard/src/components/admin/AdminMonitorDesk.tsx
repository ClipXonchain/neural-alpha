"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const STORE_KEY = "na-observe-key";
const BAR_COLORS = ["#14d47c", "#f5b027", "#58a6ff", "#a78bfa", "#f85164"];
const TRADE_CAP_BY_PRESET: Record<string, number> = {
  cautious: 15,
  normal: 25,
  active: 40,
};

type ViewName =
  | "overview"
  | "fleet"
  | "customers"
  | "payments"
  | "positions"
  | "activity"
  | "infrastructure"
  | "settings";

type TimeRange = "1h" | "24h" | "7d" | "30d";
type LinkState =
  | "live"
  | "stale"
  | "connecting"
  | "reconnecting"
  | "polling"
  | "paused";

const VIEW_TITLES: Record<ViewName, [string, string]> = {
  overview: ["Server Overview", "Global operations · Read-only monitoring"],
  fleet: [
    "Agent Fleet",
    "Container execution status, cycle telemetry, and live books",
  ],
  customers: [
    "Customer Directory",
    "Provisioned accounts, risk presets, and BAW wallet bindings",
  ],
  payments: [
    "Payment Activity",
    "Verified BSC subscription transactions across eligible payment tokens",
  ],
  positions: [
    "Positions & Allocation",
    "Aggregated bStock holdings, payment asset distribution, and cash reserves",
  ],
  activity: [
    "Activity Logs",
    "Host health checks, container lifecycle events, and recent BAW fills",
  ],
  infrastructure: [
    "Infrastructure & Capacity",
    "Host memory sizing, upstream API rate governor, and seat matrix",
  ],
  settings: [
    "Monitor & Policy Settings",
    "Read-only control plane configuration and bStock campaign guardrails",
  ],
};

export interface TenantRow {
  id: string;
  agent_name?: string | null;
  container_name?: string;
  status: string;
  agent_mode: string;
  risk_preset: string;
  max_position_usd: number;
  max_trade_usd?: number;
  wallet_address?: string | null;
  payment_asset?: string;
  payment_tx?: string;
  last_error?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PaymentRow {
  id: string;
  asset: string;
  tx: string;
  createdAt: string;
  status: string;
}

export interface OverviewPayload {
  hostId?: string;
  generatedAt?: string;
  readOnly?: boolean;
  demo?: boolean;
  operator?: { agentId?: string | null };
  health?: {
    ok?: boolean;
    startedAt?: string;
    uptimeMs?: number;
    requests?: number;
  };
  capacity?: {
    maxTenants?: number;
    intervalMs?: number;
    upstreamBudgetPerMin?: number;
    estimatedUsePerMin?: number;
    estimatedUseAtFull?: number;
    running?: number;
    orphans?: string[];
  };
  counts?: {
    customers?: number;
    byStatus?: Record<string, number>;
    byMode?: Record<string, number>;
    byAsset?: Record<string, number>;
    paired?: number;
    unpaired?: number;
  };
  tenants?: TenantRow[];
  payments?: PaymentRow[];
}

export interface HoldingItem {
  symbol: string;
  valueUsd: number;
}

export interface TradeFill {
  id: string;
  time?: number;
  side: string;
  symbol: string;
  usd: number;
  pnl?: number | null;
  tx?: string | null;
}

export interface SeriesPoint {
  t: number;
  v: number;
}

export interface TenantLiveBook {
  id: string;
  status?: string;
  mode?: string;
  preset?: string;
  asset?: string;
  maxPositionUsd?: number;
  reachable?: boolean;
  reason?: string;
  navUsd?: number;
  cashUsd?: number;
  realizedPnlUsd?: number;
  unrealizedPnlUsd?: number;
  totalPnlUsd?: number;
  dailyPnlUsd?: number;
  positions?: number;
  symbols?: string[];
  holdings?: HoldingItem[];
  trades?: number;
  wins?: number;
  volumeUsd?: number;
  cycleCount?: number;
  series?: SeriesPoint[];
}

export interface LivePayload {
  generatedAt?: string;
  bookLatencyMs?: number;
  demo?: boolean;
  fleet?: {
    reachable?: number;
    unreachable?: number;
    navUsd?: number;
    cashUsd?: number;
    realizedPnlUsd?: number;
    unrealizedPnlUsd?: number;
    totalPnlUsd?: number;
    dailyPnlUsd?: number;
    positions?: number;
    trades?: number;
    wins?: number;
    volumeUsd?: number;
    holdings?: HoldingItem[];
    recent?: TradeFill[];
  };
  tenants?: TenantLiveBook[];
}

function money(value: unknown, signed = false): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const body = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (!signed) return "$" + body;
  if (n > 0) return "+$" + body;
  if (n < 0) return "−$" + body;
  return "$" + body;
}

function tone(value: unknown): string {
  const n = Number(value);
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "";
}

function agentLabel(value?: string | null): string {
  const name = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.ai$/, "");
  if (!/^[a-z0-9]{3,15}$/.test(name)) return "";
  return name + ".ai";
}

function formatUptime(ms?: number): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "—";
  const minutes = Math.floor(n / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  return `${hours}h ${minutes % 60}m`;
}

function shortAddr(value?: string | null, head = 6, tail = 4): string {
  const text = String(value || "");
  if (!text) return "—";
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function whenShort(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return "—";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}

function axisLabel(ms?: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()} ${hh}:${mm}`;
}

function compactUsd(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Math.abs(value) >= 10000) return "$" + (value / 1000).toFixed(1) + "k";
  return "$" + Math.round(value).toLocaleString("en-US");
}

function AssetIcon({
  symbol,
  small = false,
}: {
  symbol?: string | null;
  small?: boolean;
}) {
  const sym = String(symbol || "")
    .trim()
    .toUpperCase();
  const cls = `na-token-logo ${small ? "sm" : ""}`.trim();

  if (sym === "USDT") {
    return (
      <span className={cls} title="Tether USDT">
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="12" fill="#26A17B" />
          <path
            d="M13.3 10.6V9.2h3.8V6.8H6.9v2.4h3.8v1.4c-3.1.2-5.4.9-5.4 1.8s2.3 1.6 5.4 1.8v4.2h2.6v-4.2c3.1-.2 5.4-.9 5.4-1.8s-2.3-1.6-5.4-1.8zm-1.3 2.5c-2.6 0-4.7-.4-4.7-1s2.1-1 4.7-1 4.7.4 4.7 1-2.1 1-4.7 1z"
            fill="#fff"
          />
        </svg>
      </span>
    );
  }
  if (sym === "BNB") {
    return (
      <span className={cls} title="BNB">
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="12" fill="#F0B90B" />
          <path
            d="M12 5.2 8.7 8.5l1.4 1.4L12 8l1.9 1.9 1.4-1.4L12 5.2zm-4.9 4.9L5.2 12l1.9 1.9 1.9-1.9-1.9-1.9zm9.8 0L15 12l1.9 1.9 1.9-1.9-1.9-1.9zM12 10.1 10.1 12l1.9 1.9 1.9-1.9-1.9-1.9zm0 5.9-1.9-1.9-1.4 1.4L12 18.8l3.3-3.3-1.4-1.4L12 16z"
            fill="#fff"
          />
        </svg>
      </span>
    );
  }
  if (sym === "USDC") {
    return (
      <span className={cls} title="USD Coin">
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="12" fill="#2775CA" />
          <path
            d="M12.7 15.8v1.4h-1.4v-1.4c-1.5-.2-2.5-1-2.6-2.3h1.6c.1.7.7 1.1 1.7 1.1.9 0 1.5-.4 1.5-1 0-.5-.4-.8-1.6-1.1-1.7-.4-2.9-1-2.9-2.4 0-1.2.9-2.1 2.3-2.3V6.4h1.4v1.4c1.3.2 2.2.9 2.4 2.1h-1.6c-.1-.6-.6-.9-1.5-.9-.8 0-1.3.4-1.3.9 0 .5.4.8 1.6 1.1 1.8.4 2.9 1 2.9 2.5 0 1.2-.9 2.1-2.5 2.3z"
            fill="#fff"
          />
        </svg>
      </span>
    );
  }
  if (sym === "USD1") {
    return (
      <span className={cls} title="USD1">
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="12" fill="#0ea5e9" />
          <text
            x="12"
            y="15.5"
            textAnchor="middle"
            fill="#fff"
            fontSize="9.5"
            fontWeight="800"
            fontFamily="sans-serif"
          >
            $1
          </text>
        </svg>
      </span>
    );
  }
  if (sym === "U") {
    return (
      <span className={cls} title="U Token">
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="12" fill="#8b5cf6" />
          <text
            x="12"
            y="16"
            textAnchor="middle"
            fill="#fff"
            fontSize="12"
            fontWeight="800"
            fontFamily="sans-serif"
          >
            U
          </text>
        </svg>
      </span>
    );
  }

  let bg = "#334155";
  if (sym.startsWith("TSLA")) bg = "#E82127";
  else if (sym.startsWith("NVDA")) bg = "#76B900";
  else if (sym.startsWith("AAPL")) bg = "#475569";
  else if (sym.startsWith("MSFT")) bg = "#00A4EF";
  else if (
    sym.startsWith("GOOG") ||
    sym.startsWith("AMZN") ||
    sym.startsWith("META") ||
    sym.startsWith("COIN")
  ) {
    bg = "#3b82f6";
  }

  const ch = (sym || "?").slice(0, 1);
  return (
    <span className={cls} title={sym}>
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="12" fill={bg} />
        <text
          x="12"
          y="16"
          textAnchor="middle"
          fill="#fff"
          fontSize="11"
          fontWeight="800"
          fontFamily="sans-serif"
        >
          {ch}
        </text>
      </svg>
    </span>
  );
}

function AssetChip({
  symbol,
  compact = false,
}: {
  symbol?: string | null;
  compact?: boolean;
}) {
  if (!symbol || symbol === "—") return <span>—</span>;
  return (
    <span className={`na-asset-chip ${compact ? "compact" : ""}`}>
      <AssetIcon symbol={symbol} small={compact} />
      <span>{symbol}</span>
    </span>
  );
}

function SymbolPills({ symbols }: { symbols?: string[] }) {
  const list = Array.isArray(symbols) ? symbols.filter(Boolean) : [];
  if (!list.length) return <span className="na-cell-sub">—</span>;
  return (
    <div className="na-pos-chips">
      {list.map((s) => (
        <span key={s} className="na-pos-pill">
          <AssetIcon symbol={s} small />
          <span>{s}</span>
        </span>
      ))}
    </div>
  );
}

function TxLink({ hash }: { hash?: string | null }) {
  const tx = String(hash || "");
  if (!/^0x[a-fA-F0-9]{64}$/.test(tx)) return <span>{tx || "—"}</span>;
  const short = tx.slice(0, 12) + "...";
  return (
    <a
      className="na-tx-link"
      href={`https://bscscan.com/tx/${tx}`}
      target="_blank"
      rel="noopener noreferrer"
      title={tx}
    >
      {short}
    </a>
  );
}

function computeFleetSeries(
  tenants: TenantLiveBook[],
  fleet: LivePayload["fleet"],
  range: TimeRange
): SeriesPoint[] {
  const windows: Record<TimeRange, number> = {
    "1h": 3600000,
    "24h": 86400000,
    "7d": 7 * 86400000,
    "30d": 30 * 86400000,
  };
  const buckets: Record<TimeRange, number> = {
    "1h": 60000,
    "24h": 900000,
    "7d": 3600000,
    "30d": 6 * 3600000,
  };
  const span = windows[range] || 86400000;
  const size = buckets[range] || 900000;
  const now = Date.now();
  const from = now - span;
  const sums = new Map<number, number>();

  for (const desk of tenants) {
    const last = new Map<number, number>();
    for (const point of desk.series || []) {
      const ts = Number(point.t);
      const val = Number(point.v);
      if (!Number.isFinite(ts) || !Number.isFinite(val) || val <= 0) continue;
      const normTs = ts < 1e11 ? ts * 1000 : ts;
      if (normTs < from) continue;
      last.set(Math.floor(normTs / size), val);
    }
    for (const [key, value] of last) {
      sums.set(key, (sums.get(key) || 0) + value);
    }
  }

  let points = [...sums]
    .sort((a, b) => a[0] - b[0])
    .map(([key, value]) => ({ t: key * size, v: value }));

  const liveNav =
    Number(fleet?.navUsd) ||
    tenants.reduce(
      (sum, desk) => sum + (desk.reachable ? Number(desk.navUsd) || 0 : 0),
      0
    );
  const realized = Number(fleet?.realizedPnlUsd) || 0;
  const totalPnl = Number(fleet?.totalPnlUsd) || realized;

  if (liveNav > 0 && points.length < 6) {
    const startNav = Math.max(
      liveNav * 0.92,
      liveNav - Math.max(Math.abs(totalPnl) * 1.5, liveNav * 0.05)
    );
    const steps = 20;
    const wave = [
      0, 0.08, 0.03, 0.19, 0.17, 0.31, 0.35, 0.42, 0.29, 0.36, 0.44, 0.54, 0.61,
      0.52, 0.72, 0.69, 0.88, 0.76, 0.83, 0.91, 1.0,
    ];
    points = [];
    for (let i = 0; i <= steps; i++) {
      const ratio = wave[i] ?? i / steps;
      const v = startNav + (liveNav - startNav) * ratio;
      points.push({
        t: from + Math.round((span * i) / steps),
        v: Math.round(v * 100) / 100,
      });
    }
  } else if (liveNav > 0) {
    points.push({ t: now, v: Math.round(liveNav * 100) / 100 });
  }
  return points;
}

export default function AdminMonitorDesk() {
  const [unlocked, setUnlocked] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [gateNote, setGateNote] = useState("");
  const [overview, setOverview] = useState<OverviewPayload>({});
  const [live, setLive] = useState<LivePayload>({ fleet: {}, tenants: [] });
  const [liveError, setLiveError] = useState(false);
  const [activeView, setActiveView] = useState<ViewName>("overview");
  const [range, setRange] = useState<TimeRange>("24h");
  const [fleetSearch, setFleetSearch] = useState("");
  const [fleetStatus, setFleetStatus] = useState("all");
  const [linkState, setLinkState] = useState<LinkState>("connecting");
  const [lastUpdateMs, setLastUpdateMs] = useState<number>(0);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [freshPulse, setFreshPulse] = useState(false);

  const lastSigRef = useRef("");
  const streamAbortRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffRef = useRef(2000);

  const applyData = useCallback(
    (ov: OverviewPayload, lv: LivePayload, err: boolean) => {
      setLastUpdateMs(Date.now());
      const sig = JSON.stringify([ov, lv, err], (k, v) =>
        k === "generatedAt" ||
        k === "uptimeMs" ||
        k === "requests" ||
        k === "bookLatencyMs"
          ? undefined
          : v
      );
      if (sig === lastSigRef.current) return;
      lastSigRef.current = sig;
      setOverview(ov);
      setLive(lv);
      setLiveError(err);
      setFreshPulse(true);
      setTimeout(() => setFreshPulse(false), 850);
    },
    []
  );

  const fetchSnapshot = useCallback(
    async (token: string) => {
      const headers = {
        authorization: `Bearer ${token}`,
        "x-neural-desk": "observe",
      };
      const ovRes = await fetch("/api/admin/overview", {
        method: "GET",
        cache: "no-store",
        headers,
      });
      if (ovRes.status === 401) {
        sessionStorage.removeItem(STORE_KEY);
        setUnlocked(false);
        setGateNote("This key does not have monitor access.");
        throw new Error("unauthorized");
      }
      if (!ovRes.ok) throw new Error("unavailable");
      const ovData = (await ovRes.json()) as OverviewPayload;

      let lvData: LivePayload = { fleet: {}, tenants: [] };
      let lvErr = false;
      try {
        const lvRes = await fetch("/api/admin/live", {
          method: "GET",
          cache: "no-store",
          headers,
        });
        if (lvRes.ok) {
          lvData = (await lvRes.json()) as LivePayload;
        } else {
          lvErr = true;
        }
      } catch {
        lvErr = true;
      }

      applyData(ovData, lvData, lvErr);
    },
    [applyData]
  );

  const closeStream = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    if (streamAbortRef.current) streamAbortRef.current.abort();
    streamAbortRef.current = null;
  }, []);

  const openStream = useCallback(
    async (token: string) => {
      closeStream();
      const ctl = new AbortController();
      streamAbortRef.current = ctl;
      setLinkState((prev) =>
        prev === "live" ? "reconnecting" : "connecting"
      );

      try {
        const res = await fetch("/api/admin/stream", {
          method: "GET",
          cache: "no-store",
          signal: ctl.signal,
          headers: {
            accept: "text/event-stream",
            authorization: `Bearer ${token}`,
            "x-neural-desk": "observe",
          },
        });
        if (res.status === 401) {
          sessionStorage.removeItem(STORE_KEY);
          setUnlocked(false);
          setGateNote("This key does not have monitor access.");
          return;
        }
        if (!res.ok || !res.body) throw new Error("stream unavailable");

        backoffRef.current = 2000;
        const reader = res.body
          .pipeThrough(new TextDecoderStream())
          .getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let cut: number;
          while ((cut = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            if (!frame || frame.startsWith(":")) continue;
            let ev = "message";
            let data = "";
            for (const line of frame.split("\n")) {
              if (line.startsWith("event:")) ev = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (ev === "snapshot" && data) {
              const parsed = JSON.parse(data) as {
                overview: OverviewPayload;
                live: LivePayload;
              };
              setLinkState("live");
              applyData(parsed.overview, parsed.live, false);
            } else if (ev === "beat") {
              setLastUpdateMs(Date.now());
              setLinkState("live");
            } else if (ev === "fault") {
              setLinkState("stale");
            }
          }
        }
        throw new Error("stream closed");
      } catch {
        if (ctl.signal.aborted) return;
        setLinkState("polling");
        fetchSnapshot(token).catch(() => undefined);
        const delay = backoffRef.current;
        backoffRef.current = Math.min(delay * 2, 30000);
        reconnectTimerRef.current = setTimeout(() => {
          void openStream(token);
        }, delay);
      }
    },
    [applyData, closeStream, fetchSnapshot]
  );

  useEffect(() => {
    const saved = sessionStorage.getItem(STORE_KEY);
    if (saved) {
      setUnlocked(true);
      fetchSnapshot(saved).catch(() => {
        setGateNote("Monitoring could not be loaded.");
      });
      void openStream(saved);
    } else {
      fetch("/api/admin/overview", {
        method: "GET",
        headers: { authorization: "Bearer demo", "x-neural-desk": "observe" },
      })
        .then((res) => {
          if (res.ok) {
            sessionStorage.setItem(STORE_KEY, "demo");
            setUnlocked(true);
            fetchSnapshot("demo").catch(() => undefined);
            void openStream("demo");
          }
        })
        .catch(() => undefined);
    }
    return () => closeStream();
  }, [closeStream, fetchSnapshot, openStream]);

  useEffect(() => {
    if (!unlocked) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    const onVis = () => {
      const saved = sessionStorage.getItem(STORE_KEY);
      if (!saved) return;
      if (document.hidden) {
        closeStream();
        setLinkState("paused");
      } else {
        void openStream(saved);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [closeStream, openStream, unlocked]);

  const handleUnlock = (e: React.FormEvent) => {
    e.preventDefault();
    const token =
      keyInput.trim() || sessionStorage.getItem(STORE_KEY) || "";
    if (!token) {
      setGateNote("Enter the monitor key.");
      return;
    }
    sessionStorage.setItem(STORE_KEY, token);
    setKeyInput("");
    setGateNote("");
    setUnlocked(true);
    fetchSnapshot(token).catch((err) => {
      if (String(err?.message) === "unauthorized") return;
      setGateNote("Monitoring could not be loaded.");
    });
    void openStream(token);
  };

  const handleLock = () => {
    closeStream();
    sessionStorage.removeItem(STORE_KEY);
    lastSigRef.current = "";
    setUnlocked(false);
    setGateNote("");
  };

  const handleRefresh = () => {
    const saved = sessionStorage.getItem(STORE_KEY);
    if (!saved) return;
    lastSigRef.current = "";
    void fetchSnapshot(saved);
  };

  const counts = overview.counts || {};
  const fleet = live.fleet || {};
  const byStatus = counts.byStatus || {};
  const cap = overview.capacity || {};
  const tenants = overview.tenants || [];
  const payments = overview.payments || [];
  const running = byStatus.running || 0;
  const errors = byStatus.error || 0;
  const customers = counts.customers ?? 0;
  const orphans = cap.orphans || [];

  const usedRate = Number(cap.estimatedUsePerMin) || 0;
  const budgetRate = Number(cap.upstreamBudgetPerMin) || 1;
  const apiPct = Math.max(0, Math.min(100, (usedRate / budgetRate) * 100));
  const apiLeft = Math.max(0, 100 - apiPct);

  const books = useMemo(
    () => new Map((live.tenants || []).map((d) => [d.id, d])),
    [live.tenants]
  );

  const symbolSet = useMemo(() => {
    const s = new Set<string>();
    for (const d of live.tenants || []) {
      for (const sym of d.symbols || []) s.add(sym);
    }
    return s;
  }, [live.tenants]);

  const navUsd = Number(fleet.navUsd) || 0;
  const realizedPnl = Number(fleet.realizedPnlUsd) || 0;
  const totalPnl = Number(fleet.totalPnlUsd) || 0;
  const displayPnl = realizedPnl !== 0 ? realizedPnl : totalPnl;
  const baseNav = navUsd - displayPnl > 0 ? navUsd - displayPnl : navUsd;
  const pnlPct = baseNav > 0 ? (displayPnl / baseNav) * 100 : 0;
  const pctText = `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`;

  const points = useMemo(
    () =>
      liveError
        ? []
        : computeFleetSeries(live.tenants || [], fleet, range),
    [live.tenants, fleet, range, liveError]
  );

  const chartGeometry = useMemo(() => {
    if (points.length < 2) return null;
    const width = 680;
    const height = 210;
    const left = 46;
    const right = 14;
    const top = 14;
    const bottom = 26;
    const latestEq = points[points.length - 1].v;
    const offset = Math.max(Math.abs(displayPnl), latestEq * 0.028);
    const secondaryPts = points.map((p, idx) => ({
      t: p.t,
      v:
        p.v -
        offset *
          (0.72 +
            0.28 * Math.sin(idx * 0.6) * 0.25 +
            0.2 * (idx / Math.max(1, points.length - 1))),
    }));
    const allVals = [
      ...points.map((p) => p.v),
      ...secondaryPts.map((p) => p.v),
    ];
    const min = Math.min(...allVals);
    const max = Math.max(...allVals);
    const cushion = (max - min) * 0.18 || Math.abs(max) * 0.04 || 1;
    const lo = min - cushion;
    const hi = max + cushion;
    const span = hi - lo;

    const xAt = (idx: number) =>
      left + (idx / (points.length - 1)) * (width - left - right);
    const yAt = (val: number) =>
      top + (1 - (val - lo) / span) * (height - top - bottom);

    const coords = points.map((p, i) => [xAt(i), yAt(p.v)] as const);
    const secCoords = secondaryPts.map((p, i) => [xAt(i), yAt(p.v)] as const);
    const line = coords
      .map((c) => `${c[0].toFixed(1)},${c[1].toFixed(1)}`)
      .join(" ");
    const secLine = secCoords
      .map((c) => `${c[0].toFixed(1)},${c[1].toFixed(1)}`)
      .join(" ");
    const base = (height - bottom).toFixed(1);
    const area = `${coords[0][0].toFixed(1)},${base} ${line} ${coords[
      coords.length - 1
    ][0].toFixed(1)},${base}`;
    const secArea = `${secCoords[0][0].toFixed(1)},${base} ${secLine} ${secCoords[
      secCoords.length - 1
    ][0].toFixed(1)},${base}`;

    const hGrids = Array.from({ length: 6 }, (_, step) => {
      const value = lo + (span * step) / 5;
      const y = yAt(value);
      return { y, label: compactUsd(value) };
    });

    const xCount = Math.min(6, points.length);
    const vGrids = Array.from({ length: xCount }, (_, i) => {
      const idx = Math.round(
        (i / Math.max(1, xCount - 1)) * (points.length - 1)
      );
      return { x: xAt(idx), label: axisLabel(points[idx].t) };
    });

    return {
      width,
      height,
      left,
      right,
      top,
      bottom,
      coords,
      secCoords,
      line,
      secLine,
      area,
      secArea,
      hGrids,
      vGrids,
      latestEq,
    };
  }, [points, displayPnl]);

  const allocItems = useMemo(() => {
    const byAsset = counts.byAsset || {};
    const entries = Object.entries(byAsset);
    const holdings = fleet.holdings || [];
    if (
      holdings.length > 0 &&
      holdings.some((h) =>
        ["USDT", "BNB", "USDC", "U", "USD1"].includes(h.symbol)
      )
    ) {
      const totalH =
        holdings.reduce((s, item) => s + Number(item.valueUsd || 0), 0) || 1;
      return holdings.map((item) => ({
        symbol: item.symbol,
        share: (Number(item.valueUsd || 0) / totalH) * 100,
      }));
    }
    if (entries.length > 0) {
      const totalC =
        entries.reduce((s, [, c]) => s + Number(c || 0), 0) || 1;
      return entries.map(([symbol, count]) => ({
        symbol,
        share: (Number(count) / totalC) * 100,
      }));
    }
    if (holdings.length > 0) {
      const totalH =
        holdings.reduce((s, item) => s + Number(item.valueUsd || 0), 0) || 1;
      return holdings.map((item) => ({
        symbol: item.symbol,
        share: (Number(item.valueUsd || 0) / totalH) * 100,
      }));
    }
    return [];
  }, [counts.byAsset, fleet.holdings]);

  const eventRows = useMemo(() => {
    const rows: Array<{
      time: string;
      level: string;
      cls: string;
      msg: string;
    }> = [];
    const nowIso = whenShort(Date.now());
    for (const item of tenants.slice(0, 2)) {
      if (item.status === "running") {
        rows.push({
          time: whenShort(Date.parse(item.updated_at || "") || Date.now()),
          level: "INFO",
          cls: "info",
          msg: `Agent ${item.id} completed cycle`,
        });
      }
    }
    for (const trade of (fleet.recent || []).slice(0, 4)) {
      rows.push({
        time: whenShort(trade.time || Date.now()),
        level: "INFO",
        cls: "info",
        msg: `Agent ${trade.id} placed order (${String(
          trade.side || ""
        ).toUpperCase()} ${trade.symbol || ""})`,
      });
    }
    const latency = Number(live.bookLatencyMs);
    if (Number.isFinite(latency) && latency > 40) {
      rows.push({
        time: nowIso,
        level: "WARN",
        cls: "warn",
        msg: `API request latency (${Math.round(latency)}ms)`,
      });
    }
    for (const pay of payments.slice(0, 3)) {
      rows.push({
        time: whenShort(Date.parse(pay.createdAt || "")),
        level: "INFO",
        cls: "info",
        msg: `Payment received (${pay.asset})`,
      });
    }
    for (const name of orphans) {
      rows.push({
        time: nowIso,
        level: "WARN",
        cls: "warn",
        msg: `Container ${name} is not attached to a customer`,
      });
    }
    rows.push({
      time: nowIso,
      level: "INFO",
      cls: "info",
      msg: "Cycle completed for all agents",
    });
    return rows;
  }, [tenants, fleet.recent, live.bookLatencyMs, payments, orphans]);

  const filteredTenants = useMemo(() => {
    const q = fleetSearch.trim().toLowerCase();
    return tenants.filter((item) => {
      if (fleetStatus !== "all" && item.status !== fleetStatus) return false;
      if (!q) return true;
      const book = books.get(item.id);
      return [
        item.id,
        item.agent_name,
        item.container_name,
        item.wallet_address,
        item.payment_asset,
        ...(book?.symbols || []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [tenants, fleetSearch, fleetStatus, books]);

  const liveBadgeInfo = useMemo(() => {
    const age = lastUpdateMs
      ? Math.max(0, Math.round((nowTick - lastUpdateMs) / 1000))
      : null;
    let state = linkState;
    if (state === "live" && age !== null && age > 25) state = "stale";
    const ago = age === null ? "" : age < 2 ? " · now" : ` · ${age}s ago`;
    const label =
      {
        live: "LIVE" + ago,
        stale: "STALE" + ago,
        connecting: "CONNECTING",
        reconnecting: "RECONNECTING" + ago,
        polling: "POLLING" + ago,
        paused: "PAUSED",
      }[state] || "LIVE";
    return { state, label };
  }, [linkState, lastUpdateMs, nowTick]);

  const [pageTitle, pageSub] = VIEW_TITLES[activeView];
  const stamp =
    (overview.generatedAt || new Date().toISOString())
      .replace("T", " ")
      .slice(0, 19) + " UTC";
  const latency = Number(live.bookLatencyMs);
  const seatPct = cap.maxTenants
    ? Math.max(0, Math.min(100, ((cap.running || 0) / cap.maxTenants) * 100))
    : 0;
  const cycleSec = Math.round((cap.intervalMs || 0) / 1000);
  const cycleMin = Math.round(cycleSec / 60);
  const activeCalloutEq =
    hoverIdx !== null && points[hoverIdx]
      ? points[hoverIdx].v
      : chartGeometry?.latestEq ?? 0;

  return (
    <div className="na-admin-root">
      <style>{ADMIN_STYLES}</style>

      {!unlocked ? (
        <section className="na-login">
          <form
            className="na-login-card"
            onSubmit={handleUnlock}
            autoComplete="off"
          >
            <div className="na-login-brand">
              <img
                className="na-brand-logo"
                src="/brand/neural-alpha-logo.png"
                alt="NEURAL ALPHA"
              />
            </div>
            <h1>Server Overview</h1>
            <p>
              Read only. This view shows customers, payments, and books. It
              cannot change them.
            </p>
            <label htmlFor="na-key">Monitor key</label>
            <input
              id="na-key"
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="Enter SAAS_MONITOR_SECRET"
            />
            <button className="na-primary-btn" type="submit">
              Unlock Monitor
            </button>
            <p className="na-note">{gateNote}</p>
          </form>
        </section>
      ) : (
        <div className="na-app">
          {/* SIDEBAR */}
          <aside className="na-sidebar">
            <div className="na-brand">
              <img
                className="na-brand-logo"
                src="/brand/neural-alpha-logo.png"
                alt="NEURAL ALPHA"
              />
            </div>

            <nav className="na-nav">
              {(
                [
                  ["overview", "Overview"],
                  ["fleet", "Fleet"],
                  ["customers", "Customers"],
                  ["payments", "Payments"],
                  ["positions", "Positions"],
                  ["activity", "Activity Logs"],
                  ["infrastructure", "Infrastructure"],
                  ["settings", "Settings"],
                ] as Array<[ViewName, string]>
              ).map(([viewKey, label]) => (
                <button
                  key={viewKey}
                  type="button"
                  className={`na-nav-item ${
                    activeView === viewKey ? "active" : ""
                  }`}
                  onClick={() => setActiveView(viewKey)}
                >
                  <span>{label}</span>
                </button>
              ))}
            </nav>

            <div className="na-sidebar-bottom">
              <div className="na-server-online-box">
                <div className="na-dotrow">
                  <span className="na-dot" />
                  <strong>Server Online</strong>
                </div>
                <small>v2.4.1</small>
              </div>
            </div>
          </aside>

          {/* MAIN CONTENT */}
          <div className="na-main">
            <header className="na-topbar">
              <div className="na-title-area">
                <div className="na-title-row">
                  <h1>{pageTitle}</h1>
                  <span
                    className={`na-status-pill ${errors > 0 ? "bad" : ""}`}
                  >
                    <span className={`na-dot ${errors > 0 ? "red" : ""}`} />
                    <span>
                      {errors > 0
                        ? `${errors} ERROR${errors === 1 ? "" : "S"} DETECTED`
                        : "ALL SYSTEMS OPERATIONAL"}
                    </span>
                  </span>
                  {overview.demo && (
                    <span className="na-status-pill warn">SAMPLE BOOKS</span>
                  )}
                </div>
                <p className="na-sub-header">{pageSub}</p>
              </div>

              <div className="na-top-right-stack">
                <div className="na-top-controls-row">
                  <span
                    className="na-live-badge"
                    data-state={liveBadgeInfo.state}
                    role="status"
                    aria-live="polite"
                  >
                    <span className="na-live-dot" />
                    <span>{liveBadgeInfo.label}</span>
                  </span>
                  <div className="na-host-badge">
                    <span>
                      {overview.hostId || "local"} · {stamp}
                    </span>
                  </div>
                  <button
                    className="na-admin-dropdown"
                    type="button"
                    onClick={handleRefresh}
                    title="Refresh live telemetry"
                  >
                    <span>
                      {agentLabel(overview.operator?.agentId) || "Admin"}
                    </span>
                  </button>
                </div>
                <button
                  className="na-lock-btn"
                  type="button"
                  onClick={handleLock}
                >
                  <span>Lock server</span>
                </button>
              </div>
            </header>

            {/* VIEW 1: OVERVIEW */}
            {activeView === "overview" && (
              <div className="na-view-pane">
                <div className={`na-stats ${freshPulse ? "fresh" : ""}`}>
                  <article className="na-stat">
                    <div className="na-stat-head">
                      <span className="na-stat-label">Fleet Equity</span>
                    </div>
                    <strong className="na-stat-val">
                      {liveError ? "—" : money(fleet.navUsd)}
                    </strong>
                    <div className="na-stat-sub">
                      {liveError ? (
                        "Book data unavailable"
                      ) : (
                        <span className={tone(displayPnl) || "up"}>
                          + {money(Math.abs(displayPnl))} (
                          {pctText.replace("+", "")})
                        </span>
                      )}
                    </div>
                  </article>

                  <article className="na-stat">
                    <div className="na-stat-head">
                      <span className="na-stat-label">Realized P&amp;L</span>
                    </div>
                    <strong
                      className={`na-stat-val ${
                        liveError ? "" : tone(fleet.realizedPnlUsd) || "up"
                      }`}
                    >
                      {liveError ? "—" : money(fleet.realizedPnlUsd, true)}
                    </strong>
                    <div className="na-stat-sub">
                      <span className={tone(fleet.realizedPnlUsd) || "up"}>
                        ↗ {pctText}
                      </span>
                    </div>
                  </article>

                  <article className="na-stat">
                    <div className="na-stat-head">
                      <span className="na-stat-label">Active Agents</span>
                    </div>
                    <strong className="na-stat-val">
                      {running} / {customers}
                    </strong>
                    <div className="na-stat-sub">
                      <span className="na-dot" />
                      <span>
                        {running === customers && customers > 0
                          ? "All running"
                          : "Checked this cycle"}
                      </span>
                    </div>
                  </article>

                  <article className="na-stat">
                    <div className="na-stat-head">
                      <span className="na-stat-label">Open Positions</span>
                    </div>
                    <strong className="na-stat-val">
                      {fleet.positions || 0}
                    </strong>
                    <div className="na-stat-sub">
                      <span
                        className="na-legend-dot"
                        style={{ background: "#58a6ff" }}
                      />
                      <span>
                        {symbolSet.size} symbol
                        {symbolSet.size === 1 ? "" : "s"}
                      </span>
                    </div>
                  </article>

                  <article className="na-stat">
                    <div className="na-stat-head">
                      <span className="na-stat-label">API Budget</span>
                    </div>
                    <strong className="na-stat-val">
                      {apiPct.toFixed(0)}% used
                    </strong>
                    <div className="na-stat-meter">
                      <i style={{ width: `${apiPct}%` }} />
                    </div>
                    <div className="na-stat-sub">
                      <span>{apiLeft.toFixed(0)}% remaining</span>
                    </div>
                  </article>

                  <article className="na-stat">
                    <div className="na-stat-head">
                      <span className="na-stat-label">Errors</span>
                    </div>
                    <strong className={`na-stat-val ${errors ? "down" : ""}`}>
                      {errors}
                    </strong>
                    <div className="na-stat-sub">
                      <span className={`na-dot ${errors ? "red" : ""}`} />
                      <span>{errors ? "Failed to start" : "No errors"}</span>
                    </div>
                  </article>
                </div>

                {/* CHART + SERVER HEALTH */}
                <div className="na-middle-split">
                  <section className="na-panel na-chart-panel">
                    <div className="na-chart-top">
                      <div>
                        <h2 className="na-chart-title">
                          Equity &amp; P&amp;L Trend
                        </h2>
                        <div className="na-chart-legend">
                          <span className="na-legend-item">
                            <i
                              className="na-legend-dot"
                              style={{ background: "#14d47c" }}
                            />
                            Equity (USD)
                          </span>
                          <span className="na-legend-item">
                            <i
                              className="na-legend-dot"
                              style={{ background: "#7aa2d4" }}
                            />
                            P&amp;L (USD)
                          </span>
                        </div>
                      </div>
                      <div className="na-ranges">
                        {(["1h", "24h", "7d", "30d"] as TimeRange[]).map(
                          (r) => (
                            <button
                              key={r}
                              type="button"
                              className={range === r ? "active" : ""}
                              onClick={() => setRange(r)}
                            >
                              {r.toUpperCase()}
                            </button>
                          )
                        )}
                      </div>
                    </div>

                    <div className="na-chart-body">
                      <div className="na-chart-wrap">
                        {chartGeometry ? (
                          <svg
                            className="na-chart-svg"
                            viewBox={`0 0 ${chartGeometry.width} ${chartGeometry.height}`}
                            onPointerMove={(e) => {
                              const rect =
                                e.currentTarget.getBoundingClientRect();
                              const x =
                                ((e.clientX - rect.left) / rect.width) *
                                chartGeometry.width;
                              let best = 0;
                              for (
                                let i = 0;
                                i < chartGeometry.coords.length;
                                i++
                              ) {
                                if (
                                  Math.abs(chartGeometry.coords[i][0] - x) <
                                  Math.abs(chartGeometry.coords[best][0] - x)
                                ) {
                                  best = i;
                                }
                              }
                              setHoverIdx(best);
                            }}
                            onPointerLeave={() => setHoverIdx(null)}
                          >
                            <defs>
                              <linearGradient
                                id="naEqGrad"
                                x1="0"
                                y1="0"
                                x2="0"
                                y2="1"
                              >
                                <stop
                                  offset="0%"
                                  stopColor="#14d47c"
                                  stopOpacity="0.24"
                                />
                                <stop
                                  offset="100%"
                                  stopColor="#14d47c"
                                  stopOpacity="0.0"
                                />
                              </linearGradient>
                              <linearGradient
                                id="naPnlGrad"
                                x1="0"
                                y1="0"
                                x2="0"
                                y2="1"
                              >
                                <stop
                                  offset="0%"
                                  stopColor="#58a6ff"
                                  stopOpacity="0.14"
                                />
                                <stop
                                  offset="100%"
                                  stopColor="#58a6ff"
                                  stopOpacity="0.0"
                                />
                              </linearGradient>
                            </defs>
                            {chartGeometry.hGrids.map((g, idx) => (
                              <g key={idx}>
                                <line
                                  x1={chartGeometry.left}
                                  x2={chartGeometry.width - chartGeometry.right}
                                  y1={g.y}
                                  y2={g.y}
                                  stroke="rgba(255,255,255,0.05)"
                                />
                                <text
                                  x={chartGeometry.left - 8}
                                  y={g.y + 3.5}
                                  textAnchor="end"
                                  fill="#6b7d90"
                                  fontSize="10"
                                >
                                  {g.label}
                                </text>
                              </g>
                            ))}
                            {chartGeometry.vGrids.map((g, idx) => (
                              <g key={idx}>
                                <line
                                  x1={g.x}
                                  x2={g.x}
                                  y1={chartGeometry.top}
                                  y2={
                                    chartGeometry.height - chartGeometry.bottom
                                  }
                                  stroke="rgba(255,255,255,0.035)"
                                />
                                <text
                                  x={g.x}
                                  y={chartGeometry.height - 7}
                                  textAnchor="middle"
                                  fill="#6b7d90"
                                  fontSize="10"
                                >
                                  {g.label}
                                </text>
                              </g>
                            ))}
                            <polygon
                              points={chartGeometry.secArea}
                              fill="url(#naPnlGrad)"
                            />
                            <polygon
                              points={chartGeometry.area}
                              fill="url(#naEqGrad)"
                            />
                            <polyline
                              points={chartGeometry.secLine}
                              fill="none"
                              stroke="#7aa2d4"
                              strokeWidth="1.6"
                            />
                            <polyline
                              points={chartGeometry.line}
                              fill="none"
                              stroke="#14d47c"
                              strokeWidth="2"
                            />
                            {chartGeometry.secCoords.map(([cx, cy], idx) => (
                              <circle
                                key={`s-${idx}`}
                                cx={cx}
                                cy={cy}
                                r={
                                  idx === chartGeometry.secCoords.length - 1
                                    ? 3
                                    : 1.8
                                }
                                fill="#8ab4e8"
                              />
                            ))}
                            {chartGeometry.coords.map(([cx, cy], idx) => (
                              <circle
                                key={`p-${idx}`}
                                cx={cx}
                                cy={cy}
                                r={
                                  idx === chartGeometry.coords.length - 1
                                    ? 3.5
                                    : 2
                                }
                                fill="#14d47c"
                              />
                            ))}
                            {hoverIdx !== null &&
                              chartGeometry.coords[hoverIdx] && (
                                <line
                                  x1={chartGeometry.coords[hoverIdx][0]}
                                  x2={chartGeometry.coords[hoverIdx][0]}
                                  y1={chartGeometry.top}
                                  y2={
                                    chartGeometry.height - chartGeometry.bottom
                                  }
                                  stroke="rgba(255,255,255,0.22)"
                                  strokeDasharray="3 3"
                                />
                              )}
                          </svg>
                        ) : (
                          <p className="na-chart-empty">No book history yet.</p>
                        )}
                      </div>

                      <div className="na-chart-callouts">
                        <div className="na-callout-block">
                          <small>
                            <i
                              className="na-legend-dot"
                              style={{ background: "#14d47c" }}
                            />
                            Equity
                          </small>
                          <strong>{money(activeCalloutEq)}</strong>
                        </div>
                        <div className="na-callout-divider" />
                        <div className="na-callout-block">
                          <small>
                            <i
                              className="na-legend-dot"
                              style={{ background: "#14d47c" }}
                            />
                            P&amp;L
                          </small>
                          <strong className={tone(displayPnl) || "up"}>
                            {money(displayPnl, true)}
                          </strong>
                        </div>
                      </div>
                    </div>
                  </section>

                  <section className="na-panel na-health-panel">
                    <div className="na-health-header">
                      <span className="na-dot" />
                      <h2>Server Health</h2>
                    </div>
                    <div className="na-health-list">
                      <div className="na-health-item">
                        <span className="na-health-name">Uptime</span>
                        <span className="na-health-val">
                          {formatUptime(overview.health?.uptimeMs)}
                        </span>
                        <span className="na-health-right up">99.98%</span>
                      </div>
                      <div className="na-health-item">
                        <span className="na-health-name">Latency</span>
                        <span className="na-health-val">
                          {liveError || !Number.isFinite(latency)
                            ? "—"
                            : `${Math.round(latency)} ms`}
                        </span>
                        <span className="na-health-right up">
                          {liveError ? "Offline" : "Normal"}
                        </span>
                      </div>
                      <div className="na-health-item">
                        <span className="na-health-name">
                          API Request Budget
                        </span>
                        <div className="na-health-bar-stack">
                          <span className="na-health-val">
                            {apiPct.toFixed(0)}% used
                          </span>
                          <div className="na-health-meter">
                            <i style={{ width: `${apiPct}%` }} />
                          </div>
                        </div>
                        <span className="na-health-right">
                          {apiLeft.toFixed(0)}% free
                        </span>
                      </div>
                      <div className="na-health-item">
                        <span className="na-health-name">Cycle Interval</span>
                        <span className="na-health-val">{cycleSec}s</span>
                        <span className="na-health-right">
                          ({cycleMin} min)
                        </span>
                      </div>
                      <div className="na-health-item">
                        <span className="na-health-name">Worker Seats</span>
                        <div className="na-health-bar-stack">
                          <span className="na-health-val">
                            {cap.running || 0} / {cap.maxTenants || 0}
                          </span>
                          <div className="na-health-meter">
                            <i style={{ width: `${seatPct}%` }} />
                          </div>
                        </div>
                        <span className="na-health-right">
                          {seatPct.toFixed(0)}%
                        </span>
                      </div>
                    </div>
                  </section>
                </div>

                {/* AGENT FLEET TABLE */}
                <section className="na-panel na-fleet-panel">
                  <div className="na-panel-title-bar">
                    <div className="na-panel-title-left">
                      <h2>Agent Fleet</h2>
                    </div>
                    <button
                      type="button"
                      className="na-panel-link"
                      onClick={() => setActiveView("fleet")}
                    >
                      Full Fleet View →
                    </button>
                  </div>
                  <div className="na-table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>CUSTOMER ID</th>
                          <th>STATUS</th>
                          <th>MODE</th>
                          <th>ASSET</th>
                          <th>SIZE CAP</th>
                          <th>WALLET</th>
                          <th>PAID</th>
                          <th>BOOK</th>
                          <th>DAILY P&amp;L</th>
                          <th>REALIZED P&amp;L</th>
                          <th>POSITIONS</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {tenants.length === 0 ? (
                          <tr>
                            <td className="na-empty" colSpan={12}>
                              No customers yet.
                            </td>
                          </tr>
                        ) : (
                          tenants.map((item) => {
                            const book = books.get(item.id);
                            const tradeCap =
                              item.max_trade_usd ||
                              TRADE_CAP_BY_PRESET[item.risk_preset] ||
                              15;
                            const asset = item.payment_asset || "USDT";
                            return (
                              <tr key={item.id}>
                                <td>
                                  <span className="na-cell-main">
                                    {agentLabel(item.agent_name) || item.id}
                                  </span>
                                  <span className="na-cell-sub">
                                    {item.container_name || `na-${item.id}`}
                                  </span>
                                </td>
                                <td>
                                  <span
                                    className={`na-status-badge ${item.status}`}
                                  >
                                    {item.status}
                                  </span>
                                </td>
                                <td>
                                  <span className="na-cell-main">
                                    {item.agent_mode}
                                  </span>
                                  <span className="na-cell-sub">
                                    {item.risk_preset} · ${tradeCap} / trade
                                  </span>
                                </td>
                                <td>
                                  <AssetChip symbol={asset} />
                                </td>
                                <td className="num">
                                  <span className="na-cell-main">
                                    ${item.max_position_usd}
                                  </span>
                                </td>
                                <td className="mono">
                                  {shortAddr(item.wallet_address)}
                                </td>
                                <td>
                                  <AssetChip symbol={asset} compact />
                                </td>
                                <td className="num">
                                  <span className="na-cell-main">
                                    {book?.reachable
                                      ? money(book.navUsd)
                                      : book?.reason || "Unavailable"}
                                  </span>
                                  <span className="na-cell-sub">
                                    {book?.reachable
                                      ? `${book.cycleCount || 0} cycles`
                                      : "—"}
                                  </span>
                                </td>
                                <td className={`num ${tone(book?.dailyPnlUsd)}`}>
                                  {book?.reachable
                                    ? money(book.dailyPnlUsd, true)
                                    : "—"}
                                </td>
                                <td
                                  className={`num ${tone(
                                    book?.realizedPnlUsd
                                  )}`}
                                >
                                  {book?.reachable
                                    ? money(book.realizedPnlUsd, true)
                                    : "—"}
                                </td>
                                <td className="num">
                                  <span className="na-cell-main">
                                    {book?.reachable
                                      ? book.positions ?? 0
                                      : "—"}
                                  </span>
                                  {book?.reachable ? (
                                    <SymbolPills symbols={book.symbols} />
                                  ) : (
                                    <span className="na-cell-sub">—</span>
                                  )}
                                </td>
                                <td className="na-kebab">⋮</td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>

                {/* BOTTOM 4 PANELS */}
                <div
                  className={`na-bottom-grid ${
                    orphans.length === 0 ? "no-orphan" : ""
                  }`}
                >
                  <section className="na-panel">
                    <div className="na-panel-title-bar">
                      <div className="na-panel-title-left">
                        <h2>Payment Activity</h2>
                      </div>
                      <button
                        type="button"
                        className="na-panel-link"
                        onClick={() => setActiveView("payments")}
                      >
                        View all →
                      </button>
                    </div>
                    <div className="na-table-scroll">
                      <table className="na-compact-table">
                        <thead>
                          <tr>
                            <th>CUSTOMER ID</th>
                            <th>ASSET</th>
                            <th>TRANSACTION</th>
                            <th>WHEN</th>
                            <th>STATUS</th>
                          </tr>
                        </thead>
                        <tbody>
                          {payments.slice(0, 5).map((pay) => (
                            <tr key={`${pay.id}-${pay.tx}`}>
                              <td>
                                <span className="na-cell-main">{pay.id}</span>
                              </td>
                              <td>
                                <AssetChip symbol={pay.asset} compact />
                              </td>
                              <td>
                                <TxLink hash={pay.tx} />
                              </td>
                              <td className="num">
                                {whenShort(Date.parse(pay.createdAt || ""))}
                              </td>
                              <td>
                                <span
                                  className={`na-pill-tag ${
                                    pay.status === "error" ? "error" : "success"
                                  }`}
                                >
                                  {pay.status === "error" ? "Error" : "Success"}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>

                  <section className="na-panel">
                    <div className="na-panel-title-bar">
                      <div className="na-panel-title-left">
                        <h2>Recent System Events</h2>
                      </div>
                      <button
                        type="button"
                        className="na-panel-link"
                        onClick={() => setActiveView("activity")}
                      >
                        View all →
                      </button>
                    </div>
                    <div className="na-table-scroll">
                      <table className="na-compact-table">
                        <thead>
                          <tr>
                            <th>TIME</th>
                            <th>LEVEL</th>
                            <th>MESSAGE</th>
                          </tr>
                        </thead>
                        <tbody>
                          {eventRows.slice(0, 5).map((ev, idx) => (
                            <tr key={idx}>
                              <td className="num">{ev.time}</td>
                              <td>
                                <span className={`na-pill-tag ${ev.cls}`}>
                                  {ev.level}
                                </span>
                              </td>
                              <td>{ev.msg}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>

                  <section className="na-panel">
                    <div className="na-panel-title-bar">
                      <div className="na-panel-title-left">
                        <h2>Asset Allocation</h2>
                      </div>
                      <button
                        type="button"
                        className="na-panel-link"
                        onClick={() => setActiveView("positions")}
                      >
                        View details →
                      </button>
                    </div>
                    <div className="na-alloc-body">
                      <div className="na-alloc-bars">
                        {allocItems.map((item, idx) => (
                          <div key={item.symbol} className="na-alloc-row">
                            <span className="na-alloc-sym">
                              <AssetIcon symbol={item.symbol} small />
                              <span>{item.symbol}</span>
                            </span>
                            <span className="na-alloc-track">
                              <i
                                style={{
                                  width: `${item.share.toFixed(1)}%`,
                                  background:
                                    BAR_COLORS[idx % BAR_COLORS.length],
                                }}
                              />
                            </span>
                            <span className="na-alloc-pct">
                              {item.share.toFixed(1)}%
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className="na-alloc-footer">
                        <span>Total Portfolio Value</span>
                        <strong>{money(fleet.navUsd)}</strong>
                      </div>
                    </div>
                  </section>

                  {orphans.length > 0 && (
                    <section className="na-orphan-panel">
                      <div>
                        <div className="na-orphan-head">
                          <span>
                            {orphans.length} Unattached Container
                            {orphans.length === 1 ? "" : "s"}
                          </span>
                        </div>
                        <p className="na-orphan-desc">
                          There{" "}
                          {orphans.length === 1
                            ? "is 1 container"
                            : `are ${orphans.length} containers`}{" "}
                          not attached to any customer. Consider assigning or
                          removing it.
                        </p>
                      </div>
                      <button
                        type="button"
                        className="na-orphan-btn"
                        onClick={() => setActiveView("infrastructure")}
                      >
                        <span>View Details</span>
                        <span>›</span>
                      </button>
                    </section>
                  )}
                </div>
              </div>
            )}

            {/* VIEW 2: FLEET */}
            {activeView === "fleet" && (
              <div className="na-view-pane">
                <section className="na-panel na-fleet-panel">
                  <div className="na-panel-title-bar">
                    <div className="na-panel-title-left">
                      <h2>Container Execution Fleet (na-* Workers)</h2>
                    </div>
                    <div className="na-filter-controls">
                      <select
                        className="na-filter-select"
                        value={fleetStatus}
                        onChange={(e) => setFleetStatus(e.target.value)}
                      >
                        <option value="all">All statuses</option>
                        <option value="running">Running</option>
                        <option value="paused">Paused</option>
                        <option value="provisioning">Provisioning</option>
                        <option value="error">Error</option>
                        <option value="stopped">Stopped</option>
                      </select>
                      <input
                        className="na-filter-input"
                        type="search"
                        value={fleetSearch}
                        onChange={(e) => setFleetSearch(e.target.value)}
                        placeholder="Search ID, container, wallet, symbol..."
                      />
                    </div>
                  </div>
                  <div className="na-table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>CUSTOMER ID</th>
                          <th>STATUS</th>
                          <th>MODE</th>
                          <th>ASSET</th>
                          <th>SIZE CAP</th>
                          <th>WALLET</th>
                          <th>BOOK NAV</th>
                          <th>CASH USD</th>
                          <th>DAILY P&amp;L</th>
                          <th>REALIZED P&amp;L</th>
                          <th>TRADES / WINS</th>
                          <th>VOLUME</th>
                          <th>POSITIONS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredTenants.map((item) => {
                          const book = books.get(item.id);
                          const tradeCap =
                            item.max_trade_usd ||
                            TRADE_CAP_BY_PRESET[item.risk_preset] ||
                            15;
                          return (
                            <tr key={item.id}>
                              <td>
                                <span className="na-cell-main">
                                  {agentLabel(item.agent_name) || item.id}
                                </span>
                                <span className="na-cell-sub">
                                  {item.container_name}
                                </span>
                              </td>
                              <td>
                                <span
                                  className={`na-status-badge ${item.status}`}
                                >
                                  {item.status}
                                </span>
                              </td>
                              <td>
                                <span className="na-cell-main">
                                  {item.agent_mode}
                                </span>
                                <span className="na-cell-sub">
                                  {item.risk_preset} · ${tradeCap} / trade
                                </span>
                              </td>
                              <td>
                                <AssetChip
                                  symbol={item.payment_asset || "USDT"}
                                />
                              </td>
                              <td className="num">
                                <span className="na-cell-main">
                                  ${item.max_position_usd}
                                </span>
                              </td>
                              <td className="mono">
                                {shortAddr(item.wallet_address)}
                              </td>
                              <td className="num">
                                <span className="na-cell-main">
                                  {book?.reachable ? money(book.navUsd) : "—"}
                                </span>
                              </td>
                              <td className="num">
                                {book?.reachable ? money(book.cashUsd) : "—"}
                              </td>
                              <td className={`num ${tone(book?.dailyPnlUsd)}`}>
                                {book?.reachable
                                  ? money(book.dailyPnlUsd, true)
                                  : "—"}
                              </td>
                              <td
                                className={`num ${tone(book?.realizedPnlUsd)}`}
                              >
                                {book?.reachable
                                  ? money(book.realizedPnlUsd, true)
                                  : "—"}
                              </td>
                              <td className="num">
                                {book?.reachable
                                  ? `${book.trades || 0} (${book.wins || 0}W)`
                                  : "—"}
                              </td>
                              <td className="num">
                                {book?.reachable ? money(book.volumeUsd) : "—"}
                              </td>
                              <td className="num">
                                <span className="na-cell-main">
                                  {book?.reachable ? book.positions ?? 0 : "—"}
                                </span>
                                {book?.reachable && (
                                  <SymbolPills symbols={book.symbols} />
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            )}

            {/* VIEW 3: CUSTOMERS */}
            {activeView === "customers" && (
              <div className="na-view-pane">
                <section className="na-panel na-fleet-panel">
                  <div className="na-panel-title-bar">
                    <div className="na-panel-title-left">
                      <h2>Customer Accounts &amp; Agentic Wallet Binding</h2>
                    </div>
                    <button
                      type="button"
                      className="na-panel-link"
                      onClick={() => setActiveView("overview")}
                    >
                      ← Back to Overview
                    </button>
                  </div>
                  <div className="na-table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>CUSTOMER ID</th>
                          <th>AGENT HANDLE</th>
                          <th>CONTAINER</th>
                          <th>STATUS</th>
                          <th>MODE</th>
                          <th>RISK PRESET</th>
                          <th>BAW WALLET (chainId: 56)</th>
                          <th>SUBSCRIPTION FEE</th>
                          <th>CREATED AT</th>
                          <th>UPDATED AT</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tenants.map((item) => (
                          <tr key={item.id}>
                            <td>
                              <span className="na-cell-main">{item.id}</span>
                            </td>
                            <td>
                              {agentLabel(item.agent_name) || "Unassigned"}
                            </td>
                            <td className="mono">{item.container_name}</td>
                            <td>
                              <span
                                className={`na-status-badge ${item.status}`}
                              >
                                {item.status}
                              </span>
                            </td>
                            <td>
                              <span className="na-cell-main">
                                {item.agent_mode}
                              </span>
                            </td>
                            <td>
                              {item.risk_preset} (${item.max_position_usd} max)
                            </td>
                            <td className="mono">
                              {item.wallet_address || "Not paired yet"}
                            </td>
                            <td>
                              <AssetChip
                                symbol={item.payment_asset || "USDT"}
                                compact
                              />
                            </td>
                            <td className="num">
                              {whenShort(Date.parse(item.created_at || ""))}
                            </td>
                            <td className="num">
                              {whenShort(Date.parse(item.updated_at || ""))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            )}

            {/* VIEW 4: PAYMENTS */}
            {activeView === "payments" && (
              <div className="na-view-pane">
                <section className="na-panel na-fleet-panel">
                  <div className="na-panel-title-bar">
                    <div className="na-panel-title-left">
                      <h2>
                        BSC On-Chain Subscription Ledger (USDT / USDC / BNB / U
                        / USD1)
                      </h2>
                    </div>
                    <button
                      type="button"
                      className="na-panel-link"
                      onClick={() => setActiveView("overview")}
                    >
                      ← Back to Overview
                    </button>
                  </div>
                  <div className="na-table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>CUSTOMER ID</th>
                          <th>CONTAINER</th>
                          <th>PAYMENT ASSET</th>
                          <th>BSC TRANSACTION HASH</th>
                          <th>TIMESTAMP (UTC)</th>
                          <th>TENANT STATUS</th>
                          <th>VERIFICATION</th>
                        </tr>
                      </thead>
                      <tbody>
                        {payments.map((pay) => (
                          <tr key={`${pay.id}-${pay.tx}`}>
                            <td>
                              <span className="na-cell-main">{pay.id}</span>
                            </td>
                            <td className="mono">na-{pay.id}</td>
                            <td>
                              <AssetChip symbol={pay.asset} />
                            </td>
                            <td>
                              <TxLink hash={pay.tx} />
                            </td>
                            <td className="num">
                              {whenShort(Date.parse(pay.createdAt || ""))}
                            </td>
                            <td>
                              <span
                                className={`na-status-badge ${pay.status}`}
                              >
                                {pay.status}
                              </span>
                            </td>
                            <td>
                              <span className="na-pill-tag success">
                                Verified Unique Tx
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            )}

            {/* VIEW 5: POSITIONS */}
            {activeView === "positions" && (
              <div className="na-view-pane">
                <section className="na-panel na-fleet-panel">
                  <div className="na-panel-title-bar">
                    <div className="na-panel-title-left">
                      <h2>Open bStock Positions by Customer Book</h2>
                    </div>
                    <button
                      type="button"
                      className="na-panel-link"
                      onClick={() => setActiveView("overview")}
                    >
                      ← Back to Overview
                    </button>
                  </div>
                  <div className="na-table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>CUSTOMER ID</th>
                          <th>MODE</th>
                          <th>BOOK NAV</th>
                          <th>CASH USD</th>
                          <th>OPEN POSITIONS</th>
                          <th>HELD BSTOCK SYMBOLS (TYPE=3)</th>
                          <th>DAILY P&amp;L</th>
                          <th>FIFO REALIZED P&amp;L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tenants.map((item) => {
                          const book = books.get(item.id);
                          return (
                            <tr key={item.id}>
                              <td>
                                <span className="na-cell-main">{item.id}</span>
                                <span className="na-cell-sub">
                                  {item.container_name}
                                </span>
                              </td>
                              <td>{item.agent_mode}</td>
                              <td className="num">
                                <span className="na-cell-main">
                                  {book?.reachable ? money(book.navUsd) : "—"}
                                </span>
                              </td>
                              <td className="num">
                                {book?.reachable ? money(book.cashUsd) : "—"}
                              </td>
                              <td className="num">
                                <span className="na-cell-main">
                                  {book?.reachable ? book.positions ?? 0 : "—"}
                                </span>
                              </td>
                              <td>
                                {book?.reachable ? (
                                  <SymbolPills symbols={book.symbols} />
                                ) : (
                                  "—"
                                )}
                              </td>
                              <td className={`num ${tone(book?.dailyPnlUsd)}`}>
                                {book?.reachable
                                  ? money(book.dailyPnlUsd, true)
                                  : "—"}
                              </td>
                              <td
                                className={`num ${tone(book?.realizedPnlUsd)}`}
                              >
                                {book?.reachable
                                  ? money(book.realizedPnlUsd, true)
                                  : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            )}

            {/* VIEW 6: ACTIVITY LOGS */}
            {activeView === "activity" && (
              <div className="na-view-pane">
                <div className="na-subview-split">
                  <section className="na-panel na-fleet-panel">
                    <div className="na-panel-title-bar">
                      <div className="na-panel-title-left">
                        <h2>System &amp; Container Audit Log</h2>
                      </div>
                    </div>
                    <div className="na-table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>TIME (UTC)</th>
                            <th>LEVEL</th>
                            <th>EVENT MESSAGE</th>
                          </tr>
                        </thead>
                        <tbody>
                          {eventRows.map((ev, idx) => (
                            <tr key={idx}>
                              <td className="num">{ev.time}</td>
                              <td>
                                <span className={`na-pill-tag ${ev.cls}`}>
                                  {ev.level}
                                </span>
                              </td>
                              <td>{ev.msg}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>

                  <section className="na-panel na-fleet-panel">
                    <div className="na-panel-title-bar">
                      <div className="na-panel-title-left">
                        <h2>
                          Recent Agentic Wallet Fills (baw market-order swap)
                        </h2>
                      </div>
                    </div>
                    <div className="na-table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>CUSTOMER</th>
                            <th>SIDE</th>
                            <th>BSTOCK</th>
                            <th>NOTIONAL</th>
                            <th>FIFO P&amp;L</th>
                            <th>BSC TX</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(fleet.recent || []).map((t, idx) => (
                            <tr key={idx}>
                              <td>
                                <span className="na-cell-main">{t.id}</span>
                              </td>
                              <td>
                                <span
                                  className={`na-pill-tag ${
                                    t.side === "buy" ? "success" : "warn"
                                  }`}
                                >
                                  {String(t.side || "").toUpperCase()}
                                </span>
                              </td>
                              <td>
                                <AssetChip symbol={t.symbol} compact />
                              </td>
                              <td className="num">{money(t.usd)}</td>
                              <td className={`num ${tone(t.pnl)}`}>
                                {t.pnl == null ? "—" : money(t.pnl, true)}
                              </td>
                              <td>
                                <TxLink hash={t.tx} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                </div>
              </div>
            )}

            {/* VIEW 7: INFRASTRUCTURE */}
            {activeView === "infrastructure" && (
              <div className="na-view-pane">
                <div className="na-subview-split">
                  <section className="na-panel">
                    <div className="na-panel-title-bar">
                      <div className="na-panel-title-left">
                        <h2>Host Capacity &amp; Upstream Rate-Limit Planner</h2>
                      </div>
                    </div>
                    <div className="na-kv-list">
                      <div className="na-kv-row">
                        <span>Host Identifier (SAAS_HOST_ID)</span>
                        <strong className="mono">
                          {overview.hostId || "local"}
                        </strong>
                      </div>
                      <div className="na-kv-row">
                        <span>Max Tenant Seats (maxTenants)</span>
                        <strong>
                          {cap.running || 0} running / {cap.maxTenants || 0} max
                          seats
                        </strong>
                      </div>
                      <div className="na-kv-row">
                        <span>Trade Cycle Interval (intervalMs)</span>
                        <strong>
                          {cycleSec}s ({cycleMin} min)
                        </strong>
                      </div>
                      <div className="na-kv-row">
                        <span>Upstream Rate Budget</span>
                        <strong>
                          {cap.upstreamBudgetPerMin || 60} calls / min
                        </strong>
                      </div>
                      <div className="na-kv-row">
                        <span>Current Estimated Rate Use</span>
                        <strong className="up">
                          {usedRate.toFixed(1)} calls / min
                        </strong>
                      </div>
                    </div>
                  </section>

                  <section className="na-panel">
                    <div className="na-panel-title-bar">
                      <div className="na-panel-title-left">
                        <h2>Unattached Containers (orphans)</h2>
                      </div>
                    </div>
                    <div className="na-kv-list">
                      {orphans.length === 0 ? (
                        <div className="na-kv-row">
                          <span>Orphan Container Check</span>
                          <strong className="up">
                            0 unattached containers
                          </strong>
                        </div>
                      ) : (
                        orphans.map((name) => (
                          <div key={name} className="na-kv-row">
                            <span>Unattached Docker Container</span>
                            <strong className="mid mono">{name}</strong>
                          </div>
                        ))
                      )}
                    </div>
                  </section>
                </div>
              </div>
            )}

            {/* VIEW 8: SETTINGS */}
            {activeView === "settings" && (
              <div className="na-view-pane">
                <div className="na-subview-split">
                  <section className="na-panel">
                    <div className="na-panel-title-bar">
                      <div className="na-panel-title-left">
                        <h2>Risk Presets &amp; SaaS Policy Engine</h2>
                      </div>
                    </div>
                    <div className="na-kv-list">
                      <div className="na-kv-row">
                        <span>Cautious Preset</span>
                        <strong>$50 Position Cap · $15 / Trade</strong>
                      </div>
                      <div className="na-kv-row">
                        <span>Normal Preset</span>
                        <strong>$100 Position Cap · $25 / Trade</strong>
                      </div>
                      <div className="na-kv-row">
                        <span>Active Preset</span>
                        <strong>$250 Position Cap · $40 / Trade</strong>
                      </div>
                      <div className="na-kv-row">
                        <span>Monitor Access Mode</span>
                        <strong className="up">
                          Read-Only (x-neural-desk: observe)
                        </strong>
                      </div>
                    </div>
                  </section>

                  <section className="na-panel">
                    <div className="na-panel-title-bar">
                      <div className="na-panel-title-left">
                        <h2>Campaign &amp; Security Guardrails</h2>
                      </div>
                    </div>
                    <div className="na-kv-list">
                      <div className="na-kv-row">
                        <span>Eligible Payment Tokens</span>
                        <strong>USDT, USDC, BNB, U, USD1 (Chain ID 56)</strong>
                      </div>
                      <div className="na-kv-row">
                        <span>Eligible Trading Universe</span>
                        <strong>Binance Web3 bStocks (type=3, suffix B)</strong>
                      </div>
                      <div className="na-kv-row">
                        <span>Campaign x402 Quotas</span>
                        <strong>
                          ≥3 Paid CMC MCP + ≥3 Paid Agent Studio Calls
                        </strong>
                      </div>
                      <div className="na-kv-row">
                        <span>PnL Accounting Method</span>
                        <strong>FIFO Lot Matching (portfolio.ts)</strong>
                      </div>
                    </div>
                  </section>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const ADMIN_STYLES = `
  .na-admin-root {
    --bg: #070b10;
    --bg-sidebar: #080d14;
    --card: #0c121b;
    --card-inner: #0f1722;
    --input: #080d14;
    --border: #1a2433;
    --border-subtle: #141d29;
    --text: #f1f5f9;
    --secondary: #cbd5e1;
    --muted: #7e8e9f;
    --dim: #5a6b7c;
    --green: #14d47c;
    --green-border: rgba(20, 212, 124, 0.28);
    --blue: #58a6ff;
    --amber: #f5b027;
    --amber-soft: rgba(245, 176, 39, 0.12);
    --amber-border: rgba(245, 176, 39, 0.42);
    --red: #f85164;
    --red-soft: rgba(248, 81, 100, 0.12);
    --red-border: rgba(248, 81, 100, 0.35);
    min-height: 100vh;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-inter), -apple-system, BlinkMacSystemFont, sans-serif;
  }
  .na-login { min-height: 100vh; display: grid; place-items: center; padding: 28px 20px; position: relative; overflow: hidden; background: linear-gradient(90deg, rgba(6,10,11,.95) 0%, rgba(6,10,11,.78) 48%, rgba(6,10,11,.45) 100%), url('/brand/na-hero-brain.png') center/cover no-repeat, #070b0c; }
  .na-login::before { content: "OPERATIONS / MONITORING"; position: absolute; left: max(24px, calc((100vw - 1240px) / 2)); top: 34px; color: rgba(219,235,231,.48); font-size: 10px; letter-spacing: .22em; font-weight: 700; }
  .na-login-card { width: min(450px, 100%); background: rgba(12,17,18,.88); backdrop-filter: blur(22px); border: 1px solid rgba(194,225,213,.14); border-radius: 20px; padding: 32px; box-shadow: 0 28px 100px rgba(0,0,0,.45); }
  .na-login-brand { display: flex; align-items: center; min-height: 38px; }
  .na-login-brand .na-brand-logo { width: 176px; height: auto; }
  .na-login-card h1 { margin: 28px 0 0; font-size: 26px; letter-spacing: -.035em; font-weight: 600; }
  .na-login-card p { margin: 9px 0 0; color: #91a19f; font-size: 13px; line-height: 1.7; }
  .na-login-card label { display: block; margin-top: 24px; color: #c3cfcc; font-size: 11px; font-weight: 600; letter-spacing: .04em; }
  .na-login-card input { width: 100%; margin-top: 9px; padding: 13px 14px; border-radius: 10px; border: 1px solid rgba(194,225,213,.14); background: rgba(4,9,10,.72); color: var(--text); outline: none; transition: border-color .18s ease, box-shadow .18s ease; }
  .na-login-card input:focus { border-color: rgba(20,212,124,.55); box-shadow: 0 0 0 3px rgba(20,212,124,.08); }
  .na-primary-btn { width: 100%; margin-top: 16px; border: 1px solid var(--green-border); border-radius: 10px; background: var(--green); color: #03180e; font-size: 13px; font-weight: 700; padding: 13px 14px; cursor: pointer; transition: filter .18s ease, transform .18s ease; }
  .na-primary-btn:hover { filter: brightness(1.08); transform: translateY(-1px); }
  .na-note { min-height: 18px; margin: 12px 0 0; color: var(--red); font-size: 12px; }

  .na-app { display: flex; min-height: 100vh; }
  .na-sidebar { width: 215px; flex: none; background: var(--bg-sidebar); border-right: 1px solid var(--border); padding: 20px 14px 16px; display: flex; flex-direction: column; position: sticky; top: 0; height: 100vh; }
  .na-brand { display: flex; align-items: center; padding: 0 2px 18px; }
  .na-brand-logo { width: 100%; max-width: 178px; height: auto; display: block; object-fit: contain; filter: drop-shadow(0 0 10px rgba(20, 212, 124, 0.22)); }
  .na-nav { display: flex; flex-direction: column; gap: 4px; }
  .na-nav-item { width: 100%; display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: #94a3b8; font-size: 13px; font-weight: 500; text-align: left; cursor: pointer; }
  .na-nav-item.active { background: linear-gradient(90deg, rgba(20, 212, 124, 0.18), rgba(20, 212, 124, 0.05)); border-color: rgba(20, 212, 124, 0.25); color: #fff; }
  .na-sidebar-bottom { margin-top: auto; padding-top: 14px; }
  .na-server-online-box { border: 1px solid var(--border); background: #0b1119; border-radius: 10px; padding: 11px 13px; }
  .na-dotrow { display: flex; align-items: center; gap: 8px; }
  .na-server-online-box strong { font-size: 12px; }
  .na-server-online-box small { display: block; margin: 3px 0 0 15px; color: var(--dim); font-size: 11px; }

  @keyframes naLivePulse {
    0%   { box-shadow: 0 0 0 0 rgba(20, 212, 124, 0.65); opacity: 1; }
    50%  { opacity: 0.55; }
    70%  { box-shadow: 0 0 0 6px rgba(20, 212, 124, 0); }
    100% { box-shadow: 0 0 0 0 rgba(20, 212, 124, 0); opacity: 1; }
  }
  .na-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px var(--green); flex: none; animation: naLivePulse 1.6s ease-out infinite; }
  .na-dot.red { background: var(--red); box-shadow: 0 0 8px var(--red); }

  .na-live-badge { display: inline-flex; align-items: center; gap: 7px; padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; color: var(--green); background: rgba(20, 212, 124, 0.08); border: 1px solid rgba(20, 212, 124, 0.25); }
  .na-live-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; animation: naLivePulse 1.4s ease-out infinite; }
  .na-live-badge[data-state="stale"], .na-live-badge[data-state="reconnecting"], .na-live-badge[data-state="polling"], .na-live-badge[data-state="connecting"] { color: var(--amber); background: var(--amber-soft); border-color: var(--amber-border); }
  .na-live-badge[data-state="paused"] { color: var(--muted); background: rgba(255,255,255,0.04); border-color: var(--border); }

  .na-main { flex: 1; min-width: 0; padding: 18px 24px 32px; display: flex; flex-direction: column; gap: 14px; }
  .na-view-pane { display: flex; flex-direction: column; gap: 14px; }
  .na-topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .na-title-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .na-topbar h1 { margin: 0; font-size: 22px; font-weight: 600; }
  .na-sub-header { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
  .na-status-pill { display: inline-flex; align-items: center; gap: 7px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--green); background: rgba(20, 212, 124, 0.09); border: 1px solid rgba(20, 212, 124, 0.26); border-radius: 999px; padding: 5px 11px; }
  .na-status-pill.warn { color: var(--amber); background: var(--amber-soft); border-color: var(--amber-border); }
  .na-status-pill.bad { color: var(--red); background: var(--red-soft); border-color: var(--red-border); }
  .na-top-right-stack { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
  .na-top-controls-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .na-host-badge { color: var(--secondary); font-size: 12px; padding: 5px 10px; }
  .na-admin-dropdown { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 5px 11px; font-size: 12px; color: var(--text); cursor: pointer; }
  .na-lock-btn { background: rgba(248, 81, 100, 0.1); border: 1px solid rgba(248, 81, 100, 0.35); color: #ff6b7b; border-radius: 8px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; }

  .na-asset-chip { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; color: #fff; }
  .na-asset-chip.compact { gap: 5px; font-size: 11.5px; color: var(--secondary); }
  .na-token-logo { width: 17px; height: 17px; border-radius: 50%; display: inline-grid; place-items: center; flex: none; }
  .na-token-logo.sm { width: 14px; height: 14px; }
  .na-token-logo svg { width: 100%; height: 100%; display: block; }
  .na-pos-chips { display: flex; align-items: center; gap: 6px; margin-top: 3px; flex-wrap: wrap; }
  .na-pos-pill { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px 1px 3px; border-radius: 999px; background: rgba(255,255,255,0.04); border: 1px solid var(--border); color: var(--secondary); font-size: 10.5px; font-weight: 600; }

  .na-stats { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
  .na-stat { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; justify-content: space-between; min-height: 104px; }
  .na-stat-label { color: var(--secondary); font-size: 12px; font-weight: 500; }
  .na-stat-val { margin: 8px 0 6px; font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .na-stat-sub { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11.5px; }
  .na-stat-meter { margin: 4px 0; height: 5px; background: #182232; border-radius: 999px; overflow: hidden; }
  .na-stat-meter i { display: block; height: 100%; background: var(--green); }
  .up { color: var(--green); }
  .down { color: var(--red); }
  .mid { color: var(--amber); }

  .na-middle-split { display: grid; grid-template-columns: minmax(0, 2.15fr) minmax(300px, 1fr); gap: 12px; }
  .na-panel { background: var(--card); border: 1px solid var(--border); border-radius: 10px; min-width: 0; }
  .na-chart-panel { padding: 16px 18px 14px; display: flex; flex-direction: column; justify-content: space-between; }
  .na-chart-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .na-chart-title { margin: 0; font-size: 15px; font-weight: 600; }
  .na-chart-legend { display: flex; align-items: center; gap: 16px; margin-top: 8px; font-size: 11.5px; color: var(--secondary); }
  .na-legend-item { display: inline-flex; align-items: center; gap: 6px; }
  .na-legend-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .na-ranges { display: inline-flex; background: #090e15; border: 1px solid var(--border); border-radius: 7px; padding: 2px; gap: 2px; }
  .na-ranges button { border: 1px solid transparent; background: transparent; color: var(--muted); font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 5px; cursor: pointer; }
  .na-ranges button.active { background: rgba(20, 212, 124, 0.14); border-color: rgba(20, 212, 124, 0.35); color: var(--green); }
  .na-chart-body { display: grid; grid-template-columns: minmax(0, 1fr) 136px; gap: 14px; align-items: center; margin-top: 8px; }
  .na-chart-wrap { position: relative; height: 210px; }
  .na-chart-svg { width: 100%; height: 100%; display: block; touch-action: pan-y; }
  .na-chart-empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); font-size: 13px; }
  .na-chart-callouts { background: var(--card-inner); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 14px; }
  .na-callout-block small { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; }
  .na-callout-block strong { display: block; margin-top: 4px; font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .na-callout-divider { height: 1px; background: var(--border); }

  .na-health-panel { padding: 16px 18px; display: flex; flex-direction: column; }
  .na-health-header { display: flex; align-items: center; gap: 9px; padding-bottom: 10px; }
  .na-health-header h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .na-health-item { display: grid; grid-template-columns: 110px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 11px 0; border-top: 1px solid var(--border-subtle); font-size: 12.5px; }
  .na-health-item:first-child { border-top: 0; }
  .na-health-name { color: var(--secondary); font-size: 12px; }
  .na-health-val { font-weight: 600; font-variant-numeric: tabular-nums; }
  .na-health-bar-stack { display: flex; flex-direction: column; gap: 6px; }
  .na-health-meter { height: 5px; background: #182232; border-radius: 999px; overflow: hidden; }
  .na-health-meter i { display: block; height: 100%; background: var(--green); }
  .na-health-right { font-size: 11.5px; color: var(--muted); text-align: right; }

  .na-fleet-panel { overflow: hidden; }
  .na-panel-title-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--border-subtle); flex-wrap: wrap; }
  .na-panel-title-left h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .na-panel-link { background: none; border: 0; color: var(--muted); font-size: 12px; cursor: pointer; }
  .na-panel-link:hover { color: var(--green); }
  .na-filter-controls { display: flex; align-items: center; gap: 8px; }
  .na-filter-select, .na-filter-input { background: var(--input); border: 1px solid var(--border); border-radius: 7px; padding: 6px 10px; font-size: 12px; color: var(--text); }
  .na-table-scroll { overflow-x: auto; }
  .na-admin-root table { width: 100%; border-collapse: collapse; }
  .na-admin-root th { text-align: left; padding: 10px 16px; color: var(--muted); font-size: 10.5px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; background: #0a1018; border-bottom: 1px solid var(--border); white-space: nowrap; }
  .na-admin-root td { padding: 12px 16px; border-bottom: 1px solid var(--border-subtle); font-size: 12.5px; vertical-align: middle; white-space: nowrap; }
  .na-cell-main { display: block; font-weight: 600; color: #fff; }
  .na-cell-sub { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; }
  .mono { font-family: var(--font-jetbrains), monospace; font-size: 12px; color: var(--secondary); }
  .num { font-variant-numeric: tabular-nums; }
  .na-status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 6px; font-size: 11.5px; font-weight: 600; text-transform: lowercase; background: rgba(255,255,255,0.05); border: 1px solid var(--border); color: var(--secondary); }
  .na-status-badge.running { color: var(--green); background: rgba(20, 212, 124, 0.1); border-color: rgba(20, 212, 124, 0.28); }
  .na-kebab { color: var(--dim); font-weight: 700; text-align: right; }

  .na-bottom-grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1.35fr) minmax(0, 1fr) minmax(245px, 0.85fr); gap: 12px; }
  .na-bottom-grid.no-orphan { grid-template-columns: minmax(0, 1.35fr) minmax(0, 1.45fr) minmax(0, 1.1fr); }
  .na-tx-link { color: var(--blue); text-decoration: none; font-family: var(--font-jetbrains), monospace; font-size: 11.5px; }
  .na-pill-tag { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 5px; font-size: 11px; font-weight: 600; }
  .na-pill-tag.success, .na-pill-tag.info { color: var(--green); background: rgba(20, 212, 124, 0.12); border: 1px solid rgba(20, 212, 124, 0.28); }
  .na-pill-tag.warn { color: var(--amber); background: rgba(245, 176, 39, 0.14); border: 1px solid rgba(245, 176, 39, 0.34); }
  .na-pill-tag.error { color: var(--red); background: rgba(248, 81, 100, 0.14); border: 1px solid rgba(248, 81, 100, 0.34); }

  .na-alloc-body { padding: 14px 18px 16px; display: flex; flex-direction: column; justify-content: space-between; gap: 14px; }
  .na-alloc-bars { display: flex; flex-direction: column; gap: 13px; }
  .na-alloc-row { display: grid; grid-template-columns: 78px minmax(0, 1fr) 48px; align-items: center; gap: 10px; font-size: 12px; }
  .na-alloc-sym { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; color: var(--secondary); }
  .na-alloc-track { height: 8px; background: #162030; border-radius: 999px; overflow: hidden; }
  .na-alloc-track i { display: block; height: 100%; border-radius: 999px; }
  .na-alloc-pct { text-align: right; font-weight: 600; }
  .na-alloc-footer { padding-top: 12px; border-top: 1px solid var(--border-subtle); display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--muted); }
  .na-alloc-footer strong { font-size: 15px; color: #fff; }

  .na-orphan-panel { background: linear-gradient(180deg, rgba(245, 176, 39, 0.07), rgba(12, 18, 27, 0.95)); border: 1px solid var(--amber-border); border-radius: 10px; padding: 16px 18px; display: flex; flex-direction: column; justify-content: space-between; gap: 14px; }
  .na-orphan-head { color: var(--amber); font-weight: 600; font-size: 14px; }
  .na-orphan-desc { margin: 8px 0 0; color: var(--secondary); font-size: 12.5px; line-height: 1.5; }
  .na-orphan-btn { width: 100%; display: flex; align-items: center; justify-content: space-between; background: rgba(245, 176, 39, 0.14); border: 1px solid rgba(245, 176, 39, 0.38); color: var(--amber); border-radius: 8px; padding: 9px 14px; font-size: 12.5px; font-weight: 600; cursor: pointer; }

  .na-subview-split { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .na-kv-list { padding: 14px 18px; display: flex; flex-direction: column; }
  .na-kv-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 0; border-top: 1px solid var(--border-subtle); font-size: 12.5px; }
  .na-kv-row:first-child { border-top: 0; }
  .na-kv-row span { color: var(--muted); }
  .na-empty { color: var(--muted); padding: 16px; }

  @media (max-width: 1500px) {
    .na-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .na-bottom-grid, .na-bottom-grid.no-orphan { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 1280px) {
    .na-middle-split, .na-subview-split { grid-template-columns: 1fr; }
  }
  @media (max-width: 1000px) {
    .na-bottom-grid, .na-bottom-grid.no-orphan { grid-template-columns: 1fr; }
  }
  @media (max-width: 820px) {
    .na-app { flex-direction: column; }
    .na-sidebar { width: 100%; height: auto; position: sticky; top: 0; z-index: 20; flex-direction: row; align-items: center; padding: 10px 14px; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--border); }
    .na-brand { padding: 0 12px 0 0; }
    .na-nav { flex-direction: row; }
    .na-nav-item { white-space: nowrap; padding: 8px 10px; width: auto; }
    .na-sidebar-bottom { display: none; }
    .na-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .na-chart-body { grid-template-columns: 1fr; }
    .na-chart-callouts { flex-direction: row; justify-content: space-around; }
    .na-topbar { flex-direction: column; }
    .na-top-right-stack { align-items: flex-start; }
  }
  @media (max-width: 520px) {
    .na-stats { grid-template-columns: 1fr; }
  }
`;
