import { logger } from "../utils/logger.js";

/** Operator-curated blocklist — persisted in Neon, merged at runtime with static exclusions. */
const userBlacklisted = new Set<string>();

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

export function getUserBlacklistedTokens(): string[] {
  return [...userBlacklisted].sort();
}

export function isUserBlacklisted(symbol: string): boolean {
  return userBlacklisted.has(normalizeSymbol(symbol));
}

export function blacklistToken(symbol: string): boolean {
  const sym = normalizeSymbol(symbol);
  if (!/^[A-Z0-9]{1,12}$/.test(sym)) return false;
  if (userBlacklisted.has(sym)) return false;
  userBlacklisted.add(sym);
  logger.info("Token added to user blacklist", { symbol: sym });
  return true;
}

export function unblacklistToken(symbol: string): boolean {
  const sym = normalizeSymbol(symbol);
  if (!userBlacklisted.has(sym)) return false;
  userBlacklisted.delete(sym);
  logger.info("Token removed from user blacklist", { symbol: sym });
  return true;
}

export function restoreUserBlacklist(symbols: string[]): void {
  userBlacklisted.clear();
  for (const s of symbols) {
    const sym = normalizeSymbol(s);
    if (/^[A-Z0-9]{1,12}$/.test(sym)) userBlacklisted.add(sym);
  }
}
