const DECIMALS_SELECTOR = "0x313ce567";

const decimalsCache = new Map<string, number>();

function rpcEndpoints(): string[] {
  const fromEnv = process.env.BSC_RPC_URLS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (fromEnv?.length) return fromEnv;
  const single = process.env.BSC_RPC_URL?.trim();
  if (single) return [single];
  return [
    "https://bsc-dataseed.binance.org/",
    "https://bsc-dataseed1.binance.org/",
    "https://bsc-dataseed2.binance.org/",
  ];
}

/** Convert ERC-20 base units to human-readable amount without float precision loss. */
export function tokenAmountFromRaw(raw: bigint, decimals: number): number {
  if (decimals <= 0) return Number(raw);
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = raw % base;
  if (frac === 0n) return Number(whole);
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return parseFloat(`${whole}.${fracStr}`);
}

export async function getTokenDecimals(contractAddress: string): Promise<number> {
  const key = contractAddress.toLowerCase();

  const cached = decimalsCache.get(key);
  if (cached !== undefined) return cached;

  for (const url of rpcEndpoints()) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: contractAddress, data: DECIMALS_SELECTOR }, "latest"],
        }),
      });
      const json = (await res.json()) as { result?: string };
      const dec = parseInt(json.result ?? "0x12", 16);
      const value = Number.isFinite(dec) && dec >= 0 && dec <= 36 ? dec : 18;
      decimalsCache.set(key, value);
      return value;
    } catch {
      continue;
    }
  }

  decimalsCache.set(key, 18);
  return 18;
}

export async function preloadDecimals(contracts: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  await Promise.all(
    [...new Set(contracts.map((c) => c.toLowerCase()))].map(async (c) => {
      map.set(c, await getTokenDecimals(c));
    })
  );
  return map;
}
