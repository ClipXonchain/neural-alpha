import { normalizeTokenIconUrl } from "@/lib/utils";

const META_URL =
  "https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/dex/market/token/meta/info/ai";

/** Pinned BSC contracts. BNB uses the wrapped token so Binance returns the BNB mark. */
const ASSETS: { symbol: string; contract: string; accept: string[] }[] = [
  { symbol: "USDT", contract: "0x55d398326f99059ff775485246999027b3197955", accept: ["USDT"] },
  { symbol: "USDC", contract: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", accept: ["USDC"] },
  { symbol: "BNB", contract: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", accept: ["WBNB", "BNB"] },
  { symbol: "U", contract: "0xce24439f2d9c6a2289f741120fe202248b666666", accept: ["U"] },
  { symbol: "USD1", contract: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", accept: ["USD1"] },
];

export type PortalAsset = { symbol: string; name: string; icon: string };

type Upstream = { symbol: string; name: string; upstream: string };

let cache: { at: number; rows: Record<string, Upstream> } | null = null;
const CACHE_MS = 6 * 60 * 60 * 1000;

async function fetchMeta(contract: string): Promise<Upstream | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${META_URL}?chainId=56&contractAddress=${contract}`, {
      headers: {
        clienttype: "web",
        clientversion: "1.2.0",
        "user-agent": "binance-web3/2.0 (NeuralAlpha)",
      },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { code?: string; data?: { symbol?: string; name?: string; icon?: string } };
    if (json.code !== "000000" || !json.data?.symbol) return null;
    const upstream = normalizeTokenIconUrl(json.data.icon);
    if (!upstream || !upstream.startsWith("https://bin.bnbstatic.com/")) return null;
    return {
      symbol: String(json.data.symbol).toUpperCase(),
      name: String(json.data.name || json.data.symbol),
      upstream,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadUpstream() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const found = await Promise.all(
    ASSETS.map(async (asset) => {
      const meta = await fetchMeta(asset.contract);
      if (!meta || !asset.accept.includes(meta.symbol)) return null;
      return [asset.symbol, { ...meta, name: asset.symbol === "BNB" ? "BNB" : meta.name, symbol: asset.symbol }] as const;
    }),
  );
  const rows: Record<string, Upstream> = {};
  for (const row of found) {
    if (row) rows[row[0]] = row[1];
  }
  if (Object.keys(rows).length > 0) cache = { at: Date.now(), rows };
  return rows;
}

export async function portalAssets(): Promise<Record<string, PortalAsset>> {
  const rows = await loadUpstream();
  const assets: Record<string, PortalAsset> = {};
  for (const [symbol, row] of Object.entries(rows)) {
    assets[symbol] = {
      symbol,
      name: row.name,
      icon: `/api/portal/assets/icon/${symbol}`,
    };
  }
  return assets;
}

export async function portalAssetBytes(symbol: string) {
  const rows = await loadUpstream();
  const row = rows[symbol];
  if (!row) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(row.upstream, {
      headers: { "user-agent": "binance-web3/2.0 (NeuralAlpha)" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length < 8) return null;
    const type = body[0] === 0xff && body[1] === 0xd8 ? "image/jpeg" : "image/png";
    return { body, type };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
