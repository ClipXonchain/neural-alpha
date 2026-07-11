import { createHash, createHmac, randomBytes, scryptSync } from "node:crypto";

/**
 * Derive a per-agent AES-256 key from the platform master secret + agent id.
 * Never store plaintext mnemonics — only encrypted keystores on disk.
 */
export function getAgentId(): string {
  return process.env.AGENT_ID?.trim() || "default";
}

export function getMasterSecret(): string {
  const secret = process.env.WALLET_MASTER_SECRET?.trim();
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "WALLET_MASTER_SECRET is required in production (must differ from API_SECRET)"
      );
    }
    throw new Error(
      "WALLET_MASTER_SECRET is required to unlock agent keystores"
    );
  }
  if (
    process.env.NODE_ENV === "production" &&
    process.env.API_SECRET?.trim() &&
    secret === process.env.API_SECRET.trim()
  ) {
    throw new Error("WALLET_MASTER_SECRET must differ from API_SECRET");
  }
  return secret;
}

/** 32-byte AES key unique to this agent. */
export function deriveAgentKey(agentId: string = getAgentId()): Buffer {
  const master = getMasterSecret();
  return scryptSync(master, `neural-alpha:wallet:${agentId}`, 32, {
    N: 16384,
    r: 8,
    p: 1,
  });
}

/** Deterministic unlock password for keystore file encryption. */
export function deriveUnlockPassword(agentId: string = getAgentId()): string {
  const master = getMasterSecret();
  return createHmac("sha256", master)
    .update(`unlock:${agentId}`)
    .digest("hex");
}

export function generateApiSecret(): string {
  return randomBytes(32).toString("hex");
}

export function hashApiSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function verifyApiSecret(secret: string, hash: string): boolean {
  return hashApiSecret(secret) === hash;
}
