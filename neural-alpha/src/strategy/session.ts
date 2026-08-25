/**
 * US equity session clock for 24/7 on-chain bStocks.
 *
 * Cash US names still discover price on NYSE hours. Tokenized bStocks trade
 * continuously on BSC — this module lets the agent size and score differently
 * in RTH (price discovery), the cash close (overnight-premium harvest), and
 * overnight / weekends (gap + news, thinner books).
 */

export type SessionName = "rth" | "close" | "overnight";
export type SessionPolicy = "auto" | SessionName;

export interface SessionClock {
  policy: SessionPolicy;
  /** America/New_York session from the wall clock. */
  clock: SessionName;
  /** Profile used for scoring — clock when policy is auto, else locked. */
  active: SessionName;
  weekday: number;
  nyHour: number;
  nyMinute: number;
  nyTimeLabel: string;
  label: string;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function nyWallParts(at: Date | number = Date.now()): {
  weekday: number;
  hour: number;
  minute: number;
} {
  const date = typeof at === "number" ? new Date(at) : at;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const weekdayName = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const weekday = Math.max(
    0,
    WEEKDAY_SHORT.indexOf(weekdayName as (typeof WEEKDAY_SHORT)[number])
  );
  return { weekday, hour, minute };
}

/** Regular trading hours: Mon–Fri 09:30–16:00 ET. */
export function isRth(weekday: number, hour: number, minute: number): boolean {
  if (weekday === 0 || weekday === 6) return false;
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

/** Cash close / after-hours window: Mon–Fri 16:00–20:00 ET. */
export function isCloseWindow(weekday: number, hour: number, minute: number): boolean {
  if (weekday === 0 || weekday === 6) return false;
  const mins = hour * 60 + minute;
  return mins >= 16 * 60 && mins < 20 * 60;
}

export function clockSession(at: Date | number = Date.now()): SessionName {
  const { weekday, hour, minute } = nyWallParts(at);
  if (isRth(weekday, hour, minute)) return "rth";
  if (isCloseWindow(weekday, hour, minute)) return "close";
  return "overnight";
}

export function isSessionName(value: unknown): value is SessionName {
  return value === "rth" || value === "close" || value === "overnight";
}

export function isSessionPolicy(value: unknown): value is SessionPolicy {
  return value === "auto" || isSessionName(value);
}

export function resolveSessionPolicy(raw?: string | null): SessionPolicy {
  const v = (raw || "").trim().toLowerCase();
  if (isSessionPolicy(v)) return v;
  if (v === "regular" || v === "cash" || v === "open") return "rth";
  if (v === "afterhours" || v === "ah" || v === "post") return "close";
  if (v === "on" || v === "asia" || v === "weekend") return "overnight";
  return "auto";
}

export function sessionLabel(name: SessionName): string {
  switch (name) {
    case "rth":
      return "RTH";
    case "close":
      return "Close";
    default:
      return "Overnight";
  }
}

export function getSessionClock(
  policy: SessionPolicy = "auto",
  at: Date | number = Date.now()
): SessionClock {
  const { weekday, hour, minute } = nyWallParts(at);
  const clock = clockSession(at);
  const active = policy === "auto" ? clock : policy;
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return {
    policy,
    clock,
    active,
    weekday,
    nyHour: hour,
    nyMinute: minute,
    nyTimeLabel: `${hh}:${mm} ET`,
    label: sessionLabel(active),
  };
}

/** Minutes from midnight ET. */
function nyMinutes(hour: number, minute: number): number {
  return hour * 60 + minute;
}

/**
 * Last regular-session close price from OHLCV (weekday ~16:00 ET candle).
 * Used as the overnight-gap reference.
 */
export function lastRthClosePrice(
  history: Array<{ timestamp: number; close: number }>,
  at: Date | number = Date.now()
): number | null {
  if (history.length === 0) return null;
  const now = typeof at === "number" ? at : at.getTime();
  let best: { ts: number; close: number } | null = null;

  for (const c of history) {
    if (c.timestamp > now || !(c.close > 0)) continue;
    const { weekday, hour, minute } = nyWallParts(c.timestamp);
    if (weekday === 0 || weekday === 6) continue;
    const mins = nyMinutes(hour, minute);
    // Capture the cash close print (15:55–16:10 ET).
    if (mins < 15 * 60 + 55 || mins > 16 * 60 + 10) continue;
    if (!best || c.timestamp > best.ts) best = { ts: c.timestamp, close: c.close };
  }

  if (best) return best.close;

  // Fallback: last weekday candle before 16:00 ET that is at least 30m old.
  for (let i = history.length - 1; i >= 0; i--) {
    const c = history[i];
    if (c.timestamp > now || !(c.close > 0)) continue;
    const { weekday, hour, minute } = nyWallParts(c.timestamp);
    if (weekday === 0 || weekday === 6) continue;
    if (nyMinutes(hour, minute) <= 16 * 60) return c.close;
  }
  return history[history.length - 1]?.close ?? null;
}

export function overnightGapPct(
  currentPrice: number,
  history: Array<{ timestamp: number; close: number }>,
  at: Date | number = Date.now()
): number | null {
  if (!(currentPrice > 0)) return null;
  const close = lastRthClosePrice(history, at);
  if (close === null || close <= 0) return null;
  return ((currentPrice - close) / close) * 100;
}

export interface OpeningRange {
  high: number;
  low: number;
  /** % above the OR high (positive) or below the OR low (negative). 0 inside. */
  breakoutPct: number;
}

/**
 * Opening range = first 30 minutes of RTH (09:30–10:00 ET) on the current
 * NY session date. Returns null overnight / weekends or if candles are missing.
 */
export function openingRange(
  history: Array<{ timestamp: number; high: number; low: number }>,
  currentPrice: number,
  at: Date | number = Date.now()
): OpeningRange | null {
  const nowParts = nyWallParts(at);
  if (nowParts.weekday === 0 || nowParts.weekday === 6) return null;

  const now = typeof at === "number" ? at : at.getTime();
  let high = -Infinity;
  let low = Infinity;
  let count = 0;

  for (const c of history) {
    if (c.timestamp > now) continue;
    const p = nyWallParts(c.timestamp);
    if (p.weekday !== nowParts.weekday) continue;
    const mins = nyMinutes(p.hour, p.minute);
    if (mins < 9 * 60 + 30 || mins >= 10 * 60) continue;
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
    count++;
  }

  if (count === 0 || !Number.isFinite(high) || !Number.isFinite(low) || high <= low) {
    return null;
  }

  let breakoutPct = 0;
  if (currentPrice > high && high > 0) {
    breakoutPct = ((currentPrice - high) / high) * 100;
  } else if (currentPrice < low && low > 0) {
    breakoutPct = ((currentPrice - low) / low) * 100;
  }

  return { high, low, breakoutPct };
}
