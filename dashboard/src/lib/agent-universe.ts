/** Agent trading universe: chosen at deploy time. */

export type AgentUniverse = "spot" | "alpha" | "both" | "bstocks";

export interface AgentUniverseOption {
  id: AgentUniverse;
  label: string;
  tagline: string;
  detail: string;
}

export const AGENT_UNIVERSE_OPTIONS: AgentUniverseOption[] = [
  {
    id: "spot",
    label: "Spot Agent",
    tagline: "Binance Spot only",
    detail: "Trades BSC-routable Binance Spot listings: majors & mid-caps on Spot.",
  },
  {
    id: "alpha",
    label: "Alpha Agent",
    tagline: "Binance Alpha only",
    detail: "Trades Binance Alpha (BSC) tokens only: newer listings & alpha movers.",
  },
  {
    id: "both",
    label: "Default Agent",
    tagline: "Spot ∪ Alpha",
    detail: "Full safe universe: Binance Spot and Alpha tokens together.",
  },
  {
    id: "bstocks",
    label: "bStocks Agent",
    tagline: "On-chain equities",
    detail:
      "Trades bStocks only (TSLAB, NVDAB, GOOGLB, …) with an equity-trend strategy.",
  },
];

export const DEFAULT_AGENT_UNIVERSE: AgentUniverse = "both";

export function isAgentUniverse(value: unknown): value is AgentUniverse {
  return (
    value === "spot" ||
    value === "alpha" ||
    value === "both" ||
    value === "bstocks"
  );
}

export function resolveAgentUniverse(raw?: string | null): AgentUniverse {
  const v = (raw || "").trim().toLowerCase();
  if (isAgentUniverse(v)) return v;
  return DEFAULT_AGENT_UNIVERSE;
}

export function agentUniverseLabel(universe: AgentUniverse): string {
  return (
    AGENT_UNIVERSE_OPTIONS.find((o) => o.id === universe)?.label ??
    "Default Agent"
  );
}
