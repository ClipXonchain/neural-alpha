import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDocker } from "./docker.mjs";
import { createEdgeCluster, formatCompoundToken, normalizeBaseUrl, parseCompoundToken } from "./edge.mjs";
import { tenantDir, writeTenantFiles } from "./files.mjs";
import { createBscRpc, createTreasuryWatcher, ERC20_TRANSFER_TOPIC, padTopicAddress, verifyBscReceipt } from "./payments.mjs";
import {
  assertAddress,
  assertPayment,
  CALLS_PER_CYCLE,
  CHECKOUT_EXPIRY_MS,
  CHECKOUT_SETTLEMENT_GRACE_MS,
  containerName,
  estimatedUsePerMin,
  formatUnits18,
  hostPlan,
  parseUnits18,
  PAYMENT_ASSETS,
  projectName,
  quoteOrderAmount,
  REQUIRED_CONFIRMATIONS,
  resolveRisk,
  resolveTokenContracts,
  staggerSeconds,
  SUBSCRIPTION_MS,
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
    databaseUrl: env.TENANT_DATABASE_URL?.trim() || "",
    treasuryAddress: rawTreasury ? assertAddress(rawTreasury, "SAAS_TREASURY_ADDRESS") : "",
    priceUsd: num("SAAS_PRICE_USD", 30),
    bnbPriceUsd: num("SAAS_BNB_PRICE_USD", 600),
    minConfirmations: num("SAAS_MIN_CONFIRMATIONS", REQUIRED_CONFIRMATIONS),
    bscRpcUrl: env.SAAS_BSC_RPC_URL?.trim() || "https://bsc-dataseed.binance.org",
    tokenContracts: resolveTokenContracts(env),
    cellNodesEnv: env.SAAS_CELL_NODES?.trim() || "",
    edgeOnly: env.SAAS_EDGE_ONLY === "1",
    devSandbox,
    bind: env.SAAS_BIND_HOST?.trim() || "127.0.0.1",
    port: num("SAAS_CONTROL_PORT", 3910),
    portalUrl: env.SAAS_APP_URL?.trim() || "http://127.0.0.1:3000/portal",
    demo: env.SAAS_DESK_DEMO === "1",
    streamIntervalMs: num("SAAS_DESK_STREAM_MS", 3000),
    operatorAgent: formatAgentId(env.SAAS_OPERATOR_AGENT_ID),
    plan,
  };
}

export function formatAgentId(value) {
  const name = String(value || "").trim().toLowerCase().replace(/\.ai$/, "");
  if (!/^[a-z0-9]{3,15}$/.test(name)) return null;
  return name + ".ai";
}

