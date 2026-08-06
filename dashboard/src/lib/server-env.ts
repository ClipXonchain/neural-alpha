import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Parsed keys from repo-root / dashboard env files (lazy, once per process). */
let fileEnv: Record<string, string> | null = null;

function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadFileEnv(): Record<string, string> {
  if (fileEnv) return fileEnv;
  fileEnv = {};
  const paths = [
    resolve(process.cwd(), "../.env"),
    resolve(process.cwd(), ".env.local"),
    resolve(process.cwd(), ".env"),
  ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      Object.assign(fileEnv, parseEnvFile(readFileSync(p, "utf8")));
    } catch {
      /* ignore unreadable env files */
    }
  }
  return fileEnv;
}

/** Server-side env — falls back to repo-root `.env` when Next.js only loaded dashboard env. */
export function getServerEnv(key: string): string | undefined {
  const direct = process.env[key]?.trim();
  if (direct) return direct;
  return loadFileEnv()[key]?.trim() || undefined;
}
