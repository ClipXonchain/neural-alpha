/**
 * Binance Alpha tokens on BSC that are also competition-eligible (the 149).
 * Source: alpha.md (BNB Alpha common tickers). Stablecoins are excluded since
 * they are never trading candidates. Symbols are upper-cased for matching.
 */
export const BINANCE_ALPHA_TOKENS = new Set<string>([
  "0G", "AB", "APR", "ASTER", "B", "BANANAS31", "BARD", "BAS", "BEAT", "BILL",
  "BSB", "CHEEMS", "COAI", "CYS", "EDGE", "FF", "GENIUS", "GUA", "GWEI", "H",
  "HOME", "HUMA", "IP", "IRYS", "KITE", "KOGE", "LAB", "M", "MYX", "NEX",
  "NIGHT", "NXPC", "OPEN", "PEAQ", "PIEVERSE", "Q", "RAVE", "RIVER", "SAHARA",
  "SIREN", "SKYAI", "SLX", "SOON", "TAC", "TAG", "TOSHI", "TRIA", "U", "UAI",
  "UB", "VELO", "XPL", "ZAMA",
]);

export function isAlphaToken(symbol: string): boolean {
  return BINANCE_ALPHA_TOKENS.has(symbol.toUpperCase());
}
