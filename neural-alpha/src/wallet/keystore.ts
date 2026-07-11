import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import { privateKeyToAccount } from "viem/accounts";
import { createHash } from "node:crypto";

const BSC_PATH = "m/44'/60'/0'/0/0";
const KEYSTORE_VERSION = 1;

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export interface EncryptedKeystore {
  version: number;
  address: string;
  crypto: {
    cipher: "aes-256-gcm";
    ciphertext: string;
    iv: string;
    tag: string;
    kdf: "scrypt";
    salt: string;
  };
  createdAt: string;
}

export interface UnlockedWallet {
  address: `0x${string}`;
  privateKey: `0x${string}`;
  mnemonic?: string;
}

function encryptMnemonic(mnemonic: string, password: string): EncryptedKeystore["crypto"] {
  const salt = randomBytes(32);
  const key = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(mnemonic, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    cipher: "aes-256-gcm",
    ciphertext: encrypted.toString("hex"),
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    kdf: "scrypt",
    salt: salt.toString("hex"),
  };
}

function decryptMnemonic(
  crypto: EncryptedKeystore["crypto"],
  password: string
): string {
  const salt = Buffer.from(crypto.salt, "hex");
  const key = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const iv = Buffer.from(crypto.iv, "hex");
  const tag = Buffer.from(crypto.tag, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(crypto.ciphertext, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

function deriveAccountFromMnemonic(mnemonic: string): UnlockedWallet {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const hd = HDKey.fromMasterSeed(seed);
  const child = hd.derive(BSC_PATH);
  if (!child.privateKey) {
    throw new Error("Failed to derive private key from mnemonic");
  }
  const privateKey = `0x${bytesToHex(child.privateKey)}` as `0x${string}`;
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    privateKey,
    mnemonic,
  };
}

/** Generate a new BIP-39 wallet and return encrypted keystore + unlocked account. */
export function createEncryptedKeystore(password: string): {
  keystore: EncryptedKeystore;
  wallet: UnlockedWallet;
} {
  const mnemonic = bip39.generateMnemonic(wordlist, 128);
  const wallet = deriveAccountFromMnemonic(mnemonic);
  const keystore: EncryptedKeystore = {
    version: KEYSTORE_VERSION,
    address: wallet.address.toLowerCase(),
    crypto: encryptMnemonic(mnemonic, password),
    createdAt: new Date().toISOString(),
  };
  return {
    keystore,
    wallet: {
      address: wallet.address,
      privateKey: wallet.privateKey,
      mnemonic,
    },
  };
}

export function unlockKeystore(
  keystore: EncryptedKeystore,
  password: string
): UnlockedWallet {
  const mnemonic = decryptMnemonic(keystore.crypto, password);
  if (!bip39.validateMnemonic(mnemonic, wordlist)) {
    throw new Error("Invalid mnemonic after decrypt — wrong password?");
  }
  const wallet = deriveAccountFromMnemonic(mnemonic);
  if (wallet.address.toLowerCase() !== keystore.address.toLowerCase()) {
    throw new Error("Keystore address mismatch after unlock");
  }
  // Signing path: do not keep mnemonic in memory by default
  return { address: wallet.address, privateKey: wallet.privateKey };
}

/**
 * Owner backup export — decrypts and returns the BSC account private key.
 * Call only after SIWE owner auth; never log or persist the result.
 */
export function exportPrivateKeyFromKeystore(
  keystore: EncryptedKeystore,
  password: string
): { address: `0x${string}`; privateKey: `0x${string}` } {
  const wallet = unlockKeystore(keystore, password);
  return { address: wallet.address, privateKey: wallet.privateKey };
}

/**
 * Owner backup export — decrypts the BIP-39 seed phrase.
 * Call only after SIWE owner auth; never log or persist the result.
 */
export function exportMnemonicFromKeystore(
  keystore: EncryptedKeystore,
  password: string
): { address: `0x${string}`; mnemonic: string } {
  const mnemonic = decryptMnemonic(keystore.crypto, password);
  if (!bip39.validateMnemonic(mnemonic, wordlist)) {
    throw new Error("Invalid mnemonic after decrypt — wrong password?");
  }
  const wallet = deriveAccountFromMnemonic(mnemonic);
  if (wallet.address.toLowerCase() !== keystore.address.toLowerCase()) {
    throw new Error("Keystore address mismatch after unlock");
  }
  return { address: wallet.address, mnemonic };
}

export function defaultKeystorePath(agentId: string): string {
  const base =
    process.env.AGENT_DATA_DIR?.trim() ||
    join(process.cwd(), "data", "agents");
  return join(base, agentId, "keystore.json");
}

export function saveKeystore(path: string, keystore: EncryptedKeystore): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(keystore, null, 2), { mode: 0o600 });
}

export function loadKeystore(path: string): EncryptedKeystore {
  if (!existsSync(path)) {
    throw new Error(`Keystore not found: ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as EncryptedKeystore;
  if (!raw?.crypto?.ciphertext || !raw.address) {
    throw new Error(`Invalid keystore format: ${path}`);
  }
  return raw;
}

export function keystoreExists(path: string): boolean {
  return existsSync(path);
}

/** Fingerprint for audit logs — never the key itself. */
export function addressFingerprint(address: string): string {
  return createHash("sha256").update(address.toLowerCase()).digest("hex").slice(0, 16);
}
