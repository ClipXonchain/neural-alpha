/**
 * Node boot hook — fail fast on missing production secrets.
 * Keep this file free of node: / fs imports so Next instrumentation webpack stays clean.
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV !== "production") return;

  const DEV_SESSION_FALLBACK = "dev-only-session-secret-change-me-32chars!!";
  const secret =
    process.env.SESSION_SECRET?.trim() ||
    process.env.NEXTAUTH_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error(
      "SESSION_SECRET (min 32 characters) is required in production"
    );
  }
  if (secret === DEV_SESSION_FALLBACK) {
    throw new Error("SESSION_SECRET must not use the dev default in production");
  }

  const master = process.env.WALLET_MASTER_SECRET?.trim();
  if (!master || master.length < 32) {
    throw new Error(
      "WALLET_MASTER_SECRET (min 32 characters) is required in production"
    );
  }
  if (master === secret) {
    throw new Error(
      "WALLET_MASTER_SECRET must differ from SESSION_SECRET in production"
    );
  }

  const web3Key = process.env.BINANCE_WEB3_API_KEY?.trim();
  const web3Secret = process.env.BINANCE_WEB3_API_SECRET?.trim();
  if (!web3Key || !web3Secret) {
    console.warn(
      "[instrumentation] BINANCE_WEB3_API_KEY/SECRET missing — agent swaps will fail until set"
    );
  }
}
