import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ERC20_TRANSFER_TOPIC, padTopicAddress } from "./payments.mjs";
import { CHECKOUT_EXPIRY_MS, DEFAULT_TOKEN_CONTRACTS, parseUnits18 } from "./policy.mjs";
import { loadConfig, createHandler, portalLocation, adminLocation, runMaintenance } from "./server.mjs";
import { openStore } from "./store.mjs";

function fakeDocker() {
  const containers = new Set();
  return {
    containers,
    async ensureNetwork() {},
    async ensureImage() {},
    async up(tenant) {
      containers.add(tenant.containerName || tenant.project);
    },
    async stop(tenant) {
      containers.delete(tenant.containerName || tenant.project);
    },
    async start(tenant) {
      containers.add(tenant.containerName || tenant.project);
    },
    async down(tenant) {
      containers.delete(tenant.containerName || tenant.project);
    },
    async signin() {
      return { qrCodeId: "qr-1", pairingCode: "4455", urlForWeb: "https://example.test/pair" };
    },
    async verify() {
      return { ok: true };
    },
    async walletAddress() {
      return "0xabc";
    },
    async listContainers() {
      return [...containers];
    },
    async readState() {
      return JSON.stringify({
        mode: "paper",
        running: true,
        cycleCount: 4,
        portfolio: {
          totalValueUsd: 120.5,
          cashUsd: 80,
          dailyPnl: 1.5,
          totalPnl: 3.25,
          realizedPnl: 2,
          positions: [{ symbol: "AAPLB" }],
          maxDrawdownPct: 4,
        },
        trades: [
          {
            success: true,
            fromToken: "USDT",
            toToken: "AAPLB",
            fromAmount: "25",
            toAmount: "0.1",
            priceAtExecution: 250,
            timestamp: 1,
            txHash: `0x${"ab".repeat(32)}`,
          },
          {
            success: true,
            fromToken: "AAPLB",
            toToken: "USDT",
            fromAmount: "0.1",
            toAmount: "30",
            priceAtExecution: 300,
            timestamp: 2,
            txHash: `0x${"cd".repeat(32)}`,
            realizedPnl: 5,
          },
        ],
      });
    },
  };
}

function pay(tag, asset = "USDT") {
  return { paymentAsset: asset, paymentTx: `0x${tag.repeat(32).slice(0, 64)}` };
}

const handlerRegistry = new Map();
let nextMockPort = 41000;
const nativeFetch = globalThis.fetch;

globalThis.fetch = async (input, init = {}) => {
  const urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const parsed = new URL(urlStr);
  const handler = handlerRegistry.get(parsed.origin);
  if (!handler) {
    return nativeFetch(input, init);
  }
  return dispatchInMemory(handler, parsed, init);
};

function dispatchInMemory(handler, parsedUrl, init = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = (init.method || "GET").toUpperCase();
    req.url = parsedUrl.pathname + parsedUrl.search;
    req.headers = {};
    if (init.headers) {
      const entries = init.headers instanceof Headers ? init.headers.entries() : Object.entries(init.headers);
      for (const [k, v] of entries) req.headers[String(k).toLowerCase()] = String(v);
    }
    req.socket = { remoteAddress: "127.0.0.1" };
    req.destroy = () => req.emit("close");

    const res = new EventEmitter();
    let statusCode = 200;
    let resHeaders = {};
    let resolved = false;
    let streamController = null;

    const stream = new ReadableStream({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        req.emit("close");
      },
    });

    if (init.signal) {
      if (init.signal.aborted) {
        req.emit("close");
        return reject(new DOMException("Aborted", "AbortError"));
      }
      init.signal.addEventListener("abort", () => {
        req.emit("close");
        try {
          streamController?.close();
        } catch {}
      });
    }

    res.writeHead = (code, headers = {}) => {
      statusCode = code;
      resHeaders = {};
      for (const [k, v] of Object.entries(headers)) resHeaders[k.toLowerCase()] = String(v);
      if (!resolved) {
        resolved = true;
        resolve(new Response(req.method === "HEAD" ? null : stream, { status: statusCode, headers: resHeaders }));
      }
      return res;
    };

    res.write = (chunk) => {
      if (!resolved) res.writeHead(statusCode, resHeaders);
      const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
      try {
        streamController?.enqueue(bytes);
      } catch {}
      return true;
    };

    res.end = (chunk) => {
      if (!resolved) res.writeHead(statusCode, resHeaders);
      if (chunk !== undefined && chunk !== null && req.method !== "HEAD") {
        res.write(chunk);
      }
      try {
        streamController?.close();
      } catch {}
      res.emit("finish");
    };

    Promise.resolve(handler(req, res)).catch(reject);

    queueMicrotask(() => {
      if (init.body !== undefined && init.body !== null) {
        const buf = typeof init.body === "string" ? Buffer.from(init.body, "utf8") : Buffer.from(init.body);
        req.emit("data", buf);
      }
      req.emit("end");
    });
  });
}

async function listen(handler) {
  const port = nextMockPort++;
  const url = `http://127.0.0.1:${port}`;
  handlerRegistry.set(url, handler);
  return {
    server: {
      close() {
        handlerRegistry.delete(url);
      },
    },
    url,
  };
}

