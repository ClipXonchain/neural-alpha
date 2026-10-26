import { NextRequest, NextResponse } from "next/server";
import { getServerEnv } from "@/lib/server-env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_SUBPATHS = new Set(["overview", "live", "stream"]);
const GET_TIMEOUT_MS = 10_000;

type RouteContext = { params: Promise<{ path: string[] }> };

function controlPlaneBaseUrl(): string {
  const raw =
    getServerEnv("SAAS_CONTROL_URL") ||
    getServerEnv("CONTROL_PLANE_URL") ||
    process.env.SAAS_CONTROL_URL ||
    process.env.CONTROL_PLANE_URL ||
    "http://127.0.0.1:3910";
  return raw.replace(/\/+$/, "");
}

function buildDemoOverview() {
  const now = Date.now();
  return {
    hostId: "local",
    generatedAt: new Date(now).toISOString(),
    readOnly: true,
    demo: true,
    operator: { agentId: null },
    health: {
      ok: true,
      startedAt: new Date(now - 455220000).toISOString(),
      uptimeMs: 455220000,
      requests: 1420,
    },
    capacity: {
      maxTenants: 6,
      intervalMs: 45000,
      upstreamBudgetPerMin: 60,
      estimatedUsePerMin: 10.2,
      estimatedUseAtFull: 60,
      running: 3,
      orphans: ["na-c08a91e4"],
    },
    counts: {
      customers: 3,
      byStatus: {
        running: 3,
        paused: 0,
        provisioning: 0,
        error: 0,
        stopped: 0,
      },
      byMode: { live: 2, paper: 1 },
      byAsset: { USDT: 1, BNB: 1, USDC: 1 },
      paired: 3,
      unpaired: 0,
    },
    tenants: [
      {
        id: "9af2de37",
        agent_name: null,
        container_name: "na-9af2de37",
        status: "running",
        agent_mode: "live",
        risk_preset: "cautious",
        max_position_usd: 50,
        max_trade_usd: 15,
        wallet_address: "0x71C95911E9a5D330f4D621842EC243EE1343292e",
        payment_asset: "USDT",
        payment_tx:
          "0x8a34f1e29b04a7c8d6e12f4509b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0",
        last_error: null,
        created_at: "2026-04-20T17:40:00Z",
        updated_at: "2026-04-20T17:41:00Z",
      },
      {
        id: "77e1d98c",
        agent_name: null,
        container_name: "na-77e1d98c",
        status: "running",
        agent_mode: "live",
        risk_preset: "normal",
        max_position_usd: 100,
        max_trade_usd: 25,
        wallet_address: "0x3f5CE5FBFe3E9af3971dD833D26bA9b5C936f0bE",
        payment_asset: "BNB",
        payment_tx:
          "0x4c91b8a7d6e5f4c3b2a1908f7e6d5c4b3a291807f6e5d4c3b2a1908f7e6d5c4b",
        last_error: null,
        created_at: "2026-04-20T17:19:00Z",
        updated_at: "2026-04-20T17:41:00Z",
      },
      {
        id: "d77c4ff2",
        agent_name: null,
        container_name: "na-d77c4ff2",
        status: "running",
        agent_mode: "paper",
        risk_preset: "active",
        max_position_usd: 250,
        max_trade_usd: 40,
        wallet_address: "0x28C6c06298d514Db089934071355E5743bf21d60",
        payment_asset: "USDC",
        payment_tx:
          "0x91e4a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f",
        last_error: null,
        created_at: "2026-04-20T16:45:00Z",
        updated_at: "2026-04-20T17:40:00Z",
      },
    ],
    payments: [
      {
        id: "9af2de37",
        asset: "USDT",
        tx: "0x8a34f1e29b04a7c8d6e12f4509b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0",
        createdAt: "2026-04-20T17:40:00Z",
        status: "running",
      },
      {
        id: "77e1d98c",
        asset: "BNB",
        tx: "0x4c91b8a7d6e5f4c3b2a1908f7e6d5c4b3a291807f6e5d4c3b2a1908f7e6d5c4b",
        createdAt: "2026-04-20T17:19:00Z",
        status: "running",
      },
      {
        id: "d77c4ff2",
        asset: "USDC",
        tx: "0x91e4a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f",
        createdAt: "2026-04-20T16:45:00Z",
        status: "running",
      },
    ],
  };
}

