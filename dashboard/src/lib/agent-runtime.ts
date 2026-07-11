import "server-only";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { envToControlBody } from "./config-allowlist";
import { getServerEnv } from "./server-env";

export interface AgentHealth {
  ok: boolean;
  running?: boolean;
  initialized?: boolean;
  uptime?: number;
  error?: string;
}

export interface HotReloadResult {
  reloaded: boolean;
  error?: string;
}

export function getAgentDataDir(): string {
  return getServerEnv("AGENT_DATA_DIR") || join(process.cwd(), "..", "data", "agents");
}

export function getAgentDir(agentId: string): string {
  return join(getAgentDataDir(), agentId);
}

export function readAgentPid(agentId: string): number | null {
  const pidFile = join(getAgentDir(agentId), "pid");
  if (!existsSync(pidFile)) return null;
  try {
    const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function readAgentApiPort(agentId: string): number | null {
  const portFile = join(getAgentDir(agentId), "api-port");
  if (!existsSync(portFile)) return null;
  try {
    const port = parseInt(readFileSync(portFile, "utf8").trim(), 10);
    return Number.isFinite(port) && port > 1024 ? port : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function probeAgentHealth(runtimeUrl: string): Promise<AgentHealth> {
  const base = runtimeUrl.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      status?: string;
      running?: boolean;
      initialized?: boolean;
      uptime?: number;
    };
    return {
      ok: data.status === "ok",
      running: data.running,
      initialized: data.initialized ?? true,
      uptime: data.uptime,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export function resolveRuntimeUrl(
  agentId: string,
  dbRuntimeUrl: string | null
): string | null {
  const diskPort = readAgentApiPort(agentId);
  if (diskPort) return `http://127.0.0.1:${diskPort}`;
  return dbRuntimeUrl;
}

export async function hotReloadAgent(
  runtimeUrl: string,
  apiSecret: string,
  envUpdates: Record<string, string>
): Promise<HotReloadResult> {
  const controlBody = envToControlBody(envUpdates);
  if (Object.keys(controlBody).length === 0) {
    return { reloaded: true };
  }

  try {
    const res = await fetch(`${runtimeUrl.replace(/\/$/, "")}/api/control/config`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiSecret}`,
      },
      body: JSON.stringify(controlBody),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        reloaded: false,
        error: (data as { error?: string }).error || `Hot-reload failed (${res.status})`,
      };
    }
    return { reloaded: true };
  } catch (err) {
    return { reloaded: false, error: String(err) };
  }
}

export async function waitForAgentHealth(
  runtimeUrl: string,
  timeoutMs = 30_000
): Promise<AgentHealth> {
  const deadline = Date.now() + timeoutMs;
  let last: AgentHealth = { ok: false, error: "timeout" };
  while (Date.now() < deadline) {
    last = await probeAgentHealth(runtimeUrl);
    if (last.ok) return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}

/** Write config map to per-agent .env (no WALLET_MASTER_SECRET). */
export function writeAgentEnvFile(agentId: string, env: Record<string, string>): void {
  const agentDir = getAgentDir(agentId);
  mkdirSync(agentDir, { recursive: true });
  const lines = Object.entries(env)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${v}`);
  writeFileSync(join(agentDir, ".env"), lines.join("\n") + "\n", { mode: 0o600 });
}
