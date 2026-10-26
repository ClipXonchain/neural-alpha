import { assertAddress, CHECKOUT_SETTLEMENT_GRACE_MS, formatUnits18, PAYMENT_ASSETS, REQUIRED_CONFIRMATIONS } from "./policy.mjs";

export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const BSC_CHAIN_ID = 56n;
const ERC20_DECIMALS_SELECTOR = "0x313ce567";
const WATCHER_STARTUP_LOOKBACK_BLOCKS = 900n;

export function padTopicAddress(address) {
  const clean = assertAddress(address).slice(2);
  return `0x${clean.padStart(64, "0")}`;
}

export function extractTopicAddress(topic) {
  const raw = String(topic || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(raw)) return "";
  return `0x${raw.slice(26)}`;
}

export function createBscRpc(rpcUrl, fetchImpl = globalThis.fetch) {
  let reqId = 1;
  return async function rpcCall(method, params = []) {
    if (!rpcUrl) {
      throw Object.assign(new Error("SAAS_BSC_RPC_URL is not configured"), { status: 503 });
    }
    const id = reqId++;
    const response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!response.ok) {
      throw Object.assign(new Error(`BSC RPC HTTP ${response.status}`), { status: 502 });
    }
    const payload = await response.json();
    if (payload?.error) {
      throw Object.assign(new Error(payload.error.message || "BSC RPC error"), { status: 502 });
    }
    return payload?.result ?? null;
  };
}

/**
 * Verifies a BSC transaction receipt against a checkout order or direct payment requirement.
 * Enforces:
 *  1. status is success (0x1)
 *  2. token matches the order (native BNB or pinned BEP-20 contract)
 *  3. receiver is the treasury address
 *  4. amount exactly equals the locked quote (18 decimals)
 *  5. block has >= 15 confirmations
 */