async function call(base, path, opts = {}) {
  const response = await fetch(`${base}${path}`, {
    method: opts.method || "GET",
    headers: {
      ...(opts.token === null ? {} : { authorization: `Bearer ${opts.token || "test-secret"}` }),
      ...(opts.headers || {}),
      ...(opts.body ? { "content-type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

test("each customer gets a separate container and the third is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "na-control-"));
  const config = loadConfig({
    CONTROL_API_SECRET: "test-secret",
    SAAS_MONITOR_SECRET: "monitor-secret",
    SAAS_DATA_ROOT: root,
    SAAS_DB_PATH: join(root, "control.sqlite"),
    SAAS_HOST_ID: "box-a",
    SAAS_MAX_TENANTS: "2",
    SAAS_HOST_RAM_MB: "16384",
  });
  const store = openStore(config.dbPath);
  const docker = fakeDocker();
  const { server, url } = await listen(createHandler({ store, docker, config }));
  try {
    const first = await call(url, "/tenants", { method: "POST", token: null, body: pay("aa") });
    const second = await call(url, "/tenants", { method: "POST", token: null, body: pay("bb", "USDC") });
    const reused = await call(url, "/tenants", { method: "POST", token: null, body: pay("aa") });
    const third = await call(url, "/tenants", { method: "POST", token: null, body: pay("cc", "BNB") });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(reused.status, 409);
    assert.match(reused.body.error, /already used/);
    assert.equal(third.status, 409);
    assert.match(third.body.error, /tenant limit/);
    assert.notEqual(first.body.tenant.container_name, second.body.tenant.container_name);
    assert.equal(first.body.tenant.data_dir, undefined);
    assert.equal(first.body.tenant.payment_tx, undefined);
    assert.match(first.body.accessToken, /^[a-f0-9]{64}$/);
    const listed = await call(url, "/tenants");
    const row = listed.body.tenants.find((tenant) => tenant.id === first.body.tenant.id);
    const env = readFileSync(join(row.data_dir, "tenant.env"), "utf8");
    assert.match(env, /AGENT_MODE=live/);
    assert.match(env, /MAX_POSITION_SIZE_USD=100/);
    assert.match(env, /HACKATHON_MAX_TRADE_USD=100/);
    assert.match(env, /X402_MIN_PAYMENTS_PER_DAY=1/);
    assert.match(env, /DISABLE_DRAWDOWN_LIMIT=true/);
    assert.match(env, /PAYMENT_TOKEN=USDT/);
    const usdc = listed.body.tenants.find((tenant) => tenant.payment_asset === "USDC");
    const usdcEnv = readFileSync(join(usdc.data_dir, "tenant.env"), "utf8");
    assert.match(usdcEnv, /PAYMENT_TOKEN=USDT/);
    assert.doesNotMatch(usdcEnv, /PAYMENT_TOKEN=USDC/);
    assert.match(env, /API_SECRET=/);
    assert.doesNotMatch(env, /MAX_DRAWDOWN_PCT/);
    assert.match(env, /TRADE_INTERVAL_MS=300000/);
    assert.doesNotMatch(JSON.stringify(listed.body), /agent_api_secret|access_token_hash|access_code_hash|accessCode/);
    assert.match(first.body.accessCode, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}(?:-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}){3}$/);
    const byCode = await call(url, "/session/code", {
      method: "POST",
      token: null,
      body: { code: first.body.accessCode.toLowerCase() },
    });
    assert.equal(byCode.status, 200);
    assert.match(byCode.body.compoundToken, /^box-a\.[a-z0-9]{8}\.[a-f0-9]{64}$/);
    const wrongCode = await call(url, "/session/code", {
      method: "POST",
      token: null,
      body: { code: "AAAA-BBBB-CCCC-DDDD" },
    });
    assert.equal(wrongCode.status, 401);
    assert.equal(wrongCode.body.compoundToken, undefined);

    const live = await call(url, `/tenants/${first.body.tenant.id}/mode`, {
      method: "POST",
      body: { mode: "live" },
    });
    assert.equal(live.status, 409);

    const pair = await call(url, `/tenants/${first.body.tenant.id}/pair/verify`, {
      method: "POST",
      body: { qrCodeId: "qr-1" },
    });
    assert.equal(pair.body.tenant.wallet_address, "0xabc");
    assert.equal(pair.body.tenant.agent_mode, "live");
    const allowed = await call(url, `/tenants/${first.body.tenant.id}/mode`, {
      method: "POST",
      body: { mode: "live" },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.tenant.agent_mode, "live");

    const cap = await call(url, "/capacity");
    assert.equal(cap.body.maxTenants, 2);
    assert.equal(cap.body.running, 2);
    assert.ok(cap.body.estimatedUsePerMin <= cap.body.upstreamBudgetPerMin);

    const sessionToken = byCode.body.compoundToken;
    const other = await call(url, `/tenants/${second.body.tenant.id}`, { token: sessionToken });
    assert.equal(other.status, 404);
    const own = await call(url, `/tenants/${first.body.tenant.id}`, { token: sessionToken });
    assert.equal(own.status, 200);
    assert.equal(own.body.tenant.id, first.body.tenant.id);
    const listedAsCustomer = await call(url, "/tenants", { token: first.body.accessToken });
    assert.equal(listedAsCustomer.status, 401);

    const desk = await call(url, "/admin/overview", { token: "monitor-secret" });
    assert.equal(desk.status, 200);
    assert.equal(desk.body.readOnly, true);
    assert.equal(desk.body.operator.agentId, null);
    assert.ok(desk.body.health.requests >= 1);
    assert.ok(desk.body.health.uptimeMs >= 0);
    assert.equal(desk.body.counts.byAsset.USDT, 1);
    assert.equal(desk.body.counts.byAsset.USDC, 1);
    assert.equal(desk.body.counts.customers, 2);
    assert.doesNotMatch(JSON.stringify(desk.body), /agent_api_secret|access_token_hash|accessToken/);
    const books = await call(url, "/admin/live", { token: "monitor-secret" });
    assert.equal(books.body.fleet.reachable, 2);
    assert.equal(books.body.fleet.navUsd, 241);
    assert.equal(books.body.fleet.trades, 4);
    assert.equal(books.body.fleet.volumeUsd, 110);
    assert.equal(books.body.fleet.wins, 2);
    assert.equal(books.body.fleet.recent[0].side, "sell");
    assert.equal(books.body.tenants[0].symbols[0], "AAPLB");
    assert.equal(books.body.tenants[0].maxDrawdownPct, undefined);
    const monitorControl = await call(url, `/tenants/${first.body.tenant.id}/pause`, {
      method: "POST",
      token: "monitor-secret",
    });
    assert.equal(monitorControl.status, 404);
    const deskWrite = await call(url, "/tenants", {
      method: "POST",
      headers: { "x-neural-desk": "observe" },
      body: pay("dd"),
    });
    assert.equal(deskWrite.status, 403);
    const page = await fetch(`${url}/admin`, { redirect: "manual" });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get("location"), "http://127.0.0.1:3000/admin");
    await page.body?.cancel();
    const home = await fetch(`${url}/`, { redirect: "manual" });
    assert.equal(home.status, 302);
    assert.equal(home.headers.get("location"), "http://127.0.0.1:3000/admin");
    await home.body?.cancel();
    const customerDesk = await call(url, "/admin/overview", { token: first.body.accessToken });
    assert.equal(customerDesk.status, 401);

    const deniedStream = await fetch(`${url}/admin/stream`, { headers: { authorization: `Bearer ${first.body.accessToken}` } });
    assert.equal(deniedStream.status, 401);
    await deniedStream.body?.cancel();
    const streamCtl = new AbortController();
    const stream = await fetch(`${url}/admin/stream`, {
      headers: { authorization: "Bearer monitor-secret", "x-neural-desk": "observe" },
      signal: streamCtl.signal,
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type"), /text\/event-stream/);
    const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
    let streamed = "";
    while (!streamed.includes("event: snapshot")) {
      const { value, done } = await reader.read();
      if (done) break;
      streamed += value;
    }
    streamCtl.abort();
    const frame = streamed.slice(streamed.indexOf("event: snapshot")).split("\n\n")[0];
    const payload = JSON.parse(frame.split("\n").find((line) => line.startsWith("data:")).slice(5));
    assert.equal(payload.overview.counts.customers, 2);
    assert.equal(payload.live.fleet.navUsd, 241);
    assert.doesNotMatch(frame, /agent_api_secret|access_token_hash|accessToken/);
  } finally {
    server.close();
    store.close();
  }
});

test("checkout verifies BSC receipt (status, token, treasury, amount, 15 confirmations) and provisions dedicated customer dashboard", async () => {
  const root = mkdtempSync(join(tmpdir(), "na-checkout-"));
  const treasury = "0x1111111111111111111111111111111111111111";
  const payer = "0x2222222222222222222222222222222222222222";
  // Chain timestamps are second-granular; a valid payment may be mined during
  // the same second the millisecond-granular quote is issued.
  let currentTime = new Date("2026-10-26T12:00:00.500Z");

  const txs = new Map();
  let latestBlock = 1000n;
  let chainIdHex = "0x38";
  let decimalsHex = "0x12";

  function mockRpc(method, params) {
    if (method === "eth_chainId") return chainIdHex;
    if (method === "eth_call") return decimalsHex;
    if (method === "eth_blockNumber") return `0x${latestBlock.toString(16)}`;
    if (method === "eth_getTransactionReceipt") {
      return txs.get(String(params[0]).toLowerCase())?.receipt ?? null;
    }
    if (method === "eth_getTransactionByHash") {
      return txs.get(String(params[0]).toLowerCase())?.tx ?? null;
    }
    if (method === "eth_getBlockByNumber") {
      const entry = [...txs.values()].find((item) => String(item.receipt?.blockNumber).toLowerCase() === String(params[0]).toLowerCase());
      return {
        hash: entry?.receipt?.blockHash || `0x${String(params[0]).replace(/^0x/, "").padStart(64, "0")}`,
        timestamp: `0x${Math.floor(currentTime.getTime() / 1000).toString(16)}`,
        transactions: params[1] === true ? [...txs.values()].map((item) => item.tx) : undefined,
      };
    }
    if (method === "eth_getLogs") {
      const logs = [];
      const filter = params[0] || {};
      const from = BigInt(filter.fromBlock || "0x0");
      const to = BigInt(filter.toBlock || "0x0");
      for (const entry of txs.values()) {
        const blockNumber = BigInt(entry.receipt?.blockNumber || "0x0");
        if (blockNumber < from || blockNumber > to) continue;
        for (const log of entry.receipt?.logs || []) {
          logs.push({ ...log, transactionHash: entry.tx.hash, blockNumber: entry.receipt.blockNumber });
        }
      }
      return logs;
    }
    return null;
  }

  function registerBep20Tx(hash, { contract, to, amountWei, secondPayer, secondAmountWei, blockNumber = 980n, status = "0x1" }) {
    const clean = hash.toLowerCase();
    const blockHash = `0x${BigInt(blockNumber).toString(16).padStart(64, "0")}`;
    const blockNumberHex = `0x${BigInt(blockNumber).toString(16)}`;
    txs.set(clean, {
      tx: {
        hash: clean,
        blockNumber: blockNumberHex,
        blockHash,
        from: payer,
        to: contract,
        value: "0x0",
      },
      receipt: {
        status,
        transactionHash: clean,
        blockHash,
        blockNumber: blockNumberHex,
        logs: [
          {
            address: contract,
            topics: [ERC20_TRANSFER_TOPIC, padTopicAddress(payer), padTopicAddress(to)],
            data: `0x${BigInt(amountWei).toString(16).padStart(64, "0")}`,
            blockNumber: blockNumberHex,
          },
          ...(secondPayer && secondAmountWei !== undefined ? [{
            address: contract,
            topics: [ERC20_TRANSFER_TOPIC, padTopicAddress(secondPayer), padTopicAddress(to)],
            data: `0x${BigInt(secondAmountWei).toString(16).padStart(64, "0")}`,
            blockNumber: blockNumberHex,
          }] : []),
        ],
      },
    });
  }

  const config = loadConfig({
    CONTROL_API_SECRET: "test-secret",
    SAAS_MONITOR_SECRET: "monitor-secret",
    SAAS_TREASURY_ADDRESS: treasury,
    SAAS_PRICE_USD: "15",
    SAAS_DATA_ROOT: root,
    SAAS_DB_PATH: join(root, "control.sqlite"),
    SAAS_HOST_ID: "cell-01",
    SAAS_MAX_TENANTS: "5",
  });
  const store = openStore(config.dbPath);
  const docker = fakeDocker();
  const { server, url } = await listen(
    createHandler({
      store,
      docker,
      config,
      rpc: mockRpc,
      now: () => currentTime,
      // The address index is not the mock chain. A failed list falls back to eth_getLogs.
      fetchImpl: async () => {
        throw new Error("transfer list HTTP 503");
      },
    }),
  );

  try {
    // 1. Direct POST /tenants with unverified txHash is rejected when treasury is configured
    const unverified = await call(url, "/tenants", {
      method: "POST",
      token: null,
      body: { paymentAsset: "USDT", paymentTx: `0x${"99".repeat(32)}` },
    });
    assert.equal(unverified.status, 402);

    const absurd = await call(url, "/checkout", {
      method: "POST",
      token: null,
      body: { paymentAsset: "USDT", preset: "custom", positionUsd: 9_000_000_000 },
    });
    assert.equal(absurd.status, 400);
    assert.match(absurd.body.error, /10000/);
    const customQuote = await call(url, "/checkout", {
      method: "POST",
      token: null,
      body: { paymentAsset: "USDT", preset: "custom", positionUsd: "320.50", x402PerDay: 2 },
    });
    assert.equal(customQuote.status, 201);
    assert.equal(customQuote.body.order.preset, "custom");
    assert.equal(customQuote.body.order.positionUsd, 320.5);
    assert.equal(customQuote.body.order.x402PerDay, 2);

    // 2. Create an unpaid checkout order
    const createdOrder = await call(url, "/checkout", {
      method: "POST",
      token: null,
      body: { paymentAsset: "USDT", preset: "250", x402PerDay: 2 },
    });
    assert.equal(createdOrder.status, 201);
    assert.equal(createdOrder.body.order.status, "pending");
    assert.equal(createdOrder.body.order.treasuryAddress, treasury);
    assert.match(createdOrder.body.order.amountDisplay, /^15\.\d{3}$/);
    assert.equal(createdOrder.body.order.amountWei, parseUnits18(createdOrder.body.order.amountDisplay).toString());
    assert.equal(Date.parse(createdOrder.body.order.expiresAt) - currentTime.getTime(), CHECKOUT_EXPIRY_MS);
    assert.equal(docker.containers.size, 0);

    const orderId = createdOrder.body.order.id;
    const claimSecret = createdOrder.body.claimSecret;
    const requiredWei = BigInt(createdOrder.body.order.amountWei);

    // 3. Underpaid transfer -> stays unpaid (402), no container created
    const underpaidTx = `0x${"11".repeat(32)}`;
    registerBep20Tx(underpaidTx, {
      contract: DEFAULT_TOKEN_CONTRACTS.USDT,
      to: treasury,
      amountWei: requiredWei - 1n,
      blockNumber: 980n,
    });
    const underRes = await call(url, `/checkout/${orderId}/verify`, {
      method: "POST",
      token: null,
      body: { paymentTx: underpaidTx, claimSecret, payer },
    });
    assert.equal(underRes.status, 402);
    assert.match(underRes.body.error, /underpaid/);
    assert.equal(docker.containers.size, 0);

    // 4. Insufficient confirmations (< 15 blocks) -> rejected (402)
    const unconfirmedTx = `0x${"22".repeat(32)}`;
    registerBep20Tx(unconfirmedTx, {
      contract: DEFAULT_TOKEN_CONTRACTS.USDT,
      to: treasury,
      amountWei: requiredWei,
      blockNumber: 995n, // 1000 - 995 + 1 = 6 confirmations (< 15)
    });
    const unconfRes = await call(url, `/checkout/${orderId}/verify`, {
      method: "POST",
      token: null,
      body: { paymentTx: unconfirmedTx, claimSecret, payer },
    });
    assert.equal(unconfRes.status, 402);
    assert.match(unconfRes.body.error, /confirmations/);

    // 5. Overpayment is not silently credited to the quote.
    const validOverpaidTx = `0x${"33".repeat(32)}`;
    const extraWei = parseUnits18("2.5");
    registerBep20Tx(validOverpaidTx, {
      contract: DEFAULT_TOKEN_CONTRACTS.USDT,
      to: treasury,
      amountWei: requiredWei + extraWei,
      blockNumber: 980n, // 21 confirmations
    });
    const verified = await call(url, `/checkout/${orderId}/verify`, {
      method: "POST",
      token: null,
      body: { paymentTx: validOverpaidTx, claimSecret, payer },
    });
    assert.equal(verified.status, 402);
    assert.match(verified.body.error, /exact quote/);
    assert.equal(store.getOrder(orderId).status, "pending");
    assert.equal(docker.containers.size, 0);

    const splitPayerTx = `0x${"35".repeat(32)}`;
    registerBep20Tx(splitPayerTx, {
      contract: DEFAULT_TOKEN_CONTRACTS.USDT,
      to: treasury,
      amountWei: requiredWei - 1n,
      secondPayer: "0x3333333333333333333333333333333333333333",
      secondAmountWei: 1n,
      blockNumber: 980n,
    });
    const splitPayer = await call(url, `/checkout/${orderId}/verify`, {
      method: "POST",
      token: null,
      body: { paymentTx: splitPayerTx, claimSecret, payer },
    });
    assert.equal(splitPayer.status, 402);
    assert.match(splitPayer.body.error, /one wallet address/);
    assert.equal(docker.containers.size, 0);

    // Exact amount on the right BSC token contract and with enough confirmations provisions.
    const exactTx = `0x${"34".repeat(32)}`;
    registerBep20Tx(exactTx, {
      contract: DEFAULT_TOKEN_CONTRACTS.USDT,
      to: treasury,
      amountWei: requiredWei,
      blockNumber: 980n,
    });
    chainIdHex = "0x1";
    const wrongNetwork = await call(url, `/checkout/${orderId}/verify`, {
      method: "POST",
      token: null,
      body: { paymentTx: exactTx, claimSecret, payer },
    });
    assert.equal(wrongNetwork.status, 503);
    assert.match(wrongNetwork.body.error, /BNB Smart Chain/);
    assert.equal(docker.containers.size, 0);

    chainIdHex = "0x38";
    decimalsHex = "0x6";
    const wrongDecimals = await call(url, `/checkout/${orderId}/verify`, {
      method: "POST",
      token: null,
      body: { paymentTx: exactTx, claimSecret, payer },
    });
    assert.equal(wrongDecimals.status, 503);
    assert.match(wrongDecimals.body.error, /decimals are 6/);
    assert.equal(docker.containers.size, 0);

    decimalsHex = "0x12";
    const wrongSigner = await call(url, `/checkout/${orderId}/verify`, {
      method: "POST",
      token: null,
      body: { paymentTx: exactTx, claimSecret, payer: "0x3333333333333333333333333333333333333333" },
    });
    assert.equal(wrongSigner.status, 401);
    assert.match(wrongSigner.body.error, /did not send/);
    assert.equal(store.getOrder(orderId).status, "pending");
    assert.equal(docker.containers.size, 0);

    const exactVerified = await call(url, `/checkout/${orderId}/verify`, {
      method: "POST",
      token: null,
      body: { paymentTx: exactTx, claimSecret, payer },
    });
    assert.equal(exactVerified.status, 200);
    assert.equal(exactVerified.body.order.status, "paid");
    assert.equal(exactVerified.body.order.overpaidDisplay, "0");
    assert.equal(exactVerified.body.tenant.status, "running");
    assert.equal(exactVerified.body.tenant.risk_preset, "250");
    assert.equal(exactVerified.body.tenant.max_position_usd, 250);
    assert.equal(exactVerified.body.tenant.max_trade_usd, 250);
    assert.equal(exactVerified.body.tenant.x402_per_day, 2);
    assert.equal(createdOrder.body.order.positionUsd, 250);
    assert.equal(exactVerified.body.tenant.overpaid_amount, "0");
    assert.match(exactVerified.body.compoundToken, /^cell-01\.[a-z0-9]{8}\.[a-f0-9]{64}$/);
    assert.match(exactVerified.body.accessCode, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}(?:-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}){3}$/);
    assert.equal(exactVerified.body.tenant.access_code_hash, undefined);

    // 6. Customer accesses their Dedicated Dashboard (/tenants/:id/state) using compoundToken
    const tenantId = exactVerified.body.tenant.id;
    const compoundToken = exactVerified.body.compoundToken;
    const stateRes = await call(url, `/tenants/${tenantId}/state`, { token: compoundToken });
    assert.equal(stateRes.status, 200);
    assert.equal(stateRes.body.tenant.id, tenantId);
    assert.equal(stateRes.body.state.reachable, true);
    assert.equal(stateRes.body.state.navUsd, 120.5);
    assert.equal(stateRes.body.state.realizedPnlUsd, 2);

    const portalPage = await fetch(`${url}/portal`, { redirect: "manual" });
    assert.equal(portalPage.status, 302);
    assert.match(portalPage.headers.get("location") || "", /\/portal$/);

    // 7. Subscription expiry (`paid_until`) halts new buys while leaving positions intact
    currentTime = new Date("2026-12-01T00:00:00.000Z"); // > 30 days later
    const sweep = await call(url, "/subscriptions/sweep", { method: "POST" });
    assert.equal(sweep.status, 200);
    assert.equal(sweep.body.haltedCount, 1);

    const afterExpiry = await call(url, `/tenants/${tenantId}`, { token: compoundToken });
    assert.equal(afterExpiry.body.tenant.buys_halted, 1);
    const haltedEnv = readFileSync(join(root, tenantId, "tenant.env"), "utf8");
    assert.match(haltedEnv, /DISABLE_NEW_BUYS=true/);
    assert.match(haltedEnv, /MAX_POSITION_SIZE_USD=0/);

    // 8. Renew subscription via checkout + background watcher scan
    const renewOrder = await call(url, "/checkout", {
      method: "POST",
      token: null,
      body: { paymentAsset: "USDC", preset: "500", tenantId },
    });
    assert.equal(renewOrder.status, 201);
    const renewTx = `0x${"44".repeat(32)}`;
    registerBep20Tx(renewTx, {
      contract: DEFAULT_TOKEN_CONTRACTS.USDC,
      to: treasury,
      amountWei: BigInt(renewOrder.body.order.amountWei),
      blockNumber: 1000n,
    });
    latestBlock = 1020n;
    const watched = await call(url, "/watcher/scan", { method: "POST" });
    assert.equal(watched.status, 200);
    assert.equal(watched.body.matched, 1);

    const renewed = await call(url, `/tenants/${tenantId}`, { token: compoundToken });
    assert.equal(renewed.body.tenant.buys_halted, 0);
    assert.equal(renewed.body.tenant.risk_preset, "500");
    assert.equal(renewed.body.tenant.max_trade_usd, 500);
    const restoredEnv = readFileSync(join(root, tenantId, "tenant.env"), "utf8");
    assert.match(restoredEnv, /MAX_POSITION_SIZE_USD=500/);
    assert.match(restoredEnv, /HACKATHON_MAX_TRADE_USD=500/);
    assert.match(restoredEnv, /PAYMENT_TOKEN=USDT/);
    assert.match(restoredEnv, /X402_MIN_PAYMENTS_PER_DAY=1/);
    assert.doesNotMatch(restoredEnv, /DISABLE_NEW_BUYS=true/);

    const denied = await call(url, "/session/open", {
      method: "POST",
      token: "test-secret",
      body: { paymentTx: exactTx, payer: "0x3333333333333333333333333333333333333333" },
    });
    assert.equal(denied.status, 401);
    const reopened = await call(url, "/session/open", {
      method: "POST",
      token: "test-secret",
      body: { paymentTx: exactTx, payer: "0x2222222222222222222222222222222222222222" },
    });
    assert.equal(reopened.status, 200);
    assert.notEqual(reopened.body.compoundToken, compoundToken);
    const oldToken = await call(url, `/tenants/${tenantId}`, { token: compoundToken });
    assert.equal(oldToken.status, 404);
    const newToken = await call(url, `/tenants/${tenantId}`, { token: reopened.body.compoundToken });
    assert.equal(newToken.status, 200);

    const unrelated = await call(url, "/session/open", {
      method: "POST",
      token: "test-secret",
      body: { paymentTx: `0x${"55".repeat(32)}`, payer },
    });
    assert.equal(unrelated.status, 404);
    const stranger = await call(url, "/session/open", {
      method: "POST",
      token: "test-secret",
      body: { payer: "0x4444444444444444444444444444444444444444" },
    });
    assert.equal(stranger.status, 404);
    const byWallet = await call(url, "/session/open", {
      method: "POST",
      token: "test-secret",
      body: { payer },
    });
    assert.equal(byWallet.status, 200);
    assert.notEqual(byWallet.body.compoundToken, reopened.body.compoundToken);
    const afterWallet = await call(url, `/tenants/${tenantId}`, { token: byWallet.body.compoundToken });
    assert.equal(afterWallet.status, 200);
    const rotated = await call(url, `/tenants/${tenantId}/access-code`, {
      method: "POST",
      token: byWallet.body.compoundToken,
    });
    assert.equal(rotated.status, 200);
    assert.match(rotated.body.accessCode, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}(?:-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}){3}$/);
    assert.notEqual(rotated.body.accessCode, exactVerified.body.accessCode);
    const retired = await call(url, "/session/code", {
      method: "POST",
      token: null,
      body: { code: exactVerified.body.accessCode },
    });
    assert.equal(retired.status, 401);
    const replaced = await call(url, "/session/code", {
      method: "POST",
      token: null,
      body: { code: rotated.body.accessCode },
    });
    assert.equal(replaced.status, 200);
  } finally {
    server.close();
    store.close();
  }
});

test("multi-VPS edge router links a second cell VPS, spills over when cell-01 is full, and proxies customer dashboard requests", async () => {
  const root1 = mkdtempSync(join(tmpdir(), "na-cell1-"));
  const root2 = mkdtempSync(join(tmpdir(), "na-cell2-"));
  const treasury = "0x1111111111111111111111111111111111111111";

  // Cell 1 (also acting as Edge on neuralalpha.io) has maxTenants = 1
  const config1 = loadConfig({
    CONTROL_API_SECRET: "shared-cluster-secret",
    SAAS_MONITOR_SECRET: "monitor-secret",
    SAAS_TREASURY_ADDRESS: treasury,
    SAAS_DATA_ROOT: root1,
    SAAS_DB_PATH: join(root1, "control.sqlite"),
    SAAS_HOST_ID: "cell-01",
    SAAS_MAX_TENANTS: "1",
  });
  // Cell 2 has maxTenants = 2
  const config2 = loadConfig({
    CONTROL_API_SECRET: "shared-cluster-secret",
    SAAS_MONITOR_SECRET: "monitor-secret",
    SAAS_TREASURY_ADDRESS: treasury,
    SAAS_DATA_ROOT: root2,
    SAAS_DB_PATH: join(root2, "control.sqlite"),
    SAAS_HOST_ID: "cell-02",
    SAAS_MAX_TENANTS: "2",
  });

  const store1 = openStore(config1.dbPath);
  const store2 = openStore(config2.dbPath);
  const docker1 = fakeDocker();
  const docker2 = fakeDocker();

  const srv1 = await listen(createHandler({ store: store1, docker: docker1, config: config1 }));
  const srv2 = await listen(createHandler({ store: store2, docker: docker2, config: config2 }));

  try {
    // Link cell-02 into cell-01's cluster registry
    const reg = await call(srv1.url, "/cluster/nodes", {
      method: "POST",
      token: "shared-cluster-secret",
      body: { hostId: "cell-02", baseUrl: srv2.url },
    });
    assert.equal(reg.status, 201);

    const clusterBefore = await call(srv1.url, "/cluster/capacity", { token: "shared-cluster-secret" });
    assert.equal(clusterBefore.status, 200);
    assert.equal(clusterBefore.body.totalNodes, 2);
    assert.equal(clusterBefore.body.totalFreeSeats, 3);
    assert.equal(clusterBefore.body.selectedHostId, "cell-01");

    // Fill cell-01 with 1 tenant directly on cell-02 to test remote proxy, and 1 on cell-01
    const firstOrder = await call(srv1.url, "/checkout", {
      method: "POST",
      token: null,
      body: { paymentAsset: "USDT", preset: "100" },
    });
    assert.equal(firstOrder.status, 201);
    assert.equal(firstOrder.body.order.hostId, "cell-01");

    // Provision a tenant on cell-02 directly and access it through cell-01 (Edge) using its compound token
    const config2NoTreasury = { ...config2, treasuryAddress: "" };
    const srv2Direct = await listen(createHandler({ store: store2, docker: docker2, config: config2NoTreasury }));
    const remoteTenantRes = await call(srv2Direct.url, "/tenants", {
      method: "POST",
      token: null,
      body: pay("ee", "USDT"),
    });
    assert.equal(remoteTenantRes.status, 201);
    const remoteId = remoteTenantRes.body.tenant.id;
    const remoteCompound = remoteTenantRes.body.compoundToken;
    assert.match(remoteCompound, /^cell-02\./);

    // Customer sends request to cell-01 (Edge) with cell-02 compound token -> transparently proxied to cell-02!
    const proxiedGet = await call(srv1.url, `/tenants/${remoteId}`, { token: remoteCompound });
    assert.equal(proxiedGet.status, 200);
    assert.equal(proxiedGet.body.tenant.id, remoteId);
    assert.equal(proxiedGet.body.tenant.host_id, "cell-02");

    srv2Direct.server.close();
  } finally {
    srv1.server.close();
    srv2.server.close();
    store1.close();
    store2.close();
  }
});

test("saving a position size updates the live tenant in USDT and rejects a bad custom amount", async () => {
  const root = mkdtempSync(join(tmpdir(), "na-risk-"));
  const config = loadConfig({
    CONTROL_API_SECRET: "test-secret",
    SAAS_DATA_ROOT: root,
    SAAS_DB_PATH: join(root, "control.sqlite"),
    SAAS_HOST_ID: "box-a",
    SAAS_MAX_TENANTS: "2",
  });
  const store = openStore(config.dbPath);
  const docker = fakeDocker();
  const { server, url } = await listen(createHandler({ store, docker, config }));
  try {
    const created = await call(url, "/tenants", { method: "POST", token: null, body: pay("c1", "BNB") });
    assert.equal(created.status, 201);
    const id = created.body.tenant.id;
    const token = created.body.compoundToken;
    const born = readFileSync(join(root, id, "tenant.env"), "utf8");
    assert.match(born, /PAYMENT_TOKEN=USDT/);
    assert.doesNotMatch(born, /PAYMENT_TOKEN=BNB/);
    assert.equal(created.body.tenant.payment_asset, "BNB");

    const saved = await call(url, `/tenants/${id}/risk`, {
      method: "POST",
      token,
      body: { preset: "custom", positionUsd: 750, x402PerDay: 3 },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.tenant.risk_preset, "custom");
    assert.equal(saved.body.tenant.max_position_usd, 750);
    assert.equal(saved.body.tenant.max_trade_usd, 750);
    assert.equal(saved.body.tenant.x402_per_day, 3);
    assert.equal(saved.body.tenant.access_code_hash, undefined);
    const env = readFileSync(join(root, id, "tenant.env"), "utf8");
    assert.match(env, /MAX_POSITION_SIZE_USD=750/);
    assert.match(env, /HACKATHON_MAX_TRADE_USD=750/);
    assert.match(env, /X402_MIN_PAYMENTS_PER_DAY=3/);
    assert.match(env, /CMC_X402_INTERVAL_MS=28800000/);
    assert.match(env, /STUDIO_X402_INTERVAL_MS=28800000/);
    assert.match(env, /PAYMENT_TOKEN=USDT/);
    const yml = readFileSync(join(root, id, "override.yml"), "utf8");
    assert.match(yml, /PAYMENT_TOKEN: "USDT"/);
    assert.match(yml, /MAX_POSITION_SIZE_USD: "750"/);
    assert.match(yml, /HACKATHON_MAX_TRADE_USD: "750"/);

    for (const body of [
      { preset: "custom", positionUsd: 0 },
      { preset: "custom", positionUsd: -20 },
      { preset: "custom", positionUsd: 1_000_000_000_000 },
      { preset: "500", x402PerDay: 0 },
      { preset: "500", x402PerDay: 49 },
      { preset: "nope" },
    ]) {
      const rejected = await call(url, `/tenants/${id}/risk`, { method: "POST", token, body });
      assert.equal(rejected.status, 400, JSON.stringify(body));
    }
    const unchanged = readFileSync(join(root, id, "tenant.env"), "utf8");
    assert.match(unchanged, /MAX_POSITION_SIZE_USD=750/);
    assert.match(unchanged, /X402_MIN_PAYMENTS_PER_DAY=3/);

    const preset = await call(url, `/tenants/${id}/risk`, {
      method: "POST",
      token,
      body: { preset: "500" },
    });
    assert.equal(preset.status, 200);
    assert.equal(preset.body.tenant.risk_preset, "500");
    assert.equal(preset.body.tenant.max_position_usd, 500);
    assert.equal(preset.body.tenant.max_trade_usd, 500);
    assert.equal(preset.body.tenant.x402_per_day, 3);
    const after = readFileSync(join(root, id, "tenant.env"), "utf8");
    assert.match(after, /MAX_POSITION_SIZE_USD=500/);
    assert.match(after, /HACKATHON_MAX_TRADE_USD=500/);
    assert.match(after, /X402_MIN_PAYMENTS_PER_DAY=3/);
    assert.match(after, /PAYMENT_TOKEN=USDT/);
  } finally {
    server.close();
    store.close();
  }
});

test("a customer switches paid CMC and Studio signals off and on", async () => {
  const root = mkdtempSync(join(tmpdir(), "na-signals-"));
  const config = loadConfig({
    CONTROL_API_SECRET: "test-secret",
    SAAS_DATA_ROOT: root,
    SAAS_DB_PATH: join(root, "control.sqlite"),
    SAAS_HOST_ID: "box-a",
    SAAS_MAX_TENANTS: "2",
  });
  const store = openStore(config.dbPath);
  const { server, url } = await listen(createHandler({ store, docker: fakeDocker(), config }));
  try {
    const created = await call(url, "/tenants", { method: "POST", token: null, body: pay("a7", "USDT") });
    const id = created.body.tenant.id;
    const token = created.body.compoundToken;
    const envOf = () => readFileSync(join(root, id, "tenant.env"), "utf8");
    // New customers get the daily CMC call; Agent Studio is optional and starts off.
    assert.match(envOf(), /CMC_X402_ENABLED=true/);
    assert.match(envOf(), /STUDIO_X402_ENABLED=false/);
    assert.equal(created.body.tenant.studio_x402, 0);

    const off = await call(url, `/tenants/${id}/signals`, { method: "POST", token, body: { cmc: false } });
    assert.equal(off.status, 200);
    assert.equal(off.body.tenant.cmc_x402, 0);
    assert.match(envOf(), /CMC_X402_ENABLED=false/);
    assert.match(envOf(), /STUDIO_X402_ENABLED=false/);
    assert.match(readFileSync(join(root, id, "override.yml"), "utf8"), /CMC_X402_ENABLED: "false"/);

    // A risk save keeps the switch.
    await call(url, `/tenants/${id}/risk`, { method: "POST", token, body: { preset: "500" } });
    assert.match(envOf(), /CMC_X402_ENABLED=false/);

    for (const body of [{}, { cmc: "no" }, { studio: 0 }]) {
      const bad = await call(url, `/tenants/${id}/signals`, { method: "POST", token, body });
      assert.equal(bad.status, 400, JSON.stringify(body));
    }

    const both = await call(url, `/tenants/${id}/signals`, { method: "POST", token, body: { cmc: true, studio: true } });
    assert.equal(both.status, 200);
    assert.match(envOf(), /CMC_X402_ENABLED=true/);
    assert.match(envOf(), /STUDIO_X402_ENABLED=true/);
  } finally {
    server.close();
    store.close();
  }
});

test("a stored 6-decimal stablecoin quote is replaced with a 3-decimal quote when the pay screen reads it", async () => {
  const root = mkdtempSync(join(tmpdir(), "na-control-"));
  const currentTime = new Date("2026-10-26T12:00:00.000Z");
  const treasury = "0x2222222222222222222222222222222222222222";
  const config = loadConfig({
    CONTROL_API_SECRET: "test-secret",
    SAAS_MONITOR_SECRET: "monitor-secret",
    SAAS_TREASURY_ADDRESS: treasury,
    SAAS_PRICE_USD: "15",
    SAAS_DATA_ROOT: root,
    SAAS_DB_PATH: join(root, "control.sqlite"),
    SAAS_HOST_ID: "cell-01",
    SAAS_MAX_TENANTS: "5",
  });
  const store = openStore(config.dbPath);
  const { server, url } = await listen(
    createHandler({ store, docker: fakeDocker(), config, now: () => currentTime }),
  );

  try {
    const created = await call(url, "/checkout", {
      method: "POST",
      token: null,
      body: { paymentAsset: "USDT", preset: "100" },
    });
    assert.equal(created.status, 201);
    assert.match(created.body.order.amountDisplay, /^15\.\d{3}$/);
    const orderId = created.body.order.id;
    const untouched = await call(url, `/checkout/${orderId}`);
    assert.equal(untouched.status, 200);
    assert.equal(untouched.body.order.amountDisplay, created.body.order.amountDisplay);
    assert.equal(untouched.body.order.expiresAt, created.body.order.expiresAt);

    const db = new DatabaseSync(config.dbPath);
    db.prepare(
      `UPDATE orders SET amount_display = ?, amount_wei = ?, tail = ?, expires_at = ? WHERE id = ?`,
    ).run("15.008513", parseUnits18("15.008513").toString(), 8513, "2026-10-26T12:05:00.000Z", orderId);
    db.close();

    const replaced = await call(url, `/checkout/${orderId}`);
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.order.id, orderId);
    assert.equal(replaced.body.order.status, "pending");
    assert.match(replaced.body.order.amountDisplay, /^15\.\d{3}$/);
    assert.notEqual(replaced.body.order.amountDisplay, "15.008513");
    assert.equal(replaced.body.order.amountWei, parseUnits18(replaced.body.order.amountDisplay).toString());
    assert.equal(Date.parse(replaced.body.order.expiresAt) - currentTime.getTime(), CHECKOUT_EXPIRY_MS);
    assert.equal(store.getOrder(orderId).amount_display, replaced.body.order.amountDisplay);

    const stable = await call(url, `/checkout/${orderId}`);
    assert.equal(stable.body.order.amountDisplay, replaced.body.order.amountDisplay);
    assert.equal(stable.body.order.expiresAt, replaced.body.order.expiresAt);

    for (const asset of ["USDC", "U", "USD1"]) {
      const quote = await call(url, "/checkout", {
        method: "POST",
        token: null,
        body: { paymentAsset: asset, preset: "100" },
      });
      assert.equal(quote.status, 201, asset);
      assert.match(quote.body.order.amountDisplay, /^15\.\d{3}$/);
      assert.equal(quote.body.order.amountWei, parseUnits18(quote.body.order.amountDisplay).toString());
    }

    const bnb = await call(url, "/checkout", {
      method: "POST",
      token: null,
      body: { paymentAsset: "BNB", preset: "100" },
    });
    assert.equal(bnb.status, 201);
    assert.match(bnb.body.order.amountDisplay, /^\d+\.\d{6}$/);
    assert.equal(bnb.body.order.amountDisplay.slice(-3).length, 3);
    assert.notEqual(bnb.body.order.amountDisplay.slice(0, 2), "15");
    const bnbRead = await call(url, `/checkout/${bnb.body.order.id}`);
    assert.equal(bnbRead.body.order.amountDisplay, bnb.body.order.amountDisplay);
    assert.equal(bnbRead.body.order.amountWei, bnb.body.order.amountWei);
  } finally {
    server.close();
    store.close();
  }
});

test("portal opens on localhost and on neuralalpha.io", () => {
  const config = loadConfig({
    SAAS_APP_URL: "https://neuralalpha.io/portal",
    SAAS_LOCAL_APP_URL: "http://127.0.0.1:3000/portal",
    DATABASE_URL: "postgres://example",
  });
  assert.equal(config.databaseUrl, "postgres://example");
  assert.equal(config.portalUrl, "https://neuralalpha.io/portal");
  assert.equal(portalLocation({ headers: { host: "127.0.0.1:3910" } }, config), "http://127.0.0.1:3000/portal");
  assert.equal(portalLocation({ headers: { host: "localhost:3000" } }, config), "http://localhost:3000/portal");
  assert.equal(portalLocation({ headers: { host: "neuralalpha.io" } }, config), "https://neuralalpha.io/portal");
  assert.equal(portalLocation({ headers: { host: "www.neuralalpha.io" } }, config), "https://neuralalpha.io/portal");
  assert.equal(adminLocation({ headers: { host: "127.0.0.1:3910" } }, config), "http://127.0.0.1:3000/admin");
  assert.equal(adminLocation({ headers: { host: "neuralalpha.io" } }, config), "https://neuralalpha.io/admin");
});

test("a customer container does not receive the shared Neon URL", async () => {
  const root = mkdtempSync(join(tmpdir(), "na-control-"));
  const config = loadConfig({
    CONTROL_API_SECRET: "test-secret",
    SAAS_MONITOR_SECRET: "monitor-secret",
    SAAS_DATA_ROOT: root,
    SAAS_DB_PATH: join(root, "control.sqlite"),
    SAAS_HOST_ID: "box-a",
    SAAS_MAX_TENANTS: "2",
    SAAS_HOST_RAM_MB: "16384",
    DATABASE_URL: "postgres://backup-test.invalid/db",
    TENANT_DATABASE_URL: "postgres://backup-test.invalid/db",
  });
  const store = openStore(config.dbPath);
  const docker = fakeDocker();
  const { server, url } = await listen(createHandler({ store, docker, config }));
  try {
    const created = await call(url, "/tenants", { method: "POST", token: null, body: pay("aa") });
    assert.equal(created.status, 201);
    const env = readFileSync(join(root, created.body.tenant.id, "tenant.env"), "utf8");
    assert.equal(env.includes("DATABASE_URL"), false);
    assert.equal(env.includes("backup-test.invalid"), false);
  } finally {
    server.close();
    store.close();
  }
});

// ---- Telegram, reminders, alerts, cancel, rollout and backups -------------------------------

const DAY = 86_400_000;

function opsHarness(extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "na-ops-"));
  const config = loadConfig({
    CONTROL_API_SECRET: "test-secret",
    SAAS_DATA_ROOT: root,
    SAAS_DB_PATH: join(root, "control.sqlite"),
    SAAS_HOST_ID: "box-a",
    SAAS_MAX_TENANTS: "3",
    TELEGRAM_BOT_TOKEN: "123:TEST",
    TELEGRAM_BOT_USERNAME: "@NeuralAlphaBot",
    SAAS_ROLLOUT_POLL_MS: "5",
    SAAS_ROLLOUT_TIMEOUT_MS: "60",
    ...extraEnv,
  });
  const store = openStore(config.dbPath);
  const docker = fakeDocker();
  const sent = [];
  const opsSent = [];
  const telegram = {
    enabled: true,
    async send(chat, text) { sent.push({ chat: String(chat), text }); return true; },
    async ops(text) { opsSent.push(text); return true; },
  };
  const clock = { now: new Date("2026-11-01T00:00:00Z") };
  const handler = createHandler({ store, docker, config, telegram, now: () => clock.now });
  return { root, config, store, docker, sent, opsSent, telegram, clock, handler };
}

