import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDocker } from "./docker.mjs";
import { tenantDir, writeTenantFiles } from "./files.mjs";
import {
  CALLS_PER_CYCLE,
  containerName,
  estimatedUsePerMin,
  hostPlan,
  projectName,
  resolveRisk,
  staggerSeconds,
} from "./policy.mjs";
import { openStore } from "./store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const QR_RE = /^[A-Za-z0-9_-]{4,128}$/;

export function loadConfig(env = process.env) {
  const num = (name, fallback) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const plan = hostPlan({
    ramMb: num("SAAS_HOST_RAM_MB", 16_384),
    mbPerTenant: num("SAAS_MB_PER_TENANT", 512),
    budgetPerMin: num("SAAS_UPSTREAM_PER_MIN", 60),
    callsPerCycle: num("SAAS_CALLS_PER_CYCLE", CALLS_PER_CYCLE),
    minIntervalMs: num("SAAS_MIN_INTERVAL_MS", 300_000),
    maxIntervalMs: num("SAAS_MAX_INTERVAL_MS", 900_000),
    maxTenantsCap: num("SAAS_MAX_TENANTS", 20),
    reservePct: env.SAAS_RAM_RESERVE_PCT ? Number(env.SAAS_RAM_RESERVE_PCT) : 0.3,
  });
  return {
    hostId: env.SAAS_HOST_ID?.trim() || "local",
    dataRoot: env.SAAS_DATA_ROOT || join(REPO_ROOT, "saas/runtime"),
    repoRoot: env.SAAS_REPO_ROOT || REPO_ROOT,
    composeFile: join(REPO_ROOT, "saas/worker/compose.yaml"),
    dbPath: env.SAAS_DB_PATH || join(env.SAAS_DATA_ROOT || join(REPO_ROOT, "saas/runtime"), "control.sqlite"),
    apiSecret: env.CONTROL_API_SECRET?.trim() || "",
    databaseUrl: env.TENANT_DATABASE_URL?.trim() || "",
    bind: "127.0.0.1",
    port: num("SAAS_CONTROL_PORT", 3910),
    plan,
  };
}

