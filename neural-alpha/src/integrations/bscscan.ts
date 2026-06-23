import type { PortfolioHolding } from "../utils/types.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEligibleToken, isStablecoin } from "../config.js";
import { BSC_TOKEN_ADDRESSES } from "./bsc-token-addresses.js";
import { getTokenBalanceViaCli } from "./twak-cli-balance.js";
import { logger } from "../utils/logger.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCAN_SCRIPT = join(PKG_ROOT, "scripts/cli-wallet-scan.ts");

function runCliScanSubprocess(walletAddress: string): Promise<string> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
    return Promise.reject(new Error("Invalid wallet address format"));
  }
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", SCAN_SCRIPT, walletAddress], {
      cwd: PKG_ROOT,
      shell: false,
      windowsHide: true,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `CLI scan exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

const NATIVE_GAS = new Set(["BNB"]);
const BATCH_SIZE = 4;

/**
 * Probe known BEP-20 contracts for non-zero balances.
 * Prefer queryBalance (TWAK MCP bridge — CLI inside) when provided;
 * falls back to direct TWAK CLI when run out-of-process (scripts/tests).
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
    try {
      const bal = await getTokenBalanceViaCli("bsc", walletAddress, tokenAddress, sym);
      if (!bal || !(bal.amount > 0)) return null;
      return {
        symbol: bal.symbol,
        amount: bal.amount,
        ...(bal.valueUsd && bal.valueUsd > 0 ? { valueUsd: bal.valueUsd } : {}),
      };
    } catch {
      return null;
    }
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

/**
 * Run the CLI wallet scan in a child process so TWAK MCP wallet lock
 * doesn't block balance reads while `twak serve` is active in the agent.
 */
export async function scanWalletViaCliSubprocess(
  walletAddress: string
): Promise<PortfolioHolding[]> {
  if (!existsSync(SCAN_SCRIPT)) {
    logger.warn("CLI wallet scan script missing", { path: SCAN_SCRIPT });
    return scanKnownBscTokenBalances(walletAddress);
  }

  try {
    const stdout = await runCliScanSubprocess(walletAddress);
    if (!stdout.trim()) {
      logger.warn("CLI wallet scan returned empty stdout");
      return [];
    }
    const jsonLine = stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .reverse()
      .find((line) => line.startsWith("[{") || line === "[]");
    const parsed = JSON.parse(jsonLine ?? "[]") as PortfolioHolding[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    logger.warn("CLI subprocess wallet scan failed", { error: String(err) });
    return [];
  }
}

/** @deprecated BSCScan tokenlist API was shut down — returns empty. */
export async function fetchBscTokenBalances(
  _address: string
): Promise<PortfolioHolding[]> {
  return [];
}
