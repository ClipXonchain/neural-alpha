import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/server-env";
import { isSupervisorUp } from "@/lib/supervisor-client";

export const dynamic = "force-dynamic";

/**
 * Public liveness for nginx / load balancers.
 * Multi-tenant: does not depend on the optional singleton neural-agent.
 * Kicks agent reconcile via Supervisor (preferred) or local fallback.
 */
export async function GET() {
  void import("@/lib/platform-registry")
    .then((m) => m.reconcileAgentRuntime())
    .catch((err) => console.warn("[health] agent reconcile failed", err));

  const feedUrl = (
    getServerEnv("MARKET_FEED_URL") || "http://127.0.0.1:4100"
  ).replace(/\/$/, "");

  let feedOk = false;
  let feedError: string | undefined;
  try {
    const res = await fetch(`${feedUrl}/health`, {
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    feedOk = res.ok;
    if (!res.ok) feedError = `feed HTTP ${res.status}`;
  } catch (err) {
    feedError = err instanceof Error ? err.message : String(err);
  }

  const supervisorOk = await isSupervisorUp();

  const body = {
    ok: true,
    service: "neural-dashboard",
    ts: Date.now(),
    marketFeed: feedOk ? "up" : "down",
    supervisor: supervisorOk ? "up" : "down",
    ...(feedError && !feedOk ? { marketFeedError: feedError } : {}),
  };

  // Platform is up if dashboard responds; feed/supervisor status is informational
  return NextResponse.json(body, { status: 200 });
}
