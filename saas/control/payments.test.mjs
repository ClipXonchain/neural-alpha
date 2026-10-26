import assert from "node:assert/strict";
import test from "node:test";
import { createTreasuryWatcher, ERC20_TRANSFER_TOPIC, padTopicAddress } from "./payments.mjs";
import { CHECKOUT_SETTLEMENT_GRACE_MS, DEFAULT_TOKEN_CONTRACTS, REQUIRED_CONFIRMATIONS } from "./policy.mjs";

const TREASURY = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const NOW = "2026-10-26T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function order(id, amountWei, { createdAt = NOW_MS - 5 * 60_000, expiresAt = NOW_MS + 10 * 60_000, asset = "USDT" } = {}) {
  return {
    id,
    host_id: "cell-01",
    status: "pending",
    asset,
    amount_wei: amountWei.toString(),
    created_at: new Date(createdAt).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    payment_tx: null,
    confirmations: null,
  };
}

test("address list settles an exact treasury transfer inside 15 minutes and ignores the rest", async () => {
  const amountWei = 15_491_000_000_000_000_000n;
  const boundaryWei = amountWei + 7n;
  const lateWei = amountWei + 9n;
  const closedWei = amountWei + 11n;
  const exactHash = `0x${"22".repeat(32)}`;
  const oldHash = `0x${"11".repeat(32)}`;
  const boundaryHash = `0x${"33".repeat(32)}`;
  const lateHash = `0x${"44".repeat(32)}`;
  const closedHash = `0x${"55".repeat(32)}`;
  const windowStart = NOW_MS - CHECKOUT_SETTLEMENT_GRACE_MS;
  const main = order("ord_0123456789ab", amountWei);
  const boundary = order("ord_boundary0001", boundaryWei, { createdAt: windowStart - 60_000 });
  const late = order("ord_latepayment1", lateWei, { createdAt: NOW_MS - 20 * 60_000, expiresAt: NOW_MS - 2 * 60_000 });
  const closed = order("ord_closedorder1", closedWei, { expiresAt: NOW_MS - CHECKOUT_SETTLEMENT_GRACE_MS - 1_000 });
  const orders = [main, boundary, late, closed];
  const usedHashes = new Set();
  const urls = [];
  const store = {
    listOrders: () => orders,
    findByPaymentTx: (hash) => (usedHashes.has(hash) ? { payment_tx: hash } : null),
    getWatcherCursor: () => "999999999",
    setWatcherCursor: () => {
      throw new Error("cursor should not gate scans");
    },
    updateOrder: (id, patch) => {
      const row = orders.find((item) => item.id === id);
      Object.assign(row, patch);
      return row;
    },
  };
  const fetchImpl = async (url) => {
    const href = String(url);
    urls.push(href);
    assert.match(href, /blockscout\.com/);
    assert.match(href, new RegExp(TREASURY.slice(2), "i"));
    assert.match(href, new RegExp(DEFAULT_TOKEN_CONTRACTS.USDT.slice(2), "i"));
    assert.doesNotMatch(href, new RegExp(DEFAULT_TOKEN_CONTRACTS.USDC.slice(2), "i"));
    const item = (hash, value, timestamp, to = TREASURY, token = DEFAULT_TOKEN_CONTRACTS.USDT, block = 900) => ({
      transaction_hash: hash,
      to: { hash: to },
      token: { address: token },
      total: { value: value.toString() },
      timestamp: new Date(timestamp).toISOString(),
      block_number: block,
    });
    return jsonResponse({
      items: [
        item(`0x${"aa".repeat(32)}`, amountWei, NOW_MS - 2 * 60_000, PAYER),
        item(exactHash, amountWei, NOW_MS - 2 * 60_000),
        item(oldHash, amountWei, windowStart - 1_000),
        item(`0x${"66".repeat(32)}`, amountWei + 1n, NOW_MS - 60_000),
        item(`0x${"77".repeat(32)}`, amountWei - 1n, NOW_MS - 60_000),
        item(`0x${"88".repeat(32)}`, amountWei, NOW_MS - 60_000, TREASURY, DEFAULT_TOKEN_CONTRACTS.USDC),
        item(boundaryHash, boundaryWei, windowStart, TREASURY, DEFAULT_TOKEN_CONTRACTS.USDT, 800),
        item(lateHash, lateWei, NOW_MS - 60_000),
        item(closedHash, closedWei, NOW_MS - 60_000),
      ],
      next_page_params: null,
    });
  };
  const rpc = async (method) => {
    if (method === "eth_blockNumber") return "0x3e8";
    throw new Error(`Unexpected watcher RPC method: ${method}`);
  };
  const matched = [];
  const createWatcher = () => createTreasuryWatcher({
    store,
    config: {
      hostId: "cell-01",
      treasuryAddress: TREASURY,
      minConfirmations: REQUIRED_CONFIRMATIONS,
      tokenContracts: DEFAULT_TOKEN_CONTRACTS,
    },
    rpc,
    fetchImpl,
    now: () => new Date(NOW_MS),
    onOrderPaid: async (orderId, txHash) => {
      matched.push({ orderId, txHash });
      usedHashes.add(txHash);
      orders.find((item) => item.id === orderId).status = "paid";
    },
  });
  const watcher = createWatcher();
  assert.deepEqual(await watcher.scanOnce(), { matched: 2 });
  assert.deepEqual(matched.map((item) => item.txHash).sort(), [boundaryHash, exactHash].sort());
  assert.equal(main.status, "paid");
  assert.equal(late.status, "pending");
  assert.equal(closed.status, "pending");
  assert.equal(urls.length, 1);

  main.status = "pending";
  boundary.status = "pending";
  usedHashes.clear();
  matched.length = 0;
  const restarted = createWatcher();
  assert.deepEqual(await restarted.scanOnce(), { matched: 2 });
  watcher.stop();
  restarted.stop();
});

