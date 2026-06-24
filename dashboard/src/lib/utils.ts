import { clsx, type ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export function formatUsd(value: number, decimals = 2): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/** Token quantity in trade history (not USD). */
export function formatTokenQty(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 1000 ? 2 : 4,
  }).format(value);
}

/** Decimal places for a token USD price based on magnitude. */
export function priceDecimalPlaces(value: number): number {
  if (value <= 0) return 4;
  if (value >= 1000) return 2;
  if (value >= 1) return 2;
  if (value >= 0.01) return 4;
  if (value >= 0.0001) return 6;
  if (value >= 0.000001) return 8;
  return 10;
}

/** Per-token USD price — scales decimals for sub-penny assets. */
export function formatTokenPrice(value: number): string {
  if (value <= 0) return formatUsd(0, 4);
  return formatUsd(value, priceDecimalPlaces(value));
}

export function roundTokenPrice(value: number): number {
  if (value <= 0) return 0;
  return roundNum(value, priceDecimalPlaces(value));
}

/** Reject Binance on-chain quotes that disagree wildly with a reference (e.g. CMC). */
export function isPlausibleLivePrice(
  referencePrice: number | undefined,
  livePrice: number
): boolean {
  if (!Number.isFinite(livePrice) || livePrice <= 0) return false;
  if (referencePrice === undefined || referencePrice <= 0) return true;
  const ratio = livePrice / referencePrice;
  return ratio >= 0.02 && ratio <= 50;
}

/** Per-token price — extra decimals for sub-dollar assets. */
export function formatTradePrice(value: number): string {
  return formatTokenPrice(value);
}

export function roundNum(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Display a metric value with sane precision (no float noise). */
export function formatMetric(value: number, decimals = 1): string {
  return roundNum(value, decimals).toFixed(decimals);
}

export function formatPct(value: number, decimals = 2): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${roundNum(value, decimals).toFixed(decimals)}%`;
}

/** Absolute Binance token logo URL (bnbstatic CDN). */
export function normalizeTokenIconUrl(icon?: string | null): string | undefined {
  if (!icon) return undefined;
  const trimmed = icon.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    if (trimmed.includes("web3.binance.com/images/")) {
      return trimmed.replace(/^https?:\/\/web3\.binance\.com/, "https://bin.bnbstatic.com");
    }
    return trimmed;
  }
  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `https://bin.bnbstatic.com${path}`;
}

export function formatRatio(current: number, max: number, unit = "", decimals = 1): string {
  return `${formatMetric(current, decimals)}${unit} / ${max}${unit}`;
}

export function formatNumber(value: number, decimals = 2): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(decimals);
}

export function shortenHash(hash: string): string {
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
}

export function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
