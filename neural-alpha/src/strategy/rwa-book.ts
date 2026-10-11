/**
 * Pure hours-and-spread gate. No network. The signed RWA book decides
 * whether a live bStock order is allowed and how many dollars it may use.
 */

export const HACKATHON_MAX_TRADE_USD = 15;
export const HACKATHON_MIN_TRADE_USD = 8;
export const SPREAD_VETO_PCT = 1.5;
export const RESEARCH_FRESH_MS = 6 * 60 * 60 * 1000;

export type RwaSession = "rth" | "close" | "overnight";

export interface RwaDecision {
  allowed: boolean;
  amountUsd: number;
  reason: string;
  session: RwaSession;
  /** Closed, overnight, or an explicit pause. Regular hours keep the existing size. */
  capped: boolean;
}

export function hackathonTradeCap(raw?: string | null): number {
  const n = parseFloat(String(raw ?? ""));
  return Number.isFinite(n) && n > 0 ? n : HACKATHON_MAX_TRADE_USD;
}

export function sessionForMarketStatus(status: string | null | undefined): RwaSession {
  switch ((status ?? "").trim().toLowerCase()) {
    case "regular":
      return "rth";
    case "postmarket":
      return "close";
    default:
      return "overnight";
  }
}

/** Cash-market closed or the API's overnight session. Premarket keeps today's size. */
export function isCappedMarket(status: string | null | undefined): boolean {
  const name = (status ?? "").trim().toLowerCase();
  return name === "closed" || name === "overnight";
}

function clamp(requested: number, min: number, max: number, researchFresh: boolean): number {
  const cap = Math.max(min, max);
  if (!researchFresh) return min;
  return Math.min(cap, Math.max(min, requested));
}

export function clockMarketStatus(session: RwaSession): "regular" | "postmarket" | "closed" {
  if (session === "rth") return "regular";
  if (session === "close") return "postmarket";
  return "closed";
}

export function decideRwaTrade(input: {
  marketStatus: string | null | undefined;
  /** Used only when the RWA payload leaves marketStatus empty. */
  clockStatus?: string | null;
  spreadPct: number | null;
  side: "buy" | "sell";
  holdsToken: boolean;
  requestedUsd: number;
  researchFresh: boolean;
  otherOpenPositions?: number;
  maxTradeUsd?: number;
  minTradeUsd?: number;
}): RwaDecision {
  const named = (input.marketStatus ?? "").trim().toLowerCase();
  const fallback = (input.clockStatus ?? "").trim().toLowerCase();
  const inferred = (!named || named === "unknown") && Boolean(fallback);
  const status = inferred ? fallback : named;
  const session = sessionForMarketStatus(status);
  const max = input.maxTradeUsd ?? HACKATHON_MAX_TRADE_USD;
  const min = input.minTradeUsd ?? HACKATHON_MIN_TRADE_USD;
  const capped = isCappedMarket(status);
  const spread = input.spreadPct;
  const rich = spread != null && spread >= SPREAD_VETO_PCT;
  const cheap = spread != null && spread <= -SPREAD_VETO_PCT;
  const say = (reason: string) =>
    inferred ? `RWA marketStatus empty; NY clock is ${status}. ${reason}` : reason;

  if (!status || status === "unknown") {
    return {
      allowed: false,
      amountUsd: 0,
      reason: say("RWA market status missing"),
      session,
      capped,
    };
  }

  if (status === "pause") {
    return {
      allowed: false,
      amountUsd: 0,
      reason: say("RWA market paused"),
      session,
      capped: true,
    };
  }

  if (input.side === "buy" && rich) {
    return {
      allowed: false,
      amountUsd: 0,
      reason: say(`on-chain is ${spread?.toFixed(2)}% rich versus reference`),
      session,
      capped,
    };
  }

  if (input.side === "sell" && rich) {
    if (!input.holdsToken) {
      return { allowed: false, amountUsd: 0, reason: say("rich spread sell needs an open position"), session, capped };
    }
    return {
      allowed: true,
      amountUsd: Math.min(input.requestedUsd > 0 ? input.requestedUsd : max, max),
      reason: say(`on-chain is ${spread?.toFixed(2)}% rich versus reference — small sell`),
      session,
      capped: true,
    };
  }

  if (input.side === "buy" && capped && (input.otherOpenPositions ?? 0) > 0 && !input.holdsToken) {
    return {
      allowed: false,
      amountUsd: 0,
      reason: say("one closed-market entry at a time"),
      session,
      capped,
    };
  }

  if (input.side === "buy" && capped) {
    const amountUsd = clamp(input.requestedUsd, min, max, input.researchFresh);
    const research = input.researchFresh ? "research fresh" : "research stale, minimum size";
    const gap = cheap ? `discount ${spread?.toFixed(2)}%` : "hours cap";
    return {
      allowed: amountUsd > 0,
      amountUsd,
      reason: say(`${status} ${gap}; ${research}`),
      session,
      capped: true,
    };
  }

  return {
    allowed: input.requestedUsd > 0 || input.side === "sell",
    amountUsd: input.requestedUsd,
    reason: say(`${status} uses the existing strategy`),
    session,
    capped: false,
  };
}

export function researchIsFresh(at: number | null | undefined, now = Date.now()): boolean {
  return typeof at === "number" && at > 0 && now - at < RESEARCH_FRESH_MS;
}