export function createHandler({ store, docker, config, rpc, fetchImpl, now = () => new Date() }) {
  const limits = new Map();
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
  const watcher = createTreasuryWatcher({
    store,
    config,
    rpc: bscRpc,
    now,
    onOrderPaid: (orderId, txHash) =>
      fulfillQueued({ store, docker, config, rpc: bscRpc, now, orderId, paymentTx: txHash, fromWatcher: true }),
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
        let html = ADMIN_HTML;
        try {
          html = readFileSync(join(HERE, "admin.html"), "utf8");
        } catch {}
        return sendHtml(res, html);
      }
      if (
        (req.method === "GET" || req.method === "HEAD") &&
        (url.pathname === "/portal" || url.pathname === "/portal/")
      ) {
        res.writeHead(302, { location: config.portalUrl, "cache-control": "no-store" });
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
        return send(res, 200, openPaidSession({ store, config, now, body }));
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
        return send(res, 201, createCheckoutOrder({ store, config, now, body }));
      }
      const checkoutMatch = url.pathname.match(/^\/checkout\/(ord_[a-f0-9]{12})(\/verify|\/claim)?$/);
      if (checkoutMatch) {
        const orderId = checkoutMatch[1];
        const subAction = checkoutMatch[2] || "";
        if (req.method === "GET" && subAction === "") {
          const order = getFreshOrder(store, config, orderId, now);
          if (!order) return send(res, 404, { error: "order not found" });
          return send(res, 200, { order: publicOrderView(order) });
        }
        if (req.method === "POST" && subAction === "/verify") {
          const body = await readJson(req);
          const result = await fulfillQueued({
            store,
            docker,
            config,
            rpc: bscRpc,
            now,
            orderId,
            paymentTx: body.paymentTx,
            claimSecret: body.claimSecret,
          });
          return send(res, 200, result);
        }
        if (req.method === "POST" && subAction === "/claim") {
          const body = await readJson(req);
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
                  ? quoteOrderAmount({ asset: "BNB", priceUsd: config.priceUsd, bnbPriceUsd: config.bnbPriceUsd, tail: 0 }).amountWei
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
            preset: body.preset,
            agentName: body.agentName,
            verified,
          });
        });
        return send(res, 201, await created);
      }

      const match = url.pathname.match(/^\/tenants\/([a-z0-9]{8})(\/[^/]+(?:\/[^/]+)?)?$/);
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

      if (req.method === "GET" && action === "") return send(res, 200, { tenant: customerView(tenant) });
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
        const risk = resolveRisk(body.preset);
        const updated = applySpec(store, tenant, { risk, agentMode: tenant.agent_mode }, config, now);
        if (tenant.status === "running") await docker.up(dockerTarget(updated));
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
          tenant: customerView(store.update(tenant.id, {
            wallet_address: address || tenant.wallet_address,
            updated_at: now().toISOString(),
          })),
        });
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
  return handler;
}

function openPaidSession({ store, config, now, body }) {
  const tx = String(body?.paymentTx || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(tx)) {
    throw Object.assign(new Error("paymentTx must be a transaction hash"), { status: 400 });
  }
  const payer = assertAddress(body?.payer, "payer");
  const order = store.listOrders().find(
    (row) =>
      row.host_id === config.hostId &&
      row.status === "paid" &&
      String(row.payment_tx || "").toLowerCase() === tx,
  );
  if (!order?.tenant_id) throw Object.assign(new Error("paid order not found"), { status: 404 });
  if (!order.payer_address || order.payer_address !== payer) {
    throw Object.assign(new Error("payer does not match this payment"), { status: 401 });
  }
  const tenant = localTenant(store, config, order.tenant_id);
  if (!tenant) throw Object.assign(new Error("paid order not found"), { status: 404 });
  const accessToken = randomBytes(32).toString("hex");
  const updated = store.update(tenant.id, {
    access_token_hash: hashToken(accessToken),
    updated_at: now().toISOString(),
  });
  return {
    tenant: customerView(updated),
    compoundToken: formatCompoundToken(config.hostId, updated.id, accessToken),
  };
}

