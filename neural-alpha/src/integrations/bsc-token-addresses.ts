import { logger } from "../utils/logger.js";

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/i;
const CMC_PRO_BASE = process.env.CMC_PRO_BASE_URL || "https://pro-api.coinmarketcap.com";

/** BEP-20 contract addresses for competition-eligible tokens on BSC mainnet. */
export const BSC_TOKEN_ADDRESSES: Record<string, string> = {
  TWT: "0x4B0F1812e5Df2A09796481Ff14017e6005508003",
  CAKE: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82",
  ETH: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
  XRP: "0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE",
  ADA: "0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47",
  LINK: "0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD",
  DOT: "0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402",
  LTC: "0x4338665CBB7B2485A8855A139b75D5e34AB0DB94",
  BCH: "0x8fF795a6F4D97E7887C79beA79aba5cc76444aDf",
  AVAX: "0x1CE0c2827e2eF14D5C4f29a091d735A204794041",
  DOGE: "0xbA2aE424d960c26247Dd6c32edC70B295c744C43",
  SHIB: "0x2859e4544C4bB03966803b044A93563Bd2D0DD4D",
  UNI: "0xBf5140A22578168FD562DCcF235E5D43A02ce9B1",
  AAVE: "0xfb6115445Bff7b52FeB98650C87f44907E58f802",
  ATOM: "0x0Eb3a705fc54725037CC9e008bDede697f62F335",
  FIL: "0x0D8Ce2A99Bb6e3B7Db580eD848240e4a0F9aE153",
  INJ: "0xa2B726B1145A4773F68593CF171187d8EBe4d495",
  TRX: "0xCE7de646e7208a4Ef112cb6ed5038FA6cC6b12e3",
  ETC: "0x3d6545b08693daE087E957cb1180ee38B9e3c25E",
  FET: "0x031b41e504677879370e9DBcF937283A8691Fa7f",
  FLOKI: "0xfb5B838b6CfEEDC2873ab27866079Ac55363D37E",
  PENDLE: "0xb3Ed0A426155B79B898849803E3B36552f7ED507",
  "1INCH": "0x111111111117dC0aa78b770fA6a738034120C302",
  BONK: "0xA697E272a7514B19E652b5680aF433616935E32B",
  APE: "0x037A37aEf878Fc0Ee86f2eF8aC5c9D3776f4b6a",
  SNX: "0x9Ac983826058b8a9C7Aa1C917144119123A7Ba37",
  DEXE: "0x6e4f9705e7C1F050af6391A565f659468e4B988E",
  BRETT: "0x4D3DC895a9EDb2347a98585A8f44E8E14E7C2865",
  KOGE: "0xe6df05ce8c8301223373cf5b969afcb1498c5528",
  LUNC: "0x156ab3346823b651294766e103a0e46615449ee8",
  PENGU: "0x9e606F4D95aE1344B239409F9701C7C4E5E7f558",
  LDO: "0xF8Bc2914A3D68A7a4BF5268B45B5aA5eF4164fC4",
  SUSHI: "0x947950BcC74888a40Ffa259bC74CC5079690F2E7",
  COMP: "0x52CE071Bd9b1C4B00A0b92D298c512478CaD576e",
  AXS: "0x715D400F88C1674bb183aA2D1651498E75C0E5a2",
  RAY: "0x1367C4C22Ca419bAE618668D6E6943F417fcbe8d",
  // NOTE: ZRO has no verified BEP-20 deployment — the previous entry was the
  // Ethereum LayerZero contract, not a valid BSC swap target. Left unmapped.
  // the executor skips it instead of attempting a wrong-chain swap.
  STG: "0xB0D12492637F3F1aD7535416272550617A0623E2",
  CHEEMS: "0x0df0587216a4a1bb7d5082fdc491d93d2dd4b413",
  BabyDoge: "0xc7486730579aB99ca0e1671640677A7d279f0FcE",
  NILA: "0x5Ea5C597660A2E47b1F8F174eF314FCE1f9d3E7F",

  // ── Binance Alpha BEP-20 tokens (source: alpha.md) ──
  "0G": "0x4b948d64de1f71fcd12fb586f4c776421a35b3ee",
  AB: "0x95034f653d5d161890836ad2b6b8cc49d14e029a",
  APR: "0x299ad4299da5b2b93fba4c96967b040c7f611099",
  ASTER: "0x000ae314e2a2172a039b26378814c252734f556a",
  B: "0x6bdcce4a559076e37755a78ce0c06214e59e4444",
  BANANAS31: "0x3d4f0513e8a29669b960f9dbca61861548a9a760",
  BARD: "0xd23a186a78c0b3b805505e5f8ea4083295ef9f3a",
  BAS: "0x0f0df6cb17ee5e883eddfef9153fc6036bdb4e37",
  BEAT: "0xcf3232b85b43bca90e51d38cc06cc8bb8c8a3e36",
  BILL: "0xdf24f8c21cb404b3031a450d8e049d6e39fc1fa5",
  BSB: "0x595deaad1eb5476ff1e649fdb7efc36f1e4679cc",
  COAI: "0x0a8d6c86e1bce73fe4d0bd531e1a567306836ea5",
  CYS: "0x0c69199c1562233640e0db5ce2c399a88eb507c7",
  EDGE: "0x70f2eadf1ca1969ff42b0c78e9da519e8937cbaf",
  FF: "0xac23b90a79504865d52b49b327328411a23d4db2",
  GENIUS: "0x1f12b85aac097e43aa1555b2881e98a51090e9a6",
  GUA: "0xa5c8e1513b6a08334b479fe4d71f1253259469be",
  GWEI: "0x30117e4bc17d7b044194b76a38365c53b72f7d49",
  H: "0x44f161ae29361e332dea039dfa2f404e0bc5b5cc",
  HOME: "0x4bfaa776991e85e5f8b1255461cbbd216cfc714f",
  HUMA: "0x92516e0ddf1ddbf7fab1b79cac26689fdc5ba8e6",
  IP: "0x4d6394bc3031f751edce368c189b0e060b527107",
  IRYS: "0x91152b4ef635403efbae860edd0f8c321d7c035d",
  KITE: "0x904567252d8f48555b7447c67dca23f0372e16be",
  LAB: "0x7ec43cf65f1663f820427c62a5780b8f2e25593a",
  M: "0x22b1458e780f8fa71e2f84502cee8b5a3cc731fa",
  MYX: "0xd82544bf0dfe8385ef8fa34d67e6e4940cc63e16",
  NEX: "0x365de036a1f7dccb621530d517133521debb2013",
  NIGHT: "0xfe930c2d63aed9b82fc4dbc801920dd2c1a3224f",
  NXPC: "0xf2b51cc1850fed939658317a22d73d3482767591",
  OPEN: "0xa227cc36938f0c9e09ce0e64dfab226cad739447",
  PEAQ: "0x8b9ee39195ea99d6ddd68030f44131116bc218f6",
  PIEVERSE: "0x0e63b9c287e32a05e6b9ab8ee8df88a2760225a9",
  Q: "0xc07e1300dc138601fa6b0b59f8d0fa477e690589",
  RAVE: "0x97693439ea2f0ecdeb9135881e49f354656a911c",
  RIVER: "0xda7ad9dea9397cffddae2f8a052b82f1484252b3",
  SAHARA: "0xfdffb411c4a70aa7c95d5c981a6fb4da867e1111",
  SIREN: "0x997a58129890bbda032231a52ed1ddc845fc18e1",
  SKYAI: "0x92aa03137385f18539301349dcfc9ebc923ffb10",
  SLX: "0x02bcc4c181b83a8c0a342bc003389cbecb4bc54d",
  SOON: "0xb9e1fd5a02d3a33b25a14d661414e6ed6954a721",
  TAC: "0x1219c409fabe2c27bd0d1a565daeed9bd9f271de",
  TAG: "0x208bf3e7da9639f1eaefa2de78c23396b0682025",
  TOSHI: "0x6a2608dabe09bc1128eec7275b92dfb939d5db3f",
  TRIA: "0xb0b92de23baa85fb06208277e925ced53edab482",
  U: "0xcE24439F2D9C6a2289F741120FE202248B666666",
  USD1: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d",
  USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  USDT: "0x55d398326f99059fF775485246999027B3197955",
  UAI: "0x3e5d4f8aee0d9b3082d5f6da5d6e225d17ba9ea0",
  UB: "0x40b8129b786d766267a7a118cf8c07e31cdb6fde",
  VELO: "0xf486ad071f3bee968384d2e39e2d8af0fcf6fd46",
  XPL: "0x405fbc9004d857903bfd6b3357792d71a50726b0",
  ZAMA: "0x6907a5986c4950bdaf2f81828ec0737ce787519f",
  STABLE: "0x011ebe7d75e2c9d1e0bd0be0bef5c36f0a90075f",
};