test("bnbscan address list is used when Blockscout fails and still matches the exact wei", async () => {
  const amountWei = 15_491_000_000_000_000_000n;
  const exactHash = `0x${"22".repeat(32)}`;
  const row = order("ord_bnbscan00001", amountWei);
  const urls = [];
  const fetchImpl = async (url) => {
    const href = String(url);
    urls.push(href);
    if (href.includes("blockscout.com")) throw new Error("transfer list HTTP 404");
    assert.match(href, /bnbscan\.com/);
    assert.match(href, new RegExp(TREASURY.slice(2), "i"));
    return jsonResponse({
      tokenTransfers: [{
        txHash: exactHash,
        tokenAddress: DEFAULT_TOKEN_CONTRACTS.USDT,
        toAddress: TREASURY,
        value: amountWei.toString(),
        blockNumber: 900,
        timestamp: new Date(NOW_MS - 60_000).toISOString(),
      }, {
        txHash: `0x${"11".repeat(32)}`,
        tokenAddress: DEFAULT_TOKEN_CONTRACTS.USDT,
        toAddress: TREASURY,
        value: (amountWei + 1n).toString(),
        blockNumber: 901,
        timestamp: new Date(NOW_MS - 60_000).toISOString(),
      }],
      transactions: [],
    });
  };
  const matched = [];
  const watcher = createTreasuryWatcher({
    store: {
      listOrders: () => [row],
      findByPaymentTx: () => null,
      updateOrder: (_id, patch) => Object.assign(row, patch),
    },
    config: {
      hostId: "cell-01",
      treasuryAddress: TREASURY,
      minConfirmations: REQUIRED_CONFIRMATIONS,
      tokenContracts: DEFAULT_TOKEN_CONTRACTS,
    },
    rpc: async (method) => {
      if (method === "eth_blockNumber") return "0x3e8";
      throw new Error(`Unexpected watcher RPC method: ${method}`);
    },
    fetchImpl,
    now: () => new Date(NOW_MS),
    onOrderPaid: async (orderId, txHash) => {
      matched.push({ orderId, txHash });
      row.status = "paid";
    },
  });
  assert.deepEqual(await watcher.scanOnce(), { matched: 1 });
  assert.deepEqual(matched, [{ orderId: row.id, txHash: exactHash }]);
  assert.ok(urls.some((href) => href.includes("bnbscan.com")));
  watcher.stop();
});

