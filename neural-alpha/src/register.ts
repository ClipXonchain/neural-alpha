import "dotenv/config";
import { logger } from "./utils/logger.js";
import {
  CAMPAIGN_JOIN_URL,
  CAMPAIGN_PAGE_URL,
  CAMPAIGN_END_UTC,
  campaignQualification,
  isCampaignActive,
  markCampaignRegistered,
} from "./integrations/campaign.js";
import { bawWalletStatus } from "./integrations/baw-cli.js";
import { createAgenticWalletBridge } from "./integrations/agentic-wallet-bridge.js";

/**
 * bStock PnL contest registration helper.
 *
 * Official registration is "Join Now" on the campaign page, binding this
 * Agentic Wallet. Trades before registration do not count; the wallet cannot
 * be changed once confirmed.
 */
async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║   Neural Alpha — bStock PnL Contest Registration         ║
╚══════════════════════════════════════════════════════════╝
`);

  let status = "UNCONNECTED";
  let address: string | null = null;
  try {
    status = await bawWalletStatus();
    const bridge = await createAgenticWalletBridge();
    const addr = await bridge.getAddress("bsc");
    address = addr?.address ?? null;
  } catch (err) {
    logger.warn("Could not read Agentic Wallet", { error: String(err) });
  }

  const q = campaignQualification();
  if (process.env.CAMPAIGN_REGISTERED === "true") {
    markCampaignRegistered(address ?? undefined);
  }

  console.log(`
Campaign window: 2026-08-17 09:00 UTC → 2026-09-01 00:00 UTC
Active now:      ${isCampaignActive() ? "yes" : "no"}
Ends:            ${new Date(CAMPAIGN_END_UTC).toISOString()}

Agentic Wallet:  ${status}
BSC address:     ${address ?? "(sign in with baw auth signin)"}
Local registered flag: ${q.registered}
CMC x402 calls:  ${q.cmcCalls}/${q.minCmcCalls}
Studio x402:     ${q.studioCalls}/${q.minStudioCalls}

Registration (required before any scored trade):
  1. Create / sign in to a Binance Agentic Wallet
       npx --yes @binance/agentic-wallet auth signin
  2. Open the campaign page and tap Join Now, binding THIS wallet:
       ${CAMPAIGN_JOIN_URL}
  3. Docs:
       ${CAMPAIGN_PAGE_URL}

Then set CAMPAIGN_REGISTERED=true in .env so the agent records the bind.

Hard requirements at campaign end:
  • ≥ ${q.minCmcCalls} paid CMC MCP x402 calls (designated tools only)
  • ≥ ${q.minStudioCalls} paid Agent Studio x402 analysis calls
  • Realized PnL ≥ 0 on eligible bStocks, FIFO, payment token BNB/USDT/USDC/U/USD1
  • Keep BNB for gas (AI calls are gasless; swaps are not)
`);
}

main().catch((err) => {
  logger.error("Registration error", { error: String(err) });
  process.exit(1);
});