/**
 * Best-known BEP-20 contract for a symbol: static map first, then any address
 * resolved at runtime via CMC (cached). Returns undefined if none is known.
 */
export function knownBscAddress(symbol: string): string | undefined {
  const upper = symbol.toUpperCase();
  const mapped =
    BSC_TOKEN_ADDRESSES[upper] ??
    BSC_TOKEN_ADDRESSES[symbol] ??
    addressCache.get(upper);
  return mapped && EVM_ADDRESS.test(mapped) ? mapped : undefined;
}

/** Trust Wallet CDN logo for a BEP-20 contract (fallback when Binance has no icon). */
export function trustWalletIconUrl(contractAddress: string): string {
  return `https://assets.trustwallet.com/blockchains/smartchain/assets/${contractAddress}/logo.png`;
}

/**
 * Whether a symbol can be resolved to a real BSC swap target — the native gas
 * coin (BNB), USDT, or any token with a valid BEP-20 contract (static map or
 * runtime-resolved). Used to skip buys for tokens we can't route on-chain.
 */
export function hasBscSwapAddress(symbol: string): boolean {
  const upper = symbol.toUpperCase();
  if (upper === "USDT" || upper === "BNB" || upper === "USDC" || upper === "U" || upper === "USD1") {
    return true;
  }
  return knownBscAddress(symbol) !== undefined;
}

