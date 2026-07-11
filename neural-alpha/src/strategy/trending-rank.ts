import type { BinanceTrendingToken } from "../integrations/binance-web3-trending.js";

export interface TrendingRank {
  rank: number;
  percentChange5m: number;
  totalRanked: number;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function buildTrendingRankMap(
  tokens: BinanceTrendingToken[]
): Map<string, TrendingRank> {
  const total = tokens.length;
  const map = new Map<string, TrendingRank>();
  for (const t of tokens) {
    map.set(t.symbol.toUpperCase(), {
      rank: t.rank,
      percentChange5m: t.percentChange5m,
      totalRanked: total,
    });
  }
  return map;
}

/**
 * Score Binance Web3 trending (5m % sorted, Spot/Alpha).
 * Top ranks + strong 5m moves dominate — higher priority than a flat linear curve.
 */
export function scoreTrendingRank(rank: TrendingRank | null | undefined): {
  score: number;
  active: boolean;
  reason: string;
} {
  if (!rank) {
    return { score: 0, active: false, reason: "Not on Binance Web3 trending" };
  }

  const { rank: position, percentChange5m, totalRanked } = rank;

  // Steep rank curve: #1–#5 are high-conviction; mid-list still matters; tail fades.
  let rankScore: number;
  if (position === 1) rankScore = 98;
  else if (position === 2) rankScore = 92;
  else if (position === 3) rankScore = 88;
  else if (position <= 5) rankScore = 82;
  else if (position <= 10) rankScore = 72;
  else if (position <= 20) rankScore = 58;
  else {
    const denom = Math.max(totalRanked - 20, 1);
    const t = Math.min(1, (position - 20) / denom);
    rankScore = Math.round(48 - t * 38); // ~48 → ~10
  }

  // 5m % is the primary “heat” signal — weight it harder than before (*3 → *5.5)
  const changeScore = clamp(percentChange5m * 5.5, -55, 60);

  // Extra priority when both top-ranked and printing green 5m
  let heatBonus = 0;
  if (position <= 5 && percentChange5m >= 1) heatBonus = 12;
  else if (position <= 10 && percentChange5m >= 2) heatBonus = 8;
  else if (position <= 3 && percentChange5m < 0) heatBonus = -8; // fading leader

  const score = clamp(Math.round(rankScore + changeScore + heatBonus), -100, 100);
  const sign = percentChange5m >= 0 ? "+" : "";

  return {
    score,
    active: true,
    reason: `Binance trending #${position} (5m ${sign}${percentChange5m.toFixed(1)}%)`,
  };
}
