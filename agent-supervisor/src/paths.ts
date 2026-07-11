import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));

/** Repo root (parent of agent-supervisor/). */
export function repoRoot(): string {
  return resolve(here, "../..");
}

export function neuralAlphaRoot(): string {
  const candidates = [
    join(repoRoot(), "neural-alpha"),
    join(process.cwd(), "neural-alpha"),
    join(process.cwd(), "..", "neural-alpha"),
  ];
  const found = candidates.find((p) => existsSync(join(p, "src", "index.ts")));
  if (!found) {
    throw new Error("neural-alpha package not found");
  }
  return found;
}

export function agentDataDir(): string {
  return (
    process.env.AGENT_DATA_DIR?.trim() ||
    join(repoRoot(), "data", "agents")
  );
}

export function agentDir(agentId: string): string {
  return join(agentDataDir(), agentId);
}

export function agentPm2Name(agentId: string): string {
  return `neural-agent-${agentId}`;
}
