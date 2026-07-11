import { existsSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import {
  getAgent,
  listActiveAgents,
  readAgentPid,
  recordEvent,
  updateAgentRuntime,
} from "./db.js";
import {
  buildSpawnEnv,
  requireWalletMasterSecret,
  syncRuntimeFromDisk,
  writeEnvMirror,
  agentPm2Name,
} from "./env.js";
import { probeAgentHealth, probeMarketFeed, waitForAgentHealth } from "./health.js";
import { neuralAlphaRoot } from "./paths.js";
import {
  isProcessAlive,
  launchAgent,
  terminateAgent,
} from "./process-manager.js";
import {
  deleteRuntime,
  getRuntime,
  listRuntimes,
  resolveRuntimeUrl,
  setRuntime,
  type AgentRuntime,
  type ProcessPhase,
} from "./registry.js";

const MAX_PARALLEL_STARTS = parseInt(
  process.env.SUPERVISOR_MAX_PARALLEL_STARTS || "5",
  10
);

let startSlots = 0;
const startQueue: Array<() => void> = [];

async function withStartSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (startSlots >= MAX_PARALLEL_STARTS) {
    await new Promise<void>((resolve) => startQueue.push(resolve));
  }
  startSlots++;
  try {
    return await fn();
  } finally {
    startSlots--;
    const next = startQueue.shift();
    if (next) next();
  }
}

async function ensureMarketFeed(): Promise<void> {
  const feedUrl = (
    process.env.MARKET_FEED_URL || "http://127.0.0.1:4100"
  ).replace(/\/$/, "");

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await probeMarketFeed(feedUrl)) return;
    await new Promise((r) => setTimeout(r, 1500));
  }

  const root = neuralAlphaRoot();
  if (!existsSync(join(root, "src", "market-feed", "index.ts"))) {
    console.warn("[supervisor] market-feed missing — agents may hit CMC directly");
    return;
  }

  const portMatch = feedUrl.match(/:(\d+)$/);
  const port = portMatch?.[1] || "4100";
  const child = spawn(
    process.execPath,
    ["--import", "./src/load-env.ts", "--import", "tsx", "src/market-feed/index.ts"],
    {
      cwd: root,
      env: {
        ...process.env,
        MARKET_FEED_PORT: port,
        CMC_PRO_API_KEY:
          process.env.CMC_PRO_API_KEY || process.env.CMC_API_KEY || "",
      },
      detached: true,
      stdio: "ignore",
    }
  );
  child.unref();
  console.log(`[supervisor] Started market feed pid=${child.pid} on ${feedUrl}`);
  await new Promise((r) => setTimeout(r, 3000));
}

function publishRuntime(
  agentId: string,
  ownerWallet: string,
  patch: Partial<AgentRuntime> & { status: ProcessPhase }
): AgentRuntime {
  const prev = getRuntime(agentId);
  const rt: AgentRuntime = {
    agentId,
    ownerWallet,
    status: patch.status,
    port: patch.port ?? prev?.port ?? null,
    pid: patch.pid ?? prev?.pid ?? null,
    pm2Name: patch.pm2Name ?? prev?.pm2Name ?? agentPm2Name(agentId),
    healthOk: patch.healthOk ?? false,
    tradingRunning: patch.tradingRunning,
    lastSeenAt: new Date().toISOString(),
    configVersion: patch.configVersion ?? prev?.configVersion ?? 0,
    via: patch.via ?? prev?.via,
  };
  setRuntime(rt);
  return rt;
}

