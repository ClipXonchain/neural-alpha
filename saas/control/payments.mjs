import { createHmac, randomBytes } from "node:crypto";
import { assertAddress, CHECKOUT_PROVISION_RETRY_MS, CHECKOUT_SETTLEMENT_GRACE_MS, formatUnits18, parseUnits18, PAYMENT_ASSETS, REQUIRED_CONFIRMATIONS } from "./policy.mjs";

export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const BSC_CHAIN_ID = 56n;
const ERC20_DECIMALS_SELECTOR = "0x313ce567";
const BINANCE_WEB3_HOST = "https://web3.binance.com";
const BLOCKSCOUT_API = "https://bsc.blockscout.com/api/v2";
const BNBSCAN_API = "https://bnbscan.com/api/v1";
const TRANSFER_LIST_TIMEOUT_MS = 8_000;
const MAX_LOOKBACK_BLOCKS = 30_000n;
const NATIVE_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export function padTopicAddress(address) {
  const clean = assertAddress(address).slice(2);
  return `0x${clean.padStart(64, "0")}`;
}

export function extractTopicAddress(topic) {
  const raw = String(topic || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(raw)) return "";
  return `0x${raw.slice(26)}`;
}

/** Confirmations for a mined transaction, using the same block-inclusive count as receipt checks. */
export function confirmationsBetween(latestBlock, txBlock) {
  if (latestBlock < txBlock) return 0;
  const count = latestBlock - txBlock + 1n;
  return Number(count > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : count);
}

