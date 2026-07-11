import { NextRequest, NextResponse } from "next/server";

import { requireOwnerWallet } from "@/lib/session";

import {

  assertAgentOwner,

  getAgentConfig,

  setAgentConfig,

} from "@/lib/platform-registry";

import {

  maskSecrets,

  SECRET_CONFIG_KEYS,

  validateConfigUpdates,

} from "@/lib/config-allowlist";



type Ctx = { params: Promise<{ id: string }> };



export async function GET(_req: NextRequest, ctx: Ctx) {

  try {

    const { id } = await ctx.params;

    const wallet = await requireOwnerWallet();

    await assertAgentOwner(id, wallet);

    const config = await getAgentConfig(id);

    return NextResponse.json({ config: maskSecrets(config) });

  } catch (err) {

    const msg = String(err);

    const status = /Unauthorized/i.test(msg) ? 401 : /Forbidden/i.test(msg) ? 403 : 400;

    return NextResponse.json({ error: msg }, { status });

  }

}



export async function PATCH(req: NextRequest, ctx: Ctx) {

  try {

    const { id } = await ctx.params;

    const wallet = await requireOwnerWallet();

    await assertAgentOwner(id, wallet);

    const body = (await req.json()) as Record<string, unknown>;

    const validated = validateConfigUpdates(body);

    if (!validated.ok) {

      return NextResponse.json({ error: validated.error }, { status: 400 });

    }



    const { reload } = await setAgentConfig(

      id,

      wallet,

      validated.clean,

      SECRET_CONFIG_KEYS

    );



    const config = await getAgentConfig(id);

    return NextResponse.json({

      ok: true,

      config: maskSecrets(config),

      reload,

    });

  } catch (err) {

    const msg = String(err);

    const status = /Unauthorized/i.test(msg) ? 401 : /Forbidden/i.test(msg) ? 403 : 400;

    return NextResponse.json({ error: msg }, { status });

  }

}

