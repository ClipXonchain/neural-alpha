import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TradingAgent, AgentState } from "../agent.js";
import { addLogListener, removeLogListener, type LogListener } from "../utils/logger.js";
import { logger } from "../utils/logger.js";
import type { LogEntry } from "../utils/types.js";
import { executeCommand } from "../commands/handler.js";

const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || "3847", 10);
const API_SECRET = process.env.API_SECRET?.trim();
const MAX_BODY_BYTES = 64 * 1024; // 64 KB
const MAX_SSE_CLIENTS = 20;
const MAX_COMMAND_LENGTH = 500;

const ALLOWED_ORIGINS = (() => {
  const env = process.env.CORS_ORIGINS?.trim();
  const defaults = [
    "https://agents.clipx.app",
    "http://localhost:3000",
    "http://localhost:3847",
  ];
  if (!env) return defaults;
  return [...new Set([...defaults, ...env.split(",").map((o) => o.trim()).filter(Boolean)])];
})();

// ─── Rate limiter (in-memory, per-IP) ──────────────────────────────
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 120;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  return bucket.count > RATE_MAX_REQUESTS;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of rateBuckets) {
    if (b.resetAt <= now) rateBuckets.delete(ip);
  }
}, RATE_WINDOW_MS);

// ─── Auth helper ───────────────────────────────────────────────────
function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (!auth) return null;
  const parts = auth.split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") return parts[1];
  return null;
}

function isAuthenticated(req: IncomingMessage): boolean {
  if (!API_SECRET) return true; // no secret configured = dev mode
  const token = extractBearerToken(req) ?? (req.headers["x-api-key"] as string | undefined);
  return token === API_SECRET;
}

let agentRef: TradingAgent | null = null;
const sseClients: Set<ServerResponse> = new Set();
const recentLogs: LogEntry[] = [];
const MAX_LOG_BUFFER = 500;

const logListener: LogListener = (entry) => {
  recentLogs.push(entry);
  if (recentLogs.length > MAX_LOG_BUFFER) recentLogs.shift();
  broadcast("log", entry);
};

function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

let stateInterval: ReturnType<typeof setInterval> | null = null;

function startStateBroadcast() {
  if (stateInterval) return;
  stateInterval = setInterval(() => {
    if (!agentRef || sseClients.size === 0) return;
    try {
      const state = agentRef.getStateSnapshot();
      broadcast("state", state);
    } catch { /* don't crash on state errors */ }
  }, 2000);
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers["origin"] ?? "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");
}

function securityHeaders(res: ServerResponse) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cache-Control", "no-store");
}

