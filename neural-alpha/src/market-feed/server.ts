import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getSnapshot, getStatus } from "./store.js";
import { startPollLoop, POLL_MS } from "./poller.js";
import { logger } from "../utils/logger.js";

const PORT = parseInt(process.env.MARKET_FEED_PORT || "4100", 10) || 4100;

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname.replace(/\/$/, "") || "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  if (path === "/health" || path === "/status") {
    const status = getStatus();
    sendJson(res, status.ok ? 200 : 503, { ...status, pollMs: POLL_MS });
    return;
  }

  if (path === "/snapshot") {
    const status = getStatus();
    const snap = getSnapshot();
    if (!snap.updatedAt || status.stale) {
      sendJson(res, 503, {
        error: status.stale ? "snapshot stale" : "snapshot not ready yet",
        ...status,
      });
      return;
    }
    sendJson(res, 200, snap);
    return;
  }

  if (path === "/quotes") {
    const snap = getSnapshot();
    sendJson(res, 200, {
      updatedAt: snap.updatedAt,
      quotes: snap.quotes,
    });
    return;
  }

  if (path === "/trending") {
    const snap = getSnapshot();
    sendJson(res, 200, {
      updatedAt: snap.updatedAt,
      trending: snap.trending,
    });
    return;
  }

  sendJson(res, 404, {
    error: "not found",
    endpoints: ["/health", "/status", "/snapshot", "/quotes", "/trending"],
  });
}

export function startMarketFeedServer() {
  startPollLoop();
  const server = createServer(handle);
  server.listen(PORT, "127.0.0.1", () => {
    logger.info("Market feed listening", {
      url: `http://127.0.0.1:${PORT}`,
      pollMs: POLL_MS,
    });
  });
  return server;
}