async function boot(h, tag = "a7") {
  const { server, url } = await listen(h.handler);
  const created = await call(url, "/tenants", { method: "POST", token: null, body: pay(tag, "USDT") });
  assert.equal(created.status, 201);
  return { server, url, id: created.body.tenant.id, token: created.body.compoundToken };
}

async function linkTelegram(url, id, token, chat = "555") {
  const made = await call(url, `/tenants/${id}/telegram/code`, { method: "POST", token });
  assert.equal(made.status, 200);
  assert.match(made.body.deepLink, /^https:\/\/t\.me\/NeuralAlphaBot\?start=[A-Z2-9]{8}$/);
  const linked = await call(url, "/telegram/inbound", { method: "POST", body: { chatId: chat, text: `/start ${made.body.code}` } });
  assert.equal(linked.body.handled, true);
  assert.match(linked.body.reply, /^Linked/);
  return made.body.code;
}

test("a customer links Telegram with a one-time code and the portal never sees the chat id", async () => {
  const h = opsHarness();
  const { server, url, id, token } = await boot(h);
  try {
    const before = await call(url, `/tenants/${id}`, { token });
    assert.equal(before.body.tenant.telegram_linked, false);
    const code = await linkTelegram(url, id, token);
    const after = await call(url, `/tenants/${id}`, { token });
    assert.equal(after.body.tenant.telegram_linked, true);
    assert.equal(after.body.tenant.telegram_chat_id, undefined);
    assert.equal(after.body.tenant.telegram_code_hash, undefined);
    const reuse = await call(url, "/telegram/inbound", { method: "POST", body: { chatId: "999", text: `/start ${code}` } });
    assert.equal(reuse.body.handled, false);

    const status = await call(url, "/telegram/inbound", { method: "POST", body: { chatId: "555", text: "/status" } });
    assert.match(status.body.reply, new RegExp(`Agent ${id}`));
    assert.match(status.body.reply, /Value \$120.5/);
    assert.match(status.body.reply, /Subscription: 30 days left/);

    const customerCannot = await call(url, "/telegram/inbound", { method: "POST", token, body: { chatId: "1", text: "/status" } });
    assert.equal(customerCannot.status, 401, "only the operator may route bot messages");

    const unlinked = await call(url, `/tenants/${id}/telegram/unlink`, { method: "POST", token });
    assert.equal(unlinked.body.tenant.telegram_linked, false);
  } finally {
    server.close();
    h.store.close();
  }
});