export function createHandler({ store, docker, config, now = () => new Date() }) {
  const limits = new Map();

  return async function handler(req, res) {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (!allow(limits, clientIp(req), url.pathname, req.method || "GET")) {
        return send(res, 429, { error: "too many requests" });
      }
      if (!authorized(req, config.apiSecret)) return send(res, 401, { error: "unauthorized" });

      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, hostId: config.hostId });
      }
      if (req.method === "GET" && url.pathname === "/capacity") {
        return send(res, 200, await capacity(store, docker, config));
      }
      if (req.method === "GET" && url.pathname === "/recovery") {
        return send(res, 200, { hostId: config.hostId, tenants: store.list() });
      }
      if (req.method === "POST" && url.pathname === "/recovery/adopt") {
        const body = await readJson(req);
        if (body.confirm !== "adopt-this-host") return send(res, 400, { error: "confirm adopt-this-host" });
        const adopted = store.adoptHost(config.hostId, now().toISOString());
        return send(res, 200, { adopted, hostId: config.hostId });
      }
      if (req.method === "GET" && url.pathname === "/tenants") {
        return send(res, 200, { tenants: store.list().filter((row) => row.host_id === config.hostId) });
      }
      if (req.method === "POST" && url.pathname === "/tenants") {
        return send(res, 201, await createTenant({ store, docker, config, now }));
      }

      const match = url.pathname.match(/^\/tenants\/([a-z0-9]{8})(\/[^/]+(?:\/[^/]+)?)?$/);
      if (!match) return send(res, 404, { error: "not found" });
      const tenant = localTenant(store, config, match[1]);
      if (!tenant) return send(res, 404, { error: "tenant not found on this server" });
      const action = match[2] || "";

      if (req.method === "GET" && action === "") return send(res, 200, { tenant });
      if (req.method === "POST" && action === "/pause") {
        await docker.stop(dockerTarget(tenant));
        return send(res, 200, { tenant: store.update(tenant.id, { status: "paused", updated_at: now().toISOString() }) });
      }
      if (req.method === "POST" && action === "/resume") {
        await docker.start(dockerTarget(tenant));
        return send(res, 200, { tenant: store.update(tenant.id, { status: "running", updated_at: now().toISOString() }) });
      }
      if (req.method === "POST" && action === "/stop") {
        await docker.down(dockerTarget(tenant));
        return send(res, 200, { tenant: store.update(tenant.id, { status: "stopped", updated_at: now().toISOString() }) });
      }
      if (req.method === "POST" && action === "/risk") {
        const body = await readJson(req);
        const risk = resolveRisk(body.preset);
        const updated = applySpec(store, tenant, { risk, agentMode: tenant.agent_mode }, config, now);
        if (tenant.status === "running") await docker.up(dockerTarget(updated));
        return send(res, 200, { tenant: updated });
      }
      if (req.method === "POST" && action === "/mode") {
        const body = await readJson(req);
        if (body.mode !== "paper" && body.mode !== "live") return send(res, 400, { error: "mode must be paper or live" });
        if (body.mode === "live" && !tenant.wallet_address) {
          return send(res, 409, { error: "pair a wallet before live mode" });
        }
        const updated = applySpec(store, tenant, { risk: riskFromRow(tenant), agentMode: body.mode }, config, now);
        if (tenant.status === "running" || tenant.status === "paused") await docker.up(dockerTarget(updated));
        const status = tenant.status === "paused" ? "running" : tenant.status;
        return send(res, 200, { tenant: store.update(updated.id, { status, updated_at: now().toISOString() }) });
      }
      if (req.method === "POST" && action === "/pair/start") {
        if (tenant.status !== "running") return send(res, 409, { error: "tenant container is not running" });
        const payload = await docker.signin(tenant.container_name);
        const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
        return send(res, 200, {
          qrCodeId: data.qrCodeId,
          pairingCode: data.pairingCode,
          urlForWeb: data.urlForWeb,
        });
      }
      if (req.method === "POST" && action === "/pair/verify") {
        const body = await readJson(req);
        if (!QR_RE.test(body.qrCodeId || "")) return send(res, 400, { error: "qrCodeId is invalid" });
        await docker.verify(tenant.container_name, body.qrCodeId);
        const address = await docker.walletAddress(tenant.container_name);
        if (tenant.wallet_address && address && tenant.wallet_address !== address) {
          return send(res, 409, { error: "wallet address changed; refusing to replace it" });
        }
        return send(res, 200, {
          tenant: store.update(tenant.id, {
            wallet_address: address || tenant.wallet_address,
            updated_at: now().toISOString(),
          }),
        });
      }
      return send(res, 404, { error: "not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "control error";
      const status = Number(err.status) || (/must be|invalid|escapes|preset|too large|json/.test(message) ? 400 : 500);
      return send(res, status, { error: message });
    }
  };
}

async function createTenant({ store, docker, config, now }) {
  const open = new Set(["provisioning", "running", "paused"]);
  const rows = store.list().filter((row) => row.host_id === config.hostId && open.has(row.status));
  if (rows.length >= config.plan.maxTenants) {
    const err = new Error("this server is at its tenant limit");
    err.status = 409;
    throw err;
  }
  const id = newId(store);
  const risk = resolveRisk("cautious");
  const stamp = now().toISOString();
  const dir = tenantDir(config.dataRoot, id);
  const row = {
    id,
    host_id: config.hostId,
    status: "provisioning",
    container_name: containerName(id),
    data_dir: dir,
    risk_preset: risk.preset,
    agent_mode: "paper",
    max_position_usd: risk.maxPositionUsd,
    max_drawdown_pct: risk.maxDrawdownPct,
    max_trade_usd: risk.maxTradeUsd,
    trade_interval_ms: config.plan.intervalMs,
    wallet_address: null,
    created_at: stamp,
    updated_at: stamp,
  };
  store.insert(row);
  const spec = specFrom(row, risk, config);
  try {
    writeTenantFiles(dir, spec);
    await docker.ensureNetwork();
    await docker.ensureImage();
    await docker.up(dockerTarget(row));
  } catch (err) {
    try {
      await docker.down(dockerTarget(row));
    } catch {
      /* the container may never have started */
    }
    store.update(id, { status: "error", updated_at: now().toISOString() });
    throw err;
  }
  return { tenant: store.update(id, { status: "running", updated_at: now().toISOString() }) };
}

