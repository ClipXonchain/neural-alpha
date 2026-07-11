import { execFileSync, spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, openSync, closeSync } from "fs";
import { join } from "path";
import { agentDir, agentPm2Name } from "./paths.js";

export type LaunchVia = "pm2" | "detached";

export interface LaunchResult {
  ok: boolean;
  pid?: number;
  via: LaunchVia;
  error?: string;
}

function preferPm2(): boolean {
  const mode = (process.env.AGENT_PROCESS_MANAGER || "").trim().toLowerCase();
  if (mode === "spawn" || mode === "detached") return false;
  if (mode === "pm2") return true;
  try {
    execFileSync("pm2", ["-v"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function writePid(agentId: string, pid: number): void {
  const dir = agentDir(agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pid"), String(pid), { mode: 0o600 });
}

function readPm2Pid(name: string): number | null {
  try {
    const out = execFileSync("pm2", ["pid", name], {
      encoding: "utf8",
      timeout: 8_000,
    }).trim();
    const pid = parseInt(out, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pm2HasApp(name: string): boolean {
  try {
    const out = execFileSync("pm2", ["jlist"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const list = JSON.parse(out) as Array<{ name?: string }>;
    return list.some((a) => a.name === name);
  } catch {
    return false;
  }
}

const MAX_MEMORY_RESTART = process.env.AGENT_MAX_MEMORY || "256M";

/**
 * Launch an agent outside the supervisor process tree.
 * Prefer PM2 (survives dashboard/supervisor restarts).
 * Fallback: Node native detached spawn (cross-platform — no setsid).
 */
export async function launchAgent(opts: {
  agentId: string;
  neuralAlphaRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<LaunchResult> {
  const { agentId, neuralAlphaRoot, env } = opts;
  if (!existsSync(join(neuralAlphaRoot, "src", "index.ts"))) {
    return { ok: false, via: "detached", error: "neural-alpha entry not found" };
  }

  if (preferPm2()) {
    const name = agentPm2Name(agentId);
    try {
      if (pm2HasApp(name)) {
        spawnSync("pm2", ["delete", name], { stdio: "ignore", timeout: 15_000 });
      }

      const result = spawnSync(
        "pm2",
        [
          "start",
          process.execPath,
          "--name",
          name,
          "--cwd",
          neuralAlphaRoot,
          "--interpreter",
          "none",
          "--max-memory-restart",
          MAX_MEMORY_RESTART,
          "--exp-backoff-restart-delay",
          "1000",
          "--max-restarts",
          "20",
          "--",
          "--import",
          "./src/load-env.ts",
          "--import",
          "tsx",
          "src/index.ts",
        ],
        {
          env: { ...process.env, ...env },
          encoding: "utf8",
          timeout: 30_000,
        }
      );

      if (result.status !== 0) {
        return {
          ok: false,
          via: "pm2",
          error:
            result.stderr?.toString().trim() ||
            result.stdout?.toString().trim() ||
            `pm2 start exited ${result.status}`,
        };
      }

      await new Promise((r) => setTimeout(r, 800));
      const pid = readPm2Pid(name);
      if (pid) writePid(agentId, pid);
      spawnSync("pm2", ["save", "--force"], { stdio: "ignore", timeout: 10_000 });
      return { ok: true, pid: pid ?? undefined, via: "pm2" };
    } catch (err) {
      return {
        ok: false,
        via: "pm2",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Cross-platform detached spawn (macOS/Linux/Windows) — replaces broken setsid
  const dir = agentDir(agentId);
  mkdirSync(dir, { recursive: true });
  const logFile = join(dir, "agent.log");
  let logFd: number | undefined;
  try {
    logFd = openSync(logFile, "a");
  } catch {
    /* ignore */
  }

  return await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "./src/load-env.ts",
        "--import",
        "tsx",
        "src/index.ts",
      ],
      {
        cwd: neuralAlphaRoot,
        env: { ...process.env, ...env },
        detached: true,
        stdio: logFd != null ? ["ignore", logFd, logFd] : "ignore",
      }
    );

    child.on("error", (err) => {
      if (logFd != null) try { closeSync(logFd); } catch { /* ignore */ }
      resolve({ ok: false, via: "detached", error: err.message });
    });

    const pid = child.pid;
    if (pid && pid > 0) {
      writePid(agentId, pid);
      child.unref();
      if (logFd != null) {
        // Keep fd open for child; don't close in parent after unref
      }
      resolve({ ok: true, pid, via: "detached" });
    } else {
      if (logFd != null) try { closeSync(logFd); } catch { /* ignore */ }
      resolve({ ok: false, via: "detached", error: "failed to spawn detached process" });
    }
  });
}

export async function terminateAgent(
  agentId: string,
  fallbackPid?: number | null
): Promise<void> {
  const name = agentPm2Name(agentId);
  if (preferPm2() && pm2HasApp(name)) {
    spawnSync("pm2", ["stop", name], { stdio: "ignore", timeout: 15_000 });
    spawnSync("pm2", ["delete", name], { stdio: "ignore", timeout: 15_000 });
    spawnSync("pm2", ["save", "--force"], { stdio: "ignore", timeout: 10_000 });
    return;
  }

  const pid = fallbackPid;
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already dead */
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      /* ignore — may not be process group leader */
    }
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
