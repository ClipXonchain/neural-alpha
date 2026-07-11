import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";

export interface SessionData {
  wallet?: string;
  chainId?: number;
  isLoggedIn?: boolean;
}

const DEV_SESSION_FALLBACK = "dev-only-session-secret-change-me-32chars!!";

function resolveSessionPassword(): string {
  const isProd = process.env.NODE_ENV === "production";
  const secret =
    process.env.SESSION_SECRET?.trim() ||
    process.env.NEXTAUTH_SECRET?.trim();

  if (isProd) {
    if (!secret || secret.length < 32) {
      throw new Error(
        "SESSION_SECRET (min 32 characters) is required in production"
      );
    }
    if (secret === DEV_SESSION_FALLBACK) {
      throw new Error("SESSION_SECRET must not use the dev default in production");
    }
    return secret;
  }

  return secret || DEV_SESSION_FALLBACK;
}

/**
 * Edge-safe: only process.env (root .env is hydrated in next.config.ts).
 * Do not import server-env or agent-secrets here: middleware runs on Edge.
 */
export const sessionOptions: SessionOptions = {
  password: resolveSessionPassword(),
  cookieName: "neural_alpha_session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7,
  },
};

export async function getSession() {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionOptions);
}

export async function requireOwnerWallet(): Promise<string> {
  const session = await getSession();
  if (!session.isLoggedIn || !session.wallet) {
    throw new Error("Unauthorized: connect wallet first");
  }
  return session.wallet.toLowerCase();
}
