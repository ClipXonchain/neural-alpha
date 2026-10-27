import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBnbPriceFeed } from "./bnb-price.mjs";
import { createDocker } from "./docker.mjs";
import { createAttemptLimiter } from "./limiter.mjs";
import { planLifecycle, reminderText, subscriptionState } from "./lifecycle.mjs";
import { rollout, TAG_RE } from "./rollout.mjs";
import { backupAll, parseBackupKey, syncOffsite } from "./tenant-backup.mjs";
import {
  createTelegram,
  handleInbound,
  hashTelegramCode,
  newTelegramCode,
  NOT_LINKED_REPLY,
  startPolling,
  TELEGRAM_CODE_TTL_MS,
} from "./telegram.mjs";
import { evaluate, parseAlerts } from "./watchdog.mjs";
import { createEdgeCluster, formatCompoundToken, normalizeBaseUrl, parseCompoundToken } from "./edge.mjs";
import { tenantDir, writeTenantFiles } from "./files.mjs";
import { createBscRpc, createTreasuryWatcher, ERC20_TRANSFER_TOPIC, padTopicAddress, readConfirmationCount, verifyBinanceWalletPayment, verifyBscReceipt } from "./payments.mjs";
import {
  assertAddress,
  assertPayment,
  CALLS_PER_CYCLE,
  CHECKOUT_EXPIRY_MS,
  CHECKOUT_PROVISION_RETRY_MS,
  CHECKOUT_SETTLEMENT_GRACE_MS,
  checkoutAmountIsCurrent,
  containerName,
  estimatedUsePerMin,
  formatUnits18,
  hostPlan,
  parseUnits18,
  PAYMENT_ASSETS,
  projectName,
  quoteOrderAmount,
  QUOTE_MARKER_MAX,
  REQUIRED_CONFIRMATIONS,
  SOFTWARE_BNB_PRICE_USD,
  SOFTWARE_FEE_USD,
  resolveRisk,
  resolveTokenContracts,
  staggerSeconds,
  SUBSCRIPTION_MS,
} from "./policy.mjs";
import { attachSaasBackup, safeError, watchUserRecords } from "./neon-backup.mjs";
import { openStore } from "./store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const QR_RE = /^[A-Za-z0-9_-]{4,128}$/;
/** Signed-in browsers per agent, counting the original purchase token. */
export const MAX_SESSIONS = 3;
const WALLET_RE = /^0x[a-f0-9]{40}$/;

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
  const devSandbox = env.SAAS_DEV_SANDBOX === "1";
  const rawTreasury =
    env.SAAS_TREASURY_ADDRESS?.trim() || (devSandbox ? "0x1111111111111111111111111111111111111111" : "");
  return {
    hostId: env.SAAS_HOST_ID?.trim() || "local",
    dataRoot: env.SAAS_DATA_ROOT || join(REPO_ROOT, "saas/runtime"),
    repoRoot: env.SAAS_REPO_ROOT || REPO_ROOT,
    composeFile: join(REPO_ROOT, "saas/worker/compose.yaml"),
    dbPath: env.SAAS_DB_PATH || join(env.SAAS_DATA_ROOT || join(REPO_ROOT, "saas/runtime"), "control.sqlite"),
    apiSecret: env.CONTROL_API_SECRET?.trim() || (devSandbox ? "dev-operator-secret" : ""),
    monitorSecret: env.SAAS_MONITOR_SECRET?.trim() || (devSandbox ? "dev-monitor-secret" : ""),
    databaseUrl: env.TENANT_DATABASE_URL?.trim() || env.DATABASE_URL?.trim() || "",
    treasuryAddress: rawTreasury ? assertAddress(rawTreasury, "SAAS_TREASURY_ADDRESS") : "",
    priceUsd: num("SAAS_PRICE_USD", SOFTWARE_FEE_USD),
    bnbPriceUsd: num("SAAS_BNB_PRICE_USD", SOFTWARE_BNB_PRICE_USD),
    minConfirmations: num("SAAS_MIN_CONFIRMATIONS", REQUIRED_CONFIRMATIONS),
    bscRpcUrl: env.SAAS_BSC_RPC_URL?.trim() || "https://bsc-dataseed.binance.org",
    web3ApiKey: env.OC_API_KEY?.trim() || "",
    web3SecretKey: env.OC_SECRET_KEY?.trim() || "",
    tokenContracts: resolveTokenContracts(env),
    cellNodesEnv: env.SAAS_CELL_NODES?.trim() || "",
    edgeOnly: env.SAAS_EDGE_ONLY === "1",
    devSandbox,
    bind: env.SAAS_BIND_HOST?.trim() || "127.0.0.1",
    port: num("SAAS_CONTROL_PORT", 3910),
    portalUrl: env.SAAS_APP_URL?.trim() || "https://neuralalpha.io/portal",
    localPortalUrl: env.SAAS_LOCAL_APP_URL?.trim() || "http://127.0.0.1:3000/portal",
    demo: env.SAAS_DESK_DEMO === "1",
    streamIntervalMs: num("SAAS_DESK_STREAM_MS", 3000),
    operatorAgent: formatAgentId(env.SAAS_OPERATOR_AGENT_ID),
    // One bot for the whole service. Every cell sends alerts; only one process polls.
    telegramToken: env.TELEGRAM_BOT_TOKEN?.trim() || "",
    telegramBotUsername: env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "") || "",
    telegramOpsChatId: env.TELEGRAM_OPS_CHAT_ID?.trim() || "",
    telegramPoll: env.TELEGRAM_BOT_POLL === "1",
    // Only for tests against a fake Telegram on localhost.
    telegramApiBase: env.TELEGRAM_API_BASE?.trim() || "https://api.telegram.org",
    maintenanceMs: Math.max(5000, num("SAAS_MAINTENANCE_MS", 60_000)),
    backupKey: env.SAAS_BACKUP_KEY?.trim() || "",
    backupDir: env.SAAS_BACKUP_DIR?.trim() || "",
    backupRsync: env.SAAS_BACKUP_RSYNC?.trim() || "",
    backupEveryMs: num("SAAS_BACKUP_HOURS", 24) * 3_600_000,
    rolloutPollMs: num("SAAS_ROLLOUT_POLL_MS", 5000),
    rolloutTimeoutMs: num("SAAS_ROLLOUT_TIMEOUT_MS", 150_000),
    plan,
  };
}

const LOCAL_PORTAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function portalLocation(req, config) {
  const raw = String(req.headers?.host || req.headers?.["x-forwarded-host"] || "").split(",")[0].trim().toLowerCase();
  const host = raw.startsWith("[") ? raw.slice(1, raw.indexOf("]")) : raw.split(":")[0];
  if (host && !LOCAL_PORTAL_HOSTS.has(host)) return config.portalUrl;
  const base = config.localPortalUrl || "http://127.0.0.1:3000/portal";
  try {
    const url = new URL(base);
    if (host === "localhost" || host === "127.0.0.1") url.hostname = host;
    return url.toString().replace(/\/$/, "");
  } catch {
    return base;
  }
}

export function adminLocation(req, config) {
  return appPath(portalLocation(req, config), "/admin");
}

function appPath(location, pathname) {
  try {
    const url = new URL(location);
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return String(location || "").replace(/\/portal\/?$/, pathname);
  }
}

export function formatAgentId(value) {
  const name = String(value || "").trim().toLowerCase().replace(/\.ai$/, "");
  if (!/^[a-z0-9]{3,15}$/.test(name)) return null;
  return name + ".ai";
}

