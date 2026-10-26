import { spawn } from "node:child_process";

const AGENT_STATE_SCRIPT =
  'fetch("http://127.0.0.1:3847/api/state").then(async (r)=>{if(!r.ok)throw new Error(String(r.status));process.stdout.write(await r.text())}).catch((e)=>{process.stderr.write(String(e));process.exit(1)})';

export function runCommand(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out`));
    }, opts.timeoutMs ?? 120_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${command} exited ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export function createDocker({ repoRoot, composeFile, run = runCommand }) {
  return {
    async ensureNetwork() {
      try {
        await run("docker", ["network", "inspect", "neural-saas"]);
      } catch {
        await run("docker", ["network", "create", "neural-saas"]);
      }
    },
    async ensureImage() {
      try {
        await run("docker", ["image", "inspect", "neural-saas-worker:local"]);
        await run("docker", ["image", "inspect", "neural-saas-bridge:local"]);
      } catch {
        await run("docker", ["compose", "-f", composeFile, "build"], { cwd: repoRoot, timeoutMs: 600_000 });
      }
    },
    async up(tenant) {
      await run(
        "docker",
        ["compose", "-p", tenant.project, "-f", composeFile, "-f", tenant.overrideFile, "up", "-d"],
        { cwd: repoRoot, timeoutMs: 180_000 },
      );
    },
    async stop(tenant) {
      await run("docker", ["compose", "-p", tenant.project, "-f", composeFile, "-f", tenant.overrideFile, "stop"], {
        cwd: repoRoot,
      });
    },
    async start(tenant) {
      await run("docker", ["compose", "-p", tenant.project, "-f", composeFile, "-f", tenant.overrideFile, "start"], {
        cwd: repoRoot,
      });
    },
    async down(tenant) {
      await run("docker", ["compose", "-p", tenant.project, "-f", composeFile, "-f", tenant.overrideFile, "down"], {
        cwd: repoRoot,
      });
    },
    async signin(container) {
      const { stdout } = await run("docker", ["exec", container, "baw", "auth", "signin", "--json"], {
        timeoutMs: 30_000,
      });
      return parseCliJson(stdout);
    },
    async verify(container, qrCodeId) {
      const { stdout } = await run(
        "docker",
        ["exec", container, "baw", "auth", "verify", "--qrCodeId", qrCodeId, "--json"],
        { timeoutMs: 300_000 },
      );
      return parseCliJson(stdout);
    },
    async walletStatus(container) {
      const { stdout } = await run("docker", ["exec", container, "baw", "wallet", "status", "--json"], {
        timeoutMs: 20_000,
      });
      return parseCliJson(stdout);
    },
    async containerIp(container) {
      if (!/^na-[a-z0-9]{8}$/.test(container)) throw new Error("container name is invalid");
      const { stdout } = await run("docker", [
        "inspect",
        "-f",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
        container,
      ]);
      return stdout.trim().split(/\s+/).find(Boolean) || "";
    },
    async walletAddress(container) {
      const { stdout } = await run("docker", ["exec", container, "baw", "wallet", "address", "--json"], {
        timeoutMs: 30_000,
      });
      const payload = parseCliJson(stdout);
      const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
      const address = data?.address || data?.walletAddress || "";
      return typeof address === "string" ? address : "";
    },
    async readState(container) {
      if (!/^na-[a-z0-9]{8}$/.test(container)) throw new Error("container name is invalid");
      const { stdout } = await run("docker", ["exec", container, "node", "-e", AGENT_STATE_SCRIPT], {
        timeoutMs: 8_000,
      });
      return stdout;
    },
    async listContainers() {
      const { stdout } = await run("docker", ["ps", "-a", "--format", "{{.Names}}"]);
      return stdout
        .split("\n")
        .map((name) => name.trim())
        .filter(Boolean);
    },
  };
}

export function parseCliJson(text) {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  if (start < 0) throw new Error("cli did not return json");
  return JSON.parse(trimmed.slice(start));
}
