/**
 * bStocks — on-chain tokenized equity tickers (BSC).
 * Static allowlist with verified BEP-20 contracts.
 */

export interface BStockToken {
  symbol: string;
  contractAddress: string;
  name?: string;
}

/** Canonical bStocks universe (symbol → checksum-normalized lowercase address). */
export const BSTOCKS_TOKENS: readonly BStockToken[] = [
  { symbol: "AMDB", contractAddress: "0x75fd4cf6f8392e41e70391d60c90c0d5211603a1", name: "AMD bStock" },
  { symbol: "CBRSB", contractAddress: "0xe81c6bb0266cd68b4f17278531dd03ea1f12da4e", name: "CBRS bStock" },
  { symbol: "COINB", contractAddress: "0x585bde7c54abb5ccd7791f923d6c2187635f3952", name: "Coinbase bStock" },
  { symbol: "CRCLB", contractAddress: "0x80f3d493ebce97e343c53d29a137942416b4ffc0", name: "Circle bStock" },
  { symbol: "DRAMB", contractAddress: "0x93862d63fd9fd488b1328e9b47717d75e994a84b", name: "DRAM bStock" },
  { symbol: "EWYB", contractAddress: "0xbe82f76637dba2c114c41df856c2c51e522e2cb8", name: "EWY bStock" },
  { symbol: "GLWB", contractAddress: "0x740e075cbbea22a082b9d6679e65e82767875b6a", name: "GLW bStock" },
  { symbol: "GOOGLB", contractAddress: "0x3f53de71c126bdabae20f9cd64848d317f6c3238", name: "Alphabet bStock" },
  { symbol: "INTCB", contractAddress: "0xe614e2fc6c787035ff51f452e8e826bfd32d5283", name: "Intel bStock" },
  { symbol: "LITEB", contractAddress: "0x64748bea17b6d19e242adf20425de2440c656142", name: "Lite bStock" },
  { symbol: "METAB", contractAddress: "0x7425889fe94f9d693e8daefe88bcced6acfef4c0", name: "Meta bStock" },
  { symbol: "MSFTB", contractAddress: "0x80106cb3ead06659a5ad19df39d9b4733863b9b0", name: "Microsoft bStock" },
  { symbol: "MSTRB", contractAddress: "0xe87afb3076aeb0f9b14e368de8145ae6a2826a14", name: "MicroStrategy bStock" },
  { symbol: "MUB", contractAddress: "0xcdf2f3e0fa43c47a6662a91c9e4a7c5f69762699", name: "MU bStock" },
  { symbol: "NBISB", contractAddress: "0xe256bc2a4f5297f8ba6f043f180a46300ecbcbb1", name: "NBIS bStock" },
  { symbol: "NVDAB", contractAddress: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436", name: "NVIDIA bStock" },
  { symbol: "PLTRB", contractAddress: "0x0ca5d51d0277bd006fd9607d3e560785ebad8222", name: "Palantir bStock" },
  { symbol: "QCOMB", contractAddress: "0x5f7a56e877b9130608bf8be962621011182fefe1", name: "Qualcomm bStock" },
  { symbol: "QQQB", contractAddress: "0x205812cdbed920aff76c6580abd681a46d11efc7", name: "QQQ bStock" },
  { symbol: "SNDKB", contractAddress: "0x3ee4df61bd4f867e349beae8bfe07bc31b4850fb", name: "SNDK bStock" },
  { symbol: "SOXLB", contractAddress: "0xd97d097a89113fa59b76c572e5b2eb647e8eefaf", name: "SOXX bStock" },
  { symbol: "SPCXB", contractAddress: "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1", name: "SPCX bStock" },
  { symbol: "SPYB", contractAddress: "0x7138b48df7d98d7e3cc221bfe7192d0a178182d8", name: "SPY bStock" },
  { symbol: "TSLAB", contractAddress: "0x5b1910eaad6450e50f816082aa078c41f10c292f", name: "Tesla bStock" },
  { symbol: "WDCB", contractAddress: "0xebe29695f8047c13d36e7a790ca8c1b239ffad1c", name: "Western Digital bStock" },
] as const;

const symbolSet = new Set(BSTOCKS_TOKENS.map((t) => t.symbol.toUpperCase()));
const addressBySymbol = new Map(
  BSTOCKS_TOKENS.map((t) => [t.symbol.toUpperCase(), t.contractAddress.toLowerCase()] as const)
);

export function getBstocksSymbols(): string[] {
  return [...symbolSet];
}

export function isBstocksToken(symbol: string): boolean {
  return symbolSet.has(symbol.toUpperCase());
}

export function getBstocksContract(symbol: string): string | undefined {
  return addressBySymbol.get(symbol.toUpperCase());
}

export function getBstocksTokenCount(): number {
  return symbolSet.size;
}

/** Watchlist seed for bStocks agents — liquid mega-tech + index proxies. */
export const BSTOCKS_CORE_WATCHLIST: readonly string[] = [
  "NVDAB",
  "TSLAB",
  "GOOGLB",
  "MSFTB",
  "METAB",
  "QQQB",
  "SPYB",
  "AMDB",
  "COINB",
  "PLTRB",
  "MSTRB",
  "SOXLB",
];