function json(req: IncomingMessage, res: ServerResponse, data: unknown, status = 200) {
  cors(req, res);
  securityHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function safeErrorMessage(err: unknown): string {
  if (process.env.NODE_ENV === "production") return "Internal server error";
  return String(err);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    req.on("data", (chunk: Buffer | string) => {
      const str = typeof chunk === "string" ? chunk : chunk.toString();
      bytes += Buffer.byteLength(str);
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += str;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function handleApi(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url || "/";

  if (req.method === "OPTIONS") {
    cors(req, res);
    res.writeHead(204);
    res.end();
    return true;
  }

  // Health check — no auth required
  if (url === "/api/health" && req.method === "GET") {
    json(req, res, {
      status: "ok",
      running: agentRef?.isRunning() ?? false,
      uptime: process.uptime(),
      timestamp: Date.now(),
    });
    return true;
  }

  // All other endpoints require authentication
  if (!isAuthenticated(req)) {
    json(req, res, { error: "Unauthorized" }, 401);
    return true;
  }

  if (url === "/api/state" && req.method === "GET") {
    if (!agentRef) return json(req, res, { error: "Agent not initialized" }, 503), true;
    json(req, res, agentRef.getStateSnapshot());
    return true;
  }

  if (url === "/api/logs" && req.method === "GET") {
    json(req, res, recentLogs.slice(-100));
    return true;
  }

  if (url === "/api/control/stop" && req.method === "POST") {
    if (!agentRef) return json(req, res, { error: "Agent not initialized" }, 503), true;
    agentRef.stop();
    json(req, res, { ok: true, message: "Stop requested" });
    return true;
  }

  if (url === "/api/control/start" && req.method === "POST") {
    if (!agentRef) return json(req, res, { error: "Agent not initialized" }, 503), true;
    void agentRef.start().catch((e) => logger.error("Agent start failed", { error: String(e) }));
    json(req, res, { ok: true, message: "Start requested" });
    return true;
  }

  if (url === "/api/command" && req.method === "POST") {
    if (!agentRef) return json(req, res, { error: "Agent not initialized" }, 503), true;
    readBody(req)
      .then((body) => {
        try {
          const { command } = JSON.parse(body) as { command: string };
          if (!command || typeof command !== "string") {
            return json(req, res, { error: "command field required" }, 400);
          }
          if (command.length > MAX_COMMAND_LENGTH) {
            return json(req, res, { error: `command exceeds ${MAX_COMMAND_LENGTH} chars` }, 400);
          }
          executeCommand(agentRef!, command)
            .then((result) => json(req, res, result))
            .catch((e) => json(req, res, { ok: false, intent: "error", message: safeErrorMessage(e) }, 500));
        } catch {
          json(req, res, { error: "Invalid JSON" }, 400);
        }
      })
      .catch((e) => json(req, res, { error: safeErrorMessage(e) }, 413));
    return true;
  }

  if (url === "/api/control/restart" && req.method === "POST") {
    if (!agentRef) return json(req, res, { error: "Agent not initialized" }, 503), true;
    agentRef.restart()
      .then(() => json(req, res, { ok: true, message: "Agent reset and restarted" }))
      .catch((e) => json(req, res, { error: safeErrorMessage(e) }, 500));
    return true;
  }

  if (url === "/api/wallet" && req.method === "GET") {
    if (!agentRef) return json(req, res, { error: "Agent not initialized" }, 503), true;
    agentRef.getWalletInfoFast().then((w) => {
      if (w) {
        json(req, res, w);
      } else {
        json(req, res, { error: "Wallet data not yet available" }, 503);
      }
    }).catch((e) => json(req, res, { error: safeErrorMessage(e) }, 500));
    return true;
  }

  if (url === "/api/wallet/sync" && req.method === "POST") {
    if (!agentRef) return json(req, res, { error: "Agent not initialized" }, 503), true;
    agentRef.syncWalletCapital().then((r) => json(req, res, r)).catch((e) => json(req, res, { error: safeErrorMessage(e) }, 500));
    return true;
  }

  if (url === "/api/control/resync" && req.method === "POST") {
    if (!agentRef) return json(req, res, { error: "Agent not initialized" }, 503), true;
    agentRef.forceResync()
      .then((s) => {
        broadcast("state", s);
        json(req, res, {
          ok: true,
          portfolioValue: s.portfolio.totalValueUsd,
          positions: s.portfolio.positions.length,
          cashUsd: s.portfolio.cashUsd,
        });
      })
      .catch((e) => json(req, res, { error: safeErrorMessage(e) }, 500));
    return true;
  }

  if (url === "/api/wallet/mode" && req.method === "POST") {
    if (!agentRef) return json(req, res, { error: "Agent not initialized" }, 503), true;
    readBody(req)
      .then((body) => {
        try {
          const { mode } = JSON.parse(body) as { mode: string };
          if (mode !== "local" && mode !== "walletconnect") {
            return json(req, res, { error: "mode must be 'local' or 'walletconnect'" }, 400);
          }
          agentRef!.switchWalletMode(mode)
            .then((r) => json(req, res, { ok: true, ...r }))
            .catch((e) => json(req, res, { error: safeErrorMessage(e) }, 500));
        } catch {
          json(req, res, { error: "Invalid JSON" }, 400);
        }
      })
      .catch((e) => json(req, res, { error: safeErrorMessage(e) }, 413));
    return true;
  }

  if (url === "/api/competition/register" && req.method === "POST") {
    if (!agentRef) return json(req, res, { error: "Agent not initialized" }, 503), true;
    agentRef.registerCompetition().then((r) => json(req, res, r)).catch((e) => json(req, res, { error: safeErrorMessage(e) }, 500));
    return true;
  }

  if (url === "/api/competition/status" && req.method === "GET") {
    if (!agentRef) return json(req, res, { error: "Agent not initialized" }, 503), true;
    agentRef.getWalletInfo().then((w) => json(req, res, {
      registered: w.registered,
      registrationOpen: w.registrationOpen,
      address: w.address,
    })).catch((e) => json(req, res, { error: safeErrorMessage(e) }, 500));
    return true;
  }

  if (url.startsWith("/api/control/watchlist") && req.method === "POST") {
    if (!agentRef) return json(req, res, { error: "Agent not initialized" }, 503), true;
    readBody(req)
      .then((body) => {
        try {
          const { tokens } = JSON.parse(body);
          if (!Array.isArray(tokens) || tokens.length > 200) {
            return json(req, res, { error: "tokens must be an array (max 200)" }, 400);
          }
          if (!tokens.every((t: unknown) => typeof t === "string" && t.length <= 20)) {
            return json(req, res, { error: "each token must be a string (max 20 chars)" }, 400);
          }
          agentRef!.updateWatchlist(tokens);
          json(req, res, { ok: true, watchlist: tokens });
        } catch {
          json(req, res, { error: "Invalid JSON" }, 400);
        }
      })
      .catch((e) => json(req, res, { error: safeErrorMessage(e) }, 413));
    return true;
  }

  if (url === "/api/control/config" && req.method === "POST") {
    if (!agentRef) return json(req, res, { error: "Agent not initialized" }, 503), true;
    readBody(req)
      .then((body) => {
        try {
          const updates = JSON.parse(body);
          if (typeof updates !== "object" || updates === null || Array.isArray(updates)) {
            return json(req, res, { error: "body must be a JSON object" }, 400);
          }
          const ALLOWED_CONFIG_KEYS = new Set([
            "tradeIntervalMs", "maxPositionSizeUsd", "maxDailyTrades",
            "maxDrawdownPct", "slippageTolerance", "maxPortfolioTokens",
            "minTradeAmountUsd", "minBuyConfidence", "stopLossPct", "takeProfitPct",
            "trailingActivatePct", "trailingGivebackPct", "autoExitEnabled",
            "maxAutonomousTradesPerCycle", "maxOnChainTxPerDay", "strategy",
          ]);
          const disallowed = Object.keys(updates).filter((k) => !ALLOWED_CONFIG_KEYS.has(k));
          if (disallowed.length > 0) {
            return json(req, res, { error: `disallowed keys: ${disallowed.join(", ")}` }, 400);
          }
          agentRef!.updateConfig(updates);
          json(req, res, { ok: true, config: agentRef!.getConfig() });
        } catch {
          json(req, res, { error: "Invalid JSON" }, 400);
        }
      })
      .catch((e) => json(req, res, { error: safeErrorMessage(e) }, 413));
    return true;
  }

  if (url === "/api/events" && req.method === "GET") {
    if (sseClients.size >= MAX_SSE_CLIENTS) {
      json(req, res, { error: "Too many SSE connections" }, 429);
      return true;
    }
    cors(req, res);
    securityHeaders(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);

    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));

    if (agentRef) {
      try {
        const state = agentRef.getStateSnapshot();
        res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
      } catch { /* ok */ }
    }
    return true;
  }

  return false;
}

export function startDashboard(agent: TradingAgent) {
  agentRef = agent;
  addLogListener(logListener);

  if (!API_SECRET && process.env.NODE_ENV === "production") {
    logger.warn("API_SECRET not set — agent API is UNAUTHENTICATED. Set API_SECRET in .env for production.");
  }

  const server = createServer((req, res) => {
    const url = req.url || "/";
    const ip = getClientIp(req);

    if (isRateLimited(ip)) {
      securityHeaders(res);
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many requests" }));
      return;
    }

    if (url.startsWith("/api/")) {
      if (!handleApi(req, res)) {
        json(req, res, { error: "Not found" }, 404);
      }
      return;
    }

    if (url === "/" || url === "/index.html") {
      cors(req, res);
      securityHeaders(res);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ service: "Neural Alpha Agent API", status: "ok" }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.timeout = 30_000;

  const portFile = resolve(import.meta.dirname, "../../../.agent-api-port");

  function writePortFile(p: number) {
    try {
      writeFileSync(portFile, String(p), { encoding: "utf8", mode: 0o600 });
    } catch (err) {
      logger.warn("Could not write agent port file", { error: String(err) });
    }
  }

  let port = DASHBOARD_PORT;
  const MAX_PORT_RETRIES = 5;

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && port < DASHBOARD_PORT + MAX_PORT_RETRIES) {
      logger.warn(`Port ${port} in use — trying ${port + 1}`);
      port++;
      server.listen(port, "127.0.0.1");
      return;
    }
    if (err.code === "EADDRINUSE") {
      logger.error(
        `No free port in range ${DASHBOARD_PORT}–${DASHBOARD_PORT + MAX_PORT_RETRIES}`,
        { port }
      );
      console.error(
        `\n\x1b[1;31m  ✗ Agent API port ${DASHBOARD_PORT} in use — stop other agent processes\x1b[0m\n`
      );
      process.exit(1);
    }
    logger.error("Server listen error", { error: String(err), port });
  });

  server.on("listening", () => {
    writePortFile(port);
    logger.info("Agent API server started", { port, auth: !!API_SECRET });
    if (port !== DASHBOARD_PORT) {
      logger.warn(`Agent API on port ${port} (${DASHBOARD_PORT} was in use)`);
    }
    console.log(`\n\x1b[1;36m  ▸ Agent API: http://127.0.0.1:${port}/api\x1b[0m`);
    console.log(`\x1b[1;32m  ▸ Dashboard: https://agents.clipx.app\x1b[0m\n`);
  });

  // Bind to localhost only — Nginx reverse proxy handles external access
  server.listen(port, "127.0.0.1");
  startStateBroadcast();

  // Graceful shutdown
  const shutdown = () => {
    if (stateInterval) clearInterval(stateInterval);
    for (const client of sseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    sseClients.clear();
    server.close(() => {
      logger.info("HTTP server closed");
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return server;
}
