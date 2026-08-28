import { logger } from "../utils/logger.js";
import { completeCmcCampaignCall } from "../integrations/campaign-x402.js";
import { isCmcX402Enabled, parseX402Settings } from "../integrations/campaign-x402-schedule.js";

export type CmcTapeRegime = "risk_on" | "risk_off" | "neutral";

/**
 * Cheap CMC MCP overlay (~$0.01/call). Do NOT hit this on the 10s quote pulse.
 * Interval: CMC_X402_INTERVAL_MS (fallback CMC_MACRO_REFRESH_MS, default 4h).
 * Open portfolio slots force a global-metrics refresh immediately.
 *
 * Campaign-eligible tools only:
 *   get_global_metrics_latest  — risk-on / risk-off tape
 *   get_upcoming_macro_events  — event-risk gate
 * get_crypto_metrics is holder-distribution of a coin — near-zero alpha for bStock.
 * execute_skill is slow (30–300s) — keep it off the trade loop.
 */

export type CmcEventRisk = "none" | "high";

export interface CmcMacroSnapshot {
  at: number;
  regime: CmcTapeRegime;
  mcap24hPct: number | null;
  mcap7dPct: number | null;
  volume24hPct: number | null;
  eventRisk: CmcEventRisk;
  eventHint: string | null;
  sizeScale: number;
  summary: string;
}

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const EVENTS_TTL_MS = parseInt(process.env.CMC_EVENTS_REFRESH_MS || String(FOUR_HOURS_MS), 10) || FOUR_HOURS_MS;

function globalTtlMs(): number {
  return parseX402Settings().cmcX402IntervalMs;
}

const EVENT_RE =
  /\b(fomc|cpi|pce|nfp|nonfarm|payroll|powell|jackson hole|rate (cut|hike|decision)|fed(eral)? reserve|unemployment)\b/i;

let cache: CmcMacroSnapshot | null = null;
let lastGlobalAt = 0;
let lastEventsAt = 0;
let lastEvents: { hint: string | null; risk: CmcEventRisk } = { hint: null, risk: "none" };
let inflight: Promise<CmcMacroSnapshot | null> | null = null;

export function getCmcMacro(): CmcMacroSnapshot | null {
  return cache;
}

export function cmcMacroEnabled(): boolean {
  return isCmcX402Enabled();
}

export function blendEquityAndCmc(
  equity: CmcTapeRegime,
  cmc: CmcMacroSnapshot | null | undefined
): CmcTapeRegime {
  if (!cmc) return equity;
  if (cmc.eventRisk === "high") {
    if (equity === "risk_on") return "neutral";
    return "risk_off";
  }
  if (cmc.regime === "risk_off") {
    return equity === "risk_on" ? "neutral" : "risk_off";
  }
  if (cmc.regime === "risk_on" && equity === "risk_on") return "risk_on";
  return equity;
}

