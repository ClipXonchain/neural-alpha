export type SessionName = "rth" | "close" | "overnight";
export type SessionPolicy = "auto" | SessionName;

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function nyWallParts(at = Date.now()): { weekday: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const weekdayName = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return {
    weekday: Math.max(0, WEEKDAY.indexOf(weekdayName as (typeof WEEKDAY)[number])),
    hour,
    minute,
  };
}

export function clockSession(at = Date.now()): SessionName {
  const { weekday, hour, minute } = nyWallParts(at);
  if (weekday === 0 || weekday === 6) return "overnight";
  const mins = hour * 60 + minute;
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "rth";
  if (mins >= 16 * 60 && mins < 20 * 60) return "close";
  return "overnight";
}

export function sessionLabel(name: SessionName): string {
  if (name === "rth") return "RTH";
  if (name === "close") return "Close";
  return "Overnight";
}

export function formatNyTime(at = Date.now()): string {
  const { hour, minute } = nyWallParts(at);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ET`;
}

/** Cash NYSE is only open in RTH. bStocks still trade on-chain 24/7. */
export function cashMarketOpen(at = Date.now()): boolean {
  return clockSession(at) === "rth";
}

export function sessionPlaybook(session: SessionName): { title: string; detail: string } {
  switch (session) {
    case "rth":
      return {
        title: "NYSE open — price discovery",
        detail:
          "Cash is trading. Size up on trend, opening-range breakouts, and volume. Do not buy against a hard SPY/QQQ downtrend.",
      };
    case "close":
      return {
        title: "Cash closing — harvest overnight premium",
        detail:
          "Accumulate names still above VWAP into 16:00 ET. Do not dump winners just because NYSE closed — on-chain still trades.",
      };
    default:
      return {
        title: "Cash market closed — 24/7 edge",
        detail:
          "NYSE is shut (overnight / weekend). Fade extreme gaps, trade news as it hits, flatten anytime. Cash desks cannot.",
      };
  }
}

export type EdgeTone = "neon" | "cyan" | "danger" | "warning" | "muted";

export function stockEdge(
  s: {
    rsi: number;
    stochRsi?: number | null;
    gapPct?: number | null;
    vwapDev?: number | null;
    orbBreakoutPct?: number | null;
    volumeRatio?: number | null;
    newsArticles?: number;
    newsScore?: number | null;
    regime?: string;
  },
  session: SessionName
): { label: string; tone: EdgeTone } {
  const gap = s.gapPct ?? 0;
  const vwap = s.vwapDev ?? 0;
  const orb = s.orbBreakoutPct ?? 0;
  const vol = s.volumeRatio ?? 0;
  const newsHit = (s.newsArticles ?? 0) > 0 && (s.newsScore ?? 0) > 15;

  if (session === "overnight") {
    if (newsHit) return { label: "News while cash shut", tone: "cyan" };
    if (gap <= -1.5) return { label: "Fade overnight gap", tone: "neon" };
    if (gap >= 2.5) return { label: "Gap-up vs RTH close", tone: "warning" };
    if ((s.stochRsi ?? 50) < 20) return { label: "Oversold overnight", tone: "neon" };
    if ((s.stochRsi ?? 50) > 80) return { label: "Overbought overnight", tone: "danger" };
    return { label: "Overnight watch", tone: "muted" };
  }

  if (session === "close") {
    if (vwap > 0.15 && s.rsi < 72) return { label: "Hold into close", tone: "cyan" };
    if (vwap < -0.35) return { label: "Below VWAP — skip dump", tone: "muted" };
    if (newsHit) return { label: "News into close", tone: "cyan" };
    return { label: "Close harvest", tone: "cyan" };
  }

  if (s.regime === "risk_off") return { label: "Index risk-off", tone: "danger" };
  if (orb > 0.4) return { label: "ORB breakout", tone: "neon" };
  if (orb < -0.4) return { label: "ORB breakdown", tone: "danger" };
  if (vol >= 2) return { label: "RTH volume", tone: "warning" };
  if (s.rsi < 30) return { label: "RTH oversold", tone: "neon" };
  if (s.rsi > 70) return { label: "RTH overbought", tone: "danger" };
  return { label: "RTH tape", tone: "muted" };
}
