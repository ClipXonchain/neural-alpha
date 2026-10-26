import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

const SIG_RE = /^0x[0-9a-fA-F]{130}$/;

export function restoreMessage(paymentTx: string) {
  return `Neural Alpha\n${paymentTx.trim().toLowerCase()}`;
}

function personalHash(message: string) {
  const bytes = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\u0019Ethereum Signed Message:\n${bytes.length}`);
  const joined = new Uint8Array(prefix.length + bytes.length);
  joined.set(prefix, 0);
  joined.set(bytes, prefix.length);
  return keccak_256(joined);
}

/** Address that signed `message` with an Ethereum personal_sign signature. */
export function recoverAddress(message: string, signature: string) {
  if (!SIG_RE.test(signature)) throw new Error("signature is not a 65-byte hex value");
  const raw = signature.slice(2);
  let v = Number.parseInt(raw.slice(128, 130), 16);
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error("signature recovery id is invalid");
  const sig = secp256k1.Signature.fromCompact(raw.slice(0, 128)).addRecoveryBit(v);
  const pub = sig.recoverPublicKey(personalHash(message)).toRawBytes(false);
  const body = pub[0] === 4 ? pub.subarray(1) : pub;
  const addr = keccak_256(body).subarray(-20);
  return `0x${Buffer.from(addr).toString("hex")}`;
}
