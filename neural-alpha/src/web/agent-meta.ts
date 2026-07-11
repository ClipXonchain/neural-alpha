import type { TradingAgent } from "../agent.js";
import { getAgentId } from "../wallet/secrets.js";

/** Public deployment metadata for external discoverability + ERC-8004. */
export interface AgentMeta {
  agentId: string;
  displayName: string | null;
  ownerWallet: string | null;
  tradingWallet: string | null;
  publicBaseUrl: string | null;
  agentApiUrl: string | null;
  mode: string;
  bridgeSource: string | null;
  strategy: string | null;
  erc8004AgentId: string | null;
  agentNumber: number | null;
}

function resolvePublicBaseUrl(): string | null {
  const explicit = process.env.PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const cors = process.env.CORS_ORIGINS?.trim();
  if (cors) {
    const origins = cors.split(",").map((o) => o.trim()).filter(Boolean);
    const publicOrigin = origins.find(
      (o) => !/localhost|127\.0\.0\.1/i.test(o)
    );
    return (publicOrigin ?? origins[0] ?? null)?.replace(/\/$/, "") ?? null;
  }

  return null;
}

function resolveAgentApiUrl(): string | null {
  const port = process.env.DASHBOARD_PORT?.trim() || "3847";
  return `http://127.0.0.1:${port}`;
}

function deriveDisplayName(tradingWallet: string | null): string {
  if (!tradingWallet || tradingWallet.length < 10) return "Autonomous Trading Agent";
  const lower = tradingWallet.toLowerCase();
  return `Trading Agent ${lower.slice(0, 6)}…${lower.slice(-4)}`;
}

export async function buildAgentMeta(agent: TradingAgent): Promise<AgentMeta> {
  const snap = agent.getStateSnapshot();
  let walletAddress: string | null = null;

  try {
    const wallet = await agent.getWalletInfoFast();
    walletAddress = wallet?.address ?? null;
  } catch {
    /* wallet may be unavailable before unlock */
  }

  const configuredName = process.env.AGENT_DISPLAY_NAME?.trim() || null;
  const publicBase = resolvePublicBaseUrl();
  const agentApi = resolveAgentApiUrl();
  const agentId = getAgentId();

  return {
    agentId,
    displayName: configuredName ?? deriveDisplayName(walletAddress),
    ownerWallet: process.env.OWNER_WALLET?.trim()?.toLowerCase() || null,
    tradingWallet: walletAddress,
    publicBaseUrl: publicBase,
    agentApiUrl: agentApi,
    mode: snap.mode,
    bridgeSource: snap.bridgeSource ?? null,
    strategy: snap.config?.strategy ?? null,
    erc8004AgentId: process.env.ERC8004_AGENT_ID?.trim() || null,
    agentNumber: process.env.AGENT_NUMBER
      ? parseInt(process.env.AGENT_NUMBER, 10)
      : null,
  };
}