test("watcher records confirmation progress and settles only after the required depth", async () => {
  const amountWei = 15_184_000_000_000_000_000n;
  const exactHash = `0x${"33".repeat(32)}`;
  const row = order("ord_abcdefabcdef", amountWei);
  let latestBlock = 1000n;
  const fetchImpl = async () => jsonResponse({
    items: [{
      transaction_hash: exactHash,
      to: { hash: TREASURY },
      token: { address: DEFAULT_TOKEN_CONTRACTS.USDT },
      total: { value: amountWei.toString() },
      timestamp: new Date(NOW_MS - 60_000).toISOString(),
      block_number: 997,
    }],
    next_page_params: null,
  });
  const matched = [];
  const watcher = createTreasuryWatcher({
    store: {
      listOrders: () => [row],
      findByPaymentTx: () => null,
      updateOrder: (_id, patch) => Object.assign(row, patch),
    },
    config: {
      hostId: "cell-01",
      treasuryAddress: TREASURY,
      minConfirmations: REQUIRED_CONFIRMATIONS,
      tokenContracts: DEFAULT_TOKEN_CONTRACTS,
    },
    rpc: async (method) => {
      if (method === "eth_blockNumber") return `0x${latestBlock.toString(16)}`;
      throw new Error(`Unexpected watcher RPC method: ${method}`);
    },
    fetchImpl,
    now: () => new Date(NOW_MS),
    onOrderPaid: async (orderId, txHash) => {
      matched.push({ orderId, txHash });
      row.status = "paid";
    },
  });

  assert.deepEqual(await watcher.scanOnce(), { matched: 0 });
  assert.equal(row.payment_tx, exactHash);
  assert.equal(row.confirmations, 4);
  assert.equal(row.status, "pending");

  latestBlock = 1003n;
  assert.deepEqual(await watcher.scanOnce(), { matched: 0 });
  assert.equal(row.confirmations, 7);

  latestBlock = 1011n;
  assert.deepEqual(await watcher.scanOnce(), { matched: 1 });
  assert.deepEqual(matched, [{ orderId: row.id, txHash: exactHash }]);
  watcher.stop();
});

test("limit exceeded on treasury logs splits the 15-minute window and still finds the transfer", async () => {
  const amountWei = 15_491_000_000_000_000_000n;
  const exactHash = `0x${"22".repeat(32)}`;
  const overHash = `0x${"11".repeat(32)}`;
  const row = order("ord_rpcsplit0001", amountWei);
  const latestBlock = 10_000n;
  const exactBlock = 9960n;
  const overBlock = 9980n;
  const calls = [];
  const rpc = async (method, params = []) => {
    if (method === "eth_blockNumber") return `0x${latestBlock.toString(16)}`;
    if (method === "eth_getBlockByNumber") {
      assert.notEqual(params[1], true);
      const block = BigInt(params[0]);
      const latestSec = Math.floor(NOW_MS / 1000);
      const seconds = latestSec - Number(latestBlock - block) * 3;
      return { timestamp: `0x${seconds.toString(16)}` };
    }
    if (method === "eth_getLogs") {
      const filter = params[0];
      const from = BigInt(filter.fromBlock);
      const to = BigInt(filter.toBlock);
      calls.push({ from, to, address: filter.address, topics: filter.topics });
      assert.equal(typeof filter.address, "string");
      assert.equal(filter.address, DEFAULT_TOKEN_CONTRACTS.USDT);
      assert.deepEqual(filter.topics, [ERC20_TRANSFER_TOPIC, null, padTopicAddress(TREASURY)]);
      if (to - from > 10n) throw new Error("limit exceeded");
      const logs = [];
      const push = (block, hash, value) => {
        if (block < from || block > to) return;
        logs.push({
          transactionHash: hash,
          address: DEFAULT_TOKEN_CONTRACTS.USDT,
          topics: [ERC20_TRANSFER_TOPIC, padTopicAddress(PAYER), padTopicAddress(TREASURY)],
          data: `0x${value.toString(16)}`,
          blockNumber: `0x${block.toString(16)}`,
        });
      };
      push(exactBlock, exactHash, amountWei);
      push(overBlock, overHash, amountWei + 1n);
      push(9690n, `0x${"99".repeat(32)}`, amountWei);
      return logs;
    }
    throw new Error(`Unexpected watcher RPC method: ${method}`);
  };
  const matched = [];
  const watcher = createTreasuryWatcher({
    store: {
      listOrders: () => [row],
      findByPaymentTx: () => null,
      updateOrder: (_id, patch) => Object.assign(row, patch),
    },
    config: {
      hostId: "cell-01",
      treasuryAddress: TREASURY,
      minConfirmations: REQUIRED_CONFIRMATIONS,
      tokenContracts: DEFAULT_TOKEN_CONTRACTS,
    },
    rpc,
    fetchImpl: async () => {
      throw new Error("transfer list HTTP 503");
    },
    now: () => new Date(NOW_MS),
    onOrderPaid: async (orderId, txHash) => {
      matched.push({ orderId, txHash });
      row.status = "paid";
    },
  });
  assert.deepEqual(await watcher.scanOnce(), { matched: 1 });
  assert.deepEqual(matched, [{ orderId: row.id, txHash: exactHash }]);
  assert.ok(calls.some((call) => call.to - call.from > 10n));
  assert.ok(calls.every((call) => call.from >= 9700n));
  assert.ok(calls.some((call) => call.from <= exactBlock && call.to >= exactBlock && call.to - call.from <= 10n));
  watcher.stop();
});

