import { chatText, llmEnabled, llmReasoningModel } from "./client.js";
import { logger } from "../utils/logger.js";

/**
 * Read-only facts about the desk, assembled by the agent. Every number the
 * assistant or the daily review quotes must come from here.
 */
export interface OperatorContext {
  now: string;
  mode: string;
  running: boolean;
  wallet: {
    /**
     * wallet = live Binance Web3 scan; agent-book = agent's synced ledger;
     * last-saved = newest stored NAV point (the book was not synced).
     */
    navSource: "wallet" | "agent-book" | "last-saved";
    navUsd: number;
    depositUsd: number;
    sentOutUsd: number;
    sentInUsd: number;
    totalPnlUsd: number;
    totalPnlPct: number;
    /** Null when there is no trustworthy start-of-day NAV. */
    dailyPnlUsd: number | null;
    cashUsd: number | null;
    gasUsd: number | null;
    navVerified: boolean;
  };
  positions: Array<{ symbol: string; qty: number; price: number; entry: number | null; pnlUsd: number | null; pnlPct: number | null }>;
  transfers: Array<{ direction: string; symbol: string; qty: number; valueUsd: number; time: string; note?: string }>;
  trades: Array<{ time: string; side: string; symbol: string; qty: number; usd: number; price: number; pnlUsd: number | null; tx?: string }>;
  stats: { closedTrades: number; wins: number; losses: number; realizedPnlUsd: number };
  rules: Record<string, unknown>;
  aiInsights: Array<{ symbol: string; verdict: string; agrees: boolean; summary: string }>;
  macro: string | null;
  studioReports: Array<{ tickers: string[]; time: string }>;
  recentEvents: Array<{ time: string; level: string; event: string; detail?: string }>;
  latestReview?: { day: string; text: string };
  /** Present for daily reviews: the reviewed UTC day's NAV and transfers. */
  reviewDay?: {
    day: string;
    openNavUsd: number;
    closeNavUsd: number;
    /** Close − open, with transfers added back. */
    pnlUsd: number;
    transfersOutUsd: number;
    transfersInUsd: number;
  };
}

export interface DailyReview {
  /** UTC date the review covers (YYYY-MM-DD). */
  day: string;
  text: string;
  model: string;
  generatedAt: number;
  partial: boolean;
}

const ASSISTANT_SYSTEM = `You are the operator assistant for Neural Alpha, an autonomous bStock (tokenized US stock) trading agent on BNB Smart Chain.
You answer the operator's questions using ONLY the JSON context provided. You cannot trade, change settings, or move funds — say so if asked.
Rules:
- Quote numbers exactly as they appear in the context, with $ and %. Never estimate a figure that is not there.
- Total PnL already excludes operator transfers: PnL = NAV + sent out − sent in − deposit.
- If the context doesn't contain the answer, say what is missing instead of guessing.
- If wallet.navSource is not "wallet", say the figures are not from a fresh wallet scan.
- Be brief: lead with the direct answer, then at most a few short bullets. Plain language, no jargon.`;

const REVIEW_SYSTEM = `You write the end-of-day trading review for Neural Alpha, an autonomous bStock trading agent on BNB Smart Chain.
Use ONLY the JSON context. Quote numbers exactly; never invent trades, prices, or causes.
Write under 300 words as exactly five sections. Each section starts on its own line. Never put two labels in the same paragraph.
**Result** — day PnL, total PnL, and the named positions that moved them, with the dollar or percent figure from the context.
**Trades** — each fill on its own line: symbol, side, size, and result. If there were none, write "No trades."
**What worked / what didn't** — one sentence for what helped and one for what hurt, each naming a position, rule, or report from the context.
**Rule check** — each stop-loss, take-profit, or block from recentEvents, with the symbol. If none, write "No rule blocked or closed a trade."
**Watch tomorrow** — up to 3 bullets. Each bullet is one symbol plus the specific level, pending item, or data problem.
Mention operator transfers only as transfers, never as losses.`;

const MAX_QUESTION_CHARS = 600;

export function operatorLlmEnabled(): boolean {
  return llmEnabled();
}

export async function answerOperatorQuestion(question: string, ctx: OperatorContext): Promise<string> {
  const q = question.trim().slice(0, MAX_QUESTION_CHARS);
  if (!q) throw new Error("Ask a question");
  if (!llmEnabled()) throw new Error("No LLM configured — set OPENAI_API_KEY in .env");
  const answer = await chatText({
    system: ASSISTANT_SYSTEM,
    user: `Context:\n${JSON.stringify(ctx)}\n\nQuestion: ${q}`,
    maxTokens: 700,
    temperature: 0.2,
  });
  logger.info("Operator assistant answered", { chars: answer.length, model: llmReasoningModel() });
  return answer || "No answer returned by the model.";
}

export async function writeDailyReview(day: string, ctx: OperatorContext, partial: boolean): Promise<DailyReview> {
  if (!llmEnabled()) throw new Error("No LLM configured — set OPENAI_API_KEY in .env");
  const text = await chatText({
    system: REVIEW_SYSTEM,
    user: `Review day (UTC): ${day}${partial ? " — day still in progress" : ""}\n\nContext:\n${JSON.stringify(ctx)}`,
    maxTokens: 900,
    temperature: 0.3,
  });
  logger.info("Daily review written", { day, partial, chars: text.length });
  return { day, text, model: llmReasoningModel(), generatedAt: Date.now(), partial };
}