function createCheckoutOrder({ store, config, now, body }) {
  if (!config.treasuryAddress) {
    throw Object.assign(new Error("SAAS_TREASURY_ADDRESS is not configured on this host"), { status: 503 });
  }
  const asset = String(body?.paymentAsset || "USDT").trim().toUpperCase();
  if (!PAYMENT_ASSETS.includes(asset)) {
    throw Object.assign(new Error("paymentAsset must be USDT, USDC, BNB, U, or USD1"), { status: 400 });
  }
  const risk = resolveRisk(body?.preset || "cautious");
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
  const nowMs = nowDate.getTime();
  const usedTails = new Set(
    store
      .listOrders()
      .filter((ord) => ord.host_id === config.hostId && ord.status === "pending" && Date.parse(ord.expires_at) > nowMs)
      .map((ord) => Number(ord.tail)),
  );
  let tail = (randomBytes(3).readUIntBE(0, 3) % 9_999) + 1;
  while (usedTails.has(tail)) {
    tail = (tail % 9_999) + 1;
  }

  const quote = quoteOrderAmount({
    asset,
    priceUsd: config.priceUsd,
    bnbPriceUsd: config.bnbPriceUsd,
    tail,
  });
  const id = `ord_${randomBytes(6).toString("hex")}`;
  const claimSecret = randomBytes(24).toString("hex");
  const stamp = nowDate.toISOString();
  const expiresAt = new Date(nowMs + CHECKOUT_EXPIRY_MS).toISOString();
  const order = store.insertOrder({
    id,
    host_id: config.hostId,
    status: "pending",
    asset: quote.asset,
    risk_preset: risk.preset,
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

function getFreshOrder(store, config, orderId, now) {
  const order = store.getOrder(orderId);
  if (!order || order.host_id !== config.hostId) return null;
  if (
    order.status === "pending" &&
    Date.parse(order.expires_at) + CHECKOUT_SETTLEMENT_GRACE_MS <= now().getTime()
  ) {
    return store.updateOrder(order.id, { status: "expired", updated_at: now().toISOString() });
  }
  return order;
}

function publicOrderView(order) {
  return {
    id: order.id,
    hostId: order.host_id,
    status: order.status,
    asset: order.asset,
    preset: order.risk_preset,
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
  now,
  orderId,
  paymentTx,
  claimSecret,
  fromWatcher = false,
}) {
  const order = getFreshOrder(store, config, orderId, now);
  if (!order) throw Object.assign(new Error("order not found"), { status: 404 });
  if (order.status === "paid") {
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
  if (store.findByPaymentTx(payment.tx)) {
    throw Object.assign(new Error("paymentTx was already used"), { status: 409 });
  }
  if (!rpc) {
    throw Object.assign(new Error("BSC RPC is not configured"), { status: 503 });
  }

  const verified = await verifyBscReceipt({
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

  const stamp = now().toISOString();

  // Case 1: Renewal for an existing tenant
  if (order.tenant_id) {
    const existing = localTenant(store, config, order.tenant_id);
    if (!existing) throw Object.assign(new Error("tenant to renew not found"), { status: 404 });
    const currentExpiry = Date.parse(existing.paid_until || "") || 0;
    const baseMs = Math.max(now().getTime(), currentExpiry);
    const nextPaidUntil = new Date(baseMs + SUBSCRIPTION_MS).toISOString();
    const risk = resolveRisk(order.risk_preset || existing.risk_preset);
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

  // Case 2: Provision new tenant container
  const created = await createTenant({
    store,
    docker,
    config,
    now,
    payment,
    preset: order.risk_preset,
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
    updated_at: stamp,
  });

  return {
    order: publicOrderView(updatedOrder),
    tenant: created.tenant,
    ...(canClaimNow
      ? {
          accessToken: created.accessToken,
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
  if (token) {
    store.updateOrder(order.id, { pending_access_token: null, updated_at: new Date().toISOString() });
  }
  return {
    order: publicOrderView(order),
    tenant: tenant ? customerView(tenant) : null,
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
  const mine = store.list().filter((row) => row.host_id === config.hostId);
  const haltedIds = [];
  for (const row of mine) {
    if (!row.paid_until) continue;
    const expiryMs = Date.parse(row.paid_until);
    if (Number.isFinite(expiryMs) && expiryMs <= nowMs && !row.buys_halted) {
      const updated = applySpec(
        store,
        row,
        { risk: riskFromRow(row), agentMode: row.agent_mode, buysHalted: true },
        config,
        now,
      );
      if (row.status === "running") {
        await docker.up(dockerTarget(updated));
      }
      haltedIds.push(row.id);
    }
  }
  return { hostId: config.hostId, haltedCount: haltedIds.length, haltedIds };
}

async function createTenant({ store, docker, config, now, payment, preset, agentName, orderId = null, verified = null }) {
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
  const id = newId(store);
  const risk = resolveRisk(preset || "cautious");
  const nowDate = now();
  const stamp = nowDate.toISOString();
  const paidUntil = new Date(nowDate.getTime() + SUBSCRIPTION_MS).toISOString();
  const dir = tenantDir(config.dataRoot, id);
  const accessToken = randomBytes(32).toString("hex");
  const row = {
    id,
    host_id: config.hostId,
    status: "provisioning",
    container_name: containerName(id),
    data_dir: dir,
    risk_preset: risk.preset,
    agent_mode: "paper",
    max_position_usd: risk.maxPositionUsd,
    max_drawdown_pct: 0,
    max_trade_usd: risk.maxTradeUsd,
    trade_interval_ms: config.plan.intervalMs,
    wallet_address: null,
    access_token_hash: hashToken(accessToken),
    agent_api_secret: randomBytes(32).toString("hex"),
    payment_asset: payment.asset,
    payment_tx: payment.tx,
    agent_name: formatAgentId(agentName),
    paid_until: paidUntil,
    order_id: orderId,
    paid_amount: verified ? verified.paidDisplay : null,
    overpaid_amount: verified ? verified.overpaidDisplay : null,
    buys_halted: 0,
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
    buysHalted: Boolean(row.buys_halted),
    paymentAsset: row.payment_asset,
    apiSecret: row.agent_api_secret,
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
  const row = store.findByAccessHash(hashToken(lookupToken));
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
  if (method === "GET" && (pathname === "/capacity" || pathname === "/recovery" || pathname === "/tenants")) return true;
  if (
    method === "POST" &&
    (pathname === "/recovery/adopt" ||
      pathname === "/cluster/nodes" ||
      pathname === "/watcher/scan" ||
      pathname === "/subscriptions/sweep" ||
      pathname === "/session/open")
  ) {
    return true;
  }
  return method === "DELETE" && pathname.startsWith("/cluster/nodes/");
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

const HIDDEN = new Set(["access_token_hash", "agent_api_secret", "max_drawdown_pct"]);

function customerView(row) {
  const view = operatorView(row);
  delete view.data_dir;
  delete view.payment_tx;
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

const ADMIN_HTML = readFileSync(join(HERE, "admin.html"), "utf8");

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

function sendHtml(res, html) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(html);
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
  const payer = "0x9999999999999999999999999999999999999999";
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
    if (method === "eth_getTransactionByHash") {
      return {
        hash,
        from: payer,
        to: isBnb ? openOrder.treasury_address : contract,
        value: isBnb ? `0x${BigInt(openOrder.amount_wei).toString(16)}` : "0x0",
      };
    }
    if (method === "eth_getTransactionReceipt") {
      return {
        status: "0x1",
        blockNumber: "0x3d0", // block 976 -> 25 confirmations (>= 15)
        logs: isBnb
          ? []
          : [
              {
                address: contract,
                topics: [ERC20_TRANSFER_TOPIC, padTopicAddress(payer), padTopicAddress(openOrder.treasury_address)],
                data: `0x${BigInt(openOrder.amount_wei).toString(16)}`,
              },
            ],
      };
    }
    return [];
  };
}

export function start(config = loadConfig(), deps = {}) {
  const store = deps.store || openStore(config.dbPath);
  const docker =
    deps.docker ||
    (config.devSandbox ? createSandboxDocker() : createDocker({ repoRoot: config.repoRoot, composeFile: config.composeFile }));
  const rpc = deps.rpc || (config.devSandbox ? createSandboxRpc(store, config) : undefined);
  const server = createServer(createHandler({ store, docker, config, rpc }));
  server.listen(config.port, config.bind, () => {
    console.log(`Neural Alpha SaaS Control (${config.hostId}) listening on http://${config.bind}:${config.port}`);
    console.log(`  Customer portal:  ${config.portalUrl}`);
    console.log(`  Admin Monitor:    http://${config.bind}:${config.port}/admin`);
    if (config.devSandbox) {
      console.log(`  [DEV SANDBOX]     Monitor Secret: ${config.monitorSecret} | Operator Secret: ${config.apiSecret}`);
    }
  });
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) start();
