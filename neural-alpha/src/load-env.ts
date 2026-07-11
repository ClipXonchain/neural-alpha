/**
 * Preload env before app modules.
 * Process env (set by orchestrator) wins over repo .env so multi-tenant
 * agents keep their AGENT_ID / API_SECRET / keystore paths.
 *
 * Tenant agents (non-default AGENT_ID) do not inherit dangerous root-only
 * knobs like DISABLE_DRAWDOWN_LIMIT / AGENT_PRIVATE_KEY from the repo .env.
 */
import { config } from "dotenv";
import { resolve } from "node:path";

const TENANT_BLOCKLIST = [
  "DISABLE_DRAWDOWN_LIMIT",
  "AGENT_PRIVATE_KEY",
] as const;

const beforeKeys = new Set(Object.keys(process.env));
const envPath = resolve(import.meta.dirname, "../../.env");
const result = config({ path: envPath, override: false });

if (result.error) {
  const code = (result.error as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") {
    console.warn(`[load-env] Could not read ${envPath}: ${result.error.message}`);
  }
}

const agentId = process.env.AGENT_ID?.trim();
if (agentId && agentId !== "default") {
  for (const key of TENANT_BLOCKLIST) {
    // Only strip values that came from the file (were not set before dotenv)
    if (!beforeKeys.has(key) && process.env[key] !== undefined) {
      delete process.env[key];
    }
  }
}
