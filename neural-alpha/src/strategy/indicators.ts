/**
 * Pure technical analysis indicators computed from price arrays.
 * No external dependencies — all math is self-contained.
 */

export function sma(data: number[], period: number): number | null {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

export function ema(data: number[], period: number): number[] {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];

  let prev = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
  result.push(prev);

  for (let i = period; i < data.length; i++) {
    prev = data[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

export function latestEma(data: number[], period: number): number | null {
  const values = ema(data, period);
  return values.length > 0 ? values[values.length - 1] : null;
}

/**
 * RSI (Relative Strength Index) — 0 to 100.
 * Below 30 = oversold (buy signal), above 70 = overbought (sell signal).
 */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }

  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * MACD (Moving Average Convergence Divergence).
 * Returns { macd, signal, histogram } for the latest data point.
 */
export function macd(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): { macd: number; signal: number; histogram: number } | null {
  if (closes.length < slowPeriod + signalPeriod) return null;

  const fastEma = ema(closes, fastPeriod);
  const slowEma = ema(closes, slowPeriod);

  const offset = fastEma.length - slowEma.length;
  const macdLine: number[] = [];
  for (let i = 0; i < slowEma.length; i++) {
    macdLine.push(fastEma[i + offset] - slowEma[i]);
  }

  if (macdLine.length < signalPeriod) return null;

  const signalLine = ema(macdLine, signalPeriod);
  if (signalLine.length === 0) return null;

  const macdVal = macdLine[macdLine.length - 1];
  const signalVal = signalLine[signalLine.length - 1];

  return {
    macd: macdVal,
    signal: signalVal,
    histogram: macdVal - signalVal,
  };
}

/**
 * Bollinger Bands — returns { upper, middle, lower }.
 * Price near lower band = potential buy, near upper = potential sell.
 */
export function bollingerBands(
  closes: number[],
  period = 20,
  stdDevMultiplier = 2
): { upper: number; middle: number; lower: number } | null {
  if (closes.length < period) return null;

  const slice = closes.slice(-period);
  const middle = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - middle) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);

  return {
    upper: middle + stdDevMultiplier * stdDev,
    middle,
    lower: middle - stdDevMultiplier * stdDev,
  };
}

/**
 * ATR (Average True Range) — volatility measure.
 */
export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14
): number | null {
  if (highs.length < period + 1) return null;

  const trueRanges: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) return null;

  let atrVal = trueRanges.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atrVal = (atrVal * (period - 1) + trueRanges[i]) / period;
  }
  return atrVal;
}

/**
 * Volume ratio — current volume vs average volume.
 * Above 1.5 = high volume (confirms trend), below 0.5 = low conviction.
 */
export function volumeRatio(volumes: number[], period = 20): number | null {
  if (volumes.length < period + 1) return null;
  const avg = volumes.slice(-period - 1, -1).reduce((s, v) => s + v, 0) / period;
  if (avg === 0) return null;
  return volumes[volumes.length - 1] / avg;
}

/**
 * Price momentum — rate of change over N periods.
 */
export function momentum(closes: number[], period = 10): number | null {
  if (closes.length < period + 1) return null;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - 1 - period];
  if (past === 0) return null;
  return ((current - past) / past) * 100;
}

/**
 * Stochastic RSI — maps RSI to 0-100 range for more sensitive signals.
 */
export function stochRsi(closes: number[], rsiPeriod = 14, stochPeriod = 14): number | null {
  const rsiValues: number[] = [];
  for (let i = rsiPeriod + 1; i <= closes.length; i++) {
    const val = rsi(closes.slice(0, i), rsiPeriod);
    if (val !== null) rsiValues.push(val);
  }

  if (rsiValues.length < stochPeriod) return null;

  const recent = rsiValues.slice(-stochPeriod);
  const min = Math.min(...recent);
  const max = Math.max(...recent);
  if (max === min) return 50;

  return ((rsiValues[rsiValues.length - 1] - min) / (max - min)) * 100;
}
