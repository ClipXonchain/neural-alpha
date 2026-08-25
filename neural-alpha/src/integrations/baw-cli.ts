import { spawn } from "node:child_process";

export const BAW_BINANCE_CHAIN_ID = "56";

export class BawCliError extends Error {
  readonly code?: string | number;
  readonly payload?: unknown;

  constructor(message: string, opts?: { code?: string | number; payload?: unknown }) {
    super(message);
    this.name = "BawCliError";
    this.code = opts?.code;
    this.payload = opts?.payload;
  }
}

export interface BawRunOptions {
  timeoutMs?: number;
  /** Extra env for the child (never log). */
  env?: Record<string, string>;
}

function bawBinary(): { file: string; prefixArgs: string[] } {
  const configured = process.env.BAW_CLI?.trim();
  if (configured) return { file: configured, prefixArgs: [] };
  return { file: "baw", prefixArgs: [] };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    const arrStart = trimmed.indexOf("[");
    const arrEnd = trimmed.lastIndexOf("]");
    if (arrStart >= 0 && arrEnd > arrStart) {
      try {
        return JSON.parse(trimmed.slice(arrStart, arrEnd + 1));
      } catch {
        /* fall through */
      }
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorMessage(payload: unknown, fallback: string): string {
  const rec = asRecord(payload);
  const err = rec?.error;
  if (typeof err === "string" && err) return err;
  const nested = asRecord(err);
  if (nested) {
    if (typeof nested.message === "string" && nested.message) return nested.message;
    if (typeof nested.name === "string" && nested.name) return nested.name;
  }
  if (typeof rec?.message === "string" && rec.message) return rec.message;
  return fallback;
}

/**
 * Run `baw <args> --json` and return parsed JSON.
 * Never logs session tokens, clientId, or raw payment headers.
 */
export async function bawJson(
  args: string[],
  opts: BawRunOptions = {}
): Promise<Record<string, unknown>> {
  const { file, prefixArgs } = bawBinary();
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const argv = [...prefixArgs, ...args];
  if (!argv.includes("--json")) argv.push("--json");

  const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (resolve, reject) => {
      const child = spawn(file, argv, {
        env: { ...process.env, ...opts.env },
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new BawCliError(`baw ${args[0] ?? ""} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += String(chunk);
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(
          new BawCliError(
            `Failed to spawn baw CLI (${file}): ${err.message}. Install with: npm i -g @binance/agentic-wallet`
          )
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      });
    }
  );

  const parsed = extractJson(result.stdout) ?? extractJson(result.stderr);
  const rec = asRecord(parsed);

  if (rec && rec.success === false) {
    throw new BawCliError(errorMessage(rec, `baw ${args.join(" ")} failed`), {
      code: asRecord(rec.error)?.code as string | number | undefined,
      payload: rec,
    });
  }

  if (!rec) {
    const hint = (result.stderr || result.stdout).trim().slice(0, 240);
    throw new BawCliError(
      result.code
        ? `baw ${args[0] ?? ""} exited ${result.code}${hint ? `: ${hint}` : ""}`
        : `baw ${args[0] ?? ""} returned no JSON${hint ? `: ${hint}` : ""}`
    );
  }

  return rec;
}

export function bawData<T = Record<string, unknown>>(result: Record<string, unknown>): T {
  return (result.data ?? result) as T;
}

export async function bawWalletStatus(): Promise<string> {
  const rec = await bawJson(["wallet", "status"], { timeoutMs: 20_000 });
  const data = bawData<{ status?: string }>(rec);
  return String(data.status ?? "UNCONNECTED").toUpperCase();
}