export async function startAgentProcess(
  agentId: string,
  opts?: { envOverride?: Record<string, string> }
): Promise<{ ok: boolean; error?: string; runtime?: AgentRuntime }> {
  return withStartSlot(async () => {
    const agent = await getAgent(agentId);
    if (!agent) return { ok: false, error: "Agent not found" };
    if (agent.status === "archived") {
      return { ok: false, error: "Agent is archived" };
    }

    const existingUrl = resolveRuntimeUrl(
      agentId,
      agent.runtime_url,
      agent.runtime_port
    );
    if (existingUrl) {
      const health = await probeAgentHealth(existingUrl);
      if (health.ok) {
        const rt = publishRuntime(agentId, agent.owner_wallet, {
          status: "running",
          port: agent.runtime_port,
          healthOk: true,
          tradingRunning: health.running,
          configVersion: agent.config_version ?? 0,
        });
        await updateAgentRuntime(agentId, {
          status: "running",
          process_phase: "running",
          last_health_at: new Date(),
        });
        return { ok: true, runtime: rt };
      }
    }

    const port = agent.runtime_port;
    if (!port) {
      return { ok: false, error: "Agent has no runtime port — redeploy required" };
    }

    publishRuntime(agentId, agent.owner_wallet, {
      status: "starting",
      port,
      healthOk: false,
      configVersion: agent.config_version ?? 0,
    });
    await updateAgentRuntime(agentId, {
      process_phase: "starting",
      pm2_name: agentPm2Name(agentId),
    });

    await ensureMarketFeed();

    let spawnEnv: Record<string, string>;
    try {
      spawnEnv = opts?.envOverride ?? (await buildSpawnEnv(agentId));
      writeEnvMirror(agentId, spawnEnv);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateAgentRuntime(agentId, {
        status: "failed",
        process_phase: "failed",
      });
      await recordEvent(agentId, "start_fail", { error: msg });
      return { ok: false, error: msg };
    }

    const masterSecret = requireWalletMasterSecret();
    let root: string;
    try {
      root = neuralAlphaRoot();
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const launched = await launchAgent({
      agentId,
      neuralAlphaRoot: root,
      env: {
        ...process.env,
        ...spawnEnv,
        WALLET_MASTER_SECRET: masterSecret,
      },
    });

    if (!launched.ok) {
      console.warn(
        `[supervisor] launch failed ${agentId.slice(0, 8)} via ${launched.via}: ${launched.error}`
      );
      publishRuntime(agentId, agent.owner_wallet, {
        status: "failed",
        port,
        healthOk: false,
        via: launched.via,
      });
      await updateAgentRuntime(agentId, {
        status: "failed",
        process_phase: "failed",
      });
      await recordEvent(agentId, "start_fail", {
        via: launched.via,
        error: launched.error,
      });
      return {
        ok: false,
        error: launched.error || "Agent process failed to launch",
      };
    }

    console.log(
      `[supervisor] Agent ${agentId.slice(0, 8)} started via ${launched.via}` +
        (launched.pid ? ` pid=${launched.pid}` : "")
    );

    await syncRuntimeFromDisk(agentId);
    const expectedUrl = `http://127.0.0.1:${port}`;
    const diskPort = await syncRuntimeFromDisk(agentId);
    const runtimeUrl = diskPort
      ? `http://127.0.0.1:${diskPort}`
      : expectedUrl;

    const health = await waitForAgentHealth(runtimeUrl, 35_000);
    if (!health.ok) {
      console.warn(
        `[supervisor] health check failed ${agentId.slice(0, 8)}: ${health.error}`
      );
      publishRuntime(agentId, agent.owner_wallet, {
        status: "unhealthy",
        port: diskPort ?? port,
        pid: launched.pid ?? null,
        healthOk: false,
        via: launched.via,
      });
      await updateAgentRuntime(agentId, {
        status: "failed",
        process_phase: "unhealthy",
      });
      await recordEvent(agentId, "health_fail", { error: health.error });
      return {
        ok: false,
        error: health.error || "Health check timed out",
      };
    }

    const finalPort = (await syncRuntimeFromDisk(agentId)) ?? port;
    const rt = publishRuntime(agentId, agent.owner_wallet, {
      status: "running",
      port: finalPort,
      pid: launched.pid ?? null,
      healthOk: true,
      tradingRunning: health.running,
      via: launched.via,
      configVersion: agent.config_version ?? 0,
    });
    await updateAgentRuntime(agentId, {
      status: "running",
      process_phase: "running",
      runtime_port: finalPort,
      runtime_url: `http://127.0.0.1:${finalPort}`,
      pm2_name: agentPm2Name(agentId),
      last_health_at: new Date(),
    });
    await recordEvent(agentId, "start", {
      via: launched.via,
      port: finalPort,
      pid: launched.pid,
    });
    return { ok: true, runtime: rt };
  });
}

export async function stopAgentProcess(
  agentId: string
): Promise<{ ok: boolean }> {
  const agent = await getAgent(agentId);
  const pid = getRuntime(agentId)?.pid ?? readAgentPid(agentId);
  await terminateAgent(agentId, pid);
  deleteRuntime(agentId);
  await updateAgentRuntime(agentId, {
    status: "stopped",
    process_phase: "stopped",
  });
  await recordEvent(agentId, "stop", {
    previous: agent?.status,
  });
  return { ok: true };
}

export async function getAgentRuntimeStatus(
  agentId: string
): Promise<AgentRuntime | null> {
  const agent = await getAgent(agentId);
  if (!agent) return null;

  const cached = getRuntime(agentId);
  const url = resolveRuntimeUrl(
    agentId,
    agent.runtime_url,
    agent.runtime_port
  );
  const health = url ? await probeAgentHealth(url) : { ok: false as const };
  const pid = cached?.pid ?? readAgentPid(agentId);
  const pidAlive = pid ? isProcessAlive(pid) : false;

  const status: ProcessPhase = health.ok
    ? "running"
    : pidAlive
      ? "unhealthy"
      : agent.status === "running"
        ? "unhealthy"
        : "stopped";

  const rt = publishRuntime(agentId, agent.owner_wallet, {
    status,
    port: agent.runtime_port,
    pid: pidAlive ? pid : null,
    healthOk: health.ok,
    tradingRunning: health.ok ? health.running : undefined,
    configVersion: agent.config_version ?? 0,
  });

  if (health.ok) {
    await updateAgentRuntime(agentId, {
      last_health_at: new Date(),
      process_phase: "running",
    });
  }

  return rt;
}

export async function reconcileFleet(): Promise<{
  checked: number;
  respawned: number;
  healthy: number;
}> {
  const agents = await listActiveAgents();
  let respawned = 0;
  let healthy = 0;

  for (const agent of agents) {
    await syncRuntimeFromDisk(agent.id);
    const refreshed = (await getAgent(agent.id))!;
    const url = resolveRuntimeUrl(
      agent.id,
      refreshed.runtime_url,
      refreshed.runtime_port
    );
    const health = url ? await probeAgentHealth(url) : { ok: false };

    if (health.ok) {
      healthy++;
      publishRuntime(agent.id, agent.owner_wallet, {
        status: "running",
        port: refreshed.runtime_port,
        healthOk: true,
        tradingRunning: health.running,
        configVersion: refreshed.config_version ?? 0,
      });
      if (refreshed.status !== "running") {
        await updateAgentRuntime(agent.id, {
          status: "running",
          process_phase: "running",
          last_health_at: new Date(),
        });
      } else {
        await updateAgentRuntime(agent.id, {
          process_phase: "running",
          last_health_at: new Date(),
        });
      }
      continue;
    }

    if (
      refreshed.status === "running" ||
      refreshed.status === "provisioning"
    ) {
      if (!refreshed.runtime_port) {
        await updateAgentRuntime(agent.id, {
          status: "stopped",
          process_phase: "stopped",
        });
        deleteRuntime(agent.id);
        continue;
      }

      console.log(
        `[supervisor] Respawning ${agent.id.slice(0, 8)}… (was ${refreshed.status})`
      );
      const result = await startAgentProcess(agent.id);
      if (result.ok) respawned++;
    }
  }

  return { checked: agents.length, respawned, healthy };
}

export function fleetSummary() {
  return {
    runtimes: listRuntimes(),
    startSlotsInUse: startSlots,
    maxParallelStarts: MAX_PARALLEL_STARTS,
    queueDepth: startQueue.length,
  };
}
