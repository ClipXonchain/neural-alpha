import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../utils/logger.js";

/**
 * Wallet transfers that are not swaps — tokens or cash sent out of (or into)
 * the wallet by the operator. They move NAV but are not trading PnL:
 *   Total PnL = NAV + transferred out − transferred in − deposit.
 */
export interface ExternalFlow {
  direction: "out" | "in";
  symbol: string;
  qty: number;
  /** USD value at the time of the transfer. */
  valueUsd: number;
  timestamp: number;
  txHash?: string;
  note?: string;
}

export interface ExternalFlowSummary {
  outUsd: number;
  inUsd: number;
  outTodayUsd: number;
  inTodayUsd: number;
}

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

export function externalFlowsPath(): string {
  return process.env.EXTERNAL_FLOWS_FILE?.trim() || join(PKG_ROOT, "data/external-flows.json");
}

function isFlow(v: unknown): v is ExternalFlow {
  const f = v as ExternalFlow;
  return (
    !!f &&
    (f.direction === "out" || f.direction === "in") &&
    typeof f.symbol === "string" &&
    Number.isFinite(f.qty) && f.qty > 0 &&
    Number.isFinite(f.valueUsd) && f.valueUsd >= 0 &&
    Number.isFinite(f.timestamp) && f.timestamp > 0
  );
}

/** File holds `[{ direction, symbol, qty, valueUsd, timestamp | time, txHash?, note? }]`. */
export function loadExternalFlows(path = externalFlowsPath()): ExternalFlow[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, unknown>>;
    const flows = (Array.isArray(raw) ? raw : [])
      .map((r) => ({
        ...r,
        symbol: String(r.symbol ?? "").toUpperCase(),
        timestamp:
          typeof r.timestamp === "number" ? r.timestamp : Date.parse(String(r.time ?? "")),
      }))
      .filter(isFlow)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (flows.length > 0) {
      logger.info("External wallet transfers loaded", {
        count: flows.length,
        ...summarizeExternalFlows(flows),
      });
    }
    return flows;
  } catch (err) {
    logger.warn("Could not read external transfers file", { path, error: String(err) });
    return [];
  }
}

export function summarizeExternalFlows(
  flows: ExternalFlow[],
  dayStartMs = utcDayStartMs()
): ExternalFlowSummary {
  const s: ExternalFlowSummary = { outUsd: 0, inUsd: 0, outTodayUsd: 0, inTodayUsd: 0 };
  for (const f of flows) {
    const today = f.timestamp >= dayStartMs;
    if (f.direction === "out") {
      s.outUsd += f.valueUsd;
      if (today) s.outTodayUsd += f.valueUsd;
    } else {
      s.inUsd += f.valueUsd;
      if (today) s.inTodayUsd += f.valueUsd;
    }
  }
  return s;
}

function utcDayStartMs(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
