import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function resolveTwakInvocation(): { file: string; prefixArgs: string[]; cwd?: string } {
  if (process.env.TWAK_CLI) {
    return { file: process.env.TWAK_CLI, prefixArgs: [] };
  }

  const appData = process.env.APPDATA;
  if (appData) {
    const npmDir = join(appData, "npm");
    const cliJs = join(npmDir, "node_modules", "@trustwallet", "cli", "dist", "index.js");
    if (existsSync(cliJs)) {
      return { file: process.execPath, prefixArgs: [cliJs] };
    }
    const twakCmd = join(npmDir, "twak.cmd");
    if (existsSync(twakCmd)) {
      // twak.cmd must run with cwd = npm dir (Node spawn EINVAL on .cmd; PATH breaks without cwd).
      return {
        file: process.env.ComSpec || "cmd.exe",
        prefixArgs: ["/d", "/s", "/c", "twak.cmd"],
        cwd: npmDir,
      };
    }
  }

  const mcpCmd = process.env.TWAK_MCP_COMMAND;
  return { file: mcpCmd || "twak", prefixArgs: [] };
}

/** Query ERC-20 balance via `twak balance` CLI (reliable; MCP token_balance can leak native BNB). */
export async function getTokenBalanceViaCli(
  chain: string,
  walletAddress: string,
  tokenAddress: string,
  symbol: string
): Promise<{ amount: number; valueUsd?: number; symbol: string } | null> {
  const balanceArgs = [
    "balance",
    "--chain", chain,
    "--address", walletAddress,
    "--token", tokenAddress,
    "--json",
  ];

  try {
    const { file, prefixArgs, cwd } = resolveTwakInvocation();
    const { stdout } = await execFileAsync(file, [...prefixArgs, ...balanceArgs], {
      timeout: 20_000,
      windowsHide: true,
      ...(cwd ? { cwd } : {}),
    });

    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if (parsed.error) return null;

    const respSym = String(parsed.symbol ?? "").toUpperCase();
    if (respSym && respSym !== symbol.toUpperCase()) return null;

    const amount = Number(parsed.available ?? parsed.total);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    const valueUsd = Number(parsed.totalUsd ?? parsed.availableUsd);
    return {
      symbol: symbol.toUpperCase(),
      amount,
      ...(Number.isFinite(valueUsd) && valueUsd > 0 ? { valueUsd } : {}),
    };
  } catch {
    return null;
  }
}