const addressCache = new Map<string, string>();

/** Register a runtime-resolved BEP-20 address (bStock type=3, CMC, etc.). */
export function cacheBscTokenAddress(symbol: string, address: string): string | undefined {
  const addr = normalizeAddress(address);
  if (!addr) return undefined;
  addressCache.set(symbol.toUpperCase(), addr);
  return addr;
}

function normalizeAddress(addr: string): string | undefined {
  const trimmed = addr.trim();
  return EVM_ADDRESS.test(trimmed) ? trimmed : undefined;
}

function extractBscAddressFromCmcEntry(entry: Record<string, unknown>): string | undefined {
  const platform = entry.platform as Record<string, unknown> | undefined;
  if (platform) {
    const name = String(platform.name ?? "").toLowerCase();
    const slug = String(platform.slug ?? "").toLowerCase();
    const tokenAddress = platform.token_address;
    if (
      typeof tokenAddress === "string" &&
      (name.includes("bnb") || name.includes("bsc") || slug === "bnb" || slug === "bsc")
    ) {
      return normalizeAddress(tokenAddress);
    }
  }

  const contracts = entry.contract_address;
  if (Array.isArray(contracts)) {
    for (const row of contracts) {
      if (!row || typeof row !== "object") continue;
      const c = row as Record<string, unknown>;
      const platformName = String(
        (c.platform as Record<string, unknown> | undefined)?.name ?? c.platform_name ?? ""
      ).toLowerCase();
      const addr = c.contract_address ?? c.address;
      if (
        typeof addr === "string" &&
        (platformName.includes("bnb") || platformName.includes("bsc"))
      ) {
        return normalizeAddress(addr);
      }
    }
  }

  return undefined;
}

/** Synchronous lookup — static map only (no CMC API round-trip). */
export function getKnownBscTokenAddress(symbol: string): string | undefined {
  const sym = symbol.toUpperCase();
  const known = BSC_TOKEN_ADDRESSES[sym] ?? BSC_TOKEN_ADDRESSES[symbol];
  return known ? normalizeAddress(known) : undefined;
}

/** Resolve a symbol → BEP-20 contract via static map, then CMC Pro API. */
export async function resolveBscTokenAddress(symbol: string): Promise<string | undefined> {
  const sym = symbol.toUpperCase();
  if (addressCache.has(sym)) return addressCache.get(sym);

  const known = BSC_TOKEN_ADDRESSES[sym] ?? BSC_TOKEN_ADDRESSES[symbol];
  if (known) {
    const addr = normalizeAddress(known);
    if (addr) {
      addressCache.set(sym, addr);
      return addr;
    }
  }

  const apiKey = process.env.CMC_PRO_API_KEY?.trim();
  if (!apiKey) return undefined;

  try {
    const url = `${CMC_PRO_BASE}/v2/cryptocurrency/info?symbol=${encodeURIComponent(sym)}`;
    const res = await fetch(url, {
      headers: { "X-CMC_PRO_API_KEY": apiKey, Accept: "application/json" },
    });
    if (!res.ok) return undefined;

    const body = (await res.json()) as { data?: Record<string, Record<string, unknown>> };
    const entries = body.data?.[sym] ?? body.data?.[symbol];
    const list = Array.isArray(entries) ? entries : entries ? [entries] : [];

    for (const entry of list) {
      const addr = extractBscAddressFromCmcEntry(entry);
      if (addr) {
        addressCache.set(sym, addr);
        logger.info("Resolved BSC token address via CMC", { symbol: sym, address: addr });
        return addr;
      }
    }
  } catch (err) {
    logger.warn("CMC token address lookup failed", { symbol: sym, error: String(err) });
  }

  return undefined;
}