function parsePct(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const n = parseFloat(value.replace(/[%+,]/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function walkForPct(obj: unknown, keys: string[]): number | null {
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  for (const key of keys) {
    if (key in rec) {
      const hit = parsePct(rec[key]);
      if (hit !== null) return hit;
    }
  }
  for (const v of Object.values(rec)) {
    const nested = walkForPct(v, keys);
    if (nested !== null) return nested;
  }
  return null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function classifyGlobalMetrics(raw: unknown): Pick<
  CmcMacroSnapshot,
  "regime" | "mcap24hPct" | "mcap7dPct" | "volume24hPct"
> {
  const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const marketSize = (rec.market_size ?? rec.marketSize ?? rec) as Record<string, unknown>;
  const mcap = (marketSize.total_crypto_market_cap_usd ??
    marketSize.totalCryptoMarketCapUsd ??
    marketSize) as Record<string, unknown>;
  const chg = (mcap.percent_change ?? mcap.percentChange ?? {}) as Record<string, unknown>;

  const mcap24hPct =
    parsePct(chg["24h"]) ??
    parsePct(chg.h24) ??
    walkForPct(raw, ["24h", "percent_change_24h"]);
  const mcap7dPct = parsePct(chg["7d"]) ?? parsePct(chg.d7) ?? walkForPct(raw, ["7d"]);

  const liquidity = (rec.liquidity ?? {}) as Record<string, unknown>;
  const vol = (liquidity.volume24h ?? liquidity.volume_24h ?? {}) as Record<string, unknown>;
  const volTotal = (vol.total ?? vol) as Record<string, unknown>;
  const volChg = (volTotal.percent_change ?? volTotal.percentChange ?? {}) as Record<string, unknown>;
  const volume24hPct = parsePct(volChg["24h"]) ?? parsePct(volChg.h24);

  let regime: CmcTapeRegime = "neutral";
  const m24 = mcap24hPct ?? 0;
  const m7 = mcap7dPct ?? 0;
  if (m24 <= -2.5 || (m24 <= -1.2 && (volume24hPct ?? 0) > 40)) {
    regime = "risk_off";
  } else if (m24 >= 1.2 && m7 >= 0) {
    regime = "risk_on";
  }

  return { regime, mcap24hPct, mcap7dPct, volume24hPct };
}

function parseEventDate(raw: unknown): number | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

export function classifyMacroEvents(raw: unknown, now = Date.now()): {
  hint: string | null;
  risk: CmcEventRisk;
} {
  const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const table = (rec.upcomingEventNews ?? rec) as Record<string, unknown>;
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const horizon = now + 48 * 60 * 60 * 1000;

  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const title = String(row[0] ?? "");
    const snippet = String(row[1] ?? "");
    const dateStr = String(row[3] ?? "");
    const blob = `${title} ${snippet}`;
    if (!EVENT_RE.test(blob)) continue;
    const at = parseEventDate(dateStr);
    if (at === null || at < now - 6 * 60 * 60 * 1000 || at > horizon) continue;
    return { hint: `${title} (${dateStr})`, risk: "high" };
  }
  return { hint: null, risk: "none" };
}

function sizeScale(regime: CmcTapeRegime, eventRisk: CmcEventRisk): number {
  let scale = regime === "risk_off" ? 0.55 : regime === "risk_on" ? 1.12 : 1;
  if (eventRisk === "high") scale *= 0.6;
  return Math.round(scale * 100) / 100;
}

function buildSnapshot(
  global: ReturnType<typeof classifyGlobalMetrics>,
  events: { hint: string | null; risk: CmcEventRisk }
): CmcMacroSnapshot {
  const scale = sizeScale(global.regime, events.risk);
  const m24 = global.mcap24hPct != null ? `${global.mcap24hPct.toFixed(2)}%` : "n/a";
  const parts = [`crypto mcap 24h ${m24}`, global.regime];
  if (events.risk === "high" && events.hint) parts.push(`event: ${events.hint}`);
  return {
    at: Date.now(),
    regime: global.regime,
    mcap24hPct: global.mcap24hPct,
    mcap7dPct: global.mcap7dPct,
    volume24hPct: global.volume24hPct,
    eventRisk: events.risk,
    eventHint: events.hint,
    sizeScale: scale,
    summary: parts.join(" · "),
  };
}

async function paidJson(
  tool: "get_global_metrics_latest" | "get_upcoming_macro_events"
): Promise<unknown> {
  const { text } = await completeCmcCampaignCall(tool);
  return parseJson(text);
}

async function doRefresh(force = false): Promise<CmcMacroSnapshot | null> {
  const now = Date.now();
  const ttl = globalTtlMs();
  const needGlobal = force || !cache || now - lastGlobalAt >= ttl;
  const needEvents = now - lastEventsAt >= EVENTS_TTL_MS;

  if (!needGlobal && !needEvents && cache) return cache;

  let global = cache
    ? {
        regime: cache.regime,
        mcap24hPct: cache.mcap24hPct,
        mcap7dPct: cache.mcap7dPct,
        volume24hPct: cache.volume24hPct,
      }
    : { regime: "neutral" as CmcTapeRegime, mcap24hPct: null, mcap7dPct: null, volume24hPct: null };

  try {
    if (needGlobal) {
      const raw = await paidJson("get_global_metrics_latest");
      global = classifyGlobalMetrics(raw);
      lastGlobalAt = Date.now();
    }
    if (needEvents) {
      const raw = await paidJson("get_upcoming_macro_events");
      lastEvents = classifyMacroEvents(raw);
      lastEventsAt = Date.now();
    }
  } catch (err) {
    logger.warn("CMC macro overlay refresh failed — keeping last snapshot", {
      error: String(err),
    });
    return cache;
  }

  cache = buildSnapshot(global, lastEvents);
  logger.info("CMC macro overlay updated", {
    regime: cache.regime,
    mcap24hPct: cache.mcap24hPct,
    sizeScale: cache.sizeScale,
    eventRisk: cache.eventRisk,
  });
  return cache;
}

/** Refresh when TTL expired. `force` bypasses the global-metrics interval (open-slot path). */
export async function refreshCmcMacro(opts?: { force?: boolean }): Promise<CmcMacroSnapshot | null> {
  if (!cmcMacroEnabled()) return cache;
  if (inflight) return inflight;
  inflight = doRefresh(opts?.force === true).finally(() => {
    inflight = null;
  });
  return inflight;
}
