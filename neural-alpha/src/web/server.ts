import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { TradingAgent, AgentState } from "../agent.js";
import { addLogListener, removeLogListener, type LogListener } from "../utils/logger.js";
import { logger } from "../utils/logger.js";
import type { LogEntry } from "../utils/types.js";

const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || "3847", 10);

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

function cors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res: ServerResponse, data: unknown, status = 200) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function handleApi(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url || "/";

  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return true;
  }

  if (url === "/api/state" && req.method === "GET") {
    if (!agentRef) return json(res, { error: "Agent not initialized" }, 503), true;
    json(res, agentRef.getStateSnapshot());
    return true;
  }

  if (url === "/api/logs" && req.method === "GET") {
    json(res, recentLogs.slice(-100));
    return true;
  }

  if (url === "/api/control/stop" && req.method === "POST") {
    if (!agentRef) return json(res, { error: "Agent not initialized" }, 503), true;
    agentRef.stop();
    json(res, { ok: true, message: "Stop requested" });
    return true;
  }

  if (url === "/api/wallet" && req.method === "GET") {
    if (!agentRef) return json(res, { error: "Agent not initialized" }, 503), true;
    agentRef.getWalletInfo().then((w) => json(res, w)).catch((e) => json(res, { error: String(e) }, 500));
    return true;
  }

  if (url === "/api/wallet/sync" && req.method === "POST") {
    if (!agentRef) return json(res, { error: "Agent not initialized" }, 503), true;
    agentRef.syncWalletCapital().then((r) => json(res, r)).catch((e) => json(res, { error: String(e) }, 500));
    return true;
  }

  if (url === "/api/wallet/mode" && req.method === "POST") {
    if (!agentRef) return json(res, { error: "Agent not initialized" }, 503), true;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { mode } = JSON.parse(body) as { mode: "local" | "walletconnect" };
        agentRef!.switchWalletMode(mode)
          .then((r) => json(res, { ok: true, ...r }))
          .catch((e) => json(res, { error: String(e) }, 500));
      } catch {
        json(res, { error: "Invalid JSON — mode must be local or walletconnect" }, 400);
      }
    });
    return true;
  }

  if (url === "/api/competition/register" && req.method === "POST") {
    if (!agentRef) return json(res, { error: "Agent not initialized" }, 503), true;
    agentRef.registerCompetition().then((r) => json(res, r)).catch((e) => json(res, { error: String(e) }, 500));
    return true;
  }

  if (url === "/api/competition/status" && req.method === "GET") {
    if (!agentRef) return json(res, { error: "Agent not initialized" }, 503), true;
    agentRef.getWalletInfo().then((w) => json(res, {
      registered: w.registered,
      registrationOpen: w.registrationOpen,
      address: w.address,
    })).catch((e) => json(res, { error: String(e) }, 500));
    return true;
  }

  if (url.startsWith("/api/control/watchlist") && req.method === "POST") {
    if (!agentRef) return json(res, { error: "Agent not initialized" }, 503), true;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { tokens } = JSON.parse(body);
        if (Array.isArray(tokens)) {
          agentRef!.updateWatchlist(tokens);
          json(res, { ok: true, watchlist: tokens });
        } else {
          json(res, { error: "tokens must be an array" }, 400);
        }
      } catch {
        json(res, { error: "Invalid JSON" }, 400);
      }
    });
    return true;
  }

  if (url === "/api/control/config" && req.method === "POST") {
    if (!agentRef) return json(res, { error: "Agent not initialized" }, 503), true;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const updates = JSON.parse(body);
        agentRef!.updateConfig(updates);
        json(res, { ok: true, config: agentRef!.getConfig() });
      } catch {
        json(res, { error: "Invalid JSON" }, 400);
      }
    });
    return true;
  }

  if (url === "/api/events" && req.method === "GET") {
    cors(res);
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

  const server = createServer((req, res) => {
    const url = req.url || "/";

    if (url.startsWith("/api/")) {
      if (!handleApi(req, res)) {
        json(res, { error: "Not found" }, 404);
      }
      return;
    }

    if (url === "/" || url === "/index.html") {
      cors(res);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Neural Alpha Agent API — use http://localhost:3000 for the dashboard");
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(DASHBOARD_PORT, () => {
    logger.info("Agent API server started", { port: DASHBOARD_PORT });
    console.log(`\n\x1b[1;36m  ▸ Agent API: http://localhost:${DASHBOARD_PORT}/api\x1b[0m`);
    console.log(`\x1b[1;32m  ▸ Dashboard: http://localhost:3000\x1b[0m\n`);
  });

  startStateBroadcast();

  return server;
}
