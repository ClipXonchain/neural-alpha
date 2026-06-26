import { BSC_USDT_ADDRESS, isEligibleToken } from "../config.js";
import { getKnownBscTokenAddress } from "./bsc-token-addresses.js";

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/i;

/** Scam airdrops often report absurd 24h % via fake liquidity pools. */
const MAX_24H_CHANGE_PCT = 500;

const KNOWN_STABLE_CONTRACTS: Record<string, string> = {
  USDT: BSC_USDT_ADDRESS,
  USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  BUSD: "0xe9e7CEA3DedcA5984780B199269ADba9dD8aFcb2",
  DAI: "0x1AF3F329e8Dc152f6ad61aF67c2633425CBB9A27",
  FDUSD: "0xc5f0f6b861618251967158556e0a3a2942db9c5",
};

export interface WalletPositionLike {
  symbol: string;
  contractAddress: string;
  percentChange24h: number;
}

function normContract(addr: string): string {
  return addr.trim().toLowerCase();
}

function contractsMatch(a: string, b: string): boolean {
  return normContract(a) === normContract(b);
}

/**
 * Drop BSC dust/scam tokens that reuse legitimate tickers but use a different
 * contract (e.g. fake MYX airdrops priced by manipulated pools).
 */
export function isVerifiedWalletPosition(
  pos: Pick<WalletPositionLike, "symbol" | "contractAddress" | "percentChange24h">
): boolean {
  const symbol = pos.symbol.toUpperCase();
  const contract = pos.contractAddress?.trim() ?? "";
  const pct = pos.percentChange24h ?? 0;

  if (!/^[A-Z0-9]{1,12}$/.test(symbol)) return false;
  if (Math.abs(pct) > MAX_24H_CHANGE_PCT) return false;

  // Native gas coin — Binance Web3 may omit contractAddress.
  if (symbol === "BNB") return true;

  const stable = KNOWN_STABLE_CONTRACTS[symbol];
  if (stable) {
    return contract !== "" && contractsMatch(contract, stable);
  }

  const known = getKnownBscTokenAddress(symbol);
  if (known) {
    return contract !== "" && contractsMatch(contract, known);
  }

  // Unknown contract for a mapped ticker — reject (likely name-squatting).
  if (isEligibleToken(symbol)) {
    return contract !== "" && EVM_ADDRESS.test(contract);
  }

  return false;
}

export function filterVerifiedWalletPositions<T extends WalletPositionLike>(
  positions: T[]
): T[] {
  return positions.filter(isVerifiedWalletPosition);
}
