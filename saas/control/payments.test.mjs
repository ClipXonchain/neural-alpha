import assert from "node:assert/strict";
import test from "node:test";
import { createTreasuryWatcher, ERC20_TRANSFER_TOPIC, padTopicAddress } from "./payments.mjs";
import { DEFAULT_TOKEN_CONTRACTS, REQUIRED_CONFIRMATIONS } from "./policy.mjs";

test("treasury watcher ignores overpayments and auto matches only the exact quote", async () => {
  const treasuryAddress = "0x1111111111111111111111111111111111111111";
  const payer = "0x2222222222222222222222222222222222222222";
  const amountWei = 30_000_000_000_000_000_001n;
  const order = {
    id: "ord_0123456789ab",
    host_id: "cell-01",
    status: "pending",
    asset: "USDT",
    amount_wei: amountWei.toString(),
    expires_at: "2026-10-26T12:30:00.000Z",
  };
  const overpayHash = `0x${"11".repeat(32)}`;
  const exactHash = `0x${"22".repeat(32)}`;
  const usedHashes = new Set();
  let latestBlock = 1000n;
  let savedCursor = null;
  let incoming = {
    transactionHash: overpayHash,
    address: DEFAULT_TOKEN_CONTRACTS.USDT,
    topics: [ERC20_TRANSFER_TOPIC, padTopicAddress(payer), padTopicAddress(treasuryAddress)],
    data: `0x${(amountWei + 1n).toString(16)}`,
    blockNumber: "0x64",
  };
  const store = {
    listOrders: () => [order],
    findByPaymentTx: (hash) => (usedHashes.has(hash) ? { payment_tx: hash } : null),
    getWatcherCursor: () => savedCursor,
    setWatcherCursor: (_hostId, block) => { savedCursor = block; },
  };
  const rpc = async (method, params = []) => {
    if (method === "eth_blockNumber") return `0x${latestBlock.toString(16)}`;
    if (method === "eth_getLogs") {
      const from = BigInt(params[0].fromBlock);
      const to = BigInt(params[0].toBlock);
      const block = BigInt(incoming.blockNumber);
      return block >= from && block <= to ? [incoming] : [];
    }
    throw new Error(`Unexpected watcher RPC method: ${method}`);
  };
  const matched = [];
  const createWatcher = () => createTreasuryWatcher({
      store,
      config: {
        hostId: "cell-01",
        treasuryAddress,
        minConfirmations: REQUIRED_CONFIRMATIONS,
        tokenContracts: DEFAULT_TOKEN_CONTRACTS,
      },
      rpc,
      now: () => new Date("2026-10-26T12:00:00.000Z"),
      onOrderPaid: async (orderId, txHash) => {
        matched.push({ orderId, txHash });
        usedHashes.add(txHash);
        order.status = "paid";
      },
    });
  let watcher = createWatcher();

  assert.deepEqual(await watcher.scanOnce(), { matched: 0 });
  assert.deepEqual(matched, []);
  assert.equal(order.status, "pending");
  assert.equal(savedCursor, "105");

  // Restart from the durable cursor, then match an exact transfer in a later block.
  watcher.stop();
  watcher = createWatcher();
  latestBlock = 1020n;
  incoming = { ...incoming, transactionHash: exactHash, data: `0x${amountWei.toString(16)}`, blockNumber: "0x78" };
  assert.deepEqual(await watcher.scanOnce(), { matched: 1 });
  assert.equal(savedCursor, "125");
  assert.deepEqual(matched, [{ orderId: order.id, txHash: exactHash }]);
  assert.equal(order.status, "paid");
  watcher.stop();
});
