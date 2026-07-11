import type { NextRequest } from "next/server";
import { getServerEnv } from "./server-env";
import { getSession } from "./session";

/** Paths safe to expose without owner session (public monitor). */
const PUBLIC_GET_PATHS = new Set(["meta", "health"]);

/**
 * Read-only when explicitly configured.
 * Optional: PUBLIC_MONITOR_HOSTS=agents.clipx.app,other.host (comma-separated)
 * — do NOT hardcode the operator domain here or owners cannot sync/trade.
 */
export function isReadonlyDeploy(req: NextRequest): boolean {
  if (getServerEnv("READONLY") === "true") return true;
  if (getServerEnv("NEXT_PUBLIC_READONLY") === "true") return true;

  const raw =
    getServerEnv("PUBLIC_MONITOR_HOSTS") ||
    process.env.PUBLIC_MONITOR_HOSTS ||
    "";
  if (!raw.trim()) return false;

  const hosts = new Set(
    raw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  );
  const host = (req.headers.get("host") ?? "").split(":")[0].toLowerCase();
  return hosts.has(host);
}

export function isMutationMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

export function isPublicAgentGet(agentPath: string): boolean {
  const root = agentPath.split("/")[0]?.toLowerCase() ?? "";
  return PUBLIC_GET_PATHS.has(root);
}

export async function requireOwnerSession(
  ownerWallet: string | null | undefined
): Promise<void> {
  const session = await getSession();
  if (!session.isLoggedIn || !session.wallet) {
    throw new Error("Unauthorized: login required");
  }
  if (!ownerWallet) {
    throw new Error("Forbidden: agent owner unknown");
  }
  if (session.wallet.toLowerCase() !== ownerWallet.toLowerCase()) {
    throw new Error("Forbidden: owner session required");
  }
}

/** Default single-agent path: any logged-in operator session. */
export async function requireOperatorSession(): Promise<void> {
  const session = await getSession();
  if (!session.isLoggedIn || !session.wallet) {
    throw new Error("Unauthorized: login required");
  }
}
