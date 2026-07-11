export type ProcessPhase =
  | "stopped"
  | "starting"
  | "running"
  | "unhealthy"
  | "failed";

export interface AgentRuntime {
  agentId: string;
  ownerWallet: string;
  status: ProcessPhase;
  port: number | null;
  pid: number | null;
  pm2Name: string;
  healthOk: boolean;
  tradingRunning?: boolean;
  lastSeenAt: string;
  configVersion: number;
  via?: string;
}

const registry = new Map<string, AgentRuntime>();

export function getRuntime(agentId: string): AgentRuntime | null {
  return registry.get(agentId) ?? null;
}

export function setRuntime(rt: AgentRuntime): void {
  registry.set(rt.agentId, rt);
}

export function deleteRuntime(agentId: string): void {
  registry.delete(agentId);
}

export function listRuntimes(): AgentRuntime[] {
  return Array.from(registry.values());
}

export function resolveRuntimeUrl(
  agentId: string,
  dbUrl: string | null,
  dbPort: number | null
): string | null {
  const rt = registry.get(agentId);
  if (rt?.port) return `http://127.0.0.1:${rt.port}`;
  if (dbPort) return `http://127.0.0.1:${dbPort}`;
  return dbUrl;
}