export function createHandler({ store, docker, config, rpc, fetchImpl, bnbPrice, telegram: injectedTelegram, now = () => new Date() }) {
  const telegram =
    injectedTelegram ||
    createTelegram({ token: config.telegramToken, opsChatId: config.telegramOpsChatId, apiBase: config.telegramApiBase, fetchImpl });
  let rolloutJob = null;
  const currentBnbPriceUsd = () => {
    const live = Number(bnbPrice?.priceUsd?.());
    return Number.isFinite(live) && live > 0 ? live : config.bnbPriceUsd;
  };
  const limits = new Map();
  const codeAttempts = createAttemptLimiter({ max: 8, windowMs: 60_000 });
  const boot = Date.now();
  let requests = 0;
  const bscRpc = rpc || (config.bscRpcUrl ? createBscRpc(config.bscRpcUrl, fetchImpl) : null);
  // Receipt checks and tenant creation mutate shared order/payment state. Keep
  // them serial in one control process so simultaneous watcher and browser
  // requests cannot provision twice or spend one transaction on two orders.
  let fulfillmentQueue = Promise.resolve();
  const serializePaymentWork = (work) => {
    const task = fulfillmentQueue.then(work);
    fulfillmentQueue = task.then(() => undefined, () => undefined);
    return task;
  };
  const fulfillQueued = (args) => serializePaymentWork(() => fulfillOrderWithTx(args));
  const edge = createEdgeCluster({
    store,
    config,
    localCapacity: () => capacity(store, docker, config),
    fetchImpl,
  });
  const pairings = new Map();
  // An agent, an order or a wallet belongs to the cell that took it. When this server has no record,
  // it asks the registered cells, so sign-in and checkout also work through an edge-only mother.
  const remoteCells = () => edge.listRegisteredNodes().filter((n) => n.hostId !== config.hostId);
  async function askCells(method, path, body, headers, accept) {
    for (const node of remoteCells()) {
      try {
        const r = await edge.forwardJson(node.hostId, method, path, body, undefined, headers);
        if (accept(r)) return r;
      } catch {
        /* a cell that is down cannot answer */
      }
    }
    return null;
  }
  void promotePaperTenants({ store, docker, config, now }).catch(() => undefined);
  const watcher = createTreasuryWatcher({
    store,
    config,
    rpc: bscRpc,
    fetchImpl,
    now,
    onOrderPaid: (orderId, txHash) =>
      fulfillQueued({ store, docker, config, rpc: bscRpc, fetchImpl, now, orderId, paymentTx: txHash, fromWatcher: true }),
  });
  const desk = createDeskStream(async () => ({
    overview: await overview(store, docker, config, { uptimeMs: Date.now() - boot, requests }),
    live: await liveBoard(store, docker, config),
  }), config.streamIntervalMs);

  const handler = async function handler(req, res) {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (!allow(limits, clientIp(req), url.pathname, req.method || "GET")) {
        return send(res, 429, { error: "too many requests" });
      }
      requests += 1;
      const actor = identify(req, config, store);
      if (req.headers["x-neural-desk"] === "observe" && req.method !== "GET" && req.method !== "HEAD") {
        return send(res, 403, { error: "the monitor desk is read only" });
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, hostId: config.hostId });
      }
      if (req.method === "GET" && url.pathname === "/pricing") {
        const bnbPriceUsd = currentBnbPriceUsd();
        const mark = bnbPrice?.snapshot?.() || { source: "fallback", updatedAt: null };
        return send(res, 200, {
          feeUsd: config.priceUsd,
          bnbPriceUsd,
          bnbPriceSource: mark.source || "fallback",
          bnbPriceUpdatedAt: mark.updatedAt || null,
          bnbAmountDisplay: quoteOrderAmount({ asset: "BNB", priceUsd: config.priceUsd, bnbPriceUsd, tail: 0 }).amountDisplay,
          refreshMs: 4 * 60 * 60 * 1000,
        });
      }
      if (
        (req.method === "GET" || req.method === "HEAD") &&
        (url.pathname === "/brand/neural-alpha-logo.png" ||
          url.pathname === "/brand/neural-alpha-mark.png" ||
          url.pathname === "/favicon.ico")
      ) {
        const file =
          url.pathname === "/brand/neural-alpha-logo.png"
            ? "neural-alpha-logo.png"
            : "neural-alpha-mark.png";
        try {
          const buf = readFileSync(join(REPO_ROOT, "dashboard/public/brand", file));
          res.writeHead(200, {
            "content-type": "image/png",
            "content-length": buf.length,
            "cache-control": "public, max-age=3600",
            "x-content-type-options": "nosniff",
          });
          return res.end(req.method === "HEAD" ? undefined : buf);
        } catch {
          return send(res, 404, { error: "not found" });
        }
      }
      if (
        (req.method === "GET" || req.method === "HEAD") &&
        (url.pathname === "/" || url.pathname === "/admin" || url.pathname === "/admin/")
      ) {
        res.writeHead(302, { location: adminLocation(req, config), "cache-control": "no-store" });
        return res.end();
      }
      if (
        (req.method === "GET" || req.method === "HEAD") &&
        (url.pathname === "/portal" || url.pathname === "/portal/")
      ) {
        res.writeHead(302, { location: portalLocation(req, config), "cache-control": "no-store" });
        return res.end();
      }
      if (url.pathname === "/admin/stream") {
        if (req.method !== "GET") return send(res, 405, { error: "the monitor desk is read only" });
        if (actor?.role !== "operator" && actor?.role !== "monitor") return send(res, 401, { error: "unauthorized" });
        return desk.subscribe(req, res);
      }
      if (url.pathname === "/admin/overview" || url.pathname === "/admin/live") {
        if (req.method !== "GET") return send(res, 405, { error: "the monitor desk is read only" });
        if (actor?.role !== "operator" && actor?.role !== "monitor") return send(res, 401, { error: "unauthorized" });
        if (url.pathname === "/admin/overview") {
          return send(res, 200, await overview(store, docker, config, { uptimeMs: Date.now() - boot, requests }));
        }
        return send(res, 200, await liveBoard(store, docker, config));
      }
      if (req.method === "GET" && url.pathname === "/cluster/capacity") {
        if (actor?.role !== "operator" && actor?.role !== "monitor") return send(res, 401, { error: "unauthorized" });
        return send(res, 200, await edge.clusterStatus());
      }
      if (actor?.role !== "operator" && isOperatorRoute(req.method, url.pathname)) {
        return send(res, 401, { error: "unauthorized" });
      }
      if (req.method === "POST" && url.pathname === "/cluster/nodes") {
        const body = await readJson(req);
        const hostId = String(body.hostId || "").trim();
        const baseUrl = normalizeBaseUrl(body.baseUrl);
        if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(hostId) || !baseUrl) {
          return send(res, 400, { error: "valid hostId and http(s) baseUrl are required" });
        }
        const node = store.upsertNode({ hostId, baseUrl, status: "active", updatedAt: now().toISOString() });
        return send(res, 201, { node });
      }
      const nodeDelMatch = url.pathname.match(/^\/cluster\/nodes\/([a-z0-9][a-z0-9_-]{0,31})$/i);
      if (req.method === "DELETE" && nodeDelMatch) {
        if (actor?.role !== "operator") return send(res, 401, { error: "unauthorized" });
        const removed = store.removeNode(nodeDelMatch[1]);
        return send(res, 200, { removed });
      }
      if (req.method === "POST" && url.pathname === "/telegram/inbound") {
        const body = await readJson(req);
        const result = await handleInbound({
          store,
          config,
          now,
          chatId: String(body.chatId || ""),
          text: String(body.text || ""),
          describe: (row) => describeTenant(docker, row, now),
        });
        return send(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/maintenance/run") {
        return send(res, 200, await runMaintenance({ store, docker, config, now, telegram }));
      }
      if (req.method === "POST" && url.pathname === "/backups/run") {
        return send(res, 200, await runTenantBackup({ store, config, telegram, now }));
      }
      if (req.method === "GET" && url.pathname === "/rollout") {
        return send(res, 200, rolloutJob || { status: "idle" });
      }
      if (req.method === "POST" && url.pathname === "/rollout") {
        const body = await readJson(req);
        const tag = String(body.tag || "");
        if (!TAG_RE.test(tag)) return send(res, 400, { error: "tag must be letters, digits, . _ - (max 64)" });
        if (rolloutJob?.status === "running") return send(res, 409, { error: "a rollout is already running" });
        const ids = Array.isArray(body.tenantIds) ? body.tenantIds.map(String) : null;
        let rows = store.list().filter((row) => row.host_id === config.hostId && row.status === "running" && (!ids || ids.includes(row.id)));
        // Canary: the ids you name come first in that order, otherwise paper agents go before live ones.
        rows = ids
          ? rows.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
          : rows.sort((a, b) => (a.agent_mode === "paper" ? 0 : 1) - (b.agent_mode === "paper" ? 0 : 1));
        const soakMs = Math.min(600, Math.max(0, Number(body.soakSec) || 0)) * 1000;
        const job = { id: randomBytes(4).toString("hex"), tag, status: "running", startedAt: now().toISOString(), total: rows.length, done: [] };
        rolloutJob = job;
        void rollout({
          rows,
          tag,
          soakMs,
          apply: (row, t) => applyImageTag({ store, docker, config, now }, row.id, t),
          ready: (row) => waitUntilReady({ store, docker, config }, row.id),
          onProgress: (done) => { job.done = done; },
        }).then(
          (report) => { rolloutJob = { ...job, status: report.ok ? "done" : "failed", finishedAt: now().toISOString(), report }; },
          (err) => { rolloutJob = { ...job, status: "failed", finishedAt: now().toISOString(), report: { ok: false, reason: String(err?.message || err) } }; },
        );
        return send(res, 202, job);
      }
      if (req.method === "POST" && url.pathname === "/watcher/scan") {
        return send(res, 200, await watcher.scanOnce());
      }
      if (req.method === "POST" && url.pathname === "/subscriptions/sweep") {
        return send(res, 200, await enforceSubscriptions({ store, docker, config, now }));
      }
      if (req.method === "GET" && url.pathname === "/capacity") {
        return send(res, 200, await capacity(store, docker, config));
      }
      if (req.method === "GET" && url.pathname === "/recovery") {
        return send(res, 200, { hostId: config.hostId, tenants: store.list().map(operatorView) });
      }
      if (req.method === "POST" && url.pathname === "/recovery/adopt") {
        const body = await readJson(req);
        if (body.confirm !== "adopt-this-host") return send(res, 400, { error: "confirm adopt-this-host" });
        const adopted = store.adoptHost(config.hostId, now().toISOString());
        return send(res, 200, { adopted, hostId: config.hostId });
      }
      if (req.method === "POST" && url.pathname === "/session/open") {
        const body = await readJson(req);
        try {
          return send(res, 200, openPaidSession({ store, config, now, body }));
        } catch (err) {
          if (err.status === 404 && remoteCells().length) {
            const r = await askCells("POST", "/session/open", body, {}, (x) => x.status === 200);
            if (r) return send(res, 200, r.body);
          }
          throw err;
        }
      }
      if (req.method === "POST" && url.pathname === "/session/code") {
        const body = await readJson(req);
        // The portal passes the visitor's address (trusted only from the operator-authenticated portal);
        // a direct caller is limited by its own connection. One guesser never blocks another customer.
        const client =
          actor?.role === "operator" && req.headers["x-portal-client"]
            ? String(req.headers["x-portal-client"]).slice(0, 64)
            : req.socket?.remoteAddress || "unknown";
        try {
          return send(res, 200, openByAccessCode({ store, config, now, body, limiter: codeAttempts, client }));
        } catch (err) {
          if (err.status === 401 && remoteCells().length) {
            const r = await askCells("POST", "/session/code", body, { "x-portal-client": client }, (x) => x.status === 200);
            if (r) return send(res, 200, r.body);
          }
          throw err;
        }
      }
      if (req.method === "POST" && url.pathname === "/checkout") {
        const body = await readJson(req);
        if (body.targetHostId && body.targetHostId !== config.hostId) {
          const proxied = await edge.forwardJson(body.targetHostId, "POST", "/checkout", { ...body, targetHostId: undefined });
          return send(res, proxied.status, proxied.body);
        }
        if (config.edgeOnly || (edge.listRegisteredNodes().length > 0 && !body.localOnly)) {
          const cluster = await edge.clusterStatus();
          if (!cluster.selectedHostId) {
            return send(res, 409, { error: "all customer VPS cells are currently at capacity" });
          }
          if (cluster.selectedHostId !== config.hostId) {
            const proxied = await edge.forwardJson(cluster.selectedHostId, "POST", "/checkout", { ...body, localOnly: true });
            return send(res, proxied.status, proxied.body);
          }
        }
        return send(res, 201, createCheckoutOrder({ store, config, now, body, bnbPriceUsd: currentBnbPriceUsd() }));
      }
      const checkoutMatch = url.pathname.match(/^\/checkout\/(ord_[a-f0-9]{12})(\/verify|\/claim)?$/);
      if (checkoutMatch) {
        const orderId = checkoutMatch[1];
        const subAction = checkoutMatch[2] || "";
        if (req.method === "GET" && subAction === "") {
          let order = await serializePaymentWork(() =>
            presentCheckoutOrder({ store, config, now, orderId, bnbPriceUsd: currentBnbPriceUsd() }),
          );
          if (!order) {
            const r = remoteCells().length ? await askCells("GET", `/checkout/${orderId}`, undefined, {}, (x) => x.status === 200) : null;
            if (r) return send(res, 200, r.body);
            return send(res, 404, { error: "order not found" });
          }
          if (order.status === "pending" && order.payment_tx && bscRpc) {
            try {
              const confirmations = await readConfirmationCount(bscRpc, order.payment_tx);
              if (typeof confirmations === "number") {
                order = store.updateOrder(order.id, { confirmations, updated_at: now().toISOString() }) || order;
                if (confirmations >= config.minConfirmations) {
                  await fulfillQueued({
                    store,
                    docker,
                    config,
                    rpc: bscRpc,
                    fetchImpl,
                    now,
                    orderId: order.id,
                    paymentTx: order.payment_tx,
                    fromWatcher: true,
                  });
                  order = store.getOrder(order.id) || order;
                }
              }
            } catch {
              // Keep the last saved count. The pay screen still loads.
            }
          }
          return send(res, 200, { order: publicOrderView(order, config.minConfirmations) });
        }
        // The order may live on another cell: ask them when this server has no such order.
        const orderIsLocal = () => Boolean(store.getOrder(orderId));
        if (req.method === "POST" && subAction === "/verify") {
          const body = await readJson(req);
          if (!orderIsLocal() && remoteCells().length) {
            const r = await askCells("POST", `/checkout/${orderId}/verify`, body, {}, (x) => x.status !== 404);
            if (r) return send(res, r.status, r.body);
          }
          const payer = assertAddress(body.payer, "payer");
          const result = await fulfillQueued({
            store,
            docker,
            config,
            rpc: bscRpc,
            fetchImpl,
            now,
            orderId,
            paymentTx: body.paymentTx,
            claimSecret: body.claimSecret,
            expectedPayer: payer,
          });
          return send(res, 200, result);
        }
        if (req.method === "POST" && subAction === "/claim") {
          const body = await readJson(req);
          if (!orderIsLocal() && remoteCells().length) {
            const r = await askCells("POST", `/checkout/${orderId}/claim`, body, {}, (x) => x.status !== 404);
            if (r) return send(res, r.status, r.body);
          }
          return send(res, 200, claimPaidOrder({ store, config, orderId, claimSecret: body.claimSecret }));
        }
      }
      if (req.method === "GET" && url.pathname === "/tenants") {
        return send(res, 200, {
          tenants: store.list().filter((row) => row.host_id === config.hostId).map(operatorView),
        });
      }
      if (req.method === "POST" && url.pathname === "/tenants") {
        const body = await readJson(req);
        if (body.orderId) {
          const result = await fulfillQueued({
            store,
            docker,
            config,
            rpc: bscRpc,
            fetchImpl,
            now,
            orderId: String(body.orderId),
            paymentTx: body.paymentTx,
            claimSecret: body.claimSecret,
          });
          return send(res, 201, result);
        }
        const created = await serializePaymentWork(async () => {
          const payment = assertPayment(body);
          let verified = null;
          if (config.treasuryAddress) {
            if (!bscRpc) throw Object.assign(new Error("BSC RPC is required for receipt verification"), { status: 503 });
            verified = await verifyBscReceipt({
              rpc: bscRpc,
              txHash: payment.tx,
              asset: payment.asset,
              treasuryAddress: config.treasuryAddress,
              contracts: config.tokenContracts,
              minAmountWei:
                payment.asset === "BNB"
                  ? quoteOrderAmount({ asset: "BNB", priceUsd: config.priceUsd, bnbPriceUsd: currentBnbPriceUsd(), tail: 0 }).amountWei
                  : parseUnits18(String(config.priceUsd)).toString(),
              minConfirmations: config.minConfirmations,
            });
          }
          return createTenant({
            store,
            docker,
            config,
            now,
            payment,
            risk: resolveRisk({
              preset: body.preset,
              positionUsd: body.positionUsd,
              x402PerDay: body.x402PerDay,
            }),
            agentName: body.agentName,
            verified,
          });
        });
        return send(res, 201, await created);
      }

      const match = url.pathname.match(/^\/tenants\/([a-z0-9]{8})(\/.*)?$/);
      if (!match) return send(res, 404, { error: "not found" });
      if (actor?.role === "remote_customer" && actor.tenantId === match[1] && actor.hostId !== config.hostId) {
        const body = req.method === "POST" ? await readJson(req) : undefined;
        const proxied = await edge.forwardJson(
          actor.hostId,
          req.method || "GET",
          url.pathname,
          body,
          `Bearer ${actor.accessToken}`,
        );
        return send(res, proxied.status, proxied.body);
      }
      const tenant = localTenant(store, config, match[1]);
      if (!tenant || !canAccess(actor, tenant.id)) return send(res, 404, { error: "not found" });
      const action = match[2] || "";

      if (req.method === "GET" && action === "") {
        return send(res, 200, { tenant: customerView(tenant, store), pairing: publicPairing(pairings.get(tenant.id)) });
      }
      if (action.startsWith("/agent/") || action === "/agent") {
        return proxyTenantAgent(req, res, docker, tenant, action, url);
      }
      if (req.method === "GET" && action === "/state") {
        const state = await readDesk(docker, tenant);
        return send(res, 200, { tenant: customerView(tenant), state });
      }
      if (req.method === "POST" && action === "/pause") {
        await docker.stop(dockerTarget(tenant));
        return send(res, 200, { tenant: customerView(store.update(tenant.id, { status: "paused", updated_at: now().toISOString() })) });
      }
      if (req.method === "POST" && action === "/resume") {
        await docker.start(dockerTarget(tenant));
        return send(res, 200, { tenant: customerView(store.update(tenant.id, { status: "running", updated_at: now().toISOString() })) });
      }
      if (req.method === "POST" && action === "/stop") {
        await docker.down(dockerTarget(tenant));
        return send(res, 200, { tenant: customerView(store.update(tenant.id, { status: "stopped", updated_at: now().toISOString() })) });
      }
      if (req.method === "POST" && action === "/risk") {
        const body = await readJson(req);
        const risk = resolveRisk({
          preset: body.preset,
          positionUsd: body.positionUsd,
          x402PerDay: body.x402PerDay == null || body.x402PerDay === "" ? tenant.x402_per_day : body.x402PerDay,
        });
        const updated = applySpec(store, tenant, { risk, agentMode: tenant.agent_mode }, config, now);
        if (tenant.status === "running") await docker.up(dockerTarget(updated));
        return send(res, 200, { tenant: customerView(updated) });
      }
      if (req.method === "POST" && action === "/signals") {
        const body = await readJson(req);
        const patch = {};
        for (const [key, col] of [["cmc", "cmc_x402"], ["studio", "studio_x402"]]) {
          if (body[key] === undefined) continue;
          if (typeof body[key] !== "boolean") return send(res, 400, { error: `${key} must be true or false` });
          patch[col] = body[key] ? 1 : 0;
        }
        if (Object.keys(patch).length === 0) return send(res, 400, { error: "send cmc or studio" });
        const flagged = store.update(tenant.id, { ...patch, updated_at: now().toISOString() });
        const updated = applySpec(store, flagged, { risk: riskFromRow(flagged), agentMode: flagged.agent_mode }, config, now);
        if (tenant.status === "running") await docker.up(dockerTarget(updated));
        return send(res, 200, { tenant: customerView(updated) });
      }
      if (req.method === "POST" && action === "/wallets") {
        // The portal checked the wallet's signature; only it (the operator) may add a login wallet.
        if (actor?.role !== "operator") return send(res, 401, { error: "unauthorized" });
        const body = await readJson(req);
        const address = String(body.address || "").toLowerCase();
        if (!WALLET_RE.test(address)) return send(res, 400, { error: "address must be a 0x wallet address" });
        store.addWallet(tenant.id, address, now().toISOString());
        return send(res, 200, { tenant: customerView(store.get(tenant.id), store) });
      }
      const walletDel = action.match(/^\/wallets\/(0x[a-fA-F0-9]{40})$/);
      if (req.method === "DELETE" && walletDel) {
        store.removeWallet(tenant.id, walletDel[1].toLowerCase());
        return send(res, 200, { tenant: customerView(store.get(tenant.id), store) });
      }
      if (req.method === "POST" && action === "/sessions/revoke") {
        // Signs out every other browser. The one asking stays signed in.
        const raw = bearer(req);
        const parsed = parseCompoundToken(raw);
        const mine = actor?.role === "customer" || actor?.role === "remote_customer" ? hashToken(parsed.compound ? parsed.accessToken : raw) : null;
        if (!mine) return send(res, 400, { error: "sign in as the customer to sign out other browsers" });
        store.revokeSessionsExcept(tenant.id, mine);
        return send(res, 200, { tenant: customerView(store.get(tenant.id), store) });
      }
      if (req.method === "POST" && action === "/cancel") {
        const body = await readJson(req);
        if (!tenant.paid_until) return send(res, 409, { error: "this agent has no paid period to cancel" });
        const updated = store.update(tenant.id, { cancel_at_period_end: body.undo === true ? 0 : 1, updated_at: now().toISOString() });
        return send(res, 200, { tenant: customerView(updated) });
      }
      if (req.method === "POST" && action === "/telegram/code") {
        if (!telegram.enabled || !config.telegramBotUsername) {
          return send(res, 503, { error: "Telegram alerts are not set up on this server" });
        }
        const code = newTelegramCode();
        const expiresAt = new Date(now().getTime() + TELEGRAM_CODE_TTL_MS).toISOString();
        store.update(tenant.id, { telegram_code_hash: hashTelegramCode(code), telegram_code_expires: expiresAt, updated_at: now().toISOString() });
        return send(res, 200, {
          code,
          expiresAt,
          bot: `@${config.telegramBotUsername}`,
          deepLink: `https://t.me/${config.telegramBotUsername}?start=${code}`,
        });
      }
      if (req.method === "POST" && action === "/telegram/unlink") {
        const updated = store.update(tenant.id, { telegram_chat_id: null, telegram_code_hash: null, telegram_code_expires: null, updated_at: now().toISOString() });
        return send(res, 200, { tenant: customerView(updated) });
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
        return send(res, 200, { tenant: customerView(store.update(updated.id, { status, updated_at: now().toISOString() })) });
      }
      if (req.method === "POST" && action === "/pair/start") {
        let current = tenant;
        if (current.status === "paused") {
          await docker.start(dockerTarget(current));
          current = store.update(current.id, { status: "running", updated_at: now().toISOString() });
        }
        if (current.status !== "running") return send(res, 409, { error: "tenant container is not running" });
        const payload = await docker.signin(current.container_name);
        const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
        const qrCodeId = String(data.qrCodeId || "");
        const urlForWeb = data.urlForWeb || data.url || data.qrCodeUrl || data.deepLink || "";
        if (QR_RE.test(qrCodeId)) beginPairWatch(pairings, { store, docker, config, now }, current, qrCodeId);
        return send(res, 200, {
          qrCodeId,
          pairingCode: data.pairingCode,
          urlForWeb,
          listening: QR_RE.test(qrCodeId),
        });
      }
      if (req.method === "POST" && action === "/access-code") {
        return send(res, 200, { accessCode: rotateAccessCode(store, tenant, now) });
      }
      if (req.method === "POST" && action === "/pair/verify") {
        const body = await readJson(req);
        if (!QR_RE.test(body.qrCodeId || "")) return send(res, 400, { error: "qrCodeId is invalid" });
        const job = pairings.get(tenant.id);
        if (job?.status === "waiting" && job.qrCodeId === body.qrCodeId) {
          return send(res, 200, { listening: true, pairing: publicPairing(job) });
        }
        let current = tenant;
        if (current.status === "paused") {
          await docker.start(dockerTarget(current));
          current = store.update(current.id, { status: "running", updated_at: now().toISOString() });
        }
        if (current.status !== "running") return send(res, 409, { error: "tenant container is not running" });
        await docker.verify(current.container_name, body.qrCodeId);
        const address = await docker.walletAddress(current.container_name);
        const updated = await connectPairedWallet({ store, docker, config, now }, current, address);
        pairings.set(current.id, { status: "connected", qrCodeId: body.qrCodeId, error: "", address: updated.wallet_address });
        return send(res, 200, { tenant: customerView(updated) });
      }
      return send(res, 404, { error: "not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "control error";
      const status = Number(err.status) || (/must be|invalid|escapes|preset|too large|json/.test(message) ? 400 : 500);
      return send(res, status, { error: message });
    }
  };

  if (config.treasuryAddress && bscRpc) {
    void watcher.scanOnce().catch(() => {});
    watcher.start();
  }
  // The Telegram poller asks this cell first, then every linked cell, who owns a chat.
  handler.telegram = telegram;
  handler.routeTelegram = async ({ chatId, text }) => {
    const local = await handleInbound({ store, config, now, chatId, text, describe: (row) => describeTenant(docker, row, now) });
    if (local.handled) return local.reply;
    for (const node of edge.listRegisteredNodes()) {
      if (node.hostId === config.hostId) continue;
      try {
        const r = await edge.forwardJson(node.hostId, "POST", "/telegram/inbound", { chatId, text });
        if (r.status === 200 && r.body?.handled) return r.body.reply;
      } catch {
        /* a cell that is down cannot own this chat right now */
      }
    }
    return NOT_LINKED_REPLY;
  };
  return handler;
}

