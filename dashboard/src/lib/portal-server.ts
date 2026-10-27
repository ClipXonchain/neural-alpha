import { getServerEnv } from "@/lib/server-env";

export const SESSION_COOKIE = "na_agent";
export const ORDER_COOKIE = "na_order";

export function controlBase() {
  return (getServerEnv("SAAS_CONTROL_URL") || "http://127.0.0.1:3910").replace(/\/+$/, "");
}

export async function control(
  path: string,
  init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...(init.headers || {}) };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${controlBase()}${path}`, {
    method: init.method || "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data: data as Record<string, unknown> };
}

export function parseSession(raw: string | undefined) {
  const parts = String(raw || "").split(".");
  if (
    parts.length === 3 &&
    /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(parts[0]) &&
    /^[a-z0-9]{8}$/.test(parts[1]) &&
    /^[a-f0-9]{64}$/i.test(parts[2])
  ) {
    return { hostId: parts[0], tenantId: parts[1], token: parts[2].toLowerCase(), raw };
  }
  return null;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function requestHost(req: Request) {
  const raw = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").split(",")[0].trim().toLowerCase();
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end > 1 ? raw.slice(1, end) : "";
  }
  return raw.split(":")[0];
}

/** Secure on neuralalpha.io. Left unset on localhost so an http test still keeps the session. */
export function portalCookie(req: Request) {
  const host = requestHost(req);
  const proto = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase();
  const local = !host || LOCAL_HOSTS.has(host);
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: !local && proto !== "http",
  };
}

/** The visitor's address as the proxy in front of the portal reports it, for per-visitor limits. */
export function clientAddress(req: Request) {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (req.headers.get("x-real-ip") || forwarded || "unknown").slice(0, 64);
}