test("a treasury log query that still exceeds the limit warns once and does not throw", async () => {
  const row = order("ord_limitfail001", 15_491_000_000_000_000_000n);
  const warnings = [];
  let logCalls = 0;
  const watcher = createTreasuryWatcher({
    store: {
      listOrders: () => [row],
      findByPaymentTx: () => null,
    },
    config: {
      hostId: "cell-01",
      treasuryAddress: TREASURY,
      minConfirmations: REQUIRED_CONFIRMATIONS,
      tokenContracts: DEFAULT_TOKEN_CONTRACTS,
    },
    rpc: async (method, params = []) => {
      if (method === "eth_blockNumber") return "0x2710";
      if (method === "eth_getBlockByNumber") {
        const block = BigInt(params[0]);
        const latestSec = Math.floor(NOW_MS / 1000);
        const seconds = latestSec - Number(10_000n - block) * 3;
        return { timestamp: `0x${seconds.toString(16)}` };
      }
      if (method === "eth_getLogs") {
        logCalls += 1;
        assert.equal(params[0].topics[2], padTopicAddress(TREASURY));
        throw new Error("limit exceeded");
      }
      throw new Error(`Unexpected watcher RPC method: ${method}`);
    },
    fetchImpl: async () => {
      throw new Error("transfer list HTTP 503");
    },
    log: (message) => warnings.push(message),
    now: () => new Date(NOW_MS),
    onOrderPaid: async () => {
      throw new Error("should not settle");
    },
  });
  assert.deepEqual(await watcher.scanOnce(), { matched: 0 });
  assert.equal(row.status, "pending");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /treasury watcher scan failed: limit exceeded/);
  assert.ok(logCalls < 40);
  watcher.stop();
});

test("native BNB orders read only incoming treasury transfers from the last 15 minutes", async () => {
  const amountWei = 25_000_000_000_000_000n;
  const exactHash = `0x${"ab".repeat(32)}`;
  const oldHash = `0x${"cd".repeat(32)}`;
  const row = order("ord_nativebnb001", amountWei, { asset: "BNB" });
  const windowStart = NOW_MS - CHECKOUT_SETTLEMENT_GRACE_MS;
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("blockscout.com")) throw new Error("transfer list HTTP 404");
    return jsonResponse({
      transactions: [
        {
          hash: oldHash,
          toAddress: TREASURY,
          value: `${amountWei}.000000000000000000`,
          timestamp: new Date(windowStart - 60_000).toISOString(),
          blockNumber: 10,
          status: true,
        },
        {
          hash: exactHash,
          toAddress: TREASURY,
          value: `${amountWei}.000000000000000000`,
          timestamp: new Date(NOW_MS - 60_000).toISOString(),
          blockNumber: 500,
          status: true,
        },
      ],
      tokenTransfers: [],
    });
  };
  const matched = [];
  const watcher = createTreasuryWatcher({
    store: {
      listOrders: () => [row],
      findByPaymentTx: () => null,
      updateOrder: (_id, patch) => Object.assign(row, patch),
    },
    config: {
      hostId: "cell-01",
      treasuryAddress: TREASURY,
      minConfirmations: REQUIRED_CONFIRMATIONS,
      tokenContracts: DEFAULT_TOKEN_CONTRACTS,
    },
    rpc: async (method) => {
      if (method === "eth_blockNumber") return "0x208";
      throw new Error(`Unexpected watcher RPC method: ${method}`);
    },
    fetchImpl,
    now: () => new Date(NOW_MS),
    onOrderPaid: async (_id, txHash) => {
      matched.push(txHash);
      row.status = "paid";
    },
  });
  assert.deepEqual(await watcher.scanOnce(), { matched: 1 });
  assert.deepEqual(matched, [exactHash]);
  watcher.stop();
});