test("Telegram code is refused when the bot is not configured", async () => {
  const h = opsHarness({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_BOT_USERNAME: "" });
  h.telegram.enabled = false;
  const { server, url, id, token } = await boot(h);
  try {
    const r = await call(url, `/tenants/${id}/telegram/code`, { method: "POST", token });
    assert.equal(r.status, 503);
  } finally {
    server.close();
    h.store.close();
  }
});

test("reminders, a 3-day grace, then new buys stop; each message is sent once", async () => {
  const h = opsHarness();
  const { server, url, id, token } = await boot(h);
  try {
    await linkTelegram(url, id, token);
    const subs = () => h.sent.filter((m) => /subscription/i.test(m.text));
    const tick = async (days) => {
      h.clock.now = new Date(Date.parse("2026-11-01T00:00:00Z") + days * DAY);
      return runMaintenance({ store: h.store, docker: h.docker, config: h.config, now: () => h.clock.now, telegram: h.telegram, log: { warn() {} } });
    };
    await tick(10);
    assert.equal(subs().length, 0);
    await tick(24);
    await tick(24.5);
    assert.deepEqual(subs().map((m) => m.text.match(/ends in (\d+) day/)?.[1]), ["7"]);
    await tick(29.5);
    assert.deepEqual(subs().map((m) => m.text.match(/ends in (\d+) day/)?.[1]), ["7", "1"]);

    const grace = await tick(31);
    assert.deepEqual(grace.halted, []);
    assert.match(subs().at(-1).text, /keeps trading until 2026-12-04/);
    assert.equal(h.store.get(id).buys_halted, 0);

    const lapsed = await tick(34);
    assert.deepEqual(lapsed.halted, [id]);
    assert.equal(h.store.get(id).buys_halted, 1);
    assert.match(readFileSync(join(h.root, id, "tenant.env"), "utf8"), /DISABLE_NEW_BUYS=true/);
    assert.match(subs().at(-1).text, /New buys are stopped/);
    const count = subs().length;
    await tick(40);
    assert.equal(subs().length, count);
    assert.ok(subs().every((m) => m.chat === "555"));
  } finally {
    server.close();
    h.store.close();
  }
});