function applySpec(store, tenant, { risk, agentMode }, config, now) {
  const stamp = now().toISOString();
  const next = {
    ...tenant,
    risk_preset: risk.preset,
    agent_mode: agentMode,
    max_position_usd: risk.maxPositionUsd,
    max_drawdown_pct: risk.maxDrawdownPct,
    max_trade_usd: risk.maxTradeUsd,
    trade_interval_ms: config.plan.intervalMs,
    updated_at: stamp,
  };
  writeTenantFiles(tenant.data_dir, specFrom(next, risk, config));
  return store.update(tenant.id, {
    risk_preset: next.risk_preset,
    agent_mode: next.agent_mode,
    max_position_usd: next.max_position_usd,
    max_drawdown_pct: next.max_drawdown_pct,
    max_trade_usd: next.max_trade_usd,
    trade_interval_ms: next.trade_interval_ms,
    updated_at: stamp,
  });
}

function specFrom(row, risk, config) {
  return {
    dataDir: row.data_dir,
    containerName: row.container_name,
    agentMode: row.agent_mode,
    intervalMs: config.plan.intervalMs,
    staggerSec: staggerSeconds(row.id),
    risk,
    databaseUrl: config.databaseUrl,
  };
}

function dockerTarget(row) {
  return {
    project: projectName(row.id),
    overrideFile: join(row.data_dir, "override.yml"),
    containerName: row.container_name,
  };
}

function riskFromRow(row) {
  return resolveRisk(row.risk_preset);
}

function localTenant(store, config, id) {
  const row = store.get(id);
  if (!row || row.host_id !== config.hostId) return null;
  return row;
}

async function capacity(store, docker, config) {
  const mine = store.list().filter((row) => row.host_id === config.hostId);
  const running = mine.filter((row) => row.status === "running").length;
  let orphans = [];
  try {
    const names = await docker.listContainers();
    const known = new Set(store.list().map((row) => row.container_name));
    orphans = names.filter((name) => /^na-[a-z0-9]{8}$/.test(name) && !known.has(name));
  } catch {
    orphans = [];
  }
  return {
    hostId: config.hostId,
    maxTenants: config.plan.maxTenants,
    intervalMs: config.plan.intervalMs,
    upstreamBudgetPerMin: config.plan.budgetPerMin,
    estimatedUsePerMin: estimatedUsePerMin(running, config.plan.intervalMs, config.plan.callsPerCycle),
    estimatedUseAtFull: config.plan.fullUsePerMin,
    tenants: mine.length,
    running,
    orphans,
  };
}

function newId(store) {
  for (let i = 0; i < 5; i += 1) {
    const id = randomBytes(4).toString("hex");
    if (!store.get(id)) return id;
  }
  throw new Error("could not allocate a tenant id");
}

function authorized(req, secret) {
  if (!secret) return true;
  const header = req.headers.authorization || "";
  return header === `Bearer ${secret}`;
}

function allow(limits, ip, pathname, method) {
  const create = method === "POST" && pathname === "/tenants";
  const key = `${ip}:${create ? "create" : "api"}`;
  const max = create ? 10 : 120;
  const now = Date.now();
  let bucket = limits.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + 60_000 };
    limits.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count <= max;
}

function clientIp(req) {
  return req.socket?.remoteAddress || "local";
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 32_768) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

export function start(config = loadConfig(), deps = {}) {
  const store = deps.store || openStore(config.dbPath);
  const docker = deps.docker || createDocker({ repoRoot: config.repoRoot, composeFile: config.composeFile });
  const server = createServer(createHandler({ store, docker, config }));
  server.listen(config.port, config.bind);
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) start();