function agentChoice(store, order) {
  const tenant = order.tenant_id ? store.get(order.tenant_id) : null;
  return {
    id: order.tenant_id,
    container_name: tenant?.container_name || null,
    payment_asset: tenant?.payment_asset || order.asset,
    paid_until: tenant?.paid_until || null,
    status: tenant?.status || null,
  };
}

function issueSession(store, config, now, tenantId) {
  const tenant = localTenant(store, config, tenantId);
  if (!tenant) throw Object.assign(new Error("paid order not found"), { status: 404 });
  const accessToken = randomBytes(32).toString("hex");
  store.addSession(tenant.id, hashToken(accessToken), now().toISOString(), MAX_SESSIONS);
  const updated = store.get(tenant.id);
  return {
    tenant: customerView(updated),
    compoundToken: formatCompoundToken(config.hostId, updated.id, accessToken),
  };
}

function openPaidSession({ store, config, now, body }) {
  const payer = assertAddress(body?.payer, "payer");
  const tx = String(body?.paymentTx || "").trim().toLowerCase();
  if (tx && !/^0x[a-f0-9]{64}$/.test(tx)) {
    throw Object.assign(new Error("paymentTx must be a transaction hash"), { status: 400 });
  }
  const tenantId = body?.tenantId ? String(body.tenantId).trim().toLowerCase() : "";
  if (tenantId && !/^[a-f0-9]{8}$/.test(tenantId)) {
    throw Object.assign(new Error("tenantId is invalid"), { status: 400 });
  }
  if (tx) {
    const byTx = store.listOrders().find(
      (row) =>
        row.host_id === config.hostId &&
        row.status === "paid" &&
        String(row.payment_tx || "").toLowerCase() === tx,
    );
    if (!byTx?.tenant_id) throw Object.assign(new Error("paid order not found"), { status: 404 });
    if (!byTx.payer_address || byTx.payer_address !== payer) {
      throw Object.assign(new Error("payer does not match this payment"), { status: 401 });
    }
    if (tenantId && byTx.tenant_id !== tenantId) {
      throw Object.assign(new Error("this wallet has not paid for an agent"), { status: 404 });
    }
    return issueSession(store, config, now, byTx.tenant_id);
  }

  const latestByTenant = new Map();
  for (const order of store.listOrders()) {
    if (order.host_id !== config.hostId || !order.payment_tx) continue;
    if (order.status !== "paid" && order.status !== "pending") continue;
    if (String(order.payer_address || "").toLowerCase() !== payer) continue;
    const tenantId = order.tenant_id || store.findByPaymentTx(String(order.payment_tx).toLowerCase())?.id || null;
    if (!tenantId || !store.get(tenantId)) continue;
    const stamped = tenantId === order.tenant_id ? order : { ...order, tenant_id: tenantId };
    const prev = latestByTenant.get(tenantId);
    if (!prev || String(order.updated_at) > String(prev.updated_at)) latestByTenant.set(tenantId, stamped);
  }
  // A wallet the customer linked from Settings opens that agent too, even if it never paid.
  for (const linkedId of store.tenantIdsByWallet(payer)) {
    const linked = localTenant(store, config, linkedId);
    if (linked && !latestByTenant.has(linkedId)) {
      latestByTenant.set(linkedId, { tenant_id: linkedId, asset: linked.payment_asset, updated_at: linked.updated_at || "" });
    }
  }
  let rows = [...latestByTenant.values()];
  if (tenantId) rows = rows.filter((row) => row.tenant_id === tenantId);
  if (rows.length === 0) throw Object.assign(new Error("this wallet has not paid for an agent and is not linked to one"), { status: 404 });
  if (rows.length > 1) {
    rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return { agents: rows.map((order) => agentChoice(store, order)) };
  }
  return issueSession(store, config, now, rows[0].tenant_id);
}

