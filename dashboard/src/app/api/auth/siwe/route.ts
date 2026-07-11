import { NextRequest, NextResponse } from "next/server";
import { getAddress } from "viem";
import { SiweMessage } from "siwe";
import { getSession } from "@/lib/session";
import { upsertUser } from "@/lib/platform-registry";
import { getServerEnv } from "@/lib/server-env";
import { clientIp, rateLimit } from "@/lib/rate-limit";

/** SIWE domain is host[:port] only — strip scheme / path / inline comments. */
function normalizeSiweDomain(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  let v = raw.trim();
  const hash = v.indexOf("#");
  if (hash >= 0) v = v.slice(0, hash).trim();
  if (!v) return undefined;
  v = v.replace(/^https?:\/\//i, "");
  v = v.split("/")[0]?.trim() || "";
  return v || undefined;
}

/** Comma/space-separated allowlist, e.g. `localhost:3000,agents.clipx.app`. */
function parseSiweDomainAllowlist(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,;\s]+/)) {
    const d = normalizeSiweDomain(part);
    if (!d) continue;
    const key = d.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

function formatSiweError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (err && typeof err === "object") {
    const o = err as {
      error?: { type?: string; expected?: string; received?: string };
      type?: string;
      expected?: string;
      received?: string;
      message?: string;
    };
    const nested = o.error;
    const type = nested?.type || o.type || o.message;
    if (type) {
      const expected = nested?.expected ?? o.expected;
      const received = nested?.received ?? o.received;
      if (expected != null && received != null) {
        return `${type} (expected ${expected}, got ${received})`;
      }
      return String(type);
    }
  }
  const s = String(err);
  return s === "[object Object]" ? "SIWE verification failed" : s;
}

/**
 * Prefer the domain inside the signed message when it is allowlisted.
 */
function resolveVerifyDomain(
  messageDomain: string | undefined,
  allowlist: string[],
  requestHost: string | null
): { domain: string; error?: string } {
  const msgDomain = normalizeSiweDomain(messageDomain);
  const host = normalizeSiweDomain(requestHost);
  const allowed = new Set(allowlist.map((d) => d.toLowerCase()));

  if (allowlist.length > 0) {
    if (msgDomain && allowed.has(msgDomain.toLowerCase())) {
      return { domain: msgDomain };
    }
    return {
      domain: allowlist[0],
      error: `Domain not allowed for SIWE (got ${msgDomain || "unknown"}; allowed: ${allowlist.join(", ")})`,
    };
  }

  // Dev fallback when SIWE_DOMAIN unset
  return { domain: msgDomain || host || "localhost:3000" };
}

export async function POST(req: NextRequest) {
  try {
    const limited = rateLimit(`siwe:${clientIp(req)}`, {
      limit: 20,
      windowMs: 60_000,
    });
    if (!limited.ok) {
      return NextResponse.json(
        { error: "Too many login attempts" },
        {
          status: 429,
          headers: { "Retry-After": String(limited.retryAfterSec) },
        }
      );
    }

    const body = (await req.json()) as {
      message: string;
      signature: string;
    };
    if (!body.message || !body.signature) {
      return NextResponse.json(
        { error: "message and signature required" },
        { status: 400 }
      );
    }

    const session = await getSession();
    const expectedNonce = (session as { nonce?: string }).nonce;
    if (!expectedNonce) {
      return NextResponse.json(
        { error: "Login session expired. Refresh and try again." },
        { status: 400 }
      );
    }

    const siwe = new SiweMessage(body.message);

    try {
      siwe.address = getAddress(siwe.address);
    } catch {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }

    const allowlist = parseSiweDomainAllowlist(getServerEnv("SIWE_DOMAIN"));
    if (process.env.NODE_ENV === "production" && allowlist.length === 0) {
      return NextResponse.json(
        { error: "SIWE_DOMAIN must be set in production" },
        { status: 500 }
      );
    }

    const resolved = resolveVerifyDomain(
      siwe.domain,
      allowlist,
      req.headers.get("host")
    );
    if (resolved.error) {
      return NextResponse.json({ error: resolved.error }, { status: 400 });
    }

    let result: { success: boolean; error?: unknown };
    try {
      result = await siwe.verify({
        signature: body.signature,
        domain: resolved.domain,
        nonce: expectedNonce,
      });
    } catch (verifyErr) {
      return NextResponse.json(
        { error: formatSiweError(verifyErr) },
        { status: 400 }
      );
    }

    if (!result.success) {
      return NextResponse.json(
        { error: formatSiweError(result) },
        { status: 401 }
      );
    }

    const wallet = siwe.address.toLowerCase();
    session.wallet = wallet;
    session.chainId = siwe.chainId;
    session.isLoggedIn = true;
    delete (session as { nonce?: string }).nonce;
    await session.save();

    try {
      await upsertUser(wallet);
    } catch {
      /* DB optional for login */
    }

    return NextResponse.json({ ok: true, wallet, chainId: siwe.chainId });
  } catch (err) {
    return NextResponse.json({ error: formatSiweError(err) }, { status: 400 });
  }
}

export async function DELETE() {
  const session = await getSession();
  session.destroy();
  return NextResponse.json({ ok: true });
}

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn || !session.wallet) {
    return NextResponse.json({ loggedIn: false });
  }
  return NextResponse.json({
    loggedIn: true,
    wallet: session.wallet,
    chainId: session.chainId,
  });
}
