import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getSession } from "@/lib/session";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export async function GET(req: Request) {
  const limited = rateLimit(`nonce:${clientIp(req)}`, {
    limit: 30,
    windowMs: 60_000,
  });
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many nonce requests" },
      {
        status: 429,
        headers: { "Retry-After": String(limited.retryAfterSec) },
      }
    );
  }

  const nonce = randomBytes(16).toString("hex");
  const session = await getSession();
  (session as { nonce?: string }).nonce = nonce;
  await session.save();
  return NextResponse.json({ nonce });
}
