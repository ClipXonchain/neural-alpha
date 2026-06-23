import type { NewsItem } from "../data/news.js";
import { ELIGIBLE_TOKENS } from "../config.js";
import { logger } from "../utils/logger.js";

export interface NewsSentiment {
  score: number;
  articles: number;
  reasons: string[];
}

const BULLISH_KEYWORDS: Array<[RegExp, number]> = [
  [/\b(surge|surged|surging|rally|rallied|breakout|soar|soared|moon|pump)\b/i, 35],
  [/\b(partnership|partners with|collaborat|integrat)\b/i, 30],
  [/\b(launch|launched|listing|listed|airdrop|upgrade|mainnet)\b/i, 28],
  [/\b(etf|approval|approved|institutional|inflow|accumulat)\b/i, 32],
  [/\b(bullish|buy signal|outperform|all.time high|ath)\b/i, 40],
  [/\b(gain|gains|gained|increase|increased|rise|rising|up \d+%)\b/i, 20],
];

const BEARISH_KEYWORDS: Array<[RegExp, number]> = [
  [/\b(hack|hacked|exploit|exploited|drain|drained|scam|rug)\b/i, -45],
  [/\b(crash|crashed|plunge|plunged|dump|dumped|collapse)\b/i, -40],
  [/\b(sec|lawsuit|ban|banned|delist|delisted|investigation)\b/i, -35],
  [/\b(bearish|sell.off|outflow|liquidat)\b/i, -30],
  [/\b(drop|dropped|fall|fell|decline|declined|down \d+%)\b/i, -22],
  [/\b(warning|vulnerabilit|honeypot|phishing)\b/i, -38],
];

/** Common aliases / names for token matching */
const TOKEN_ALIASES: Record<string, string[]> = {
  BTC: ["bitcoin"],
  ETH: ["ethereum", "ether"],
  BNB: ["binance coin", "binance"],
  DOGE: ["dogecoin"],
  SHIB: ["shiba"],
  FLOKI: ["floki"],
  BONK: ["bonk"],
  PEPE: ["pepe"],
  LINK: ["chainlink"],
  UNI: ["uniswap"],
  AAVE: ["aave"],
  CAKE: ["pancakeswap", "pancake swap"],
  INJ: ["injective"],
  FET: ["fetch", "fetch.ai", "artificial superintelligence"],
  PENDLE: ["pendle"],
  SNX: ["synthetix"],
  AXS: ["axie"],
  LDO: ["lido"],
  AVAX: ["avalanche"],
  DOT: ["polkadot"],
  ATOM: ["cosmos"],
  FIL: ["filecoin"],
  APE: ["apecoin"],
  SUSHI: ["sushiswap"],
  BabyDoge: ["baby doge", "babydoge"],
};

function buildSymbolPatterns(): Map<string, RegExp[]> {
  const patterns = new Map<string, RegExp[]>();

  for (const symbol of ELIGIBLE_TOKENS) {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const list: RegExp[] = [
      new RegExp(`\\b${escaped}\\b`, "i"),
      new RegExp(`\\$${escaped}\\b`, "i"),
      new RegExp(`\\(${escaped}\\)`, "i"),
    ];

    const aliases = TOKEN_ALIASES[symbol];
    if (aliases) {
      for (const alias of aliases) {
        list.push(new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));
      }
    }

    patterns.set(symbol, list);
  }

  return patterns;
}

const SYMBOL_PATTERNS = buildSymbolPatterns();

function recencyWeight(publishedAt: string): number {
  const ageMs = Date.now() - new Date(publishedAt).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  if (ageHours <= 1) return 1.0;
  if (ageHours <= 6) return 0.5;
  return 0.25;
}

function scoreArticleText(text: string): { score: number; reason: string | null } {
  let score = 0;
  const hits: string[] = [];

  for (const [re, weight] of BULLISH_KEYWORDS) {
    if (re.test(text)) {
      score += weight;
      hits.push(re.source.slice(0, 24));
    }
  }
  for (const [re, weight] of BEARISH_KEYWORDS) {
    if (re.test(text)) {
      score += weight;
      hits.push(re.source.slice(0, 24));
    }
  }

  if (hits.length === 0) return { score: 0, reason: null };
  return {
    score: Math.max(-100, Math.min(100, score)),
    reason: hits.length > 0 ? `Keywords: ${hits.slice(0, 2).join(", ")}` : null,
  };
}

function findMentionedSymbols(text: string, watchSymbols?: Set<string>): string[] {
  const mentioned: string[] = [];
  const scope = watchSymbols && watchSymbols.size > 0
    ? [...watchSymbols]
    : ELIGIBLE_TOKENS;

  for (const symbol of scope) {
    const patterns = SYMBOL_PATTERNS.get(symbol);
    if (!patterns) continue;
    if (patterns.some((re) => re.test(text))) {
      mentioned.push(symbol);
    }
  }
  return mentioned;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Analyze news articles and produce per-token sentiment scores (-100 to +100).
 */
export function analyzeNewsSentiment(
  articles: NewsItem[],
  watchSymbols?: string[]
): Map<string, NewsSentiment> {
  const watchSet = watchSymbols?.length ? new Set(watchSymbols) : undefined;
  const accum = new Map<
    string,
    { weightedSum: number; weightTotal: number; articles: number; reasons: string[] }
  >();

  for (const article of articles) {
    const text = `${article.title}. ${article.summary}`.trim();
    const recency = recencyWeight(article.publishedAt);
    const { score: articleScore, reason } = scoreArticleText(text);
    const symbols = findMentionedSymbols(text, watchSet);

    if (symbols.length === 0) continue;

    for (const symbol of symbols) {
      let entry = accum.get(symbol);
      if (!entry) {
        entry = { weightedSum: 0, weightTotal: 0, articles: 0, reasons: [] };
        accum.set(symbol, entry);
      }

      entry.weightedSum += articleScore * recency;
      entry.weightTotal += recency;
      entry.articles += 1;

      const headline = article.title.length > 60
        ? `${article.title.slice(0, 57)}...`
        : article.title;
      entry.reasons.push(
        reason
          ? `${headline} (${reason})`
          : headline
      );
    }
  }

  const result = new Map<string, NewsSentiment>();

  for (const [symbol, data] of accum) {
    const rawScore = data.weightTotal > 0 ? data.weightedSum / data.weightTotal : 0;
    result.set(symbol, {
      score: clamp(Math.round(rawScore), -100, 100),
      articles: data.articles,
      reasons: data.reasons.slice(0, 3),
    });
  }

  if (result.size > 0) {
    const top = [...result.entries()]
      .sort((a, b) => Math.abs(b[1].score) - Math.abs(a[1].score))
      .slice(0, 5)
      .map(([s, v]) => `${s}:${v.score}`);
    logger.info("News sentiment analyzed", { tokensWithNews: result.size, top });
  }

  return result;
}
