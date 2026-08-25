/**
 * Out-of-process wallet scan (legacy). Prefer Agentic Wallet `wallet balance`.
 * Usage: npx tsx scripts/cli-wallet-scan.ts <walletAddress>
 */
import { scanKnownBscTokenBalances } from "../src/integrations/bscscan.js";

const walletAddress = process.argv[2];
if (!walletAddress) {
  console.error("wallet address required");
  process.exit(1);
}

const holdings = await scanKnownBscTokenBalances(walletAddress);
process.stdout.write(JSON.stringify(holdings));
