import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../utils/logger.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const STATE_FILE = join(PKG_ROOT, "data/campaign-state.json");

/** Official campaign window (UTC). */
export const CAMPAIGN_START_UTC = Date.parse("2026-08-17T09:00:00Z");
export const CAMPAIGN_END_UTC = Date.parse("2026-09-01T00:00:00Z");

export const CAMPAIGN_PAGE_URL =
  "https://web3.binance.com/en/dev-docs/products/agentic-wallet/use-cases/campaigns/bstock-pnl-contest";

export const CAMPAIGN_ELIGIBLE_LIST_URL =
  "https://web3.binance.com/en/dev-docs/products/agentic-wallet/use-cases/campaigns/bstock-eligible-tokens";

export const CAMPAIGN_JOIN_URL =
  process.env.CAMPAIGN_JOIN_URL?.trim() ||
  "https://web3.binance.com/en/campaigns/bstock-pnl-contest";

export const CMC_X402_MCP_URL = "https://mcp.coinmarketcap.com/x402/mcp";
export const AGENT_STUDIO_BASE = "https://stock-agent.bnbchain.org";

/** Only these CMC MCP tools count toward the campaign AI-call requirement. */
export const CMC_CAMPAIGN_TOOLS = [
  "execute_skill",
  "get_crypto_metrics",
  "get_global_metrics_latest",
  "get_upcoming_macro_events",
] as const;

export const MIN_CMC_CALLS = parseInt(process.env.CAMPAIGN_MIN_CMC_CALLS || "3", 10) || 3;
export const MIN_STUDIO_CALLS =
  parseInt(process.env.CAMPAIGN_MIN_STUDIO_CALLS || "3", 10) || 3;

export interface CampaignCallRecord {
  at: number;
  tool?: string;
  symbols?: string[];
  jobId?: string;
  jobToken?: string;
  settled: boolean;
}

export interface CampaignState {
  registered: boolean;
  registeredAt?: number;
  walletAddress?: string;
  cmcCalls: CampaignCallRecord[];
  studioCalls: CampaignCallRecord[];
  lastStudioJob?: { jobId: string; jobToken: string; at: number; symbols: string[] };
}

function emptyState(): CampaignState {
  return { registered: false, cmcCalls: [], studioCalls: [] };
}

export function isCampaignActive(now = Date.now()): boolean {
  return now >= CAMPAIGN_START_UTC && now < CAMPAIGN_END_UTC;
}

export function loadCampaignState(): CampaignState {
  if (!existsSync(STATE_FILE)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as CampaignState;
    return {
      registered: Boolean(raw.registered || process.env.CAMPAIGN_REGISTERED === "true"),
      registeredAt: raw.registeredAt,
      walletAddress: raw.walletAddress,
      cmcCalls: Array.isArray(raw.cmcCalls) ? raw.cmcCalls : [],
      studioCalls: Array.isArray(raw.studioCalls) ? raw.studioCalls : [],
      lastStudioJob: raw.lastStudioJob,
    };
  } catch (err) {
    logger.warn("Could not read campaign-state.json", { error: String(err) });
    return emptyState();
  }
}

export function saveCampaignState(state: CampaignState) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function markCampaignRegistered(walletAddress?: string): CampaignState {
  const state = loadCampaignState();
  state.registered = true;
  state.registeredAt = Date.now();
  if (walletAddress) state.walletAddress = walletAddress;
  saveCampaignState(state);
  return state;
}

export function recordCmcCall(call: CampaignCallRecord): CampaignState {
  const state = loadCampaignState();
  state.cmcCalls.push(call);
  saveCampaignState(state);
  return state;
}

export function recordStudioCall(call: CampaignCallRecord): CampaignState {
  const state = loadCampaignState();
  state.studioCalls.push(call);
  if (call.jobId && call.jobToken) {
    state.lastStudioJob = {
      jobId: call.jobId,
      jobToken: call.jobToken,
      at: call.at,
      symbols: call.symbols ?? [],
    };
  }
  saveCampaignState(state);
  return state;
}

export function campaignQualification(state = loadCampaignState()) {
  const cmcOk = state.cmcCalls.filter((c) => c.settled).length;
  const studioOk = state.studioCalls.filter((c) => c.settled).length;
  return {
    registered: state.registered || process.env.CAMPAIGN_REGISTERED === "true",
    registrationOpen: isCampaignActive(),
    cmcCalls: cmcOk,
    studioCalls: studioOk,
    minCmcCalls: MIN_CMC_CALLS,
    minStudioCalls: MIN_STUDIO_CALLS,
    cmcComplete: cmcOk >= MIN_CMC_CALLS,
    studioComplete: studioOk >= MIN_STUDIO_CALLS,
    active: isCampaignActive(),
    joinUrl: CAMPAIGN_JOIN_URL,
    docsUrl: CAMPAIGN_PAGE_URL,
    eligibleListUrl: CAMPAIGN_ELIGIBLE_LIST_URL,
    endsAt: CAMPAIGN_END_UTC,
    lastStudioJob: state.lastStudioJob,
  };
}
