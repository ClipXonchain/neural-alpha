import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpBridge } from "../agent.js";
import { buildQuoteParams, buildSwapParams } from "../execution/executor.js";
import { BSC_CHAIN, BSC_USDT_ADDRESS } from "../config.js";
import { logger } from "../utils/logger.js";
import { resolveBscTokenAddress, BSC_TOKEN_ADDRESSES } from "./bsc-token-addresses.js";
import { getTokenBalanceViaCli } from "./twak-cli-balance.js";
import {
  fetchBinanceWeb3Holdings,
  getUsdtBalance as getBinanceUsdtBalance,
} from "./binance-web3-wallet.js";

type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

function parseToolResult(result: ToolResult): Record<string, unknown> | null {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent as Record<string, unknown>;
  }

  for (const block of result.content ?? []) {
    if (block.type === "text" && block.text) {
      try {
        return JSON.parse(block.text) as Record<string, unknown>;
      } catch {
        return { raw: block.text };
      }
    }
  }

  return null;
}

/** Parse a TWAK amount field (decimal or wei integer string) to token units. */
function parseAmountValue(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return parseAmountValue(obj.available ?? obj.total ?? obj.amount);
  }
  const asString = String(value);
  const asNumber = Number(asString);
  if (!Number.isFinite(asNumber)) return null;
  if (/^\d+$/.test(asString) && asString.length > 10) {
    return asNumber / 1e18;
  }
  return asNumber;
}

/** Parse TWAK token_balance / wallet_balance amounts (wei strings) to decimal units. */
function parseTwakTokenAmount(result: Record<string, unknown> | null): number | null {
  if (!result) return null;

  const direct = parseAmountValue(
    result.available ?? result.total ?? result.balance ?? result.amount
  );
  if (direct !== null && direct > 0) return direct;

  if (result.amounts && typeof result.amounts === "object") {
    const amounts = result.amounts as Record<string, unknown>;
    const fromAmounts = parseAmountValue(amounts.available ?? amounts.total);
    if (fromAmounts !== null && fromAmounts > 0) return fromAmounts;
  }

  if (result.raw && typeof result.raw === "object") {
    const raw = result.raw as Record<string, unknown>;
    if (raw.amounts && typeof raw.amounts === "object") {
      const amounts = raw.amounts as Record<string, unknown>;
      const fromRaw = parseAmountValue(amounts.available ?? amounts.total);
      if (fromRaw !== null && fromRaw > 0) return fromRaw;
    }
  }

  if (result.balance && typeof result.balance === "object") {
    const bal = result.balance as Record<string, unknown>;
    const nested = parseAmountValue(bal.available ?? bal.total ?? bal.amount);
    if (nested !== null && nested > 0) return nested;
  }

  return direct;
}

function responseMatchesSymbol(
  bal: Record<string, unknown> | null,
  symbol: string,
  tokenAddress?: string
): boolean {
  if (!bal) return false;
  const target = symbol.toUpperCase();
  const respSym = String(bal.symbol ?? bal.ticker ?? "").toUpperCase();
  const respToken = bal.token ?? bal.tokenAddress ?? bal.contract;
  const respAddr = typeof respToken === "string" ? respToken.toLowerCase() : "";

  if (respSym && respSym !== target) return false;
  if (target !== "BNB" && respSym === "BNB") return false;

  if (tokenAddress) {
    if (respAddr && respAddr !== tokenAddress.toLowerCase()) return false;
    // ERC-20 responses must identify the asset — reject native-BNB leak with no metadata.
    if (!respSym && !respAddr) return false;
  }

  return true;
}

