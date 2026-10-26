import { getServerEnv } from "@/lib/server-env";

export const SESSION_COOKIE = "na_agent";
export const ORDER_COOKIE = "na_order";

export function controlBase() {
  return (getServerEnv("SAAS_CONTROL_URL") || "http://127.0.0.1:3910").replace(/\/+$/, "");
}

export async function control(
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
) {
  const headers: Record<string, string> = {};
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

export const cookieBase = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
};
