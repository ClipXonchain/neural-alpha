/**
 * Binance Alpha Ondo tokenized securities (stocks/ETFs), e.g. TSLAon, VRTon, IVVon.
 * Detected by name "(Ondo)" and by the `*ON` ticker pattern (with crypto exceptions).
 */

/** Crypto tokens that end in "ON" but are NOT Ondo tokenized stocks/ETFs. */
const TOKENIZED_STOCK_SYMBOL_EXCEPTIONS = new Set([
  "ON", // Orochi Network
  "SOON",
  "ELON",
  "TYCOON",
  "COMMON",
  "RION",
  "AGON",
  "TON",
  "TRON",
  "ICON",
]);

export function isTokenizedStockOrEtf(
  symbol: string,
  name?: string | null
): boolean {
  const n = (name || "").toLowerCase();
  if (
    n.includes("(ondo)") ||
    n.includes("tokenized stock") ||
    n.includes("tokenized etf") ||
    n.includes("tokenized security")
  ) {
    return true;
  }

  const upper = symbol.toUpperCase();
  if (TOKENIZED_STOCK_SYMBOL_EXCEPTIONS.has(upper)) return false;
  // Ondo tickers are underlying + "on" (TSLAON, VRTON, KOON, …)
  if (upper.length >= 4 && upper.endsWith("ON")) return true;
  return false;
}