test("binance wallet history lists only the treasury and settles the exact 15-minute transfer", async () => {
  const treasuryAddress = "0x1111111111111111111111111111111111111111";
  const payer = "0x2222222222222222222222222222222222222222";
  const nowMs = Date.parse("2026-10-26T12:00:00.000Z");
  const amount = "15.491";
  const amountWei = 15_491_000_000_000_000_000n;
  const exactHash = `0x${"22".repeat(32)}`;
  const row = {
    id: "ord_0123456789ab",
    host_id: "cell-01",
    status: "pending",
    asset: "USDT",
    amount_wei: amountWei.toString(),
    created_at: "2026-10-26T11:50:00.000Z",
    expires_at: "2026-10-26T12:10:00.000Z",
    payment_tx: null,
    confirmations: null,
  };
  const usedHashes = new Set();
  const store = {
    listOrders: () => [row],
    findByPaymentTx: (hash) => (usedHashes.has(hash) ? { payment_tx: hash } : null),
    updateOrder: (_id, patch) => {
      Object.assign(row, patch);
      return row;
    },
  };
  let height = "990";
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/transactions-by-address")) {
      assert.equal(parsed.searchParams.get("address"), treasuryAddress);
      assert.equal(parsed.searchParams.get("chains"), "56");
      assert.equal(parsed.searchParams.get("begin"), String(Date.parse("2026-10-26T11:50:00.000Z") - 5_000));
      return Response.json({
        code: 0,
        data: [{
          transactionList: [
            {
              txHash: `0x${"11".repeat(32)}`,
              txStatus: "success",
              txTime: String(nowMs - 20_000),
              tokenContractAddress: DEFAULT_TOKEN_CONTRACTS.USDT,
              symbol: "USDT",
              from: [{ address: payer, amount: "15.492" }],
              to: [{ address: treasuryAddress, amount: "15.492" }],
            },
            {
              txHash: exactHash,
              txStatus: "success",
              txTime: String(nowMs - 10_000),
              tokenContractAddress: DEFAULT_TOKEN_CONTRACTS.USDT,
              symbol: "USDT",
              from: [{ address: payer, amount }],
              to: [{ address: treasuryAddress, amount }],
            },
          ],
        }],
      });
    }
    if (parsed.pathname.endsWith("/block-height")) {
      return Response.json({ code: 0, data: { blockHeight: "1000" } });
    }
    if (parsed.pathname.endsWith("/transaction-detail-by-txhash")) {
      return Response.json({
        code: 0,
        data: [{
          chainIndex: "56",
          height,
          txTime: String(nowMs - 10_000),
          txhash: exactHash,
          txStatus: "success",
          tokenTransferDetails: [{
            from: payer,
            to: treasuryAddress,
            tokenContractAddress: DEFAULT_TOKEN_CONTRACTS.USDT,
            symbol: "USDT",
            amount,
          }],
        }],
      });
    }
    throw new Error(`unexpected ${parsed.pathname}`);
  };
  const matched = [];
  const watcher = createTreasuryWatcher({
    store,
    config: {
      hostId: "cell-01",
      treasuryAddress,
      minConfirmations: REQUIRED_CONFIRMATIONS,
      tokenContracts: DEFAULT_TOKEN_CONTRACTS,
      web3ApiKey: "test-key",
      web3SecretKey: "test-secret",
    },
    rpc: async () => {
      throw new Error("chain scan should not run");
    },
    fetchImpl,
    now: () => new Date(nowMs),
    onOrderPaid: async (orderId, txHash) => {
      matched.push({ orderId, txHash });
      usedHashes.add(txHash);
      row.status = "paid";
    },
  });

  assert.deepEqual(await watcher.scanOnce(), { matched: 0 });
  assert.equal(row.status, "pending");
  assert.equal(row.payment_tx, exactHash);
  assert.equal(row.confirmations, 11);

  height = "986";
  assert.deepEqual(await watcher.scanOnce(), { matched: 1 });
  assert.deepEqual(matched, [{ orderId: row.id, txHash: exactHash }]);
  assert.equal(row.status, "paid");
  watcher.stop();
});
