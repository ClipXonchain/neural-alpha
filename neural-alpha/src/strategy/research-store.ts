import { getAgentStore } from "../db/store.js";
import { logger } from "../utils/logger.js";

/**
 * Finished Agent Studio stock reports (paid x402 jobs). Kept so the LLM analyst
 * and the operator assistant can read what the campaign already paid for.
 */
export interface StudioReport {
  jobId: string;
  /** Tickers as submitted to Studio (no bStock `B` suffix). */
  tickers: string[];
  text: string;
  at: number;
}

const STATE_KEY = "studio_reports";
const MAX_REPORTS = 12;
const MAX_REPORT_CHARS = 40_000;
/** Reports older than this are not fed to the analyst. */
const REPORT_TTL_MS = 3 * 86_400_000;

let reports: StudioReport[] | null = null;

function all(): StudioReport[] {
  if (reports) return reports;
  const store = getAgentStore();
  const loaded = store.loadJsonState<StudioReport[]>(STATE_KEY) ?? [];
  if (store.isReady) reports = loaded;
  return loaded;
}

export function hasStudioReport(jobId: string): boolean {
  return all().some((r) => r.jobId === jobId);
}

export function saveStudioReport(report: StudioReport): void {
  const next = [
    { ...report, tickers: report.tickers.map((t) => t.toUpperCase()), text: report.text.slice(0, MAX_REPORT_CHARS) },
    ...all().filter((r) => r.jobId !== report.jobId),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_REPORTS);
  reports = next;
  getAgentStore().saveJsonState(STATE_KEY, next);
  logger.info("Agent Studio report stored", { jobId: report.jobId, tickers: report.tickers, chars: report.text.length });
}

export function latestStudioReports(): StudioReport[] {
  return [...all()];
}

function tickerOf(symbol: string): string {
  const s = symbol.toUpperCase();
  return s.length > 2 && s.endsWith("B") ? s.slice(0, -1) : s;
}

/**
 * Report excerpt for one bStock — the paragraphs that mention its ticker, or
 * the report head when the job covered only this ticker.
 */
export function studioExcerpt(symbol: string, maxChars = 1500, now = Date.now()): string | null {
  const ticker = tickerOf(symbol);
  const report = all().find((r) => r.tickers.includes(ticker) && now - r.at <= REPORT_TTL_MS);
  return report ? excerptFromReport(report, symbol, maxChars) : null;
}

export function excerptFromReport(
  report: Pick<StudioReport, "tickers" | "text">,
  symbol: string,
  maxChars = 1500
): string | null {
  const ticker = tickerOf(symbol);
  if (report.tickers.length === 1) return readableReport(report.text).slice(0, maxChars);

  const scoped = tickerSection(report.text, ticker);
  if (scoped) return readableReport(JSON.stringify(scoped)).slice(0, maxChars);

  const text = readableReport(report.text);
  const mention = new RegExp(`\\b${ticker}\\b`);
  const paragraphs = text.split(/\n{2,}/).filter((p) => mention.test(p));
  const picked = (paragraphs.length > 0 ? paragraphs.join("\n\n") : text).slice(0, maxChars);
  return picked || null;
}

/** In a JSON report, the object whose symbol/ticker field equals `ticker`. */
function tickerSection(raw: string, ticker: string): unknown {
  let root: unknown;
  try {
    root = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (!v || typeof v !== "object") continue;
    if (Array.isArray(v)) {
      stack.push(...v);
      continue;
    }
    const obj = v as Record<string, unknown>;
    for (const key of ["symbol", "ticker", "stock"]) {
      if (typeof obj[key] === "string" && (obj[key] as string).toUpperCase() === ticker) return obj;
    }
    for (const [key, child] of Object.entries(obj)) {
      if (key.toUpperCase() === ticker && child && typeof child === "object") return child;
      stack.push(child);
    }
  }
  return null;
}

/** Studio may return JSON or Markdown; flatten JSON into readable lines. */
function readableReport(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;
  try {
    const lines: string[] = [];
    const walk = (v: unknown, path: string) => {
      if (v == null) return;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        lines.push(path ? `${path}: ${v}` : String(v));
      } else if (Array.isArray(v)) {
        v.forEach((item, i) => walk(item, `${path}[${i}]`));
      } else {
        for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
          walk(item, path ? `${path}.${k}` : k);
        }
      }
    };
    walk(JSON.parse(trimmed), "");
    return lines.join("\n");
  } catch {
    return trimmed;
  }
}
