/**
 * Preload before any app modules — ensures repo-root .env wins over stale
 * shell/PM2 env (dotenv default is override: false).
 */
import { config } from "dotenv";
import { resolve } from "node:path";

const envPath = resolve(import.meta.dirname, "../../.env");
const result = config({ path: envPath, override: true });

if (result.error) {
  const code = (result.error as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") {
    console.warn(`[load-env] Could not read ${envPath}: ${result.error.message}`);
  }
}