test("cancelling skips the grace and can be undone", async () => {
  const h = opsHarness();
  const { server, url, id, token } = await boot(h);
  try {
    const cancelled = await call(url, `/tenants/${id}/cancel`, { method: "POST", token, body: {} });
    assert.equal(cancelled.body.tenant.subscription.cancelling, true);
    const undone = await call(url, `/tenants/${id}/cancel`, { method: "POST", token, body: { undo: true } });
    assert.equal(undone.body.tenant.subscription.cancelling, false);
    await call(url, `/tenants/${id}/cancel`, { method: "POST", token, body: {} });

    h.clock.now = new Date(Date.parse("2026-11-01T00:00:00Z") + 30 * DAY + 60_000);
    const report = await runMaintenance({ store: h.store, docker: h.docker, config: h.config, now: () => h.clock.now, telegram: h.telegram, log: { warn() {} } });
    assert.deepEqual(report.halted, [id], "halted at once, no 3-day grace");
  } finally {
    server.close();
    h.store.close();
  }
});

test("a dead agent pages the customer and ops once, shows on the admin overview, and recovers", async () => {
  const h = opsHarness();
  const { server, url, id, token } = await boot(h);
  try {
    await linkTelegram(url, id, token);
    const healthy = h.docker.readState;
    const run = () => runMaintenance({ store: h.store, docker: h.docker, config: h.config, now: () => h.clock.now, telegram: h.telegram, log: { warn() {} } });
    await run();
    h.docker.readState = async () => { throw new Error("no answer"); };
    await run();
    assert.equal(h.opsSent.length, 0, "one miss is not an alert");
    const second = await run();
    assert.deepEqual(second.opened, [`${id}:agent_down`]);
    assert.match(h.opsSent[0], new RegExp(`Agent ${id} is not responding`));
    assert.match(h.sent.at(-1).text, /not responding/);
    await run();
    assert.equal(h.opsSent.length, 1, "no repeat while it stays down");

    const overview = await call(url, "/admin/overview");
    assert.deepEqual(overview.body.alerts.map((a) => [a.id, a.kind]), [[id, "agent_down"]]);

    h.docker.readState = healthy;
    const back = await run();
    assert.deepEqual(back.resolved, [`${id}:agent_down`]);
    assert.match(h.sent.at(-1).text, /back to normal/);
    assert.deepEqual((await call(url, "/admin/overview")).body.alerts, []);
  } finally {
    server.close();
    h.store.close();
  }
});