function allocateCheckoutQuote({ store, config, now, asset, bnbPriceUsd, exceptOrderId = null }) {
  const nowMs = now().getTime();
  const usedWei = new Set(
    store
      .listOrders()
      .filter((ord) =>
        ord.host_id === config.hostId &&
        ord.asset === asset &&
        ord.status === "pending" &&
        ord.id !== exceptOrderId &&
        Date.parse(ord.expires_at) + CHECKOUT_SETTLEMENT_GRACE_MS > nowMs,
      )
      .map((ord) => String(ord.amount_wei)),
  );
  let tail = (randomBytes(2).readUIntBE(0, 2) % QUOTE_MARKER_MAX) + 1;
  let quote = quoteOrderAmount({
    asset,
    priceUsd: config.priceUsd,
    bnbPriceUsd: bnbPriceUsd ?? config.bnbPriceUsd,
    tail,
  });
  let guard = 0;
  while (usedWei.has(quote.amountWei)) {
    tail = (tail % QUOTE_MARKER_MAX) + 1;
    quote = quoteOrderAmount({
      asset,
      priceUsd: config.priceUsd,
      bnbPriceUsd: bnbPriceUsd ?? config.bnbPriceUsd,
      tail,
    });
    guard += 1;
    if (guard > QUOTE_MARKER_MAX) {
      throw Object.assign(new Error("no unique payment amount is available right now"), { status: 409 });
    }
  }
  return quote;
}

/**
 * The pay screen reads whatever pending order the browser cookie still holds.
 * A quote from before the 3-decimal marker is replaced here, on that read,
 * so a reload shows `15.xxx` without another checkout click.
 */
function presentCheckoutOrder({ store, config, now, orderId, bnbPriceUsd }) {
  const order = store.getOrder(orderId);
  if (!order || order.host_id !== config.hostId) return null;
  if (order.status === "pending" && !checkoutAmountIsCurrent(order.asset, order.amount_display)) {
    const quote = allocateCheckoutQuote({
      store,
      config,
      now,
      asset: order.asset,
      bnbPriceUsd,
      exceptOrderId: order.id,
    });
    const nowDate = now();
    const replaced = store.replacePendingQuote(order.id, order.amount_display, {
      amount_display: quote.amountDisplay,
      amount_wei: quote.amountWei,
      tail: quote.tail,
      price_usd: quote.priceUsd,
      expires_at: new Date(nowDate.getTime() + CHECKOUT_EXPIRY_MS).toISOString(),
      updated_at: nowDate.toISOString(),
    });
    if (replaced) return replaced;
  }
  return getFreshOrder(store, config, orderId, now);
}

function createCheckoutOrder({ store, config, now, body, bnbPriceUsd }) {
  if (!config.treasuryAddress) {
    throw Object.assign(new Error("SAAS_TREASURY_ADDRESS is not configured on this host"), { status: 503 });
  }
  const asset = String(body?.paymentAsset || "USDT").trim().toUpperCase();
  if (!PAYMENT_ASSETS.includes(asset)) {
    throw Object.assign(new Error("paymentAsset must be USDT, USDC, BNB, U, or USD1"), { status: 400 });
  }
  const risk = resolveRisk({
    preset: body?.preset,
    positionUsd: body?.positionUsd,
    x402PerDay: body?.x402PerDay,
  });
  const tenantId = body?.tenantId ? String(body.tenantId).trim().toLowerCase() : null;
  if (tenantId) {
    const existing = localTenant(store, config, tenantId);
    if (!existing) throw Object.assign(new Error("tenantId not found on this host"), { status: 404 });
  } else {
    const open = new Set(["provisioning", "running", "paused"]);
    const rows = store.list().filter((row) => row.host_id === config.hostId && open.has(row.status));
    if (rows.length >= config.plan.maxTenants) {
      throw Object.assign(new Error("this server is at its tenant limit"), { status: 409 });
    }
  }

  const nowDate = now();
  const quote = allocateCheckoutQuote({ store, config, now, asset, bnbPriceUsd });
  const id = `ord_${randomBytes(6).toString("hex")}`;
  const claimSecret = randomBytes(24).toString("hex");
  const stamp = nowDate.toISOString();
  const expiresAt = new Date(nowDate.getTime() + CHECKOUT_EXPIRY_MS).toISOString();
  const order = store.insertOrder({
    id,
    host_id: config.hostId,
    status: "pending",
    asset: quote.asset,
    risk_preset: risk.preset,
    position_usd: risk.maxPositionUsd,
    x402_per_day: risk.x402PerDay,
    agent_name: formatAgentId(body?.agentName),
    tenant_id: tenantId,
    treasury_address: config.treasuryAddress,
    token_contract: config.tokenContracts[quote.asset] || "native",
    price_usd: quote.priceUsd,
    amount_display: quote.amountDisplay,
    amount_wei: quote.amountWei,
    tail: quote.tail,
    payment_tx: null,
    paid_amount_wei: null,
    overpaid_wei: null,
    payer_address: null,
    confirmations: null,
    claim_secret_hash: hashToken(claimSecret),
    pending_access_token: null,
    expires_at: expiresAt,
    created_at: stamp,
    updated_at: stamp,
  });
  return { order: publicOrderView(order), claimSecret };
}

function provisionRetryOpen(order, nowMs) {
  const expiresMs = Date.parse(order?.expires_at || "");
  return Boolean(order?.payment_tx) && Number.isFinite(expiresMs) && expiresMs + CHECKOUT_PROVISION_RETRY_MS > nowMs;
}

function getFreshOrder(store, config, orderId, now) {
  const order = store.getOrder(orderId);
  if (!order || order.host_id !== config.hostId) return null;
  const nowMs = now().getTime();
  if (provisionRetryOpen(order, nowMs) && order.status !== "paid") {
    if (order.status === "expired") {
      return store.updateOrder(order.id, { status: "pending", updated_at: now().toISOString() }) || order;
    }
    return order;
  }
  if (
    order.status === "pending" &&
    Date.parse(order.expires_at) + CHECKOUT_SETTLEMENT_GRACE_MS <= nowMs
  ) {
    return store.updateOrder(order.id, { status: "expired", updated_at: now().toISOString() });
  }
  return order;
}

function publicOrderView(order, requiredConfirmations = REQUIRED_CONFIRMATIONS) {
  return {
    id: order.id,
    hostId: order.host_id,
    status: order.status,
    asset: order.asset,
    preset: order.risk_preset,
    positionUsd: order.position_usd ?? null,
    x402PerDay: order.x402_per_day ?? null,
    tenantId: order.tenant_id || null,
    treasuryAddress: order.treasury_address,
    tokenContract: order.token_contract,
    priceUsd: order.price_usd,
    amountDisplay: order.amount_display,
    amountWei: order.amount_wei,
    paymentTx: order.payment_tx || null,
    paidAmountDisplay: order.paid_amount_wei ? formatUnits18(order.paid_amount_wei) : null,
    overpaidDisplay: order.overpaid_wei ? formatUnits18(order.overpaid_wei) : null,
    confirmations: order.confirmations ?? null,
    requiredConfirmations,
    expiresAt: order.expires_at,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
  };
}

async function fulfillOrderWithTx({
  store,
  docker,
  config,
  rpc,
  fetchImpl,
  now,
  orderId,
  paymentTx,
  claimSecret,
  expectedPayer = null,
  fromWatcher = false,
}) {
  const order = getFreshOrder(store, config, orderId, now);
  if (!order) throw Object.assign(new Error("order not found"), { status: 404 });
  if (order.status === "paid") {
    if (
      expectedPayer &&
      (!order.payer_address || String(order.payer_address).toLowerCase() !== expectedPayer)
    ) {
      throw Object.assign(new Error("the connected wallet did not send this payment"), { status: 401 });
    }
    if (!fromWatcher && claimSecret) {
      return claimPaidOrder({ store, config, orderId, claimSecret });
    }
    const existingTenant = order.tenant_id ? store.get(order.tenant_id) : null;
    return {
      order: publicOrderView(order),
      tenant: existingTenant ? customerView(existingTenant) : null,
    };
  }
  if (order.status === "expired") {
    throw Object.assign(new Error("checkout order has expired"), { status: 410 });
  }
  const payment = assertPayment({ paymentAsset: order.asset, paymentTx });
  const used = store.findByPaymentTx(payment.tx);
  let resumeTenant = null;
  if (used) {
    const tenant = store.get(used.id);
    const retryable =
      tenant &&
      tenant.host_id === config.hostId &&
      tenant.order_id === order.id &&
      (tenant.status === "error" || tenant.status === "provisioning");
    if (!retryable) {
      throw Object.assign(new Error("paymentTx was already used"), { status: 409 });
    }
    resumeTenant = tenant;
  }
  const useBinanceWallet = Boolean(config.web3ApiKey && config.web3SecretKey);
  if (!useBinanceWallet && !rpc) {
    throw Object.assign(new Error("BSC RPC is not configured"), { status: 503 });
  }

  const verified = useBinanceWallet
    ? await verifyBinanceWalletPayment({
        apiKey: config.web3ApiKey,
        secretKey: config.web3SecretKey,
        fetchImpl,
        txHash: payment.tx,
        asset: order.asset,
        treasuryAddress: order.treasury_address,
        contracts: config.tokenContracts,
        minAmountWei: order.amount_wei,
        minConfirmations: config.minConfirmations,
        notBefore: order.created_at,
        notAfter: order.expires_at,
      })
    : await verifyBscReceipt({
        rpc,
        txHash: payment.tx,
        asset: order.asset,
        treasuryAddress: order.treasury_address,
        contracts: config.tokenContracts,
        minAmountWei: order.amount_wei,
        minConfirmations: config.minConfirmations,
        notBefore: order.created_at,
        notAfter: order.expires_at,
      });
  if (expectedPayer && verified.payerAddress !== expectedPayer) {
    throw Object.assign(new Error("the connected wallet did not send this payment"), { status: 401 });
  }

  const stamp = now().toISOString();
  const noted = store.updateOrder(order.id, {
    payment_tx: verified.txHash,
    payer_address: verified.payerAddress,
    confirmations: verified.confirmations,
    paid_amount_wei: verified.paidWei,
    overpaid_wei: verified.overpaidWei,
    updated_at: stamp,
  });
  if (noted) {
    order.payer_address = noted.payer_address;
    order.payment_tx = noted.payment_tx;
    order.confirmations = noted.confirmations;
  }

  // Case 1: Renewal for an existing tenant
  if (order.tenant_id) {
    const existing = localTenant(store, config, order.tenant_id);
    if (!existing) throw Object.assign(new Error("tenant to renew not found"), { status: 404 });
    const currentExpiry = Date.parse(existing.paid_until || "") || 0;
    const baseMs = Math.max(now().getTime(), currentExpiry);
    const nextPaidUntil = new Date(baseMs + SUBSCRIPTION_MS).toISOString();
    const risk = resolveRisk(
      {
        preset: order.risk_preset || existing.risk_preset,
        positionUsd: order.position_usd ?? existing.max_position_usd,
        x402PerDay: order.x402_per_day ?? existing.x402_per_day,
      },
      { allowLegacy: true },
    );
    const updatedTenant = applySpec(
      store,
      existing,
      {
        risk,
        agentMode: existing.agent_mode,
        buysHalted: false,
        paidUntil: nextPaidUntil,
        orderId: order.id,
        paidAmount: verified.paidDisplay,
        overpaidAmount: verified.overpaidDisplay,
      },
      config,
      now,
    );
    store.update(existing.id, { cancel_at_period_end: 0 });
    if (existing.status === "running") {
      await docker.up(dockerTarget(updatedTenant));
    }
    const updatedOrder = store.updateOrder(order.id, {
      status: "paid",
      payment_tx: verified.txHash,
      paid_amount_wei: verified.paidWei,
      overpaid_wei: verified.overpaidWei,
      payer_address: verified.payerAddress,
      confirmations: verified.confirmations,
      updated_at: stamp,
    });
    return {
      order: publicOrderView(updatedOrder),
      tenant: customerView(updatedTenant),
    };
  }

  if (resumeTenant) {
    return resumeErroredTenant({
      store,
      docker,
      config,
      now,
      order,
      tenant: resumeTenant,
      verified,
    });
  }

  // Case 2: Provision new tenant container
  const created = await createTenant({
    store,
    docker,
    config,
    now,
    payment,
    risk: resolveRisk(
      {
        preset: order.risk_preset,
        positionUsd: order.position_usd,
        x402PerDay: order.x402_per_day,
      },
      { allowLegacy: true },
    ),
    agentName: order.agent_name,
    orderId: order.id,
    verified,
  });

  const canClaimNow =
    !fromWatcher &&
    (!order.claim_secret_hash || (claimSecret && safeEqual(hashToken(String(claimSecret)), order.claim_secret_hash)));

  const updatedOrder = store.updateOrder(order.id, {
    status: "paid",
    tenant_id: created.tenant.id,
    payment_tx: verified.txHash,
    paid_amount_wei: verified.paidWei,
    overpaid_wei: verified.overpaidWei,
    payer_address: verified.payerAddress,
    confirmations: verified.confirmations,
    pending_access_token: canClaimNow ? null : created.accessToken,
    pending_access_code: canClaimNow ? null : created.accessCode,
    updated_at: stamp,
  });

  return {
    order: publicOrderView(updatedOrder),
    tenant: created.tenant,
    ...(canClaimNow
      ? {
          accessToken: created.accessToken,
          accessCode: created.accessCode,
          compoundToken: formatCompoundToken(config.hostId, created.tenant.id, created.accessToken),
        }
      : {}),
  };
}

