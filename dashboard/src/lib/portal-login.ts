import { createHmac, timingSafeEqual } from "node:crypto";

export const CHALLENGE_COOKIE = "na_challenge";
export const PROOF_COOKIE = "na_wallet";

export type ChallengePurpose = "login" | "payment";

export type Challenge = {
  purpose: ChallengePurpose;
  nonce: string;
  exp: number;
  paymentTx?: string;
};

export function packCookie(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function unpackCookie<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function loginMessage(input: Challenge) {
  const lines = [
    "Neural Alpha",
    input.purpose === "payment"
      ? "Confirm the fee transaction from this wallet."
      : "Open the agent paid by this wallet.",
    `Nonce: ${input.nonce}`,
    `Expires: ${new Date(input.exp).toISOString()}`,
  ];
  if (input.purpose === "payment" && input.paymentTx) lines.push(`Transaction: ${input.paymentTx}`);
  return lines.join("\n");
}

export function readChallenge(raw: string | undefined, now = Date.now()): Challenge | null {
  const parsed = unpackCookie<Challenge>(raw);
  if (!parsed) return null;
  if (parsed.purpose !== "login" && parsed.purpose !== "payment") return null;
  if (!/^[a-f0-9]{32}$/.test(parsed.nonce || "")) return null;
  if (!Number.isFinite(parsed.exp) || parsed.exp < now) return null;
  if (parsed.purpose === "payment" && !/^0x[a-f0-9]{64}$/.test(parsed.paymentTx || "")) return null;
  return parsed;
}

export function sealPayer(payer: string, secret: string, exp = Date.now() + 10 * 60 * 1000) {
  const body = `${payer}.${exp}`;
  const mac = createHmac("sha256", secret).update(body).digest("hex");
  return `${body}.${mac}`;
}

export function openPayer(raw: string | undefined, secret: string, now = Date.now()) {
  const parts = String(raw || "").split(".");
  if (parts.length !== 3) return null;
  const [payer, expRaw, mac] = parts;
  if (!/^0x[a-f0-9]{40}$/.test(payer)) return null;
  if (!/^\d+$/.test(expRaw) || Number(expRaw) < now) return null;
  if (!/^[a-f0-9]{64}$/.test(mac)) return null;
  const expected = createHmac("sha256", secret).update(`${payer}.${expRaw}`).digest("hex");
  const left = Buffer.from(mac, "hex");
  const right = Buffer.from(expected, "hex");
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  return payer;
}