export async function verifyBscReceipt({
  rpc,
  txHash,
  asset,
  treasuryAddress,
  contracts,
  minAmountWei,
  minConfirmations = REQUIRED_CONFIRMATIONS,
  notBefore,
  notAfter,
}) {
  const hash = String(txHash || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(hash)) {
    throw Object.assign(new Error("paymentTx must be a transaction hash"), { status: 400 });
  }
  const upperAsset = String(asset || "").trim().toUpperCase();
  if (!PAYMENT_ASSETS.includes(upperAsset)) {
    throw Object.assign(new Error("paymentAsset must be USDT, USDC, BNB, U, or USD1"), { status: 400 });
  }
  const treasury = assertAddress(treasuryAddress, "SAAS_TREASURY_ADDRESS");
  const requiredWei = BigInt(minAmountWei || 0);
  if (requiredWei <= 0n) {
    throw Object.assign(new Error("locked order price must be positive"), { status: 400 });
  }

  const [receipt, tx, latestBlockHex, chainIdHex] = await Promise.all([
    rpc("eth_getTransactionReceipt", [hash]),
    rpc("eth_getTransactionByHash", [hash]),
    rpc("eth_blockNumber", []),
    rpc("eth_chainId", []),
  ]);

  let chainId;
  try {
    chainId = BigInt(chainIdHex);
  } catch {
    throw Object.assign(new Error("could not verify the BSC network id"), { status: 503 });
  }
  if (chainId !== BSC_CHAIN_ID) {
    throw Object.assign(new Error(`payment RPC is on chain ${chainId}; BNB Smart Chain (56) is required`), { status: 503 });
  }

  if (!receipt || !tx || !receipt.blockNumber) {
    throw Object.assign(new Error("transaction receipt not found or still pending on BSC"), { status: 402 });
  }
  if (String(tx.hash || "").toLowerCase() !== hash || String(receipt.transactionHash || "").toLowerCase() !== hash) {
    throw Object.assign(new Error("RPC transaction hash does not match the submitted payment hash"), { status: 402 });
  }
  if (String(receipt.status || "").toLowerCase() !== "0x1") {
    throw Object.assign(new Error("transaction failed on chain"), { status: 402 });
  }

  let txBlock;
  let transactionBlock;
  try {
    txBlock = BigInt(receipt.blockNumber);
    transactionBlock = BigInt(tx.blockNumber);
  } catch {
    throw Object.assign(new Error("transaction block number is missing or invalid"), { status: 402 });
  }
  if (transactionBlock !== txBlock || !receipt.blockHash || !tx.blockHash || String(receipt.blockHash).toLowerCase() !== String(tx.blockHash).toLowerCase()) {
    throw Object.assign(new Error("transaction and receipt block references do not match"), { status: 402 });
  }
  const canonicalBlock = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
  if (!canonicalBlock || String(canonicalBlock.hash || "").toLowerCase() !== String(receipt.blockHash).toLowerCase()) {
    throw Object.assign(new Error("payment block is not canonical on BNB Smart Chain"), { status: 402 });
  }
  let blockTimeSeconds;
  try {
    blockTimeSeconds = BigInt(canonicalBlock.timestamp);
  } catch {
    throw Object.assign(new Error("payment block timestamp is missing or invalid"), { status: 402 });
  }
  // BSC block timestamps have one-second resolution while checkout times have
  // milliseconds; compare at chain precision to avoid rejecting a valid payment
  // mined in the same second the quote was issued.
  if (notBefore) {
    const createdMs = Date.parse(notBefore);
    if (!Number.isFinite(createdMs) || blockTimeSeconds < BigInt(Math.floor(createdMs / 1000))) {
      throw Object.assign(new Error("payment transaction was mined before this checkout was created"), { status: 402 });
    }
  }
  if (notAfter) {
    const expiresMs = Date.parse(notAfter);
    if (!Number.isFinite(expiresMs) || blockTimeSeconds > BigInt(Math.floor(expiresMs / 1000))) {
      throw Object.assign(new Error("payment transaction was mined after this checkout expired"), { status: 402 });
    }
  }

  const latestBlock = BigInt(latestBlockHex || receipt.blockNumber);
  const confirmations = latestBlock >= txBlock ? Number(latestBlock - txBlock + 1n) : 0;
  if (confirmations < minConfirmations) {
    throw Object.assign(
      new Error(`transaction has ${confirmations} confirmations; ${minConfirmations} required`),
      { status: 402, confirmations },
    );
  }

  let paidWei = 0n;
  let payerAddress;
  try {
    payerAddress = assertAddress(tx.from, "payer");
  } catch {
    throw Object.assign(new Error("transaction sender is missing or invalid"), { status: 402 });
  }
  const expectedContract = contracts?.[upperAsset] || "native";

  if (upperAsset === "BNB") {
    const toAddr = typeof tx.to === "string" ? tx.to.toLowerCase() : "";
    if (toAddr !== treasury) {
      throw Object.assign(new Error("BNB transfer receiver does not match treasury address"), { status: 402 });
    }
    paidWei = BigInt(tx.value || "0x0");
  } else {
    const tokenContract = assertAddress(expectedContract, `${upperAsset} contract`);
    const decimalsHex = await rpc("eth_call", [{ to: tokenContract, data: ERC20_DECIMALS_SELECTOR }, "latest"]);
    let decimals;
    try {
      decimals = BigInt(decimalsHex);
    } catch {
      throw Object.assign(new Error(`could not verify ${upperAsset} token decimals`), { status: 503 });
    }
    if (decimals !== 18n) {
      throw Object.assign(new Error(`${upperAsset} contract decimals are ${decimals}; the locked quote requires 18`), { status: 503 });
    }
    const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
    const payerAddresses = new Set();
    for (const log of logs) {
      const logAddr = String(log?.address || "").toLowerCase();
      const topics = Array.isArray(log?.topics) ? log.topics : [];
      if (logAddr !== tokenContract) continue;
      if (String(topics[0] || "").toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
      const toAddr = extractTopicAddress(topics[2]);
      if (toAddr !== treasury) continue;
      const fromAddr = extractTopicAddress(topics[1]);
      if (!fromAddr) {
        throw Object.assign(new Error("matching token transfer has an invalid sender address"), { status: 402 });
      }
      payerAddresses.add(fromAddr);
      const rawData = String(log?.data || "0x0");
      if (!/^0x[a-fA-F0-9]{64}$/.test(rawData)) {
        throw Object.assign(new Error("matching token transfer has an invalid amount field"), { status: 402 });
      }
      paidWei += BigInt(rawData);
    }
    if (paidWei === 0n) {
      throw Object.assign(
        new Error(`no matching ${upperAsset} transfer to treasury found in transaction logs`),
        { status: 402 },
      );
    }
    if (payerAddresses.size !== 1) {
      throw Object.assign(new Error("payment must come from one wallet address"), { status: 402 });
    }
    payerAddress = [...payerAddresses][0];
  }

  if (paidWei < requiredWei) {
    throw Object.assign(
      new Error(
        `underpaid: received ${formatUnits18(paidWei)} ${upperAsset}, required ${formatUnits18(requiredWei)} ${upperAsset}`,
      ),
      { status: 402, paidWei: paidWei.toString(), requiredWei: requiredWei.toString() },
    );
  }

  if (paidWei > requiredWei) {
    throw Object.assign(
      new Error(
        `wrong amount: received ${formatUnits18(paidWei)} ${upperAsset}, exact quote is ${formatUnits18(requiredWei)} ${upperAsset}`,
      ),
      { status: 402, paidWei: paidWei.toString(), requiredWei: requiredWei.toString() },
    );
  }

  const overpaidWei = 0n;
  return {
    ok: true,
    txHash: hash,
    asset: upperAsset,
    treasuryAddress: treasury,
    tokenContract: upperAsset === "BNB" ? "native" : assertAddress(expectedContract),
    paidWei: paidWei.toString(),
    paidDisplay: formatUnits18(paidWei),
    overpaidWei: overpaidWei.toString(),
    overpaidDisplay: formatUnits18(overpaidWei),
    confirmations,
    payerAddress,
  };
}

/**
 * Watches incoming BSC transfers to the treasury address and matches them to open checkout orders.
 */
export function createTreasuryWatcher({ store, config, rpc, onOrderPaid, now = () => new Date() }) {
  let lastScannedBlock = null;
  try {
    const persistedCursor = store.getWatcherCursor?.(config.hostId);
    if (persistedCursor !== null && persistedCursor !== undefined) lastScannedBlock = BigInt(persistedCursor);
  } catch {
    lastScannedBlock = null;
  }
  let busy = false;
  let timer = null;

  function saveCursor(blockNumber) {
    store.setWatcherCursor?.(config.hostId, blockNumber.toString(), now().toISOString());
    lastScannedBlock = blockNumber;
  }

  async function scanOnce() {
    if (busy || !config.treasuryAddress || !rpc) return { matched: 0 };
    busy = true;
    let matched = 0;
    try {
      const nowMs = now().getTime();
      const pendingOrders = store
        .listOrders()
        .filter((ord) => ord.host_id === config.hostId && ord.status === "pending" && Date.parse(ord.expires_at) + CHECKOUT_SETTLEMENT_GRACE_MS > nowMs);

      const latestHex = await rpc("eth_blockNumber", []);
      if (!latestHex) return { matched: 0 };
      const latestBlock = BigInt(latestHex);
      const minConf = BigInt(config.minConfirmations || REQUIRED_CONFIRMATIONS);
      if (latestBlock < minConf) return { matched: 0 };
      const safeBlock = latestBlock - minConf + 1n;

      // Keep the cursor current while there are no live quotes. If an order is
      // pending, retain the previous cursor so a restart can resume the gap.
      if (pendingOrders.length === 0) {
        if (lastScannedBlock === null || lastScannedBlock < safeBlock) saveCursor(safeBlock);
        return { matched: 0 };
      }

      const fromBlock = lastScannedBlock !== null
        ? lastScannedBlock + 1n
        : (safeBlock > WATCHER_STARTUP_LOOKBACK_BLOCKS ? safeBlock - WATCHER_STARTUP_LOOKBACK_BLOCKS : 0n);
      if (fromBlock > safeBlock) return { matched: 0 };
      // Keep native-BNB block reads bounded and advance the cursor by only the
      // range actually scanned, so a restart or slow RPC cannot skip blocks.
      const scanToBlock = safeBlock - fromBlock > 19n ? fromBlock + 19n : safeBlock;

      const treasuryTopic = padTopicAddress(config.treasuryAddress);
      const tokenAddresses = Object.entries(config.tokenContracts || {})
        .filter(([sym, addr]) => sym !== "BNB" && addr && addr !== "native")
        .map(([, addr]) => addr.toLowerCase());

      const candidateTxs = [];

      if (tokenAddresses.length > 0) {
        const logs = await rpc("eth_getLogs", [
          {
            fromBlock: `0x${fromBlock.toString(16)}`,
            toBlock: `0x${scanToBlock.toString(16)}`,
            address: tokenAddresses,
            topics: [ERC20_TRANSFER_TOPIC, null, treasuryTopic],
          },
        ]);
        if (Array.isArray(logs)) {
          const grouped = new Map();
          for (const log of logs) {
            const txHash = String(log?.transactionHash || "").toLowerCase();
            const contract = String(log?.address || "").toLowerCase();
            const valueWei = /^0x[a-fA-F0-9]+$/.test(String(log?.data || "")) ? BigInt(log.data) : 0n;
            const asset = Object.keys(config.tokenContracts).find(
              (sym) => String(config.tokenContracts[sym]).toLowerCase() === contract,
            );
            if (txHash && asset && valueWei > 0n) {
              const key = `${txHash}:${asset}`;
              const prior = grouped.get(key);
              grouped.set(key, { txHash, asset, valueWei: (prior?.valueWei || 0n) + valueWei });
            }
          }
          candidateTxs.push(...grouped.values());
        }
      }

      if (pendingOrders.some((ord) => ord.asset === "BNB")) {
        for (let b = fromBlock; b <= scanToBlock; b += 1n) {
          const block = await rpc("eth_getBlockByNumber", [`0x${b.toString(16)}`, true]);
          const txs = Array.isArray(block?.transactions) ? block.transactions : [];
          for (const tx of txs) {
            if (String(tx?.to || "").toLowerCase() === config.treasuryAddress.toLowerCase()) {
              const valueWei = BigInt(tx?.value || "0x0");
              const txHash = String(tx?.hash || "").toLowerCase();
              if (txHash && valueWei > 0n) {
                candidateTxs.push({ txHash, asset: "BNB", valueWei });
              }
            }
          }
        }
      }

      let retryChunk = false;
      for (const cand of candidateTxs) {
        if (store.findByPaymentTx(cand.txHash)) continue;
        const openForAsset = pendingOrders.filter((ord) => ord.status === "pending" && ord.asset === cand.asset);
        const exact = openForAsset.find((ord) => BigInt(ord.amount_wei) === cand.valueWei);
        if (!exact) continue;
        try {
          await onOrderPaid(exact.id, cand.txHash);
          exact.status = "paid";
          matched += 1;
        } catch (err) {
          // Retry transient infrastructure/provisioning failures in this range.
          if (!Number(err?.status) || Number(err.status) >= 500) retryChunk = true;
        }
      }

      if (!retryChunk) saveCursor(scanToBlock);
      return { matched };
    } finally {
      busy = false;
    }
  }

  return {
    scanOnce,
    start(intervalMs = 15_000) {
      if (timer) return;
      timer = setInterval(() => {
        scanOnce().catch(() => {});
      }, Math.max(2_000, intervalMs));
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
