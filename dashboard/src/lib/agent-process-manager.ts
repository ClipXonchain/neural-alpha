import "server-only";
import { execFileSync, spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "./agent-runtime";

export function agentPm2Name(agentId: string): string {
  return `neural-agent-${agentId}`;
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
  const dir = getAgentDir(agentId);
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

/**
 * Launch an agent outside the dashboard process tree.
 * Prefer PM2 (survives `pm2 restart neural-dashboard`); else nohup+setsid.
 */
export async function launchDetachedAgent(opts: {
  agentId: string;
  neuralAlphaRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ ok: boolean; pid?: number; via: "pm2" | "setsid"; error?: string }> {
  const { agentId, neuralAlphaRoot, env } = opts;
  if (!existsSync(join(neuralAlphaRoot, "src", "index.ts"))) {
    return { ok: false, via: "setsid", error: "neural-alpha entry not found" };
  }

  if (preferPm2()) {
    const name = agentPm2Name(agentId);
    try {
      // Replace any stale app so env/cwd stay current
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

      // Give PM2 a moment to register the pid
      await new Promise((r) => setTimeout(r, 800));
      const pid = readPm2Pid(name);
      if (pid) writePid(agentId, pid);

      // Persist so agents come back after VPS reboot (secrets already in root .env)
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

  // Fallback: leave the dashboard process tree so PM2 tree-kill cannot reap agents
  const agentDir = getAgentDir(agentId);
  mkdirSync(agentDir, { recursive: true });
  const logFile = join(agentDir, "agent.log");
  const pidFile = join(agentDir, "pid");

  return await new Promise((resolve) => {
    const cmd = [
      "nohup",
      "setsid",
      process.execPath,
      "--import",
      "./src/load-env.ts",
      "--import",
      "tsx",
      "src/index.ts",
      "</dev/null",
      `>>${JSON.stringify(logFile)}`,
      "2>&1",
      "&",
      "echo $!",
    ].join(" ");

    const child = spawn("bash", ["-c", cmd], {
      cwd: neuralAlphaRoot,
      env: { ...process.env, ...env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("error", (err) => {
      resolve({ ok: false, via: "setsid", error: err.message });
    });
    child.on("close", (code) => {
      const pid = parseInt(out.trim().split("\n").pop() || "", 10);
      if (Number.isFinite(pid) && pid > 0) {
        writeFileSync(pidFile, String(pid), { mode: 0o600 });
        try {
          appendFileSync(logFile, `\n[launcher] started pid=${pid}\n`);
        } catch {
          /* ignore */
        }
        resolve({ ok: true, pid, via: "setsid" });
      } else {
        resolve({
          ok: false,
          via: "setsid",
          error: `setsid launcher failed (code=${code})`,
        });
      }
    });
    child.unref();
  });
}

export async function terminateDetachedAgent(
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
    // Also try process group in case it was session leader
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
}
