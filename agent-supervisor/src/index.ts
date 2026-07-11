import http from "http";
import { ensureFleetSchema, getPool } from "./db.js";
import {
  fleetSummary,
  getAgentRuntimeStatus,
  reconcileFleet,
  startAgentProcess,
  stopAgentProcess,
} from "./lifecycle.js";

const PORT = parseInt(process.env.SUPERVISOR_PORT || "4200", 10);
const HOST = process.env.SUPERVISOR_HOST || "127.0.0.1";
const RECONCILE_MS = parseInt(
  process.env.SUPERVISOR_RECONCILE_MS || "30000",
  10
);

function authOk(req: http.IncomingMessage): boolean {
  const secret = process.env.SUPERVISOR_SECRET?.trim();
  // Localhost-only bind is the primary security boundary.
  // When SUPERVISOR_SECRET is set, require Bearer match.
  if (!secret) return true;
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return token === secret;
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function send(
  res: http.ServerResponse,
  status: number,
  body: unknown
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const path = url.pathname.replace(/\/$/, "") || "/";
  const method = req.method || "GET";

  if (path === "/health" || path === "/v1/health") {
    send(res, 200, {
      ok: true,
      service: "neural-supervisor",
      ts: Date.now(),
      db: !!getPool(),
    });
    return;
  }

  if (!authOk(req)) {
    send(res, 401, { error: "Unauthorized" });
    return;
  }

  // GET /v1/agents — fleet summary
  if (method === "GET" && path === "/v1/agents") {
    send(res, 200, fleetSummary());
    return;
  }

  // GET /v1/agents/:id/runtime
  const runtimeMatch = path.match(/^\/v1\/agents\/([^/]+)\/runtime$/);
  if (method === "GET" && runtimeMatch) {
    const rt = await getAgentRuntimeStatus(runtimeMatch[1]);
    if (!rt) {
      send(res, 404, { error: "Agent not found" });
      return;
    }
    send(res, 200, rt);
    return;
  }

  // POST /v1/agents/:id/start
  const startMatch = path.match(/^\/v1\/agents\/([^/]+)\/start$/);
  if (method === "POST" && startMatch) {
    const body = (await readJson(req)) as {
      envOverride?: Record<string, string>;
    };
    const result = await startAgentProcess(startMatch[1], {
      envOverride: body.envOverride,
    });
    send(res, result.ok ? 200 : 502, result);
    return;
  }

  // POST /v1/agents/:id/stop
  const stopMatch = path.match(/^\/v1\/agents\/([^/]+)\/stop$/);
  if (method === "POST" && stopMatch) {
    const result = await stopAgentProcess(stopMatch[1]);
    send(res, 200, result);
    return;
  }

  // POST /v1/agents/:id/restart
  const restartMatch = path.match(/^\/v1\/agents\/([^/]+)\/restart$/);
  if (method === "POST" && restartMatch) {
    await stopAgentProcess(restartMatch[1]);
    await new Promise((r) => setTimeout(r, 500));
    const result = await startAgentProcess(restartMatch[1]);
    send(res, result.ok ? 200 : 502, result);
    return;
  }

  // POST /v1/reconcile
  if (method === "POST" && path === "/v1/reconcile") {
    const result = await reconcileFleet();
    send(res, 200, result);
    return;
  }

  send(res, 404, { error: "Not found" });
}

async function main() {
  await ensureFleetSchema();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("[supervisor] request error", err);
      send(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(
      `\x1b[1;36m  ▸ Agent Supervisor: http://${HOST}:${PORT}/v1\x1b[0m`
    );
  });

  // Periodic fleet reconcile
  const tick = async () => {
    try {
      const r = await reconcileFleet();
      if (r.respawned > 0) {
        console.log(
          `[supervisor] reconcile: checked=${r.checked} healthy=${r.healthy} respawned=${r.respawned}`
        );
      }
    } catch (err) {
      console.warn("[supervisor] reconcile error", err);
    }
  };
  // Initial reconcile after short delay (let feed come up)
  setTimeout(() => void tick(), 5_000);
  setInterval(() => void tick(), RECONCILE_MS);
}

main().catch((err) => {
  console.error("[supervisor] fatal", err);
  process.exit(1);
});