function buildDemoLive() {
  const now = Date.now();
  const curveVals = [
    680, 682, 681, 684, 686, 688, 691, 690, 689, 692, 691, 694, 697, 698, 703,
    702, 712, 706, 708, 704, 712, 716, 720.75,
  ];
  return {
    generatedAt: new Date(now).toISOString(),
    bookLatencyMs: 42,
    demo: true,
    fleet: {
      reachable: 3,
      unreachable: 0,
      navUsd: 720.75,
      cashUsd: 286.4,
      realizedPnlUsd: 24.3,
      unrealizedPnlUsd: 7.45,
      totalPnlUsd: 31.75,
      dailyPnlUsd: 13.7,
      positions: 5,
      trades: 18,
      wins: 14,
      volumeUsd: 1420.5,
      holdings: [
        { symbol: "USDT", valueUsd: 432.45 },
        { symbol: "BNB", valueUsd: 180.19 },
        { symbol: "USDC", valueUsd: 108.11 },
      ],
      recent: [
        {
          id: "9af2de37",
          time: now - 120000,
          side: "buy",
          symbol: "TSLAB",
          usd: 15,
          pnl: 1.85,
          tx: "0x8a34f1e29b04a7c8d6e12f4509b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0",
        },
        {
          id: "77e1d98c",
          time: now - 480000,
          side: "buy",
          symbol: "NVDAB",
          usd: 25,
          pnl: 4.1,
          tx: "0x4c91b8a7d6e5f4c3b2a1908f7e6d5c4b3a291807f6e5d4c3b2a1908f7e6d5c4b",
        },
        {
          id: "d77c4ff2",
          time: now - 960000,
          side: "sell",
          symbol: "AAPLB",
          usd: 38.5,
          pnl: 6.2,
          tx: "0x91e4a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f",
        },
      ],
    },
    tenants: [
      {
        id: "9af2de37",
        status: "running",
        mode: "live",
        preset: "cautious",
        asset: "USDT",
        maxPositionUsd: 50,
        reachable: true,
        navUsd: 220.5,
        cashUsd: 88.2,
        realizedPnlUsd: 8.2,
        unrealizedPnlUsd: 2.1,
        totalPnlUsd: 10.3,
        dailyPnlUsd: 4.5,
        positions: 2,
        symbols: ["TSLAB", "NVDAB"],
        holdings: [
          { symbol: "TSLAB", valueUsd: 72.3 },
          { symbol: "NVDAB", valueUsd: 60.0 },
        ],
        trades: 7,
        wins: 6,
        volumeUsd: 410,
        cycleCount: 312,
        series: curveVals.map((v, i) => ({
          t: now - (curveVals.length - 1 - i) * 3600000,
          v: Math.round(v * 0.30593 * 100) / 100,
        })),
      },
      {
        id: "77e1d98c",
        status: "running",
        mode: "live",
        preset: "normal",
        asset: "BNB",
        maxPositionUsd: 100,
        reachable: true,
        navUsd: 190.25,
        cashUsd: 74.1,
        realizedPnlUsd: -1.1,
        unrealizedPnlUsd: 1.85,
        totalPnlUsd: 0.75,
        dailyPnlUsd: 3.1,
        positions: 1,
        symbols: ["AAPLB"],
        holdings: [{ symbol: "AAPLB", valueUsd: 116.15 }],
        trades: 5,
        wins: 3,
        volumeUsd: 390.5,
        cycleCount: 285,
        series: curveVals.map((v, i) => ({
          t: now - (curveVals.length - 1 - i) * 3600000,
          v: Math.round(v * 0.26396 * 100) / 100,
        })),
      },
      {
        id: "d77c4ff2",
        status: "running",
        mode: "paper",
        preset: "active",
        asset: "USDC",
        maxPositionUsd: 250,
        reachable: true,
        navUsd: 310.0,
        cashUsd: 124.1,
        realizedPnlUsd: 17.2,
        unrealizedPnlUsd: 3.5,
        totalPnlUsd: 20.7,
        dailyPnlUsd: 6.1,
        positions: 2,
        symbols: ["NVDAB", "MSFTB"],
        holdings: [
          { symbol: "NVDAB", valueUsd: 104.9 },
          { symbol: "MSFTB", valueUsd: 81.0 },
        ],
        trades: 6,
        wins: 5,
        volumeUsd: 620,
        cycleCount: 198,
        series: curveVals.map((v, i) => ({
          t: now - (curveVals.length - 1 - i) * 3600000,
          v: Math.round(v * 0.43011 * 100) / 100,
        })),
      },
    ],
  };
}

function guardUpstreamStream(
  body: ReadableStream<Uint8Array> | null
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch {
        controller.close();
      }
    },
    cancel() {
      void reader.cancel().catch(() => undefined);
    },
  });
}

export async function GET(req: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  const subpath = (path ?? []).join("/");

  if (!ALLOWED_SUBPATHS.has(subpath)) {
    return NextResponse.json(
      { error: "not found — the monitor desk is read only" },
      { status: 404 }
    );
  }

  const incomingAuth = req.headers.get("authorization")?.trim();
  const fallbackSecret =
    getServerEnv("SAAS_MONITOR_SECRET") || getServerEnv("CONTROL_API_SECRET");
  const authHeader =
    incomingAuth || (fallbackSecret ? `Bearer ${fallbackSecret}` : "Bearer demo");

  const targetUrl = `${controlPlaneBaseUrl()}/admin/${subpath}`;
  const isStream = subpath === "stream";

  try {
    const signal = isStream
      ? req.signal
      : typeof AbortSignal.any === "function"
      ? AbortSignal.any([req.signal, AbortSignal.timeout(GET_TIMEOUT_MS)])
      : AbortSignal.timeout(GET_TIMEOUT_MS);

    const upstream = await fetch(targetUrl, {
      method: "GET",
      cache: "no-store",
      signal,
      headers: {
        accept: isStream ? "text/event-stream" : "application/json",
        authorization: authHeader,
        "x-neural-desk": "observe",
      },
    });

    if (isStream && upstream.ok && upstream.body) {
      return new Response(guardUpstreamStream(upstream.body), {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    // Fallback to demo payload when local control plane (port 3910) is not running
    if (subpath === "overview") {
      return NextResponse.json(buildDemoOverview(), { status: 200 });
    }
    if (subpath === "live") {
      return NextResponse.json(buildDemoLive(), { status: 200 });
    }
    if (subpath === "stream") {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const payload = JSON.stringify({
            overview: buildDemoOverview(),
            live: buildDemoLive(),
          });
          controller.enqueue(
            encoder.encode(`retry: 3000\n\nevent: snapshot\ndata: ${payload}\n\n`)
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store, no-transform",
        },
      });
    }
    return NextResponse.json(
      { error: "control plane unreachable" },
      { status: 502 }
    );
  }
}
