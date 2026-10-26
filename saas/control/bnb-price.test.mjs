import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BNB_PRICE_REFRESH_MS, createBnbPriceFeed, parseBinanceBnbTicker } from "./bnb-price.mjs";
import { CHECKOUT_EXPIRY_MS, parseUnits18 } from "./policy.mjs";
import { loadConfig, createHandler } from "./server.mjs";
import { openStore } from "./store.mjs";

test("official Binance BNBUSDT ticker parses and rejects a bad payload", () => {
  assert.equal(parseBinanceBnbTicker({ symbol: "BNBUSDT", price: "612.34000000" }), 612.34);
  assert.throws(() => parseBinanceBnbTicker({ symbol: "BTCUSDT", price: "600" }), /BNBUSDT/);
  assert.throws(() => parseBinanceBnbTicker({ symbol: "BNBUSDT", price: "0" }), /range/);
  assert.throws(() => parseBinanceBnbTicker({ symbol: "BNBUSDT", price: "nope" }), /range/);
});

function jsonResponse(body, ok = true) {
  return { ok, json: async () => body };
}

test("a quote younger than 4 hours is reused and an older one is refreshed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "na-bnb-"));
  const cachePath = join(dir, "bnb-price.json");
  const nowMs = Date.parse("2026-10-26T12:00:00.000Z");
  const freshAt = new Date(nowMs - 60 * 60 * 1000).toISOString();
  writeFileSync(cachePath, JSON.stringify({ symbol: "BNBUSDT", priceUsd: 640, fetchedAt: freshAt }));

  let calls = 0;
  const fresh = createBnbPriceFeed({
    fallbackUsd: 600,
    cachePath,
    now: () => nowMs,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ symbol: "BNBUSDT", price: "700" });
    },
  });
  const kept = await fresh.start();
  assert.equal(calls, 0);
  assert.equal(kept.priceUsd, 640);
  assert.equal(kept.source, "binance");
  fresh.stop();

  const staleAt = new Date(nowMs - BNB_PRICE_REFRESH_MS - 1000).toISOString();
  writeFileSync(cachePath, JSON.stringify({ symbol: "BNBUSDT", priceUsd: 640, fetchedAt: staleAt }));
  const stale = createBnbPriceFeed({
    fallbackUsd: 600,
    cachePath,
    now: () => nowMs,
    fetchImpl: async (url) => {
      calls += 1;
      assert.match(String(url), /symbol=BNBUSDT/);
      return jsonResponse({ symbol: "BNBUSDT", price: "701.5" });
    },
  });
  const updated = await stale.start();
  assert.equal(updated.priceUsd, 701.5);
  assert.equal(updated.source, "binance");
  const saved = JSON.parse(readFileSync(cachePath, "utf8"));
  assert.equal(saved.priceUsd, 701.5);
  stale.stop();
});

test("the public mirror is used when the primary Binance endpoint fails", async () => {
  const feed = createBnbPriceFeed({
    fallbackUsd: 600,
    now: () => Date.parse("2026-10-26T12:00:00.000Z"),
    fetchImpl: async (url) => {
      if (String(url).includes("api.binance.com")) throw new Error("down");
      return jsonResponse({ symbol: "BNBUSDT", price: "655" });
    },
  });
  const snap = await feed.refresh();
  assert.equal(snap.priceUsd, 655);
  assert.equal(snap.source, "binance");
  feed.stop();
});

test("both Binance endpoints failing keeps the fallback price", async () => {
  const feed = createBnbPriceFeed({
    fallbackUsd: 600,
    fetchImpl: async () => jsonResponse({}, false),
  });
  const snap = await feed.refresh();
  assert.equal(snap.priceUsd, 600);
  assert.equal(snap.source, "fallback");
  feed.stop();
});

test("BNB checkout locks $15 at the current Binance price", async () => {
  const root = mkdtempSync(join(tmpdir(), "na-bnb-quote-"));
  const config = loadConfig({
    CONTROL_API_SECRET: "test-secret",
    SAAS_MONITOR_SECRET: "monitor-secret",
    SAAS_TREASURY_ADDRESS: "0x1111111111111111111111111111111111111111",
    SAAS_PRICE_USD: "15",
    SAAS_BNB_PRICE_USD: "600",
    SAAS_DATA_ROOT: root,
    SAAS_DB_PATH: join(root, "control.sqlite"),
    SAAS_HOST_ID: "cell-01",
  });
  const store = openStore(config.dbPath);
  const bnbPrice = {
    priceUsd: () => 1000,
    snapshot: () => ({ priceUsd: 1000, source: "binance", updatedAt: "2026-10-26T12:00:00.000Z" }),
  };
  const handler = createHandler({
    store,
    docker: { async ensureNetwork() {}, async ensureImage() {}, async up() {}, async listContainers() { return []; } },
    config,
    bnbPrice,
    now: () => new Date("2026-10-26T12:00:00.000Z"),
  });
  const pricing = await invoke(handler, "GET", "/pricing");
  assert.equal(pricing.status, 200);
  assert.equal(pricing.body.bnbPriceUsd, 1000);
  assert.equal(pricing.body.feeUsd, 15);
  assert.equal(pricing.body.bnbAmountDisplay, "0.015");

  const checkout = await invoke(handler, "POST", "/checkout", { paymentAsset: "BNB" });
  assert.equal(checkout.status, 201);
  assert.match(checkout.body.order.amountDisplay, /^0\.015\d{3}$/);
  const amount = Number(checkout.body.order.amountDisplay);
  assert.ok(amount >= 0.015 && amount < 0.016, checkout.body.order.amountDisplay);
  assert.equal(checkout.body.order.amountWei, parseUnits18(checkout.body.order.amountDisplay).toString());
  assert.equal(Date.parse(checkout.body.order.expiresAt) - Date.parse("2026-10-26T12:00:00.000Z"), CHECKOUT_EXPIRY_MS);
  store.close();
});

function invoke(handler, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = path;
    req.headers = { "content-type": "application/json" };
    req.socket = { remoteAddress: "127.0.0.1" };
    req.destroy = () => req.emit("close");

    const res = new EventEmitter();
    const chunks = [];
    res.writeHead = (code) => {
      res.statusCode = code;
      return res;
    };
    res.write = (chunk) => {
      chunks.push(Buffer.from(chunk));
      return true;
    };
    res.end = (chunk) => {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve({ status: res.statusCode || 200, body: raw ? JSON.parse(raw) : {} });
    };

    Promise.resolve(handler(req, res)).catch(reject);
    queueMicrotask(() => {
      if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
      req.emit("end");
    });
  });
}
