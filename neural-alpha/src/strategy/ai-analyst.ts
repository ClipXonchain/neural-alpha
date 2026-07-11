import OpenAI from "openai";
import type { MarketData, TechnicalSignals, TradeSignal } from "../utils/types.js";
import { logger } from "../utils/logger.js";

export interface AiSignalInsight {
  symbol: string;
  summary: string;
  verdict: "bullish" | "bearish" | "neutral" | "caution";
  agreesWithSignal: boolean;
  risks: string[];
  confidence: number;
}

let client: OpenAI | null = null;
let model = "gpt-4o-mini";

function isEnabled(): boolean {
  if (process.env.AI_SIGNAL_ANALYSIS === "false") return false;
  return !!process.env.OPENAI_API_KEY?.trim();
}

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
    });
    model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  }
  return client;
}

function formatTechnicals(t: TechnicalSignals, price: number): Record<string, unknown> {
  const bb = t.bollingerBands;
  const bbPos =
    bb && bb.upper !== bb.lower
      ? (((price - bb.lower) / (bb.upper - bb.lower)) * 100).toFixed(0) + "%"
      : null;

  return {
    rsi14: t.rsi !== null ? Math.round(t.rsi * 10) / 10 : null,
    macdHistogram: t.macd?.histogram ?? null,
    macdCross: t.macd
      ? t.macd.histogram > 0 && t.macd.macd > t.macd.signal
        ? "bullish"
        : t.macd.histogram < 0 && t.macd.macd < t.macd.signal
          ? "bearish"
          : "neutral"
      : null,
    ema12: t.ema?.fast ?? null,
    ema26: t.ema?.slow ?? null,
    bollingerPosition: bbPos,
    atr: t.atr ?? null,
    volumeRatio: t.volumeRatio !== null ? Math.round(t.volumeRatio * 100) / 100 : null,
  };
}

function buildPayload(
  signals: TradeSignal[],
  markets: Map<string, MarketData>,
  technicals: Map<string, TechnicalSignals>,
  fearGreed: number | null
) {
  return signals.map((s) => {
    const m = markets.get(s.symbol);
    const t = technicals.get(s.symbol);
    return {
      symbol: s.symbol,
      price: m?.price ?? null,
      change24hPct: m?.change24h ?? null,
      ruleAction: s.action,
      ruleStrength: s.strength,
      ruleScore: Math.round(s.score),
      ruleReasons: s.reasons.slice(0, 4),
      indicators: t ? formatTechnicals(t, m?.price ?? 0) : {},
    };
  });
}

const ANALYSIS_TOOL: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "submit_ta_analysis",
    description: "Submit structured technical analysis for each token.",
    parameters: {
      type: "object",
      properties: {
        analyses: {
          type: "array",
          items: {
            type: "object",
            properties: {
              symbol: { type: "string" },
              summary: {
                type: "string",
                description: "1-2 sentence technical analysis summary for a trader.",
              },
              verdict: {
                type: "string",
                enum: ["bullish", "bearish", "neutral", "caution"],
              },
              agreesWithSignal: {
                type: "boolean",
                description: "Whether you agree with the rule-based action (buy/sell/hold).",
              },
              risks: {
                type: "array",
                items: { type: "string" },
                description: "Up to 2 key risks or invalidation points.",
              },
              confidence: {
                type: "number",
                description: "Your confidence in this read, 0.0 to 1.0.",
              },
            },
            required: ["symbol", "summary", "verdict", "agreesWithSignal", "risks", "confidence"],
          },
        },
      },
      required: ["analyses"],
    },
  },
};

/**
 * Run LLM technical analysis on the top actionable signals for this cycle.
 * Augments signals with ai insight — does NOT override rule-based action/score.
 */
export async function enrichSignalsWithAi(
  signals: TradeSignal[],
  markets: MarketData[],
  technicalsBySymbol: Map<string, TechnicalSignals>,
  fearGreed: number | null
): Promise<Map<string, AiSignalInsight>> {
  const results = new Map<string, AiSignalInsight>();
  if (!isEnabled()) return results;

  const topN = parseInt(process.env.AI_SIGNAL_TOP_N || "5", 10);
  const candidates = signals
    .filter((s) => s.action !== "hold")
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, topN);

  if (candidates.length === 0) return results;

  const marketMap = new Map(markets.map((m) => [m.symbol, m]));
  const payload = buildPayload(candidates, marketMap, technicalsBySymbol, fearGreed);

  const system = `You are a crypto technical analyst for Neural Alpha, an autonomous BSC trading agent.
Analyze each token using the provided indicators and rule-based signal.
Be concise and actionable. Flag contradictions (e.g. buy signal but bearish MACD + overbought RSI).
Fear & Greed index: ${fearGreed ?? "unknown"} (0=extreme fear, 100=extreme greed).
Do not invent prices or indicators not in the data.
Always call submit_ta_analysis with one entry per token.`;

  try {
    const ai = getClient();
    const response = await ai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `Analyze these tokens:\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
      tools: [ANALYSIS_TOOL],
      tool_choice: { type: "function", function: { name: "submit_ta_analysis" } },
      temperature: 0.2,
      max_tokens: 1200,
    });

    const toolCall = response.choices[0]?.message?.tool_calls?.[0] as
      | { type: "function"; function: { arguments: string } }
      | undefined;

    if (!toolCall?.function?.arguments) return results;

    const parsed = JSON.parse(toolCall.function.arguments) as {
      analyses: AiSignalInsight[];
    };

    for (const row of parsed.analyses ?? []) {
      if (!row.symbol) continue;
      const insight: AiSignalInsight = {
        symbol: row.symbol.toUpperCase(),
        summary: String(row.summary ?? "").slice(0, 280),
        verdict: ["bullish", "bearish", "neutral", "caution"].includes(row.verdict)
          ? row.verdict
          : "neutral",
        agreesWithSignal: Boolean(row.agreesWithSignal),
        risks: (row.risks ?? []).slice(0, 2).map(String),
        confidence: Math.min(1, Math.max(0, Number(row.confidence) || 0.5)),
      };
      results.set(insight.symbol, insight);
    }

    logger.info("AI signal analysis complete", {
      tokens: [...results.keys()],
      model,
    });
  } catch (err) {
    logger.warn("AI signal analysis failed — using rule-based signals only", {
      error: String(err),
    });
  }

  return results;
}

/** Apply AI insight to a signal (confidence tweak only — action/score unchanged). */
export function applyAiInsight(
  signal: TradeSignal,
  insight: AiSignalInsight | undefined
): TradeSignal {
  if (!insight) return signal;

  let confidence = signal.confidence;
  if (insight.agreesWithSignal) {
    confidence = Math.min(1, confidence + 0.08);
  } else if (insight.verdict === "caution") {
    confidence = Math.max(0.15, confidence - 0.12);
  } else {
    confidence = Math.max(0.2, confidence - 0.08);
  }

  return {
    ...signal,
    confidence: Math.round(confidence * 100) / 100,
    ai: insight,
  };
}

export function isAiAnalysisEnabled(): boolean {
  return isEnabled();
}

/** Single-token analysis for command panel "signal BTC". */
export async function analyzeSingleSignal(
  signal: TradeSignal,
  market: MarketData,
  technicals: TechnicalSignals,
  fearGreed: number | null
): Promise<AiSignalInsight | null> {
  const map = await enrichSignalsWithAi(
    [signal],
    [market],
    new Map([[signal.symbol, technicals]]),
    fearGreed
  );
  return map.get(signal.symbol.toUpperCase()) ?? null;
}