function claimPaidOrder({ store, config, orderId, claimSecret }) {
  const order = store.getOrder(orderId);
  if (!order || order.host_id !== config.hostId) {
    throw Object.assign(new Error("order not found"), { status: 404 });
  }
  if (!claimSecret || !order.claim_secret_hash || !safeEqual(hashToken(String(claimSecret)), order.claim_secret_hash)) {
    throw Object.assign(new Error("invalid claimSecret for order"), { status: 401 });
  }
  const tenant = order.tenant_id ? store.get(order.tenant_id) : null;
  const token = order.pending_access_token || null;
  const accessCode = order.pending_access_code || null;
  if (token || accessCode) {
    store.updateOrder(order.id, {
      pending_access_token: null,
      pending_access_code: null,
      updated_at: new Date().toISOString(),
    });
  }
  return {
    order: publicOrderView(order),
    tenant: tenant ? customerView(tenant) : null,
    ...(accessCode ? { accessCode } : {}),
    ...(token && tenant
      ? {
          accessToken: token,
          compoundToken: formatCompoundToken(config.hostId, tenant.id, token),
        }
      : {}),
  };
}

async function enforceSubscriptions({ store, docker, config, now }) {
  const nowMs = now().getTime();
  const haltedIds = [];
  for (const row of store.list().filter((r) => r.host_id === config.hostId)) {
    if (!planLifecycle(row, nowMs).halt) continue;
    await haltBuys({ store, docker, config, now }, row);
    haltedIds.push(row.id);
  }
  return { hostId: config.hostId, haltedCount: haltedIds.length, haltedIds };
}

