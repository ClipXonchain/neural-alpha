/**
 * Confirms the hackathon stack without printing secrets or sending a swap.
 * Usage: npm run hackathon:check
 */
import { bawWalletStatus } from "./integrations/baw-cli.js";
import {
  getGasPrice,
  getRwaTokenPrices,
  listRwaTokens,
  searchRwaToken,
  simulateEvmTransaction,
  web3Credentials,
} from "./integrations/binance-web3-signed.js";

const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";

function line(ok: boolean, label: string, detail = "") {
  const mark = ok ? "ready" : "missing";
  console.log(`${mark.padEnd(8)} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log("Neural Alpha hackathon check");
  console.log("Submissions lock 11 Oct 2026 12:00 UTC\n");

  line(true, "bStocks spot agent on BSC", "code path is in this repo");
  line(true, "Public site", "https://neuralalpha.io");
  line(true, "Public repo", "https://github.com/ClipXonchain/neural-alpha branch hackathon");

  const creds = web3Credentials();
  line(Boolean(creds), "Signed Web3 API key", creds ? "OC_API_KEY is set" : "add OC_API_KEY and OC_SECRET_KEY to .env");

  if (creds) {
    try {
      const listed = await listRwaTokens("bstock", "56");
      const count = Array.isArray(listed)
        ? listed.length
        : listed && typeof listed === "object"
          ? Object.keys(listed).length
          : 0;
      line(true, "RWA token list", `bstock on BSC responded (${count} top-level fields or rows)`);
    } catch (err) {
      line(false, "RWA token list", err instanceof Error ? err.message : String(err));
    }

    try {
      const prices = await getRwaTokenPrices([NVDAB], "56");
      const row = prices[0];
      line(
        Boolean(row),
        "RWA on-chain vs reference",
        row
          ? `on-chain ${row.onChainPrice ?? "n/a"} reference ${row.referencePrice ?? "n/a"} spread ${row.spreadPct ?? "n/a"}%`
          : "empty price row"
      );
    } catch (err) {
      line(false, "RWA on-chain vs reference", err instanceof Error ? err.message : String(err));
    }

    try {
      await searchRwaToken("NVDA", "bstock");
      line(true, "RWA ticker search", "NVDA");
    } catch (err) {
      line(false, "RWA ticker search", err instanceof Error ? err.message : String(err));
    }

    try {
      await getGasPrice("56");
      line(true, "Transaction API gas price", "BSC");
    } catch (err) {
      line(false, "Transaction API gas price", err instanceof Error ? err.message : String(err));
    }

    try {
      await simulateEvmTransaction({
        from: "0xc571161563A6586622b8a701b0dDd31250A5088c",
        to: "0xc571161563A6586622b8a701b0dDd31250A5088c",
        value: "0",
        data: "0x",
      });
      line(true, "Transaction API simulate", "zero-value self call, not broadcast");
    } catch (err) {
      line(false, "Transaction API simulate", err instanceof Error ? err.message : String(err));
    }
  }

  try {
    const status = await bawWalletStatus();
    line(status !== "UNCONNECTED" && !/NOT.?LOG/i.test(status), "Agentic Wallet session", status);
  } catch (err) {
    line(false, "Agentic Wallet session", err instanceof Error ? err.message : String(err));
  }

  line(false, "Hackathon registration form", "https://forms.gle/NEmy3FxYc4f5Dua47");
  line(false, "Project submission form", "https://forms.gle/yToDUzaDMwWnq6R6A");
  line(false, "Developer Experience Report", "write it yourself; generated reports are rejected");
  line(false, "Demo video", "optional, 4 minutes or less");
  console.log("\nThis check never sends a swap.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
