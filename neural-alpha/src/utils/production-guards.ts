/**
 * Fail fast when agent process starts without mandatory secrets / execution keys.
 */
import { logger } from "./logger.js";
import { isBinanceWeb3TradingConfigured } from "../integrations/binance-web3-trading.js";

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Fail fast when agent process starts without mandatory secrets. */
export function assertAgentProductionSecrets(): void {
  if (!isProduction()) {
    // Still warn in non-prod if live bridge is expected
    if (
      (process.env.BRIDGE_MODE || "auto").toLowerCase() !== "mock" &&
      !isBinanceWeb3TradingConfigured()
    ) {
      logger.warn(
        "BINANCE_WEB3_API_KEY/SECRET not set — live swaps will fail until configured"
      );
    }
    return;
  }

  const apiSecret = process.env.API_SECRET?.trim();
  if (!apiSecret || apiSecret.length < 32) {
    throw new Error(
      "API_SECRET (min 32 characters) is required when NODE_ENV=production"
    );
  }

  const walletMaster = process.env.WALLET_MASTER_SECRET?.trim();
  if (!walletMaster || walletMaster.length < 32) {
    throw new Error(
      "WALLET_MASTER_SECRET (min 32 characters) is required when NODE_ENV=production — do not reuse API_SECRET"
    );
  }

  if (walletMaster === apiSecret) {
    throw new Error(
      "WALLET_MASTER_SECRET must differ from API_SECRET in production"
    );
  }

  if (process.env.AGENT_PRIVATE_KEY?.trim()) {
    throw new Error(
      "AGENT_PRIVATE_KEY is forbidden in production — use encrypted keystore (WALLET_MASTER_SECRET)"
    );
  }

  if (
    process.env.DISABLE_DRAWDOWN_LIMIT === "true" ||
    process.env.DISABLE_DRAWDOWN_LIMIT === "1"
  ) {
    throw new Error(
      "DISABLE_DRAWDOWN_LIMIT is forbidden in production — remove it from .env"
    );
  }

  const bridgeMode = (process.env.BRIDGE_MODE || "auto").toLowerCase();
  if (bridgeMode !== "mock" && bridgeMode !== "cmc-pro") {
    if (!isBinanceWeb3TradingConfigured()) {
      throw new Error(
        "BINANCE_WEB3_API_KEY and BINANCE_WEB3_API_SECRET are required for live swaps in production"
      );
    }
  }

  logger.info("Production secret checks passed");
}