test("new trades reach Telegram once and a fresh link never replays history", async () => {
  const h = opsHarness();
  const { server, url, id, token } = await boot(h);
  try {
    await linkTelegram(url, id, token);
    const base = JSON.parse(await h.docker.readState());
    const run = () => runMaintenance({ store: h.store, docker: h.docker, config: h.config, now: () => h.clock.now, telegram: h.telegram, log: { warn() {} } });
    await run();
    assert.equal(h.sent.filter((m) => /Bought|Sold/.test(m.text)).length, 0, "history is not replayed");
    base.trades.push({ success: true, fromToken: "USDT", toToken: "TSLAB", fromAmount: "40", toAmount: "0.2", priceAtExecution: 200, timestamp: 50, txHash: `0x${"ef".repeat(32)}` });
    h.docker.readState = async () => JSON.stringify(base);
    await run();
    await run();
    const trades = h.sent.filter((m) => /Bought|Sold/.test(m.text));
    assert.equal(trades.length, 1);
    assert.equal(trades[0].text, "Bought TSLAB for $40.00"); // new customers start live, so no [paper] tag
  } finally {
    server.close();
    h.store.close();
  }
});

test("a rollout moves customers to a new image tag and a bad image rolls back", async () => {
  const h = opsHarness();
  const { server, url, id } = await boot(h);
  try {
    const wait = async () => {
      for (let i = 0; i < 100; i++) {
        const j = await call(url, "/rollout");
        if (j.body.status !== "running") return j.body;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("rollout never finished");
    };
    assert.equal((await call(url, "/rollout", { method: "POST", body: { tag: "bad tag;" } })).status, 400);
    assert.equal((await call(url, "/rollout", { method: "POST", token: null, body: { tag: "abc123" } })).status, 401);

    const started = await call(url, "/rollout", { method: "POST", body: { tag: "abc123" } });
    assert.equal(started.status, 202);
    const done = await wait();
    assert.equal(done.status, "done");
    assert.deepEqual(done.report.done, [id]);
    assert.equal(h.store.get(id).image_tag, "abc123");
    assert.match(readFileSync(join(h.root, id, "override.yml"), "utf8"), /image: neural-saas-worker:abc123/);

    const good = h.docker.readState;
    h.docker.readState = async () => { throw new Error("crash loop"); };
    await call(url, "/rollout", { method: "POST", body: { tag: "broken1" } });
    const failed = await wait();
    assert.equal(failed.status, "failed");
    assert.equal(failed.report.failed, id);
    assert.equal(failed.report.rolledBack, true);
    assert.equal(h.store.get(id).image_tag, "abc123", "back on the previous good image");
    assert.match(readFileSync(join(h.root, id, "override.yml"), "utf8"), /image: neural-saas-worker:abc123/);
    h.docker.readState = good;
  } finally {
    server.close();
    h.store.close();
  }
});

test("encrypted tenant backups run on demand and hold no readable secret", async () => {
  const backups = mkdtempSync(join(tmpdir(), "na-bkdir-"));
  const h = opsHarness({ SAAS_BACKUP_KEY: "ab".repeat(32), SAAS_BACKUP_DIR: backups });
  const { server, url, id } = await boot(h);
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(h.root, id, "home"), { recursive: true });
    writeFileSync(join(h.root, id, "home", "session.json"), "wallet-login-secret");
    const r = await call(url, "/backups/run", { method: "POST" });
    assert.equal(r.status, 200);
    assert.equal(r.body.backedUp, 1);
    assert.equal(r.body.controlDb, true);
    const files = readdirSync(backups).sort();
    assert.equal(files.length, 2, "one customer folder plus the control database");
    const mine = files.find((f) => f.startsWith(`${id}-`));
    assert.match(mine, new RegExp(`^${id}-\\d{8}T\\d{6}Z\\.tar\\.gz\\.enc$`));
    for (const f of files) assert.equal(readFileSync(join(backups, f)).includes("wallet-login-secret"), false);

    // The control copy restores into a database that still knows this customer.
    const { restoreDir, parseBackupKey } = await import("./tenant-backup.mjs");
    const dest = join(mkdtempSync(join(tmpdir(), "na-restore-")), "ctl");
    await restoreDir({ file: join(backups, files.find((f) => f.startsWith("control-"))), key: parseBackupKey("ab".repeat(32)), destDir: dest });
    const restored = openStore(join(dest, "control.sqlite"));
    assert.equal(restored.get(id)?.id, id);
    restored.close();
  } finally {
    server.close();
    h.store.close();
  }

  const off = opsHarness();
  const second = await listen(off.handler);
  try {
    const r = await call(second.url, "/backups/run", { method: "POST" });
    assert.equal(r.status, 409);
    assert.ok(!existsSync(join(off.root, "backups")));
  } finally {
    second.server.close();
    off.store.close();
  }
});