/** Latest confirmation count for a mined transaction. Null when the receipt is not on chain yet. */
export async function readConfirmationCount(rpc, txHash) {
  const hash = String(txHash || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(hash)) return null;
  const [receipt, latestHex] = await Promise.all([
    rpc("eth_getTransactionReceipt", [hash]),
    rpc("eth_blockNumber", []),
  ]);
  if (!receipt?.blockNumber || latestHex == null) return null;
  try {
    return confirmationsBetween(BigInt(latestHex), BigInt(receipt.blockNumber));
  } catch {
    return null;
  }
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

function binanceCredentials(config) {
  const apiKey = String(config?.web3ApiKey || "").trim();
  const secretKey = String(config?.web3SecretKey || "").trim();
  if (!apiKey || !secretKey) return null;
  return { apiKey, secretKey };
}

function sameAddress(left, right) {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
}

function assetForContract(tokenContracts, contract, symbol) {
  const normalized = String(contract || "").trim().toLowerCase();
  if (!normalized || normalized === NATIVE_TOKEN) {
    return String(symbol || "").toUpperCase() === "BNB" ? "BNB" : null;
  }
  return Object.keys(tokenContracts || {}).find((name) => sameAddress(tokenContracts[name], normalized)) || null;
}

async function binanceWalletGet(path, query, creds, fetchImpl = globalThis.fetch) {
  const qs = new URLSearchParams(
    Object.entries(query).filter(([, value]) => value !== undefined && value !== null && String(value) !== ""),
  ).toString();
  const requestPath = `/build${path}${qs ? `?${qs}` : ""}`;
  const timestamp = new Date().toISOString();
  const signature = createHmac("sha256", creds.secretKey)
    .update(`${timestamp}GET${requestPath}`, "utf8")
    .digest("base64");
  const response = await fetchImpl(`${BINANCE_WEB3_HOST}${requestPath}`, {
    headers: {
      "X-OC-APIKEY": creds.apiKey,
      "X-OC-TIMESTAMP": timestamp,
      "X-OC-SIGN": signature,
      "X-OC-NONCE": randomBytes(16).toString("hex"),
      "X-OC-RECV-WINDOW": "15000",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  const code = payload?.code;
  if (!response.ok || (code !== undefined && code !== 0 && String(code) !== "0")) {
    throw Object.assign(new Error(payload?.msg || "Binance Web3 wallet request failed"), { status: 502 });
  }
  return payload?.data;
}

function historyTransfers(rows, treasury, tokenContracts) {
  const transfers = [];
  for (const row of rows || []) {
    const status = String(row?.txStatus || "").toLowerCase();
    if (status && status !== "success" && status !== "pending") continue;
    const received = (Array.isArray(row?.to) ? row.to : []).find((item) => sameAddress(item?.address, treasury));
    if (!received) continue;
    const asset = assetForContract(tokenContracts, row.tokenContractAddress, row.symbol);
    if (!asset) continue;
    let amountWei;
    try {
      amountWei = parseUnits18(received.amount || row.amount);
    } catch {
      continue;
    }
    const txHash = String(row.txHash || "").trim().toLowerCase();
    const txTime = Number(row.txTime);
    if (!/^0x[a-f0-9]{64}$/.test(txHash) || !Number.isFinite(txTime)) continue;
    transfers.push({ txHash, asset, amountWei, txTime, status });
  }
  return transfers;
}

/**
 * Lists the treasury address's own BSC transfers from the last 15 minutes.
 * Uses the Binance Web3 Wallet API instead of scanning token-contract logs.
 */
export async function listBinanceTreasuryTransfers({ config, fetchImpl, nowMs, beginMs }) {
  const creds = binanceCredentials(config);
  if (!creds) throw Object.assign(new Error("Binance Web3 wallet API keys are not set"), { status: 503 });
  const earliest = Number.isFinite(beginMs) ? beginMs : nowMs - CHECKOUT_SETTLEMENT_GRACE_MS;
  const data = await binanceWalletGet(
    "/api/v1/dex/post-transaction/transactions-by-address",
    {
      address: config.treasuryAddress,
      chains: "56",
      begin: String(earliest),
      end: String(nowMs),
      limit: "100",
    },
    creds,
    fetchImpl,
  );
  const rows = (Array.isArray(data) ? data : []).flatMap((entry) => entry?.transactionList || []);
  return historyTransfers(rows, config.treasuryAddress, config.tokenContracts);
}

/**
 * Confirms one treasury payment from the Binance Wallet transaction detail.
 * This is one address lookup, not a chain log scan.
 */
export async function verifyBinanceWalletPayment({
  apiKey,
  secretKey,
  fetchImpl,
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
  const creds = { apiKey, secretKey };
  const [detailData, heightData] = await Promise.all([
    binanceWalletGet("/api/v1/dex/post-transaction/transaction-detail-by-txhash", { binanceChainId: "56", txHash: hash }, creds, fetchImpl),
    binanceWalletGet("/api/v1/dex/pre-transaction/block-height", { binanceChainId: "56" }, creds, fetchImpl),
  ]);
  const details = Array.isArray(detailData) ? detailData : [];
  const detail = details.find((row) => sameAddress(row?.txhash || row?.txHash, hash)) || details[0];
  if (!detail || String(detail.chainIndex || "") !== "56") {
    throw Object.assign(new Error("transaction was not found on BNB Smart Chain"), { status: 402 });
  }
  if (String(detail.txStatus || "").toLowerCase() !== "success") {
    throw Object.assign(new Error("transaction is not confirmed yet"), { status: 402 });
  }
  let txBlock;
  let latestBlock;
  try {
    txBlock = BigInt(detail.height);
    latestBlock = BigInt(heightData?.blockHeight);
  } catch {
    throw Object.assign(new Error("payment block height is missing"), { status: 402 });
  }
  const confirmations = confirmationsBetween(latestBlock, txBlock);
  if (confirmations < minConfirmations) {
    throw Object.assign(
      new Error(`transaction has ${confirmations} confirmations; ${minConfirmations} required`),
      { status: 402, confirmations },
    );
  }
  const txTime = Number(detail.txTime);
  if (notBefore) {
    const createdMs = Date.parse(notBefore);
    if (!Number.isFinite(txTime) || txTime < createdMs) {
      throw Object.assign(new Error("payment transaction was mined before this checkout was created"), { status: 402 });
    }
  }
  if (notAfter) {
    const expiresMs = Date.parse(notAfter);
    if (!Number.isFinite(txTime) || txTime > expiresMs) {
      throw Object.assign(new Error("payment transaction was mined after this checkout expired"), { status: 402 });
    }
  }

  let paidWei = 0n;
  const payers = new Set();
  if (upperAsset === "BNB") {
    const hit = (Array.isArray(detail.toDetails) ? detail.toDetails : []).find((row) => sameAddress(row?.address, treasury));
    if (!hit) throw Object.assign(new Error("BNB transfer receiver does not match treasury address"), { status: 402 });
    paidWei = parseUnits18(hit.amount || detail.amount);
    const from = detail.fromDetails?.[0]?.address;
    if (from) payers.add(String(from).toLowerCase());
  } else {
    const expected = assertAddress(contracts?.[upperAsset], `${upperAsset} contract`);
    for (const transfer of detail.tokenTransferDetails || []) {
      if (!sameAddress(transfer?.to, treasury) || !sameAddress(transfer?.tokenContractAddress, expected)) continue;
      const from = String(transfer?.from || "").toLowerCase();
      if (!/^0x[a-f0-9]{40}$/.test(from)) {
        throw Object.assign(new Error("matching token transfer has an invalid sender address"), { status: 402 });
      }
      payers.add(from);
      paidWei += parseUnits18(transfer.amount);
    }
  }
  if (paidWei === 0n) {
    throw Object.assign(new Error(`no matching ${upperAsset} transfer to treasury found`), { status: 402 });
  }
  if (payers.size !== 1) {
    throw Object.assign(new Error("payment must come from one wallet address"), { status: 402 });
  }
  if (paidWei < requiredWei) {
    throw Object.assign(
      new Error(`underpaid: received ${formatUnits18(paidWei)} ${upperAsset}, required ${formatUnits18(requiredWei)} ${upperAsset}`),
      { status: 402 },
    );
  }
  if (paidWei > requiredWei) {
    throw Object.assign(
      new Error(`wrong amount: received ${formatUnits18(paidWei)} ${upperAsset}, exact quote is ${formatUnits18(requiredWei)} ${upperAsset}`),
      { status: 402 },
    );
  }
  return {
    ok: true,
    txHash: hash,
    asset: upperAsset,
    treasuryAddress: treasury,
    tokenContract: upperAsset === "BNB" ? "native" : assertAddress(contracts[upperAsset]),
    paidWei: paidWei.toString(),
    paidDisplay: formatUnits18(paidWei),
    overpaidWei: "0",
    overpaidDisplay: "0",
    confirmations,
    payerAddress: [...payers][0],
  };
}

function addressOf(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim().toLowerCase();
  if (typeof value === "object") return String(value.hash || value.address || value.address_hash || "").trim().toLowerCase();
  return "";
}

function parseAmount(value) {
  const raw = String(value ?? "").trim();
  if (/^0x[0-9a-fA-F]+$/.test(raw)) return BigInt(raw);
  if (/^\d+$/.test(raw)) return BigInt(raw);
  // bnbscan writes a wei amount as "<wei>.000000000000000000".
  const weiWithFraction = raw.match(/^(\d+)\.0{18}$/);
  if (weiWithFraction) return BigInt(weiWithFraction[1]);
  return null;
}

function parseTimeMs(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 10_000_000_000 ? n : n * 1000;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBlock(value) {
  if (typeof value === "bigint") return value;
  if (value == null || value === "") return null;
  try {
    const raw = typeof value === "number" ? String(Math.trunc(value)) : String(value).trim();
    if (/^0x[0-9a-fA-F]+$/.test(raw) || /^\d+$/.test(raw)) return BigInt(raw);
  } catch {
    return null;
  }
  return null;
}

function isTxHash(value) {
  return /^0x[a-f0-9]{64}$/.test(value);
}

function isLimitError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return /limit exceeded|too many|more than|response size|block range|query timeout|exceed max|log size/.test(msg);
}

function shortFailure(err) {
  const raw = err instanceof Error ? err.message : String(err || "scan failed");
  return raw.replace(/https?:\/\/\S+/g, "remote endpoint").replace(/\s+/g, " ").slice(0, 160);
}

function hexBlock(blockNumber) {
  return `0x${blockNumber.toString(16)}`;
}

function failedStatus(status) {
  return status === false || status === 0 || status === "0" || status === "0x0" || status === "error" || status === "failed";
}

function quoteCovers(order, timestampMs) {
  if (timestampMs == null) return true;
  const mined = Math.floor(timestampMs / 1000);
  const created = Date.parse(order.created_at || "");
  if (Number.isFinite(created) && mined < Math.floor(created / 1000)) return false;
  const expires = Date.parse(order.expires_at || "");
  if (Number.isFinite(expires) && mined > Math.floor(expires / 1000)) return false;
  return true;
}

function rememberTransfer(grouped, row) {
  const key = `${row.txHash}:${row.asset}`;
  const prior = grouped.get(key);
  if (!prior) {
    grouped.set(key, { ...row });
    return;
  }
  prior.value += row.value;
  if (prior.blockNumber == null) prior.blockNumber = row.blockNumber;
  if (prior.timestampMs == null) prior.timestampMs = row.timestampMs;
}

async function fetchJson(http, url) {
  const response = await http(url, {
    method: "GET",
    headers: { accept: "application/json", "user-agent": "neural-alpha-treasury-watcher" },
    signal: AbortSignal.timeout(TRANSFER_LIST_TIMEOUT_MS),
  });
  if (!response?.ok) throw new Error(`transfer list HTTP ${response?.status || "error"}`);
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || typeof payload.result === "string" || payload.message === "NOTOK") {
    throw new Error("transfer list returned an unexpected payload");
  }
  return payload;
}

async function readPagedItems(http, firstUrl, windowStartMs, itemsOf) {
  const items = [];
  let url = firstUrl;
  for (let page = 0; page < 4 && url; page += 1) {
    const payload = await fetchJson(http, url);
    const batch = itemsOf(payload);
    if (!Array.isArray(batch)) throw new Error("transfer list returned an unexpected payload");
    items.push(...batch);
    const next = payload.next_page_params;
    if (!next || typeof next !== "object") break;
    const times = batch.map((item) => parseTimeMs(item?.timestamp ?? item?.timeStamp)).filter((ms) => ms != null);
    if (times.length && Math.max(...times) < windowStartMs) break;
    const nextUrl = new URL(url);
    for (const [key, value] of Object.entries(next)) {
      if (value != null && typeof value !== "object") nextUrl.searchParams.set(key, String(value));
    }
    const nextHref = nextUrl.toString();
    if (nextHref === url) break;
    url = nextHref;
  }
  return items;
}

function tokenRow(item, asset, contract, treasury, windowStartMs) {
  const txHash = String(item?.transaction_hash || item?.txHash || item?.hash || "").trim().toLowerCase();
  const to = addressOf(item?.to ?? item?.toAddress ?? item?.to_address);
  const token = addressOf(item?.token?.address || item?.token?.address_hash || item?.tokenAddress || item?.contractAddress || item?.contract_address);
  const value = parseAmount(item?.total?.value ?? item?.value);
  const timestampMs = parseTimeMs(item?.timestamp ?? item?.timeStamp);
  const blockNumber = parseBlock(item?.block_number ?? item?.blockNumber);
  if (!isTxHash(txHash) || to !== treasury || token !== contract || value == null || value <= 0n) return null;
  if (timestampMs == null || timestampMs < windowStartMs) return null;
  return { txHash, asset, value, timestampMs, blockNumber };
}

function nativeRow(item, treasury, windowStartMs) {
  const txHash = String(item?.hash || item?.transaction_hash || item?.txHash || "").trim().toLowerCase();
  const to = addressOf(item?.to ?? item?.toAddress);
  const value = parseAmount(item?.value);
  const timestampMs = parseTimeMs(item?.timestamp ?? item?.timeStamp);
  const blockNumber = parseBlock(item?.block_number ?? item?.blockNumber);
  if (!isTxHash(txHash) || to !== treasury || value == null || value <= 0n || failedStatus(item?.status)) return null;
  if (timestampMs == null || timestampMs < windowStartMs) return null;
  return { txHash, asset: "BNB", value, timestampMs, blockNumber };
}

function blockscoutTokenUrl(treasury, contract) {
  const params = new URLSearchParams({ type: "ERC-20", filter: "to", token: contract });
  return `${BLOCKSCOUT_API}/addresses/${treasury}/token-transfers?${params}`;
}

function blockscoutNativeUrl(treasury) {
  const params = new URLSearchParams({ filter: "to" });
  return `${BLOCKSCOUT_API}/addresses/${treasury}/transactions?${params}`;
}

/**
 * Incoming transfers to one treasury address since `windowStartMs`.
 * Blockscout's address API is preferred. bnbscan.com is the keyless backup.
 */
function assetsFor(orders, tokenContracts) {
  const tokens = [];
  const seen = new Set();
  let wantNative = false;
  for (const ord of orders) {
    const asset = String(ord.asset || "").toUpperCase();
    if (asset === "BNB") {
      wantNative = true;
      continue;
    }
    if (!asset || seen.has(asset)) continue;
    const contract = String(tokenContracts?.[asset] || "").toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(contract)) continue;
    seen.add(asset);
    tokens.push({ asset, contract });
  }
  return { tokens, wantNative };
}

async function listAddressTransfers({ http, treasury, tokenAssets, wantNative, windowStartMs }) {
  const tokens = [];
  let natives = wantNative ? null : [];
  let blockscoutError = null;
  if (tokenAssets.length) {
    try {
      for (const asset of tokenAssets) {
        const items = await readPagedItems(http, blockscoutTokenUrl(treasury, asset.contract), windowStartMs, (payload) => payload.items);
        for (const item of items) {
          const row = tokenRow(item, asset.asset, asset.contract, treasury, windowStartMs);
          if (row) tokens.push(row);
        }
      }
    } catch (err) {
      blockscoutError = err;
      tokens.length = 0;
    }
  }
  if (wantNative) {
    try {
      const items = await readPagedItems(http, blockscoutNativeUrl(treasury), windowStartMs, (payload) => payload.items);
      natives = [];
      for (const item of items) {
        const row = nativeRow(item, treasury, windowStartMs);
        if (row) natives.push(row);
      }
    } catch (err) {
      blockscoutError = blockscoutError || err;
      natives = null;
    }
  }
  if ((tokenAssets.length && blockscoutError && tokens.length === 0) || natives == null) {
    const payload = await fetchJson(http, `${BNBSCAN_API}/addresses/${treasury}`);
    if (tokenAssets.length && tokens.length === 0) {
      if (!Array.isArray(payload.tokenTransfers)) throw new Error("transfer list returned an unexpected payload");
      for (const asset of tokenAssets) {
        for (const item of payload.tokenTransfers) {
          const row = tokenRow(item, asset.asset, asset.contract, treasury, windowStartMs);
          if (row) tokens.push(row);
        }
      }
    }
    if (natives == null) {
      if (!Array.isArray(payload.transactions)) throw new Error("transfer list returned an unexpected payload");
      natives = [];
      for (const item of payload.transactions) {
        const row = nativeRow(item, treasury, windowStartMs);
        if (row) natives.push(row);
      }
    }
  }
  return [...tokens, ...(natives || [])];
}

async function readBlockTimestampMs(rpc, blockNumber, cache) {
  const key = blockNumber.toString();
  if (cache.has(key)) return cache.get(key);
  const block = await rpc("eth_getBlockByNumber", [hexBlock(blockNumber), false]);
  let timestampMs = null;
  try {
    if (block?.timestamp != null) timestampMs = Number(BigInt(block.timestamp)) * 1000;
  } catch {
    timestampMs = null;
  }
  cache.set(key, timestampMs);
  return timestampMs;
}

async function findWindowStartBlock(rpc, latestBlock, windowStartMs, cache) {
  const latestTs = await readBlockTimestampMs(rpc, latestBlock, cache);
  if (latestTs == null) throw new Error("latest block timestamp unavailable");
  if (latestTs <= windowStartMs) return latestBlock;
  const sampleGap = latestBlock > 40n ? 40n : latestBlock;
  const sampleTs = sampleGap > 0n ? await readBlockTimestampMs(rpc, latestBlock - sampleGap, cache) : latestTs;
  let lookback = 4_000n;
  if (sampleTs != null && latestTs > sampleTs && sampleGap > 0n) {
    const msPerBlock = (latestTs - sampleTs) / Number(sampleGap);
    if (msPerBlock > 0) {
      const need = Math.ceil((latestTs - windowStartMs) / msPerBlock) + 8;
      lookback = BigInt(Math.min(Number(MAX_LOOKBACK_BLOCKS), Math.max(1, need)));
    }
  }
  let lo = latestBlock > lookback ? latestBlock - lookback : 0n;
  for (let i = 0; i < 6 && lo > 0n; i += 1) {
    const loTs = await readBlockTimestampMs(rpc, lo, cache);
    if (loTs == null || loTs <= windowStartMs) break;
    const span = latestBlock - lo || lookback;
    const next = lo > span ? lo - span : 0n;
    if (latestBlock - next > MAX_LOOKBACK_BLOCKS || next === lo) break;
    lo = next;
  }
  let left = lo;
  let right = latestBlock;
  while (left < right) {
    const mid = (left + right) / 2n;
    const ts = await readBlockTimestampMs(rpc, mid, cache);
    if (ts == null || ts < windowStartMs) left = mid + 1n;
    else right = mid;
  }
  return left;
}

async function requestTreasuryLogs(rpc, treasury, contract, fromBlock, toBlock) {
  const logs = await rpc("eth_getLogs", [{
    fromBlock: hexBlock(fromBlock),
    toBlock: hexBlock(toBlock),
    address: contract,
    topics: [ERC20_TRANSFER_TOPIC, null, padTopicAddress(treasury)],
  }]);
  if (logs == null) return [];
  if (!Array.isArray(logs)) throw new Error("eth_getLogs returned no log list");
  return logs;
}

async function treasuryLogs(rpc, treasury, contract, fromBlock, toBlock, depth = 0) {
  try {
    return await requestTreasuryLogs(rpc, treasury, contract, fromBlock, toBlock);
  } catch (err) {
    if (!isLimitError(err) || fromBlock >= toBlock || depth > 24) throw err;
    const mid = (fromBlock + toBlock) / 2n;
    if (mid <= fromBlock || mid >= toBlock) throw err;
    const left = await treasuryLogs(rpc, treasury, contract, fromBlock, mid, depth + 1);
    const right = await treasuryLogs(rpc, treasury, contract, mid + 1n, toBlock, depth + 1);
    return left.concat(right);
  }
}

function rpcLogRow(log, asset, contract, treasury) {
  const txHash = String(log?.transactionHash || "").trim().toLowerCase();
  if (String(log?.address || "").toLowerCase() !== contract) return null;
  const topics = Array.isArray(log?.topics) ? log.topics : [];
  if (String(topics[0] || "").toLowerCase() !== ERC20_TRANSFER_TOPIC) return null;
  if (extractTopicAddress(topics[2]) !== treasury) return null;
  const value = parseAmount(log?.data);
  const blockNumber = parseBlock(log?.blockNumber);
  if (!isTxHash(txHash) || value == null || value <= 0n || blockNumber == null) return null;
  return { txHash, asset, value, blockNumber, timestampMs: null };
}

/**
 * Watches transfers to the treasury address from the last 15 minutes and matches them to open checkouts.
 * The list is the treasury's own token transfers, never an unfiltered scan of a payment-token contract.
 */
export function createTreasuryWatcher({ store, config, rpc, fetchImpl, onOrderPaid, now = () => new Date(), log = console.warn }) {
  let busy = false;
  let timer = null;


  async function scanBinanceWindow(pendingOrders, nowMs, beginMs) {
    const transfers = await listBinanceTreasuryTransfers({ config, fetchImpl, nowMs, beginMs });
    let latestBlock = null;
    let matched = 0;
    const minConf = Number(config.minConfirmations || REQUIRED_CONFIRMATIONS);
    for (const transfer of transfers) {
      const used = store.findByPaymentTx(transfer.txHash);
      if (used) {
        const tenant = typeof store.get === "function" ? store.get(used.id) : null;
        const retryable = tenant && (tenant.status === "error" || tenant.status === "provisioning");
        if (!retryable) continue;
      }
      const exact = pendingOrders.find((ord) => {
        if (ord.asset !== transfer.asset || BigInt(ord.amount_wei) !== transfer.amountWei) return false;
        if (ord.status === "pending") return true;
        return ord.status === "expired" && String(ord.payment_tx || "").toLowerCase() === transfer.txHash;
      });
      if (!exact) continue;
      const createdMs = Date.parse(exact.created_at || "");
      const expiresMs = Date.parse(exact.expires_at || "");
      if (Number.isFinite(createdMs) && transfer.txTime < createdMs) continue;
      if (Number.isFinite(expiresMs) && transfer.txTime > expiresMs) continue;
      if (latestBlock == null) {
        const height = await binanceWalletGet(
          "/api/v1/dex/pre-transaction/block-height",
          { binanceChainId: "56" },
          binanceCredentials(config),
          fetchImpl,
        );
        latestBlock = BigInt(height?.blockHeight);
      }
      const detailData = await binanceWalletGet(
        "/api/v1/dex/post-transaction/transaction-detail-by-txhash",
        { binanceChainId: "56", txHash: transfer.txHash },
        binanceCredentials(config),
        fetchImpl,
      );
      const detail = (Array.isArray(detailData) ? detailData : []).find((row) => sameAddress(row?.txhash || row?.txHash, transfer.txHash)) || detailData?.[0];
      let confirmations = 0;
      try {
        confirmations = confirmationsBetween(latestBlock, BigInt(detail?.height));
      } catch {
        confirmations = 0;
      }
      if (confirmations < minConf || String(detail?.txStatus || transfer.status).toLowerCase() !== "success") {
        if (typeof store.updateOrder === "function") {
          const updated = store.updateOrder(exact.id, {
            payment_tx: transfer.txHash,
            confirmations,
            updated_at: now().toISOString(),
          });
          if (updated) {
            exact.payment_tx = updated.payment_tx;
            exact.confirmations = updated.confirmations;
          }
        }
        continue;
      }
      if (typeof store.updateOrder === "function") {
        const noted = store.updateOrder(exact.id, {
          payment_tx: transfer.txHash,
          confirmations,
          updated_at: now().toISOString(),
        });
        if (noted) {
          exact.payment_tx = noted.payment_tx;
          exact.confirmations = noted.confirmations;
        }
      }
      try {
        await onOrderPaid(exact.id, transfer.txHash);
        exact.status = "paid";
        matched += 1;
      } catch (err) {
        const status = Number(err?.status) || 500;
        if (status < 500) throw err;
        console.warn(`treasury watcher: ${err instanceof Error ? err.message : "could not provision this payment yet"}`);
      }
    }
    return { matched };
  }

  function openOrders(nowMs) {
    return store.listOrders().filter((ord) => {
      if (ord.host_id !== config.hostId) return false;
      const expiresMs = Date.parse(ord.expires_at || "");
      if (!Number.isFinite(expiresMs)) return false;
      if (ord.status === "expired") {
        return Boolean(ord.payment_tx) && expiresMs + CHECKOUT_PROVISION_RETRY_MS > nowMs;
      }
      if (ord.status !== "pending") return false;
      if (expiresMs + CHECKOUT_SETTLEMENT_GRACE_MS > nowMs) return true;
      return Boolean(ord.payment_tx) && expiresMs + CHECKOUT_PROVISION_RETRY_MS > nowMs;
    });
  }

  async function settleListed(pendingOrders, rows, windowStartMs, warnOnce) {
    const grouped = new Map();
    for (const row of rows) {
      if (row.timestampMs != null && row.timestampMs < windowStartMs) continue;
      rememberTransfer(grouped, row);
    }
    if (grouped.size === 0 || !rpc) return 0;
    const latestHex = await rpc("eth_blockNumber", []);
    if (!latestHex) return 0;
    const latestBlock = BigInt(latestHex);
    const minConf = Number(config.minConfirmations || REQUIRED_CONFIRMATIONS);
    let matched = 0;
    for (const cand of grouped.values()) {
      if (store.findByPaymentTx?.(cand.txHash)) continue;
      const exact = pendingOrders.find(
        (ord) => ord.status === "pending" && ord.asset === cand.asset && BigInt(ord.amount_wei) === cand.value,
      );
      if (!exact || !quoteCovers(exact, cand.timestampMs)) continue;
      const confirmations = cand.blockNumber != null
        ? confirmationsBetween(latestBlock, cand.blockNumber)
        : await readConfirmationCount(rpc, cand.txHash);
      if (confirmations == null) continue;
      if (confirmations < minConf) {
        if (typeof store.updateOrder === "function") {
          const updated = store.updateOrder(exact.id, {
            payment_tx: cand.txHash,
            confirmations,
            updated_at: now().toISOString(),
          });
          if (updated) {
            exact.payment_tx = updated.payment_tx;
            exact.confirmations = updated.confirmations;
          }
        }
        continue;
      }
      try {
        await onOrderPaid(exact.id, cand.txHash);
        exact.status = "paid";
        matched += 1;
      } catch (err) {
        const status = Number(err?.status) || 0;
        if (!status || status >= 500) warnOnce(err);
      }
    }
    return matched;
  }

  async function listRpcTransfers(pendingOrders, windowStartMs) {
    const treasury = assertAddress(config.treasuryAddress, "SAAS_TREASURY_ADDRESS");
    const { tokens, wantNative } = assetsFor(pendingOrders, config.tokenContracts);
    const latestHex = await rpc("eth_blockNumber", []);
    if (!latestHex) return [];
    const latestBlock = BigInt(latestHex);
    const cache = new Map();
    const fromBlock = await findWindowStartBlock(rpc, latestBlock, windowStartMs, cache);
    const rows = [];
    for (const asset of tokens) {
      const logs = await treasuryLogs(rpc, treasury, asset.contract, fromBlock, latestBlock);
      for (const log of logs) {
        const row = rpcLogRow(log, asset.asset, asset.contract, treasury);
        if (!row) continue;
        const timestampMs = await readBlockTimestampMs(rpc, row.blockNumber, cache);
        if (timestampMs != null && timestampMs < windowStartMs) continue;
        rows.push({ ...row, timestampMs });
      }
    }
    if (wantNative) {
      for (let blockNumber = fromBlock; blockNumber <= latestBlock; blockNumber += 1n) {
        const block = await rpc("eth_getBlockByNumber", [hexBlock(blockNumber), true]);
        let timestampMs = null;
        try {
          if (block?.timestamp != null) timestampMs = Number(BigInt(block.timestamp)) * 1000;
        } catch {
          timestampMs = null;
        }
        if (timestampMs != null && timestampMs < windowStartMs) continue;
        const txs = Array.isArray(block?.transactions) ? block.transactions : [];
        for (const tx of txs) {
          if (String(tx?.to || "").toLowerCase() !== treasury) continue;
          const value = parseAmount(tx?.value);
          const txHash = String(tx?.hash || "").trim().toLowerCase();
          if (!isTxHash(txHash) || value == null || value <= 0n) continue;
          rows.push({ txHash, asset: "BNB", value, blockNumber, timestampMs });
        }
      }
    }
    return rows;
  }



  async function scanOnce() {
    if (busy || !config.treasuryAddress) return { matched: 0 };
    const creds = binanceCredentials(config);
    if (!creds && !rpc) return { matched: 0 };
    busy = true;
    let warned = false;
    const warnOnce = (err) => {
      if (warned) return;
      warned = true;
      log(`treasury watcher scan failed: ${shortFailure(err)}`);
    };
    try {
      const nowMs = now().getTime();
      const windowStartMs = nowMs - CHECKOUT_SETTLEMENT_GRACE_MS;
      const pendingOrders = openOrders(nowMs);
      if (pendingOrders.length === 0) return { matched: 0 };

      if (creds) {
        try {
          const oldest = pendingOrders.reduce((min, ord) => {
            const createdMs = Date.parse(ord.created_at || "");
            return Number.isFinite(createdMs) ? Math.min(min, createdMs) : min;
          }, nowMs);
          const beginMs = Math.max(nowMs - CHECKOUT_PROVISION_RETRY_MS, oldest - 5_000);
          return await scanBinanceWindow(pendingOrders, nowMs, beginMs);
        } catch (err) {
          if (err?.name === "AssertionError") throw err;
          log(`treasury watcher: ${err instanceof Error ? err.message : "wallet history failed"}`);
          return { matched: 0 };
        }
      }

      const http = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
      let listed = null;
      let listError = null;
      if (typeof http === "function") {
        try {
          const treasury = assertAddress(config.treasuryAddress, "SAAS_TREASURY_ADDRESS");
          const { tokens, wantNative } = assetsFor(pendingOrders, config.tokenContracts);
          listed = tokens.length || wantNative
            ? await listAddressTransfers({ http, treasury, tokenAssets: tokens, wantNative, windowStartMs })
            : [];
        } catch (err) {
          if (err?.name === "AssertionError") throw err;
          listError = err;
          listed = null;
        }
      }
      if (listed && rpc) {
        try {
          return { matched: await settleListed(pendingOrders, listed, windowStartMs, warnOnce) };
        } catch (err) {
          if (err?.name === "AssertionError") throw err;
          listError = err;
        }
      }

      if (rpc) {
        try {
          const rows = await listRpcTransfers(pendingOrders, windowStartMs);
          return { matched: await settleListed(pendingOrders, rows, windowStartMs, warnOnce) };
        } catch (err) {
          if (err?.name === "AssertionError") throw err;
          warnOnce(err);
          return { matched: 0 };
        }
      }

      warnOnce(listError || new Error("transfer list unavailable"));
      return { matched: 0 };
    } catch (err) {
      if (err?.name === "AssertionError") throw err;
      warnOnce(err);
      return { matched: 0 };
    } finally {
      busy = false;
    }
  }


  return {
    scanOnce,
    start(intervalMs = 15_000) {
      if (timer) return;
      timer = setInterval(() => {
        scanOnce().catch((err) => {
          log(`treasury watcher scan failed: ${shortFailure(err)}`);
        });
      }, Math.max(2_000, intervalMs));
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
