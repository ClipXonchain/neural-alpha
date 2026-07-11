import "server-only";
import { getServerEnv } from "./server-env";

export interface SupervisorRuntime {
  agentId: string;
  ownerWallet: string;
  status: string;
  port: number | null;
  pid: number | null;
  pm2Name: string;
  healthOk: boolean;
  tradingRunning?: boolean;
  lastSeenAt: string;
  configVersion: number;
  via?: string;
}

export interface SupervisorStartResult {
  ok: boolean;
  error?: string;
  runtime?: SupervisorRuntime;
}

function supervisorBase(): string {
  return (
    getServerEnv("SUPERVISOR_URL") || "http://127.0.0.1:4200"
  ).replace(/\/$/, "");
}

function supervisorHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const secret = getServerEnv("SUPERVISOR_SECRET");
  if (secret) {
    headers.Authorization = `Bearer ${secret}`;
  }
  return headers;
}

async function supervisorFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const url = `${supervisorBase()}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      ...supervisorHeaders(),
      ...(init?.headers || {}),
    },
    signal: init?.signal ?? AbortSignal.timeout(60_000),
  });
}

/** True when supervisor HTTP API is reachable. */
export async function isSupervisorUp(): Promise<boolean> {
  try {
    const res = await fetch(`${supervisorBase()}/health`, {
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function supervisorStartAgent(
  agentId: string,
  envOverride?: Record<string, string>
): Promise<SupervisorStartResult> {
  const res = await supervisorFetch(`/v1/agents/${agentId}/start`, {
    method: "POST",
    body: JSON.stringify(envOverride ? { envOverride } : {}),
    signal: AbortSignal.timeout(90_000),
  });
  const data = (await res.json().catch(() => ({}))) as SupervisorStartResult;
  if (!res.ok) {
    return {
      ok: false,
      error: data.error || `Supervisor start failed (HTTP ${res.status})`,
    };
  }
  return data;
}

export async function supervisorStopAgent(
  agentId: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await supervisorFetch(`/v1/agents/${agentId}/stop`, {
    method: "POST",
    body: "{}",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      ok: false,
      error: data.error || `Supervisor stop failed (HTTP ${res.status})`,
    };
  }
  return { ok: true };
}

export async function supervisorGetRuntime(
  agentId: string
): Promise<SupervisorRuntime | null> {
  try {
    const res = await supervisorFetch(`/v1/agents/${agentId}/runtime`, {
      method: "GET",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as SupervisorRuntime;
  } catch {
    return null;
  }
}

export async function supervisorReconcile(): Promise<{
  checked: number;
  respawned: number;
  healthy: number;
} | null> {
  try {
    const res = await supervisorFetch(`/v1/reconcile`, {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as {
      checked: number;
      respawned: number;
      healthy: number;
    };
  } catch {
    return null;
  }
}

/**
 * Resolve live runtime URL from supervisor registry, falling back to DB URL.
 */
export async function supervisorResolveUrl(
  agentId: string,
  fallbackUrl: string | null
): Promise<string | null> {
  const rt = await supervisorGetRuntime(agentId);
  if (rt?.port) return `http://127.0.0.1:${rt.port}`;
  return fallbackUrl;
}
