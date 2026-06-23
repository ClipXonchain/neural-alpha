import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

/** Resolve agent API base URL (server-side). Prefers `.agent-api-port` written by the agent on startup. */
export function getAgentApiUrl(): string {
  if (process.env.AGENT_API_URL) {
    return process.env.AGENT_API_URL.replace(/\/$/, "");
  }

  const candidates = [
    resolve(process.cwd(), "../.agent-api-port"),
    resolve(process.cwd(), ".agent-api-port"),
  ];

  for (const portFile of candidates) {
    if (!existsSync(portFile)) continue;
    try {
      const port = readFileSync(portFile, "utf8").trim();
      if (/^\d{4,5}$/.test(port)) {
        return `http://127.0.0.1:${port}`;
      }
    } catch {
      continue;
    }
  }

  return "http://127.0.0.1:3847";
}
