import type { PortfolioHolding } from "../utils/types.js";
import { createPublicClient, erc20Abi, formatUnits, http, type Address } from "viem";
import { bsc } from "viem/chains";
import { isEligibleToken, isStablecoin } from "../config.js";
import { BSC_TOKEN_ADDRESSES } from "./bsc-token-addresses.js";
import { logger } from "../utils/logger.js";

const NATIVE_GAS = new Set(["BNB"]);
const BATCH_SIZE = 4;

function rpcUrl(): string {
  return (
    process.env.BSC_RPC_URL?.trim() ||
    process.env.RPC_URL?.trim() ||
    "https://bsc-dataseed.binance.org"
  );
}

async function getErc20Balance(
  walletAddress: string,
  tokenAddress: string,
  symbol: string
): Promise<PortfolioHolding | null> {
  const client = createPublicClient({ chain: bsc, transport: http(rpcUrl()) });
  try {
    const [bal, decimals] = await Promise.all([
      client.readContract({
        address: tokenAddress as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress as Address],
      }),
      client.readContract({
        address: tokenAddress as Address,
        abi: erc20Abi,
        functionName: "decimals",
      }).catch(() => 18),
    ]);
    const amount = Number(formatUnits(bal, Number(decimals)));
    if (!(amount > 0)) return null;
    return { symbol: symbol.toUpperCase(), amount };
  } catch {
    return null;
  }
}

/**
 * Probe known BEP-20 contracts for non-zero balances via BSC RPC.
 * Prefer queryBalance (bridge) when provided.
 */
export async function scanKnownBscTokenBalances(
  walletAddress: string,
  queryBalance?: (symbol: string) => Promise<PortfolioHolding | null>
): Promise<PortfolioHolding[]> {
  const symbols = Object.keys(BSC_TOKEN_ADDRESSES).filter((sym) => {
    const upper = sym.toUpperCase();
    return isEligibleToken(upper) && !isStablecoin(upper) && !NATIVE_GAS.has(upper);
  });

  const holdings: PortfolioHolding[] = [];

  const fetchBalance = async (sym: string): Promise<PortfolioHolding | null> => {
    if (queryBalance) {
      try {
        return await queryBalance(sym);
      } catch {
        return null;
      }
    }
    const tokenAddress = BSC_TOKEN_ADDRESSES[sym];
    if (!tokenAddress) return null;
    return getErc20Balance(walletAddress, tokenAddress, sym);
  };

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(fetchBalance));
    for (const h of results) {
      if (h && h.amount > 0) holdings.push(h);
    }
  }

  if (holdings.length > 0) {
    logger.info("Known-token wallet scan complete", {
      found: holdings.length,
      symbols: holdings.map((h) => h.symbol),
    });
  }

  return holdings;
}

/** Alias kept for callers that previously used a CLI subprocess. */
export async function scanWalletViaCliSubprocess(
  walletAddress: string
): Promise<PortfolioHolding[]> {
  return scanKnownBscTokenBalances(walletAddress);
}

/** @deprecated BSCScan tokenlist API was shut down — returns empty. */
export async function fetchBscTokenBalances(
  _address: string
): Promise<PortfolioHolding[]> {
  return [];
}
