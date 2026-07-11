import { NextRequest, NextResponse } from "next/server";

import { requireOwnerWallet } from "@/lib/session";

import { exportAgentWalletBackup } from "@/lib/platform-registry";



type Ctx = { params: Promise<{ id: string }> };



/**

 * Owner-only: reveal the trading wallet private key for this agent.

 * Requires confirm=true in the body to avoid accidental clicks.

 */

export async function POST(req: NextRequest, ctx: Ctx) {

  try {

    const { id } = await ctx.params;

    const wallet = await requireOwnerWallet();

    const body = (await req.json().catch(() => ({}))) as { confirm?: boolean };

    if (!body.confirm) {

      return NextResponse.json(

        { error: "Set confirm: true to export the wallet private key" },

        { status: 400 }

      );

    }



    const backup = await exportAgentWalletBackup(id, wallet);

    return NextResponse.json({

      ok: true,

      address: backup.address,

      privateKey: backup.privateKey,

      warning:

        "Anyone with this private key can move funds from the trading wallet. Store it offline and never share it.",

    });

  } catch (err) {

    const msg = String(err);

    const status = /Unauthorized/i.test(msg)

      ? 401

      : /Forbidden/i.test(msg)

        ? 403

        : 400;

    return NextResponse.json({ error: msg }, { status });

  }

}

