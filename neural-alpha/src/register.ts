import "dotenv/config";
import { logger } from "./utils/logger.js";
import { COMPETITION_CONTRACT, BSC_CHAIN } from "./config.js";

/**
 * Neural Alpha — Competition Registration
 *
 * Registers the agent wallet on the BNB Hack competition contract.
 * This MUST be done before June 22 (the live trading window).
 *
 * Two methods:
 * 1. MCP: competition_register tool (recommended)
 * 2. CLI: twak compete register
 *
 * This script demonstrates the MCP registration flow.
 * In practice, the AI orchestrator calls the MCP tool directly.
 */

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║   Neural Alpha — Competition Registration                ║
║   Contract: ${COMPETITION_CONTRACT}   ║
╚══════════════════════════════════════════════════════════╝
`);

  logger.info("Registration helper started");
  logger.info("To register via MCP, use the competition_register tool");
  logger.info("To register via CLI, run: twak compete register");
  logger.info("To check status via MCP, use the competition_status tool");

  console.log(`
Registration Steps:
1. Ensure your TWAK wallet has BNB for gas on BSC
2. Run one of:
   - MCP tool: competition_register (no arguments needed)
   - CLI: twak compete register
3. Verify with: competition_status MCP tool
4. Also register on DoraHacks with your agent wallet address

Competition Contract (BSC): ${COMPETITION_CONTRACT}
Explorer: https://bsctrace.com/address/${COMPETITION_CONTRACT}

IMPORTANT: Registration must be completed BEFORE June 22, 2026!
  `);
}

main().catch((err) => {
  logger.error("Registration error", { error: String(err) });
  process.exit(1);
});
