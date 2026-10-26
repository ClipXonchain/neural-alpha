import { NextResponse } from "next/server";
import { control } from "@/lib/portal-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const upstream = await control("/pricing");
    return NextResponse.json(upstream.data, {
      status: upstream.status,
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "pricing unavailable" }, { status: 503 });
  }
}
