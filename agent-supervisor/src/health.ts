export interface AgentHealth {
  ok: boolean;
  running?: boolean;
  initialized?: boolean;
  uptime?: number;
  error?: string;
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

export async function waitForAgentHealth(
  runtimeUrl: string,
  timeoutMs = 35_000
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

export async function probeMarketFeed(feedUrl: string): Promise<boolean> {
  const base = feedUrl.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean };
    return data.ok !== false;
  } catch {
    return false;
  }
}