async function haltBuys({ store, docker, config, now }, row) {
  const updated = applySpec(store, row, { risk: riskFromRow(row), agentMode: row.agent_mode, buysHalted: true }, config, now);
  if (row.status === "running") await docker.up(dockerTarget(updated));
  return updated;
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

const signed = (n) => `${Number(n) < 0 ? "-" : "+"}$${Math.abs(Number(n) || 0).toFixed(2)}`;

/** The /status reply in Telegram. */
async function describeTenant(docker, row, now) {
  const desk = await readDesk(docker, row);
  const sub = subscriptionState(row, now().getTime());
  const lines = [`Agent ${row.id} (${row.agent_mode}${row.buys_halted ? ", new buys stopped" : ""})`];
  if (desk.reachable) {
    lines.push(`Value $${desk.navUsd} | Cash $${desk.cashUsd}`);
    lines.push(`Today ${signed(desk.dailyPnlUsd)} | Total ${signed(desk.totalPnlUsd)}`);
    lines.push(`Open positions: ${desk.positions}${desk.symbols?.length ? ` (${desk.symbols.join(", ")})` : ""}`);
  } else {
    lines.push("The agent is not answering right now.");
  }
  lines.push(
    sub.stage === "active"
      ? `Subscription: ${sub.daysLeft} day${sub.daysLeft === 1 ? "" : "s"} left${sub.cancelling ? " (will not renew)" : ""}`
      : `Subscription: ${sub.stage}`,
  );
  return lines.join("\n");
}

/**
 * One pass over this cell: expire or remind subscriptions, then check every running
 * agent for trouble and new trades. Safe to run again at any time, since each step
 * records what it already sent.
 */
export async function runMaintenance({ store, docker, config, now = () => new Date(), telegram, concurrency = 4, log = console }) {
  const nowMs = now().getTime();
  const report = { halted: [], reminded: [], opened: [], resolved: [], trades: 0, errors: [] };
  const tell = async (row, text) => {
    if (row.telegram_chat_id) await telegram.send(row.telegram_chat_id, text);
  };
  const renewUrl = `${config.portalUrl.replace(/\/$/, "")}?renew=1`;
  const stallMs = Math.max(config.plan.intervalMs * 3, 30 * 60_000);
  const ids = store.list().filter((row) => row.host_id === config.hostId).map((row) => row.id);

  await mapLimit(ids, concurrency, async (id) => {
    try {
      let row = store.get(id);
      const plan = planLifecycle(row, nowMs);
      if (plan.halt) {
        row = await haltBuys({ store, docker, config, now }, row);
        report.halted.push(id);
      }
      if (plan.clearStage) row = store.update(id, { reminder_stage: "" });
      if (plan.stage) {
        await tell(row, reminderText(plan.stage, plan.state, renewUrl));
        row = store.update(id, { reminder_stage: plan.stage });
        report.reminded.push(`${id}:${plan.stage}`);
      }

      const desk = row.status === "running" ? await readDesk(docker, row) : { reachable: false };
      const { next, events } = evaluate({ row, desk, nowMs, prev: parseAlerts(row.alerts_json), stallMs });
      const json = JSON.stringify(next);
      if (json !== (row.alerts_json || "")) store.update(id, { alerts_json: json });
      for (const ev of events) {
        await tell(row, ev.customer);
        if (ev.ops) await telegram.ops(ev.ops);
        if (ev.type === "open") report.opened.push(`${id}:${ev.kind}`);
        else if (ev.type === "resolved") report.resolved.push(`${id}:${ev.kind}`);
        else report.trades += 1;
      }
    } catch (err) {
      report.errors.push({ id, error: err instanceof Error ? err.message : String(err) });
      log.warn?.(`maintenance ${id}: ${err instanceof Error ? err.message : err}`);
    }
  });
  return report;
}

/** Encrypted copy of every customer folder, then (optionally) off this machine. */
export async function runTenantBackup({ store, config, telegram, now = () => new Date() }) {
  const key = parseBackupKey(config.backupKey);
  if (!key || !config.backupDir) {
    throw Object.assign(new Error("set SAAS_BACKUP_KEY (64 hex characters) and SAAS_BACKUP_DIR to turn backups on"), { status: 409 });
  }
  const rows = store.list().filter((row) => row.host_id === config.hostId && row.data_dir);
  // The control database goes in too: without it a lost disk forgets who owns which agent.
  const snap = mkdtempSync(join(tmpdir(), "na-control-snap-"));
  let result;
  try {
    store.snapshot(join(snap, "control.sqlite"));
    result = await backupAll({ rows: [...rows, { id: "control", data_dir: snap }], outDir: config.backupDir, key, now: now() });
  } finally {
    rmSync(snap, { recursive: true, force: true });
  }
  let offsite = "not configured";
  if (config.backupRsync) {
    try {
      await syncOffsite({ outDir: config.backupDir, target: config.backupRsync });
      offsite = "ok";
    } catch (err) {
      offsite = `failed: ${err instanceof Error ? err.message : err}`;
    }
  }
  if (result.failed.length || offsite.startsWith("failed")) {
    await telegram.ops(`Backup problem on ${config.hostId}: ${result.failed.length} folder(s) failed, off-site ${offsite}`);
  }
  return { hostId: config.hostId, backedUp: result.ok.length - 1, controlDb: result.ok.some((f) => /\/control-/.test(f)), failed: result.failed, offsite };
}

async function applyImageTag({ store, docker, config, now }, id, tag) {
  const tagged = store.update(id, { image_tag: tag || null });
  const updated = applySpec(store, tagged, { risk: riskFromRow(tagged), agentMode: tagged.agent_mode }, config, now);
  await docker.up(dockerTarget(updated));
}

/** True once the agent answers and its loop is running; false if it never does. */
async function waitUntilReady({ store, docker, config }, id) {
  const deadline = Date.now() + config.rolloutTimeoutMs;
  for (;;) {
    const desk = await readDesk(docker, store.get(id));
    if (desk.reachable && desk.running !== false) return true;
    if (Date.now() + config.rolloutPollMs > deadline) return false;
    await new Promise((r) => setTimeout(r, config.rolloutPollMs));
  }
}

async function resumeErroredTenant({ store, docker, config, now, order, tenant, verified }) {
  const risk = riskFromRow(tenant);
  writeTenantFiles(tenant.data_dir, specFrom(tenant, risk, config));
  try {
    await docker.ensureImage();
    await docker.up(dockerTarget(tenant));
  } catch (err) {
    try {
      await docker.down(dockerTarget(tenant));
    } catch {
      /* the container may never have started */
    }
    store.update(tenant.id, { status: "error", updated_at: now().toISOString() });
    throw err;
  }
  const accessToken = randomBytes(32).toString("hex");
  const accessCode = newAccessCode();
  const running = store.update(tenant.id, {
    status: "running",
    access_token_hash: hashToken(accessToken),
    access_code_hash: hashToken(normalizeAccessCode(accessCode)),
    updated_at: now().toISOString(),
  });
  const updatedOrder = store.updateOrder(order.id, {
    status: "paid",
    tenant_id: running.id,
    payment_tx: verified.txHash,
    paid_amount_wei: verified.paidWei,
    overpaid_wei: verified.overpaidWei,
    payer_address: verified.payerAddress,
    confirmations: verified.confirmations,
    pending_access_token: accessToken,
    pending_access_code: accessCode,
    updated_at: now().toISOString(),
  });
  return {
    order: publicOrderView(updatedOrder),
    tenant: customerView(running),
  };
}

async function createTenant({ store, docker, config, now, payment, risk, agentName, orderId = null, verified = null }) {
  if (store.findByPaymentTx(payment.tx)) {
    const err = new Error("paymentTx was already used");
    err.status = 409;
    throw err;
  }
  const open = new Set(["provisioning", "running", "paused"]);
  const rows = store.list().filter((row) => row.host_id === config.hostId && open.has(row.status));
  if (rows.length >= config.plan.maxTenants) {
    const err = new Error("this server is at its tenant limit");
    err.status = 409;
    throw err;
  }
  if (!risk?.maxPositionUsd && risk?.maxPositionUsd !== 0) {
    throw Object.assign(new Error("risk preset must be 100, 250, 500, or custom"), { status: 400 });
  }
  const id = newId(store);
  const nowDate = now();
  const stamp = nowDate.toISOString();
  const paidUntil = new Date(nowDate.getTime() + SUBSCRIPTION_MS).toISOString();
  const dir = tenantDir(config.dataRoot, id);
  const accessToken = randomBytes(32).toString("hex");
  const accessCode = newAccessCode();
  const row = {
    id,
    host_id: config.hostId,
    status: "provisioning",
    container_name: containerName(id),
    data_dir: dir,
    risk_preset: risk.preset,
    agent_mode: "live",
    max_position_usd: risk.maxPositionUsd,
    max_drawdown_pct: 0,
    max_trade_usd: risk.maxTradeUsd,
    trade_interval_ms: config.plan.intervalMs,
    x402_per_day: risk.x402PerDay,
    wallet_address: null,
    access_token_hash: hashToken(accessToken),
    access_code_hash: hashToken(normalizeAccessCode(accessCode)),
    agent_api_secret: randomBytes(32).toString("hex"),
    payment_asset: payment.asset,
    payment_tx: payment.tx,
    agent_name: formatAgentId(agentName),
    paid_until: paidUntil,
    order_id: orderId,
    paid_amount: verified ? verified.paidDisplay : null,
    overpaid_amount: verified ? verified.overpaidDisplay : null,
    buys_halted: 0,
    cmc_x402: 1,
    studio_x402: 0,
    cancel_at_period_end: 0,
    created_at: stamp,
    updated_at: stamp,
  };
  try {
    store.insert(row);
  } catch (err) {
    if (/UNIQUE/i.test(String(err instanceof Error ? err.message : err))) {
      const error = new Error("paymentTx was already used");
      error.status = 409;
      throw error;
    }
    throw err;
  }
  const spec = specFrom(row, risk, config);
  try {
    writeTenantFiles(dir, spec);
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
  const tenant = store.update(id, { status: "running", updated_at: now().toISOString() });
  return {
    tenant: customerView(tenant),
    accessToken,
    accessCode,
    compoundToken: formatCompoundToken(config.hostId, tenant.id, accessToken),
  };
}

function applySpec(store, tenant, { risk, agentMode, buysHalted, paidUntil, orderId, paidAmount, overpaidAmount }, config, now) {
  const stamp = now().toISOString();
  const halted = buysHalted !== undefined ? (buysHalted ? 1 : 0) : Number(tenant.buys_halted) || 0;
  const next = {
    ...tenant,
    risk_preset: risk.preset,
    agent_mode: agentMode,
    max_position_usd: risk.maxPositionUsd,
    max_drawdown_pct: 0,
    max_trade_usd: risk.maxTradeUsd,
    trade_interval_ms: config.plan.intervalMs,
    x402_per_day: risk.x402PerDay,
    buys_halted: halted,
    paid_until: paidUntil !== undefined ? paidUntil : tenant.paid_until,
    order_id: orderId !== undefined ? orderId : tenant.order_id,
    paid_amount: paidAmount !== undefined ? paidAmount : tenant.paid_amount,
    overpaid_amount: overpaidAmount !== undefined ? overpaidAmount : tenant.overpaid_amount,
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
    x402_per_day: next.x402_per_day,
    buys_halted: next.buys_halted,
    paid_until: next.paid_until,
    order_id: next.order_id,
    paid_amount: next.paid_amount,
    overpaid_amount: next.overpaid_amount,
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
    imageTag: row.image_tag || "",
    signals: { cmc: row.cmc_x402 !== 0, studio: row.studio_x402 !== 0 },
    buysHalted: Boolean(row.buys_halted),
    paymentAsset: row.payment_asset,
    apiSecret: row.agent_api_secret,
    // The shared Neon URL stays on the control server. A customer agent with
    // that URL would upsert the founder's public agent_state and trade rows.
  };
}

async function promotePaperTenants({ store, docker, config, now }) {
  const rows = store.list().filter((row) => row.host_id === config.hostId && row.agent_mode === "paper" && row.data_dir);
  for (const row of rows) {
    try {
      const updated = applySpec(store, row, { risk: riskFromRow(row), agentMode: "live" }, config, now);
      if (row.status === "running" || row.status === "paused") {
        await docker.up(dockerTarget(updated));
        store.update(updated.id, { status: "running", updated_at: now().toISOString() });
      }
    } catch {
      /* the next restart tries this tenant again */
    }
  }
}

const agentIdCache = new Map();

async function cachedAgentId(docker, container) {
  if (!container || typeof docker.agentId !== "function") return "";
  const hit = agentIdCache.get(container);
  const nowMs = Date.now();
  if (hit && nowMs < hit.until) return hit.name;
  let name = "";
  try {
    name = await docker.agentId(container);
  } catch {
    name = "";
  }
  if (typeof name !== "string") name = "";
  agentIdCache.set(container, { name, until: nowMs + (name ? 10 * 60_000 : 60_000) });
  return name;
}

async function proxyTenantAgent(req, res, docker, tenant, action, url) {
  if (tenant.status !== "running" && tenant.status !== "paused") {
    return send(res, 409, { error: "tenant container is not running" });
  }
  const ip = typeof docker.containerIp === "function" ? await docker.containerIp(tenant.container_name) : "";
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return send(res, 409, { error: "agent is not running" });
  const sub = action.replace(/^\/agent/, "") || "/state";
  const target = `http://${ip}:3848/api${sub}${url.search || ""}`;
  const headers = { authorization: `Bearer ${tenant.agent_api_secret}` };
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
  const init = { method: req.method || "GET", headers };
  if (req.method !== "GET" && req.method !== "HEAD") init.body = await readRaw(req);
  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch {
    return send(res, 502, { error: "agent unreachable" });
  }
  const contentType = upstream.headers.get("content-type") || "application/json";
  if (req.method === "GET" && sub === "/wallet" && upstream.ok) {
    const text = await upstream.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (body && typeof body === "object" && !body.agentId) {
      const agentId = await cachedAgentId(docker, tenant.container_name);
      if (agentId) body.agentId = agentId;
    }
    res.writeHead(upstream.status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    return res.end(body ? JSON.stringify(body) : text);
  }
  res.writeHead(upstream.status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (!upstream.body) return res.end();
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    /* the browser closed the stream */
  }
  return res.end();
}

function readRaw(req, max = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function publicPairing(job) {
  if (!job) return null;
  return { status: job.status || "", error: job.error || "" };
}

function beginPairWatch(pairings, ctx, tenant, qrCodeId) {
  pairings.set(tenant.id, { status: "waiting", qrCodeId, error: "", address: "" });
  const stillCurrent = () => pairings.get(tenant.id)?.qrCodeId === qrCodeId;
  void ctx.docker.verify(tenant.container_name, qrCodeId).catch(() => undefined);
  void (async () => {
    const deadline = Date.now() + 180_000;
    let address = "";
    while (Date.now() < deadline && stillCurrent() && !address) {
      try {
        const payload = await ctx.docker.walletStatus(tenant.container_name);
        const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
        const status = String(data?.status || "").toUpperCase();
        if (status === "CONNECTED" || status === "ALREADY_CONNECTED") {
          address = await ctx.docker.walletAddress(tenant.container_name);
        }
      } catch {
        /* Binance is still waiting for the scan */
      }
      if (!address && stillCurrent()) await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (!stillCurrent()) return;
    try {
      if (!address) address = await ctx.docker.walletAddress(tenant.container_name);
      const fresh = ctx.store.get(tenant.id) || tenant;
      const updated = await connectPairedWallet(ctx, fresh, address);
      if (!stillCurrent()) return;
      pairings.set(tenant.id, { status: "connected", qrCodeId, error: "", address: updated.wallet_address });
    } catch (err) {
      if (!stillCurrent()) return;
      pairings.set(tenant.id, {
        status: "failed",
        qrCodeId,
        error: err instanceof Error ? err.message : "Binance did not confirm",
        address: "",
      });
    }
  })();
}

async function connectPairedWallet({ store, docker, config, now }, tenant, address) {
  if (!address) {
    throw Object.assign(new Error("Binance did not connect a wallet. Scan the new code and approve it in the app while this page stays open."), { status: 409 });
  }
  if (tenant.wallet_address && tenant.wallet_address !== address) {
    throw Object.assign(new Error("wallet address changed; refusing to replace it"), { status: 409 });
  }
  let updated = store.update(tenant.id, { wallet_address: address, updated_at: now().toISOString() });
  if (updated.agent_mode !== "live") {
    updated = applySpec(store, updated, { risk: riskFromRow(updated), agentMode: "live" }, config, now);
    await docker.up(dockerTarget(updated));
    updated = store.update(updated.id, { status: "running", updated_at: now().toISOString() });
  }
  return updated;
}

function dockerTarget(row) {
  return {
    project: projectName(row.id),
    overrideFile: join(row.data_dir, "override.yml"),
    containerName: row.container_name,
  };
}

function riskFromRow(row) {
  return resolveRisk(
    {
      preset: row.risk_preset,
      positionUsd: row.max_position_usd,
      x402PerDay: row.x402_per_day,
    },
    { allowLegacy: true },
  );
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

function identify(req, config, store) {
  const token = bearer(req);
  if (!token) {
    if (config.demo === true && !config.monitorSecret && req.headers["x-neural-desk"] === "observe") {
      return { role: "monitor" };
    }
    return null;
  }
  if (config.apiSecret && safeEqual(token, config.apiSecret)) return { role: "operator" };
  if (config.monitorSecret && safeEqual(token, config.monitorSecret)) return { role: "monitor" };
  if (config.demo === true && !config.monitorSecret && req.headers["x-neural-desk"] === "observe") {
    return { role: "monitor" };
  }
  const parsed = parseCompoundToken(token);
  if (parsed.compound && parsed.hostId !== config.hostId) {
    return {
      role: "remote_customer",
      hostId: parsed.hostId,
      tenantId: parsed.tenantId,
      accessToken: parsed.accessToken,
    };
  }
  const lookupToken = parsed.compound ? parsed.accessToken : token;
  const tokenHash = hashToken(lookupToken);
  const row = store.findByAccessHash(tokenHash) || store.findBySessionHash(tokenHash);
  if (!row || row.host_id !== config.hostId) return null;
  if (parsed.compound && parsed.tenantId !== row.id) return null;
  return { role: "customer", tenantId: row.id };
}

function canAccess(actor, tenantId) {
  if (!actor) return false;
  if (actor.role === "operator") return true;
  return actor.role === "customer" && actor.tenantId === tenantId;
}

function isOperatorRoute(method, pathname) {
  if (method === "GET" && (pathname === "/capacity" || pathname === "/recovery" || pathname === "/tenants" || pathname === "/rollout")) return true;
  if (
    method === "POST" &&
    (pathname === "/recovery/adopt" ||
      pathname === "/cluster/nodes" ||
      pathname === "/watcher/scan" ||
      pathname === "/telegram/inbound" ||
      pathname === "/maintenance/run" ||
      pathname === "/backups/run" ||
      pathname === "/rollout" ||
      pathname === "/subscriptions/sweep" ||
      pathname === "/session/open")
  ) {
    return true;
  }
  return method === "DELETE" && pathname.startsWith("/cluster/nodes/");
}

const ACCESS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newAccessCode() {
  const bytes = randomBytes(16);
  let raw = "";
  for (let i = 0; i < 16; i += 1) raw += ACCESS_CODE_ALPHABET[bytes[i] % ACCESS_CODE_ALPHABET.length];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

function normalizeAccessCode(value) {
  const clean = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/.test(clean)) {
    throw Object.assign(new Error("Enter the access code as four groups, like ABCD-EFGH-JKLM-NPQR."), { status: 400 });
  }
  return clean;
}

function openByAccessCode({ store, config, now, body, limiter, client }) {
  const at = now().getTime();
  if (!limiter.allowed(client, at)) {
    throw Object.assign(new Error("Too many attempts. Wait a minute and try again."), { status: 429 });
  }
  let normalized;
  try {
    normalized = normalizeAccessCode(body?.code);
  } catch (err) {
    limiter.fail(client, at);
    throw err;
  }
  const tenant = store.findByAccessCodeHash(hashToken(normalized));
  if (!tenant || tenant.host_id !== config.hostId) {
    limiter.fail(client, at);
    throw Object.assign(new Error("That access code does not match an agent."), { status: 401 });
  }
  return issueSession(store, config, now, tenant.id);
}

function rotateAccessCode(store, tenant, now) {
  const accessCode = newAccessCode();
  store.update(tenant.id, {
    access_code_hash: hashToken(normalizeAccessCode(accessCode)),
    updated_at: now().toISOString(),
  });
  return accessCode;
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function bearer(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : "";
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const HIDDEN = new Set([
  "access_token_hash",
  "access_code_hash",
  "agent_api_secret",
  "max_drawdown_pct",
  "telegram_chat_id",
  "telegram_code_hash",
  "telegram_code_expires",
  "alerts_json",
  "reminder_stage",
]);

function customerView(row, store = null) {
  const view = operatorView(row);
  delete view.data_dir;
  delete view.payment_tx;
  if (store) {
    view.login_wallets = store.listWallets(row.id);
    view.signed_in_browsers = store.sessionCount(row.id);
  }
  view.telegram_linked = Boolean(row.telegram_chat_id);
  view.subscription = subscriptionState(row, Date.now());
  return view;
}

function operatorView(row) {
  const view = {};
  for (const [key, value] of Object.entries(row)) {
    if (!HIDDEN.has(key)) view[key] = value;
  }
  return view;
}

async function overview(store, docker, config, health = { uptimeMs: 0, requests: 0 }) {
  const mine = store.list().filter((row) => row.host_id === config.hostId);
  const cap = await capacity(store, docker, config);
  if (config.demo === true && mine.length === 0) {
    return demoOverview(config, health);
  }
  return {
    readOnly: true,
    demo: config.demo === true,
    operator: { agentId: config.operatorAgent || null },
    health: {
      uptimeMs: Math.max(0, Number(health.uptimeMs) || 0),
      requests: Math.max(0, Number(health.requests) || 0),
    },
    hostId: config.hostId,
    generatedAt: new Date().toISOString(),
    alerts: mine.flatMap((row) =>
      Object.entries(parseAlerts(row.alerts_json).open || {}).map(([kind, v]) => ({ id: row.id, kind, since: v.since })),
    ),
    capacity: cap,
    counts: {
      customers: mine.length,
      byStatus: tally(mine, "status"),
      byMode: tally(mine, "agent_mode"),
      byPreset: tally(mine, "risk_preset"),
      byAsset: tally(mine, "payment_asset"),
      paired: mine.filter((row) => row.wallet_address).length,
      unpaired: mine.filter((row) => !row.wallet_address).length,
    },
    payments: mine.map((row) => ({
      id: row.id,
      asset: row.payment_asset,
      tx: row.payment_tx,
      status: row.status,
      createdAt: row.created_at,
    })),
    tenants: mine.map(operatorView),
  };
}

async function liveBoard(store, docker, config) {
  const rows = store.list().filter((row) => row.host_id === config.hostId);
  if (config.demo === true && rows.length === 0) {
    return demoLiveBoard();
  }
  const desks = await Promise.all(rows.map((row) => readDesk(docker, row)));
  const live = desks.filter((desk) => desk.reachable);
  const samples = desks.map((desk) => desk.latencyMs).filter((value) => Number.isFinite(value));
  const sum = (key) => round2(live.reduce((total, desk) => total + (Number(desk[key]) || 0), 0));
  return {
    readOnly: true,
    bookLatencyMs: samples.length ? Math.max(...samples) : null,
    generatedAt: new Date().toISOString(),
    fleet: {
      reachable: live.length,
      navUsd: sum("navUsd"),
      cashUsd: sum("cashUsd"),
      dailyPnlUsd: sum("dailyPnlUsd"),
      totalPnlUsd: sum("totalPnlUsd"),
      realizedPnlUsd: sum("realizedPnlUsd"),
      trades: live.reduce((total, desk) => total + (Number(desk.trades) || 0), 0),
      volumeUsd: sum("volumeUsd"),
      wins: live.reduce((total, desk) => total + (Number(desk.wins) || 0), 0),
      losses: live.reduce((total, desk) => total + (Number(desk.losses) || 0), 0),
      positions: live.reduce((total, desk) => total + (Number(desk.positions) || 0), 0),
      startedAt: live.reduce((min, desk) => (desk.startedAt && (!min || desk.startedAt < min) ? desk.startedAt : min), null),
      holdings: mergeHoldings(live),
      recent: live
        .flatMap((desk) => (desk.recent || []).map((trade) => ({ ...trade, id: desk.id })))
        .sort((a, b) => b.time - a.time)
        .slice(0, 12),
    },
    tenants: desks,
  };
}

function demoOverview(config, health) {
  const now = Date.now();
  const tenants = [
    {
      id: "9af2de37",
      host_id: config.hostId,
      status: "running",
      container_name: "na-9af2de37",
      risk_preset: "cautious",
      agent_mode: "paper",
      max_position_usd: 50,
      max_trade_usd: 15,
      trade_interval_ms: 300_000,
      wallet_address: null,
      payment_asset: "USDT",
      payment_tx: `0x${"aa".repeat(32)}`,
      agent_name: null,
      created_at: new Date(now - 3600_000 * 6).toISOString(),
      updated_at: new Date(now - 120_000).toISOString(),
    },
    {
      id: "77e1d98c",
      host_id: config.hostId,
      status: "running",
      container_name: "na-77e1d98c",
      risk_preset: "cautious",
      agent_mode: "paper",
      max_position_usd: 50,
      max_trade_usd: 15,
      trade_interval_ms: 300_000,
      wallet_address: null,
      payment_asset: "BNB",
      payment_tx: `0x${"bb".repeat(32)}`,
      agent_name: null,
      created_at: new Date(now - 3600_000 * 5).toISOString(),
      updated_at: new Date(now - 240_000).toISOString(),
    },
    {
      id: "d77c4ff2",
      host_id: config.hostId,
      status: "running",
      container_name: "na-d77c4ff2",
      risk_preset: "cautious",
      agent_mode: "paper",
      max_position_usd: 50,
      max_trade_usd: 15,
      trade_interval_ms: 300_000,
      wallet_address: null,
      payment_asset: "USDC",
      payment_tx: `0x${"cc".repeat(32)}`,
      agent_name: null,
      created_at: new Date(now - 3600_000 * 4).toISOString(),
      updated_at: new Date(now - 360_000).toISOString(),
    },
  ];
  return {
    readOnly: true,
    demo: true,
    operator: { agentId: config.operatorAgent || null },
    health: {
      uptimeMs: Math.max(12 * 86_400_000 + 6 * 3_600_000 + 42 * 60_000, Number(health.uptimeMs) || 0),
      requests: Math.max(142, Number(health.requests) || 0),
    },
    hostId: config.hostId === "local" ? "box-demo" : config.hostId,
    generatedAt: new Date(now).toISOString(),
    capacity: {
      hostId: config.hostId,
      maxTenants: 6,
      intervalMs: 300_000,
      upstreamBudgetPerMin: 60,
      estimatedUsePerMin: 12,
      estimatedUseAtFull: 24,
      tenants: 3,
      running: 3,
      orphans: ["na-00dead00"],
    },
    counts: {
      customers: 3,
      byStatus: { running: 3 },
      byMode: { paper: 3 },
      byPreset: { cautious: 3 },
      byAsset: { USDT: 1, BNB: 1, USDC: 1 },
      paired: 0,
      unpaired: 3,
    },
    payments: tenants.map((row) => ({
      id: row.id,
      asset: row.payment_asset,
      tx: row.payment_tx,
      status: row.status,
      createdAt: row.created_at,
    })),
    tenants,
  };
}

function demoLiveBoard() {
  const now = Date.now();
  const curve = [683, 687, 684, 695, 694, 701, 703, 707, 699, 703, 707, 712, 715, 711, 721, 720, 729, 722, 724, 723, 725, 728, 720.75];
  const ids = ["9af2de37", "77e1d98c", "d77c4ff2"];
  const tenants = ids.map((id, idx) => ({
    id,
    reachable: true,
    mode: "paper",
    running: true,
    cycleCount: 9,
    navUsd: 240.25,
    cashUsd: 110.25,
    dailyPnlUsd: -4.5,
    totalPnlUsd: 8.1,
    realizedPnlUsd: 8.1,
    trades: 6,
    volumeUsd: 360,
    wins: 4,
    losses: 2,
    positions: 2,
    symbols: ["TSLAB", "NVDAB"],
    holdings: [
      { symbol: "TSLAB", valueUsd: 70 },
      { symbol: "NVDAB", valueUsd: 60 },
      { symbol: "Cash", valueUsd: 110.25 },
    ],
    startedAt: now - 3600_000 * 6,
    series: curve.map((totalVal, step) => ({
      t: now - (curve.length - 1 - step) * 900_000,
      v: round2(totalVal / 3),
    })),
    recent: [
      {
        time: now - (idx + 1) * 600_000,
        side: idx % 2 === 0 ? "buy" : "sell",
        symbol: idx % 2 === 0 ? "TSLAB" : "NVDAB",
        usd: 15,
        pnl: idx % 2 === 0 ? null : 4.05,
        tx: `0x${String(idx + 1).repeat(64).slice(0, 64)}`,
      },
    ],
  }));
  return {
    readOnly: true,
    bookLatencyMs: 48,
    generatedAt: new Date(now).toISOString(),
    fleet: {
      reachable: 3,
      navUsd: 720.75,
      cashUsd: 330.75,
      dailyPnlUsd: -13.5,
      totalPnlUsd: 24.3,
      realizedPnlUsd: 24.3,
      trades: 18,
      volumeUsd: 1080,
      wins: 12,
      losses: 6,
      positions: 6,
      startedAt: now - 3600_000 * 6,
      holdings: [
        { symbol: "USDT", valueUsd: 303.44 },
        { symbol: "BNB", valueUsd: 228.48 },
        { symbol: "USDC", valueUsd: 188.83 },
      ],
      recent: tenants.flatMap((t) => t.recent.map((r) => ({ ...r, id: t.id }))),
    },
    tenants,
  };
}

async function readDesk(docker, row) {
  if (row.status !== "running" && row.status !== "paused") {
    return { id: row.id, reachable: false, reason: row.status };
  }
  if (typeof docker.readState !== "function") {
    return { id: row.id, reachable: false, reason: "live book is unavailable" };
  }
  const started = Date.now();
  try {
    return { id: row.id, ...summarizeState(await docker.readState(row.container_name)), latencyMs: Date.now() - started };
  } catch {
    return { id: row.id, reachable: false, reason: "book did not answer", latencyMs: Date.now() - started };
  }
}

const STABLES = new Set(["USDT", "USDC", "USD1", "U", "BUSD", "FDUSD", "DAI"]);

function summarizeState(raw) {
  const state = JSON.parse(String(raw || "{}"));
  const book = state.portfolio && typeof state.portfolio === "object" ? state.portfolio : {};
  const positions = Array.isArray(book.positions) ? book.positions : [];
  const trades = Array.isArray(state.trades) ? state.trades.filter((trade) => trade && trade.success !== false) : [];
  return {
    reachable: true,
    mode: typeof state.mode === "string" ? state.mode : null,
    running: Boolean(state.running),
    cycleCount: Number(state.cycleCount) || 0,
    navUsd: round2(book.totalValueUsd),
    cashUsd: round2(book.cashUsd),
    dailyPnlUsd: round2(book.dailyPnl),
    totalPnlUsd: round2(book.totalPnl),
    realizedPnlUsd: round2(book.realizedPnl),
    trades: trades.length || Number(book.tradeCount) || 0,
    volumeUsd: round2(trades.reduce((total, trade) => total + tradeNotional(trade), 0)),
    wins: trades.filter((trade) => Number(trade.realizedPnl) > 0).length,
    losses: trades.filter((trade) => Number(trade.realizedPnl) < 0).length,
    positions: positions.length,
    symbols: positions.map((position) => position?.symbol).filter((symbol) => typeof symbol === "string").slice(0, 12),
    holdings: holdingsFrom(positions, book.cashUsd),
    startedAt: Number(state.startedAt) || null,
    series: (Array.isArray(state.snapshots) ? state.snapshots : [])
      .filter((point) => point && Number(point.timestamp) > 0 && Number(point.totalValueUsd) > 0)
      .slice(-120)
      .map((point) => ({ t: Number(point.timestamp), v: round2(point.totalValueUsd) })),
    recent: recentTrades(trades),
  };
}

function holdingsFrom(positions, cash) {
  const rows = [];
  for (const position of positions) {
    const symbol = position?.symbol;
    const qty = Number(position?.amount) || Number(position?.qty) || 0;
    const price = Number(position?.currentPrice) || Number(position?.price) || 0;
    const value = qty * price;
    if (typeof symbol === "string" && value > 0) rows.push({ symbol, valueUsd: round2(value) });
  }
  if (Number(cash) > 0) rows.push({ symbol: "Cash", valueUsd: round2(cash) });
  return rows;
}

function mergeHoldings(desks) {
  const totals = new Map();
  for (const desk of desks) {
    for (const holding of desk.holdings || []) {
      totals.set(holding.symbol, (totals.get(holding.symbol) || 0) + Number(holding.valueUsd || 0));
    }
  }
  return [...totals]
    .map(([symbol, valueUsd]) => ({ symbol, valueUsd: round2(valueUsd) }))
    .sort((a, b) => b.valueUsd - a.valueUsd);
}

function tradeNotional(trade) {
  const from = String(trade.fromToken || "").toUpperCase();
  const to = String(trade.toToken || "").toUpperCase();
  const fromAmt = Number(trade.fromAmount) || 0;
  const toAmt = Number(trade.toAmount) || 0;
  const price = Number(trade.priceAtExecution) || 0;
  if (STABLES.has(from) && fromAmt > 0) return fromAmt;
  if (STABLES.has(to) && toAmt > 0) return toAmt;
  const qty = fromAmt || toAmt;
  if (price > 0 && qty > 0) return qty * price;
  return 0;
}

function recentTrades(trades) {
  return trades.slice(-8).reverse().map((trade) => {
    const from = String(trade.fromToken || "").toUpperCase();
    const buy = STABLES.has(from);
    const tx = typeof trade.txHash === "string" && /^0x[a-fA-F0-9]{64}$/.test(trade.txHash) ? trade.txHash : null;
    return {
      time: Number(trade.timestamp) || 0,
      side: buy ? "buy" : "sell",
      symbol: buy ? trade.toToken || "" : trade.fromToken || "",
      usd: round2(tradeNotional(trade)),
      pnl: trade.realizedPnl == null ? null : round2(trade.realizedPnl),
      tx,
    };
  });
}

function tally(rows, key) {
  const counts = {};
  for (const row of rows) {
    const name = row[key] || "unknown";
    counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

const MAX_DESK_SUBSCRIBERS = 25;

/**
 * Server-sent event fan-out for the read-only monitor desk.
 * One shared producer polls tenant books for all viewers, so N open tabs cost
 * the same upstream load as one. Frames are only emitted when data changes;
 * otherwise a comment heartbeat keeps proxies from closing the socket.
 */
function createDeskStream(build, intervalMs = 3000) {
  const clients = new Set();
  let timer = null;
  let lastSig = "";
  let lastFrame = "";
  let lastBeat = 0;
  let busy = false;

  const signature = (data) => JSON.stringify(data, (key, val) => (key === "generatedAt" || key === "uptimeMs" || key === "requests" || key === "bookLatencyMs" ? undefined : val));

  async function tick() {
    if (busy || clients.size === 0) return;
    busy = true;
    try {
      const data = await build();
      const sig = signature(data);
      if (sig !== lastSig) {
        lastSig = sig;
        lastFrame = `event: snapshot\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of clients) res.write(lastFrame);
        lastBeat = Date.now();
      } else if (Date.now() - lastBeat >= 15_000) {
        const beat = `event: beat\ndata: ${JSON.stringify({ t: Date.now(), health: data.overview.health, bookLatencyMs: data.live.bookLatencyMs })}\n\n`;
        for (const res of clients) res.write(beat);
        lastBeat = Date.now();
      }
    } catch {
      for (const res of clients) res.write(`event: fault\ndata: {}\n\n`);
    } finally {
      busy = false;
    }
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    lastSig = "";
    lastFrame = "";
  }

  return {
    subscribe(req, res) {
      if (clients.size >= MAX_DESK_SUBSCRIBERS) return send(res, 503, { error: "too many monitor viewers" });
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff",
      });
      res.write(`retry: 3000\n\n`);
      clients.add(res);
      if (lastFrame) res.write(lastFrame);
      const drop = () => {
        clients.delete(res);
        if (clients.size === 0) stop();
      };
      req.on("close", drop);
      res.on("error", drop);
      if (!timer) {
        timer = setInterval(tick, Math.max(1000, Number(intervalMs) || 3000));
        timer.unref?.();
      }
      if (!lastFrame) tick();
    },
  };
}

function allow(limits, ip, pathname, method) {
  const create = method === "POST" && (pathname === "/tenants" || pathname === "/checkout");
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
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

export function createSandboxDocker() {
  const containers = new Set();
  return {
    async ensureNetwork() {},
    async ensureImage() {},
    async up(t) { containers.add(t.containerName || t.project); },
    async stop(t) { containers.delete(t.containerName || t.project); },
    async start(t) { containers.add(t.containerName || t.project); },
    async down(t) { containers.delete(t.containerName || t.project); },
    async signin() {
      return { qrCodeId: "sandbox-qr-01", pairingCode: "8842-9910", urlForWeb: "https://www.binance.com/en/my/wallet/agentic" };
    },
    async verify() { return { ok: true }; },
    async walletAddress() { return "0x7777777777777777777777777777777777777777"; },
    async listContainers() { return [...containers]; },
    async readState() {
      return JSON.stringify({
        mode: "paper",
        running: true,
        cycleCount: 12,
        startedAt: Date.now() - 3600_000,
        portfolio: {
          totalValueUsd: 264.8,
          cashUsd: 144.8,
          dailyPnl: 6.4,
          totalPnl: 14.8,
          realizedPnl: 9.2,
          positions: [
            { symbol: "NVDAB", amount: 0.5, currentPrice: 140 },
            { symbol: "TSLAB", amount: 0.2, currentPrice: 250 },
          ],
        },
        trades: [
          {
            success: true,
            fromToken: "USDT",
            toToken: "NVDAB",
            fromAmount: "70",
            toAmount: "0.5",
            priceAtExecution: 140,
            timestamp: Date.now() - 1800_000,
            txHash: `0x${"ab".repeat(32)}`,
          },
          {
            success: true,
            fromToken: "AAPLB",
            toToken: "USDT",
            fromAmount: "0.2",
            toAmount: "59.2",
            priceAtExecution: 296,
            timestamp: Date.now() - 600_000,
            txHash: `0x${"cd".repeat(32)}`,
            realizedPnl: 9.2,
          },
        ],
      });
    },
  };
}

export function createSandboxRpc(store, config) {
  // The fake chain pays from this address; set it to a test wallet to exercise wallet sign-in.
  const payer = (process.env.SAAS_SANDBOX_PAYER || "0x9999999999999999999999999999999999999999").toLowerCase();
  return async function sandboxRpc(method, params) {
    if (method === "eth_blockNumber") return "0x3e8"; // block 1000
    if (method === "eth_chainId") return "0x38"; // BNB Smart Chain mainnet
    if (method === "eth_call") return "0x12"; // configured BEP-20 payment assets use 18 decimals
    const openOrder = store.listOrders().find((o) => o.status === "pending") || {
      asset: "USDT",
      amount_wei: parseUnits18(String(config.priceUsd)).toString(),
      treasury_address: config.treasuryAddress,
    };
    const isBnb = openOrder.asset === "BNB";
    const contract = config.tokenContracts[openOrder.asset] || config.tokenContracts.USDT;
    const hash = String(params?.[0] || `0x${"aa".repeat(32)}`).toLowerCase();
    const blockHash = `0x${"b1".repeat(32)}`;
    if (method === "eth_getBlockByNumber") {
      // A payment is made after its order exists; one second ahead clears the sub-second rounding in the check.
      return { hash: blockHash, timestamp: `0x${(Math.floor(Date.now() / 1000) + 1).toString(16)}` };
    }
    if (method === "eth_getTransactionByHash") {
      return {
        hash,
        blockHash,
        blockNumber: "0x3d0",
        from: payer,
        to: isBnb ? openOrder.treasury_address : contract,
        value: isBnb ? `0x${BigInt(openOrder.amount_wei).toString(16)}` : "0x0",
      };
    }
    if (method === "eth_getTransactionReceipt") {
      return {
        status: "0x1",
        transactionHash: hash,
        blockHash,
        blockNumber: "0x3d0", // block 976 -> 25 confirmations (>= 15)
        logs: isBnb
          ? []
          : [
              {
                address: contract,
                topics: [ERC20_TRANSFER_TOPIC, padTopicAddress(payer), padTopicAddress(openOrder.treasury_address)],
                data: `0x${BigInt(openOrder.amount_wei).toString(16).padStart(64, "0")}`, // a real log pads to 32 bytes
              },
            ],
      };
    }
    return [];
  };
}

export function start(config = loadConfig(), deps = {}) {
  const store = deps.store || openStore(config.dbPath);
  const backup = { kick() {}, stop() {} };
  let backupClosed = false;
  watchUserRecords(store, () => backup.kick());
  void attachSaasBackup({
    store,
    databaseUrl: config.devSandbox ? "" : config.databaseUrl,
    log: (message, level) => {
      if (level === "info") console.log(message);
      else console.warn(message);
    },
  }).then((attached) => {
    backup.kick = attached.kick;
    backup.stop = attached.stop;
    if (backupClosed) void attached.stop();
  }).catch((err) => {
    console.warn(`SaaS Neon backup unavailable — local control store remains live: ${safeError(err)}`);
  });
  const docker =
    deps.docker ||
    (config.devSandbox ? createSandboxDocker() : createDocker({ repoRoot: config.repoRoot, composeFile: config.composeFile }));
  const rpc = deps.rpc || (config.devSandbox ? createSandboxRpc(store, config) : undefined);
  const bnbPrice =
    deps.bnbPrice ||
    createBnbPriceFeed({
      fallbackUsd: config.bnbPriceUsd,
      cachePath: join(dirname(config.dbPath), "bnb-price.json"),
      fetchImpl: deps.fetchImpl,
    });
  if (typeof bnbPrice.start === "function") {
    bnbPrice.start().then(
      (snap) => console.log(`  BNB/USD: ${snap.priceUsd} (${snap.source})`),
      (err) => console.warn(`  BNB/USD fallback ${config.bnbPriceUsd}: ${err instanceof Error ? err.message : err}`),
    );
  }
  const handler = createHandler({ store, docker, config, rpc, bnbPrice });
  const server = createServer(handler);
  const timers = [];
  const every = (fn, ms, firstMs) => {
    let busy = false;
    const run = async () => {
      if (busy) return; // a slow pass must not stack up behind itself
      busy = true;
      try { await fn(); } catch (err) { console.warn(`scheduled task failed: ${safeError(err)}`); } finally { busy = false; }
    };
    timers.push(setTimeout(run, firstMs).unref(), setInterval(run, ms).unref());
  };
  every(() => runMaintenance({ store, docker, config, telegram: handler.telegram }), config.maintenanceMs, 15_000);
  if (parseBackupKey(config.backupKey) && config.backupDir) {
    every(() => runTenantBackup({ store, config, telegram: handler.telegram }), config.backupEveryMs, 120_000);
  } else if (!config.devSandbox) {
    console.warn("  Tenant backups are OFF: set SAAS_BACKUP_KEY and SAAS_BACKUP_DIR (a lost disk loses every wallet login).");
  }
  let poller = null;
  if (config.telegramPoll && handler.telegram.enabled) {
    poller = startPolling({ telegram: handler.telegram, route: handler.routeTelegram });
    console.log("  Telegram bot: polling for messages");
  }
  server.on("close", () => {
    backupClosed = true;
    void backup.stop();
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    void poller?.stop();
  });
  server.listen(config.port, config.bind, () => {
    console.log(`Neural Alpha SaaS Control (${config.hostId}) listening on http://${config.bind}:${config.port}`);
    console.log(`  Customer portal:  ${config.localPortalUrl}`);
    console.log(`  Public portal:    ${config.portalUrl}`);
    console.log(`  Admin desk:       ${appPath(config.localPortalUrl, "/admin")}`);
    if (config.devSandbox) {
      console.log(`  [DEV SANDBOX]     Monitor Secret: ${config.monitorSecret} | Operator Secret: ${config.apiSecret}`);
    }
  });
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const cellEnv = join(REPO_ROOT, "saas/runtime/cell.env");
  // The dev sandbox is fake end to end: it must never pick up a real cell's secrets or database.
  if (process.env.SAAS_DEV_SANDBOX !== "1" && existsSync(cellEnv)) process.loadEnvFile(cellEnv);
  start();
}