function parseTwakFiatUsd(result: Record<string, unknown> | null): number | undefined {
  if (!result) return undefined;
  const candidates = [
    result.totalUsd,
    result.availableUsd,
    result.valueUsd,
    (result.amounts as Record<string, unknown> | undefined)?.totalInFiat,
    (result.amounts as Record<string, unknown> | undefined)?.availableInFiat,
  ];
  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const raw = result.raw as Record<string, unknown> | undefined;
  const amounts = raw?.amounts as Record<string, unknown> | undefined;
  if (amounts) {
    for (const key of ["totalInFiat", "availableInFiat"]) {
      const n = Number(amounts[key]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

/** SLIP-44 coin ids for chains we may query holdings on. */
const CHAIN_COIN_IDS: Record<string, number> = {
  bsc: 714,
  ethereum: 60,
  eth: 60,
  polygon: 137,
  avalanche: 43114,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
};

/** Coerce a holding amount that may be a decimal or a wei-style integer string. */
function parseHoldingAmount(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const asString = String(value);
  const asNumber = Number(asString);
  if (!Number.isFinite(asNumber)) return null;
  // Large all-digit strings are base units (wei); short values are decimals.
  if (/^\d+$/.test(asString) && asString.length > 12) {
    return asNumber / 1e18;
  }
  return asNumber;
}

/** Native gas token symbol per chain (not traded by the agent). */
const NATIVE_SYMBOL: Record<string, string> = {
  bsc: "BNB",
  ethereum: "ETH",
  eth: "ETH",
};

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/**
 * Resolve a token symbol to its BEP-20 contract address.
 * Static map → CMC Pro API → TWAK asset search.
 */
function extractAddressForSymbol(
  raw: Record<string, unknown> | null,
  symbol: string
): string | undefined {
  if (!raw) return undefined;
  const target = symbol.toUpperCase();

  const scan = (val: unknown, depth = 0): string | undefined => {
    if (depth > 4 || val === null || val === undefined) return undefined;
    if (Array.isArray(val)) {
      for (const item of val) {
        const found = scan(item, depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    if (typeof val === "object") {
      const obj = val as Record<string, unknown>;
      const sym = obj.symbol ?? obj.ticker ?? obj.assetSymbol;
      const addr = obj.address ?? obj.contractAddress ?? obj.tokenAddress ?? obj.contract;
      if (
        typeof sym === "string" &&
        sym.toUpperCase() === target &&
        typeof addr === "string" &&
        EVM_ADDRESS.test(addr)
      ) {
        return addr;
      }
      for (const v of Object.values(obj)) {
        const found = scan(v, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  };

  return scan(raw);
}

/** Parse TWAK `get_balance` / `wallet_balance` native coin payloads. */
function parseNativeBalance(
  raw: Record<string, unknown>,
  chain: string
): import("../utils/types.js").PortfolioHolding | null {
  const symbol = NATIVE_SYMBOL[chain.toLowerCase()] ?? "NATIVE";

  // get_balance: { slug: "bnb", amounts: { total, totalInFiat, available, availableInFiat } }
  if (raw.amounts && typeof raw.amounts === "object") {
    const amounts = raw.amounts as Record<string, unknown>;
    const amount = parseHoldingAmount(amounts.available ?? amounts.total);
    const fiat = amounts.availableInFiat ?? amounts.totalInFiat;
    const valueUsd = fiat !== undefined ? Number(fiat) : undefined;
    if (amount !== null && amount > 0) {
      return {
        symbol,
        amount,
        ...(valueUsd !== undefined && Number.isFinite(valueUsd) && valueUsd > 0
          ? { valueUsd }
          : {}),
      };
    }
  }

  // wallet_balance: { balance: { available, total } } (wei strings)
  if (raw.balance && typeof raw.balance === "object") {
    const bal = raw.balance as Record<string, unknown>;
    const amount = parseHoldingAmount(bal.available ?? bal.total);
    if (amount !== null && amount > 0) {
      return { symbol, amount };
    }
  }

  return null;
}

/** Parse token rows from get_token_holdings { tokens: [...] }. */
function parseTokenHoldingsList(
  raw: Record<string, unknown>,
  chain: string
): import("../utils/types.js").PortfolioHolding[] {
  const containers = [
    raw.tokens, raw.holdings, raw.balances, raw.assets, raw.positions, raw.data,
  ];
  let list: unknown = containers.find((c) => Array.isArray(c));
  if (!Array.isArray(list) && raw[chain] && typeof raw[chain] === "object") {
    const inner = raw[chain] as Record<string, unknown>;
    list = [inner.tokens, inner.holdings, inner.balances, inner.assets, inner.data]
      .find((c) => Array.isArray(c));
  }
  if (!Array.isArray(list)) return [];

  const holdings: import("../utils/types.js").PortfolioHolding[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;

    const rowChain = row.chain ?? row.network ?? row.chainId;
    if (typeof rowChain === "string" && rowChain.toLowerCase() !== chain.toLowerCase()) {
      continue;
    }

    const symbolRaw = row.symbol ?? row.ticker ?? row.asset ?? row.token ?? row.name;
    if (!symbolRaw) continue;
    const symbol = String(symbolRaw).toUpperCase();

    const amount = parseHoldingAmount(
      row.amount ?? row.balance ?? row.quantity ?? row.available ?? row.qty
    );
    if (amount === null || amount <= 0) continue;

    const priceRaw = row.priceUsd ?? row.price ?? row.usdPrice ?? row.priceUSD;
    const valueRaw = row.valueUsd ?? row.value ?? row.usdValue ?? row.valueUSD ?? row.fiatValue;
    const priceUsd = priceRaw !== undefined ? Number(priceRaw) : undefined;
    const valueUsd = valueRaw !== undefined ? Number(valueRaw) : undefined;

    holdings.push({
      symbol,
      amount,
      ...(Number.isFinite(priceUsd) ? { priceUsd } : {}),
      ...(Number.isFinite(valueUsd) ? { valueUsd } : {}),
    });
  }

  return holdings;
}

/**
 * Parse a TWAK portfolio/holdings payload into normalized holdings.
 * Handles BEP-20 token lists and native gas balance shapes.
 */
function parsePortfolioHoldings(
  raw: Record<string, unknown>,
  chain: string
): import("../utils/types.js").PortfolioHolding[] {
  const holdings = parseTokenHoldingsList(raw, chain);
  const native = parseNativeBalance(raw, chain);
  if (native && !holdings.some((h) => h.symbol === native.symbol)) {
    holdings.push(native);
  }
  return holdings;
}

/**
 * Connect to TWAK MCP server (`twak serve`) and expose McpBridge methods.
 * CMC Agent Hub data flows through x402_request per
 * https://coinmarketcap.com/api/agent/#dev-steps
 */

let activeTransport: StdioClientTransport | null = null;

function isBenignPipeError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") return true;
  return /EPIPE|broken pipe/i.test(String(err));
}

/** Close the TWAK MCP child process — call on SIGINT/SIGTERM before exit (tsx watch reload). */
export async function closeTwakMcpBridge(): Promise<void> {
  const transport = activeTransport;
  activeTransport = null;
  if (!transport) return;
  try {
    await transport.close();
  } catch (err) {
    if (!isBenignPipeError(err)) {
      logger.warn("TWAK MCP close error", { error: String(err) });
    }
  }
}

/** MCP stdio spawn whitelists HOME/PATH/USER only — forward TWAK secrets to `twak serve`. */
function twakSubprocessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "TWAK_WALLET_PASSWORD",
    "TW_ACCESS_ID",
    "TW_HMAC_SECRET",
  ] as const) {
    const val = process.env[key]?.trim();
    if (val) env[key] = val;
  }
  return env;
}

export async function createTwakMcpBridge(): Promise<McpBridge> {
  const command = process.env.TWAK_MCP_COMMAND || "twak";
  const args = (process.env.TWAK_MCP_ARGS || "serve").split(" ").filter(Boolean);

  const transport = new StdioClientTransport({
    command,
    args,
    env: twakSubprocessEnv(),
  });
  activeTransport = transport;
  transport.onerror = (err) => {
    if (isBenignPipeError(err)) {
      logger.warn("TWAK MCP pipe closed (benign)", {
        code: (err as NodeJS.ErrnoException)?.code,
      });
      return;
    }
    logger.warn("TWAK MCP transport error", { error: String(err) });
  };
  const client = new Client(
    { name: "neural-alpha", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  logger.info("Connected to TWAK MCP server", { command, args: args.join(" ") });

  // Discover the exact tool names this TWAK build exposes. Names vary across
  // versions, so we log them and resolve portfolio/balance tools dynamically.
  let availableTools: string[] = [];
  try {
    const toolList = await client.listTools();
    availableTools = (toolList.tools ?? []).map((t) => t.name);
    logger.info("TWAK MCP tools available", { tools: availableTools });
  } catch (err) {
    logger.warn("Could not list TWAK MCP tools", { error: String(err) });
  }

  /** Log each distinct TWAK tool error once — dashboard polling otherwise spams logs. */
  const loggedToolErrors = new Set<string>();
  /** Last tool failure message — surfaced to swap callers when result is null. */
  let lastToolError: string | undefined;

  const callTool = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown> | null> => {
    lastToolError = undefined;
    try {
      const result = (await client.callTool({ name, arguments: args })) as ToolResult;
      if (result.isError) {
        const errBody = parseToolResult(result);
        const errMsg = String(errBody?.message ?? errBody?.error ?? errBody?.code ?? errBody ?? "unknown");
        lastToolError = errMsg;
        const errKey = `${name}:${errMsg.slice(0, 160)}`;
        if (!loggedToolErrors.has(errKey)) {
          loggedToolErrors.add(errKey);
          logger.warn(`TWAK MCP tool error: ${name}`, { args, error: errMsg });
        }
        return null;
      }
      return parseToolResult(result);
    } catch (err) {
      lastToolError = String(err);
      const errKey = `${name}:exception:${String(err).slice(0, 160)}`;
      if (!loggedToolErrors.has(errKey)) {
        loggedToolErrors.add(errKey);
        logger.warn(`TWAK MCP call failed: ${name}`, { error: String(err) });
      }
      return null;
    }
  };

  // TWAK MCP starts with no wallet mode until switch_wallet_mode is called.
  // Production agents must bind the local HD wallet non-interactively on boot.
  const walletModeEnv = (process.env.TWAK_WALLET_MODE ?? "local").trim().toLowerCase();
  if (walletModeEnv !== "skip" && walletModeEnv !== "none") {
    const mode = walletModeEnv === "walletconnect" ? "walletconnect" : "local";
    if (availableTools.length === 0 || availableTools.includes("switch_wallet_mode")) {
      const bound = await callTool("switch_wallet_mode", { mode });
      if (bound) {
        const addr = bound.address ?? bound.walletAddress;
        logger.info("TWAK wallet mode bound at startup", {
          mode,
          ...(addr ? { address: String(addr) } : {}),
        });
      } else {
        logger.error(
          "TWAK wallet bind failed — on the VPS run: twak wallet create && twak wallet address --chain bsc",
          { mode }
        );
      }
    }
  }

  // Cache symbol → contract address so we resolve each token at most once.
  const addressCache = new Map<string, string>();
  let cachedWalletAddress: string | null | undefined;

  const getWalletAddress = async (chain: string): Promise<string | null> => {
    if (cachedWalletAddress) return cachedWalletAddress;
    const addr = await callTool("get_address", { chain });
    cachedWalletAddress = addr?.address ? String(addr.address) : null;
    return cachedWalletAddress;
  };

  let cachedNativeGasAmount: number | null | undefined;

  const getNativeGasAmount = async (
    chain: string,
    walletAddress: string
  ): Promise<number | null> => {
    if (cachedNativeGasAmount !== undefined) return cachedNativeGasAmount;
    const raw = await callTool("token_balance", { chain, address: walletAddress });
    cachedNativeGasAmount = parseTwakTokenAmount(raw);
    return cachedNativeGasAmount;
  };

  /** MCP token_balance can return native gas balance for ERC-20 queries — reject that leak. */
  const isNativeGasLeak = (
    chain: string,
    symbol: string,
    amount: number,
    nativeAmount: number | null
  ): boolean => {
    const sym = symbol.toUpperCase();
    const nativeSym = NATIVE_SYMBOL[chain.toLowerCase()] ?? "BNB";
    if (sym === nativeSym) return false;
    if (nativeAmount === null || nativeAmount <= 0) return false;
    const rel = Math.abs(amount - nativeAmount) / nativeAmount;
    return rel < 1e-4;
  };

  const formatHolding = async (
    chain: string,
    symbol: string,
    amount: number,
    fiatUsd?: number
  ): Promise<import("../utils/types.js").PortfolioHolding> => {
    let priceUsd: number | undefined;
    let valueUsd = fiatUsd;

    if (!(valueUsd && valueUsd > 0)) {
      try {
        const price = await callTool("get_token_price", { chain, token: symbol });
        const p = price?.price ?? price?.usdPrice ?? price?.value;
        if (p !== undefined && p !== null) priceUsd = Number(p);
      } catch { /* price is best-effort */ }
    } else {
      priceUsd = amount > 0 ? valueUsd / amount : undefined;
    }

    return {
      symbol: symbol.toUpperCase(),
      amount,
      ...(priceUsd && priceUsd > 0 ? { priceUsd } : {}),
      ...(valueUsd && valueUsd > 0 ? { valueUsd } : {}),
    };
  };

  const resolveTokenAddress = async (
    chain: string,
    symbol: string,
    callToolFn: typeof callTool,
    tools: string[]
  ): Promise<string | undefined> => {
    const sym = symbol.toUpperCase();
    const key = `${chain.toLowerCase()}:${sym}`;
    if (addressCache.has(key)) return addressCache.get(key);

    if (chain.toLowerCase() === "bsc") {
      const fromMap = BSC_TOKEN_ADDRESSES[sym] ?? (await resolveBscTokenAddress(sym));
      if (fromMap) {
        addressCache.set(key, fromMap);
        return fromMap;
      }
    }

    if (tools.includes("search_assets")) {
      const r = await callToolFn("search_assets", { query: sym, chain });
      const addr = extractAddressForSymbol(r, sym);
      if (addr) {
        addressCache.set(key, addr);
        return addr;
      }
    }

    if (tools.includes("get_asset_info")) {
      const r = await callToolFn("get_asset_info", { chain, token: sym });
      const addr = extractAddressForSymbol(r, sym);
      if (addr) {
        addressCache.set(key, addr);
        return addr;
      }
    }

    return undefined;
  };

  return {
    async getTokenPrice(chain: string, token: string) {
      const r = await callTool("get_token_price", { chain, token });
      if (!r) return null;
      const price = r.price ?? r.usdPrice ?? r.value;
      if (price === undefined || price === null) return null;
      return { price: Number(price) };
    },

    async getTokenBalance(chain: string, symbol: string) {
      const walletAddress = await getWalletAddress(chain);
      if (!walletAddress) return null;
      const sym = symbol.toUpperCase();

      const tokenAddress = await resolveTokenAddress(chain, symbol, callTool, availableTools);
      if (!tokenAddress) return null;

      const nativeAmount = await getNativeGasAmount(chain, walletAddress);

      const cliBal = await getTokenBalanceViaCli(chain, walletAddress, tokenAddress, symbol);
      if (cliBal) {
        if (isNativeGasLeak(chain, sym, cliBal.amount, nativeAmount)) {
          logger.warn("Rejected CLI balance — native gas leak", { symbol: sym, amount: cliBal.amount });
          return null;
        }
        if (!responseMatchesSymbol({ symbol: cliBal.symbol }, sym, tokenAddress)) return null;
        return formatHolding(chain, cliBal.symbol, cliBal.amount, cliBal.valueUsd);
      }

      const paramSets = [
        { chain, address: walletAddress, tokenAddress },
        { chain, address: walletAddress, token: tokenAddress },
      ];

      for (const params of paramSets) {
        const bal = await callTool("token_balance", params);
        const amount = parseTwakTokenAmount(bal);
        if (amount === null || amount <= 0) continue;

        if (isNativeGasLeak(chain, sym, amount, nativeAmount)) continue;
        if (!responseMatchesSymbol(bal, sym, tokenAddress)) continue;

        const fiatUsd = parseTwakFiatUsd(bal);
        return formatHolding(chain, symbol, amount, fiatUsd);
      }

      return null;
    },

    async getWalletBalance(chain: string) {
      const addr = await callTool("get_address", { chain });
      if (!addr?.address) return null;

      const r = await callTool("token_balance", {
        chain,
        address: String(addr.address),
      });
      const amount = parseTwakTokenAmount(r);
      return amount !== null ? { balance: String(amount) } : null;
    },

    async getSwapQuote(params: ReturnType<typeof buildQuoteParams>) {
      return callTool("get_swap_quote", params);
    },

    async executeSwap(params: ReturnType<typeof buildSwapParams>) {
      const r = await callTool("swap", params);
      if (!r) {
        return {
          error: lastToolError ?? "swap returned empty result",
          success: false,
        };
      }
      logger.info("TWAK swap raw response", {
        keys: Object.keys(r),
        sample: JSON.stringify(r).slice(0, 800),
      });
      return r;
    },

    async getAddress(chain: string) {
      const r = await callTool("get_address", { chain });
      if (!r?.address) return null;
      return { address: String(r.address) };
    },

    async x402Request(url: string, maxPayment: string) {
      logger.info("CMC Agent Hub x402 request", { url, maxPaymentAtomic: maxPayment });
      return callTool("x402_request", {
        url,
        maxPaymentAtomic: maxPayment,
        preferNetwork: process.env.CMC_X402_PREFER_NETWORK || "bsc",
        autoApprove: process.env.CMC_X402_AUTO_APPROVE !== "false",
      });
    },

    async getTrendingTokens(limit: number) {
      const r = await callTool("get_trending_tokens", { limit });
      if (!r) return null;
      const list = (r.tokens ?? r.data ?? r) as unknown;
      if (!Array.isArray(list)) return null;
      return list.map((item) => {
        const row = item as Record<string, unknown>;
        return { symbol: String(row.symbol || row.ticker || row.name).toUpperCase() };
      });
    },

    async checkTokenRisk(chain: string, token?: string) {
      const args: Record<string, unknown> = { chain };
      if (token) args.token = token;
      return callTool("check_token_risk", args);
    },

    async getStablecoinBalance(chain: string) {
      const addr = await callTool("get_address", { chain });
      if (!addr?.address) return null;
      const walletAddress = String(addr.address);

      // get_balance often returns NETWORK_ERROR; token_balance is reliable on BSC.
      const bal = await callTool("token_balance", {
        chain,
        address: walletAddress,
        tokenAddress: BSC_USDT_ADDRESS,
      });

      const amount = parseTwakTokenAmount(bal);
      if (amount !== null) return { balance: amount, symbol: "USDT" };

      // Fallback: Binance Web3 public wallet API
      try {
        const binanceUsdt = await getBinanceUsdtBalance(walletAddress);
        if (binanceUsdt > 0) {
          logger.info("USDT balance from Binance Web3 API", { balance: binanceUsdt });
          return { balance: binanceUsdt, symbol: "USDT" };
        }
      } catch (err) {
        logger.warn("Binance Web3 USDT fallback failed", { error: String(err) });
      }

      return null;
    },

    async getPortfolio(chain: string) {
      const addr = await callTool("get_address", { chain });
      const address = addr?.address ? String(addr.address) : undefined;
      const coinId = CHAIN_COIN_IDS[chain.toLowerCase()];
      const baseArgs: Record<string, unknown> = {
        chain,
        ...(address ? { address } : {}),
        ...(coinId !== undefined ? { coin: coinId, coinId } : {}),
      };

      const merged: import("../utils/types.js").PortfolioHolding[] = [];
      const seen = new Set<string>();

      const addHoldings = (items: import("../utils/types.js").PortfolioHolding[]) => {
        for (const h of items) {
          if (seen.has(h.symbol)) continue;
          seen.add(h.symbol);
          merged.push(h);
        }
      };

      // BEP-20 / ERC-20 token list — try with multiple param styles
      if (availableTools.includes("get_token_holdings")) {
        const paramCombos = [
          baseArgs,
          { address, chain, coin: String(coinId) },
          { address, chain },
        ].filter((p) => p.address);
        for (const params of paramCombos) {
          const raw = await callTool("get_token_holdings", params);
          if (raw) {
            const tokens = parseTokenHoldingsList(raw, chain);
            if (tokens.length > 0) {
              addHoldings(tokens);
              break;
            }
          }
        }
      }

      // Native gas coin (BNB on BSC) — includes USD fiat from get_balance
      if (availableTools.includes("get_balance")) {
        const raw = await callTool("get_balance", baseArgs);
        if (raw) {
          const native = parseNativeBalance(raw, chain);
          if (native) addHoldings([native]);
        }
      } else if (availableTools.includes("wallet_balance")) {
        const raw = await callTool("wallet_balance", baseArgs);
        if (raw) {
          const native = parseNativeBalance(raw, chain);
          if (native) addHoldings([native]);
        }
      }

      // Fallback: token_balance without tokenAddress is reliable for native BNB on BSC.
      const nativeSym = NATIVE_SYMBOL[chain.toLowerCase()];
      if (nativeSym && address && !seen.has(nativeSym) && availableTools.includes("token_balance")) {
        const raw = await callTool("token_balance", { chain, address });
        const amount = parseTwakTokenAmount(raw);
        if (amount !== null && amount > 0) {
          addHoldings([{ symbol: nativeSym, amount }]);
        }
      }

      // USDT cash — always include for NAV even if get_token_holdings is empty.
      if (address && !seen.has("USDT") && availableTools.includes("token_balance")) {
        const raw = await callTool("token_balance", {
          chain,
          address,
          tokenAddress: BSC_USDT_ADDRESS,
        });
        const amount = parseTwakTokenAmount(raw);
        if (amount !== null && amount > 0) {
          addHoldings([{ symbol: "USDT", amount }]);
        }
      }

      if (merged.length > 0) {
        logger.info("TWAK portfolio synced", {
          tokens: merged.filter((h) => h.symbol !== NATIVE_SYMBOL[chain.toLowerCase()]).map((h) => h.symbol),
          native: merged.find((h) => h.symbol === NATIVE_SYMBOL[chain.toLowerCase()])?.amount,
        });
        return merged;
      }

      // Fallback: Binance Web3 public wallet API
      if (address) {
        try {
          const binanceHoldings = await fetchBinanceWeb3Holdings(address);
          if (binanceHoldings.length > 0) {
            logger.info("Portfolio from Binance Web3 API", {
              tokens: binanceHoldings.map((h) => h.symbol),
            });
            return binanceHoldings;
          }
        } catch (err) {
          logger.warn("Binance Web3 portfolio fallback failed", { error: String(err) });
        }
      }

      return null;
    },

    async switchWalletMode(mode: "local" | "walletconnect") {
      return callTool("switch_wallet_mode", { mode });
    },

    async getWalletStatus() {
      return callTool("get_wallet_status", {});
    },

    async competitionRegister() {
      return callTool("competition_register", {});
    },

    async competitionStatus() {
      return callTool("competition_status", {});
    },
  };
}
