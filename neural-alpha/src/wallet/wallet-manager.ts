import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Chain,
  type PublicClient,
  type WalletClient,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { logger } from "../utils/logger.js";
import {
  createEncryptedKeystore,
  defaultKeystorePath,
  keystoreExists,
  loadKeystore,
  saveKeystore,
  unlockKeystore,
  type UnlockedWallet,
} from "./keystore.js";
import { deriveUnlockPassword, getAgentId } from "./secrets.js";

export interface AgentWalletHandle {
  agentId: string;
  address: `0x${string}`;
  account: Account;
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account>;
}

let _handle: AgentWalletHandle | null = null;

function resolveRpcUrl(): string {
  return (
    process.env.BSC_RPC_URL?.trim() ||
    process.env.RPC_URL?.trim() ||
    "https://bsc-dataseed.binance.org"
  );
}

/**
 * Load or create the agent trading wallet.
 * - If keystore exists: unlock with derived password
 * - If AGENT_PRIVATE_KEY set: use that (dev/import only)
 * - Else: generate new mnemonic + encrypted keystore
 */
export async function initAgentWallet(
  agentId: string = getAgentId()
): Promise<AgentWalletHandle> {
  if (_handle && _handle.agentId === agentId) return _handle;

  const password = deriveUnlockPassword(agentId);
  const path = process.env.AGENT_KEYSTORE_PATH?.trim() || defaultKeystorePath(agentId);

  let unlocked: UnlockedWallet;

  const envKey = process.env.AGENT_PRIVATE_KEY?.trim();
  if (envKey && process.env.NODE_ENV === "production") {
    throw new Error(
      "AGENT_PRIVATE_KEY is forbidden in production — use encrypted keystore"
    );
  }
  if (envKey) {
    const pk = (envKey.startsWith("0x") ? envKey : `0x${envKey}`) as `0x${string}`;
    const account = privateKeyToAccount(pk);
    unlocked = { address: account.address, privateKey: pk };
    logger.info("Agent wallet loaded from AGENT_PRIVATE_KEY", {
      agentId,
      address: account.address,
    });
  } else if (keystoreExists(path)) {
    const keystore = loadKeystore(path);
    unlocked = unlockKeystore(keystore, password);
    logger.info("Agent wallet unlocked from keystore", {
      agentId,
      address: unlocked.address,
      path,
    });
  } else {
    const { keystore, wallet } = createEncryptedKeystore(password);
    saveKeystore(path, keystore);
    unlocked = wallet;
    logger.info("Agent wallet created and encrypted", {
      agentId,
      address: unlocked.address,
      path,
    });
  }

  const account = privateKeyToAccount(unlocked.privateKey);
  const transport = http(resolveRpcUrl());
  const publicClient = createPublicClient({ chain: bsc, transport });
  const walletClient = createWalletClient({
    account,
    chain: bsc,
    transport,
  });

  _handle = {
    agentId,
    address: account.address,
    account,
    publicClient,
    walletClient,
  };

  // Never leave mnemonic/private key in env logs
  if (!process.env.AGENT_WALLET_ADDRESS) {
    process.env.AGENT_WALLET_ADDRESS = account.address;
  }

  return _handle;
}

export function getAgentWallet(): AgentWalletHandle {
  if (!_handle) {
    throw new Error("Agent wallet not initialized — call initAgentWallet() first");
  }
  return _handle;
}

export function tryGetAgentWallet(): AgentWalletHandle | null {
  return _handle;
}

export async function getWalletAddress(): Promise<`0x${string}` | null> {
  if (_handle) return _handle.address;
  const env = process.env.AGENT_WALLET_ADDRESS?.trim();
  if (env && /^0x[a-fA-F0-9]{40}$/.test(env)) return env as `0x${string}`;
  return null;
}
