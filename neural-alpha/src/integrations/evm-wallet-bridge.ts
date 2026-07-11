import {
  type Address,
  type Hex,
  erc20Abi,
  formatEther,
  formatUnits,
  maxUint256,
  parseUnits,
} from "viem";
import type { McpBridge } from "../agent.js";
import { buildQuoteParams, buildSwapParams } from "../execution/executor.js";
import { BSC_USDT_ADDRESS } from "../config.js";
import { knownBscAddress, resolveBscTokenAddress } from "./bsc-token-addresses.js";
import {
  fetchBinanceWeb3Holdings,
  getUsdtBalance as getBinanceUsdtBalance,
} from "./binance-web3-wallet.js";
import {
  AGGREGATOR_NATIVE,
  buildSwapTransaction,
  getAggregatedQuotes,
  getErc20ApproveTransaction,
  isBinanceWeb3TradingConfigured,
  pickBestQuote,
  type AggregatorQuote,
} from "./binance-web3-trading.js";
import { getAgentWallet, initAgentWallet, type AgentWalletHandle } from "../wallet/index.js";
import { logger } from "../utils/logger.js";
import type { PortfolioHolding } from "../utils/types.js";

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" as const;
const NATIVE = "BNB";

/** Reject routes with price impact above this % (aggregator-reported). */
const MAX_PRICE_IMPACT_PCT = Math.min(
  50,
  Math.max(0.1, parseFloat(process.env.MAX_PRICE_IMPACT_PCT || "5") || 5)
);

function isNative(token: string): boolean {
  const t = token.toUpperCase();
  return (
    t === "BNB" ||
    t === WBNB.toLowerCase() ||
    t === AGGREGATOR_NATIVE.toLowerCase() ||
    t === "0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"
  );
}

/** Address used by the Binance Web3 aggregator (native = 0xeee…). */
function toAggregatorAddress(token: string, resolved: Address | null): Address | null {
  if (isNative(token)) return AGGREGATOR_NATIVE as Address;
  return resolved;
}

function resolveTokenAddress(token: string): Address | null {
  if (isNative(token)) return WBNB;
  if (/^0x[a-fA-F0-9]{40}$/.test(token)) {
    if (token.toLowerCase() === AGGREGATOR_NATIVE.toLowerCase()) return WBNB;
    return token as Address;
  }
  const upper = token.toUpperCase();
  if (upper === "USDT") return BSC_USDT_ADDRESS as Address;
  const mapped = knownBscAddress(upper);
  if (mapped) return mapped as Address;
  return null;
}

async function resolveTokenWithCmc(token: string): Promise<Address | null> {
  const direct = resolveTokenAddress(token);
  if (direct) return direct;
  try {
    const resolved = await resolveBscTokenAddress(token);
    if (resolved && /^0x[a-fA-F0-9]{40}$/.test(resolved)) return resolved as Address;
  } catch {
    /* ignore */
  }
  return null;
}

async function getTokenDecimals(
  wallet: AgentWalletHandle,
  token: Address
): Promise<number> {
  if (
    token.toLowerCase() === WBNB.toLowerCase() ||
    token.toLowerCase() === AGGREGATOR_NATIVE.toLowerCase()
  ) {
    return 18;
  }
  try {
    return await wallet.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    });
  } catch {
    return 18;
  }
}

function bscTxOptions(params: {
  gasPriceGwei?: number;
  gasLimit?: number;
}): Record<string, bigint> {
  const opts: Record<string, bigint> = {};
  // Only pin gas when the user set a fixed gwei. Otherwise omit and let
  // viem use eth_gasPrice (BSC is often ~0.05 gwei — not 3–10).
  if (params.gasPriceGwei && params.gasPriceGwei > 0) {
    opts.gasPrice = BigInt(Math.round(params.gasPriceGwei * 1e9));
  }
  if (params.gasLimit && params.gasLimit > 0) {
    opts.gas = BigInt(params.gasLimit);
  }
  return opts;
}

/** Estimate gas with a small buffer, or use a user-fixed ceiling. */
async function resolveGasLimit(
  wallet: AgentWalletHandle,
  tx: { to: Address; data: Hex; value?: bigint },
  fixedLimit?: bigint
): Promise<bigint | undefined> {
  if (fixedLimit && fixedLimit > 0n) return fixedLimit;
  try {
    const estimated = await wallet.publicClient.estimateGas({
      account: wallet.account,
      to: tx.to,
      data: tx.data,
      value: tx.value ?? 0n,
    });
    // ~20% headroom — fee is still gasUsed × price, not this ceiling
    return (estimated * 120n) / 100n;
  } catch (err) {
    logger.warn("eth_estimateGas failed — wallet will estimate on send", {
      error: String(err),
    });
    return undefined;
  }
}

function formatOutAmount(quote: AggregatorQuote, outDecimals: number): string {
  try {
    return formatUnits(BigInt(quote.toTokenAmount), outDecimals);
  } catch {
    return "0";
  }
}

/** Cached aggregator router spender (BSC) — same for all tokens once resolved. */
let cachedAggregatorSpender: Address | null = null;

/**
 * Ensure the aggregator can spend `token` for at least `amount`.
 *
 * Flow:
 * 1. Resolve spender (cached after first API call)
 * 2. Read on-chain allowance(wallet → spender)
 * 3. If allowance >= amount → no tx (reuse forever after max approve)
 * 4. Else approve(spender, maxUint256) once — later swaps skip this step
 */
async function ensureAggregatorAllowance(
  wallet: AgentWalletHandle,
  token: Address,
  amount: bigint,
  txOpts: Record<string, bigint> = {}
): Promise<void> {
  if (
    token.toLowerCase() === WBNB.toLowerCase() ||
    token.toLowerCase() === AGGREGATOR_NATIVE.toLowerCase()
  ) {
    return;
  }

  let spender = cachedAggregatorSpender;
  if (!spender) {
    const approveMeta = await getErc20ApproveTransaction({
      tokenContractAddress: token,
      approveAmount: maxUint256.toString(),
    });
    spender = approveMeta.dexContractAddress as Address;
    cachedAggregatorSpender = spender;
  }

  const allowance = await wallet.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [wallet.address, spender],
  });

  if (allowance >= amount) {
    logger.info("Token already approved — skipping approve tx", {
      token,
      spender,
      allowance: allowance.toString(),
      needed: amount.toString(),
    });
    return;
  }

  logger.info("Approving token for Binance Web3 aggregator (one-time max)", {
    token,
    spender,
    amount: amount.toString(),
  });

  const hash = await wallet.walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, maxUint256],
    account: wallet.account,
    chain: wallet.walletClient.chain,
    // Do not use aggregator gasLimit — estimate locally (approve is ~45–80k).
    ...txOpts,
  });
  await wallet.publicClient.waitForTransactionReceipt({ hash });
}

/**
 * Self-custodial EVM bridge.
 * Quotes + calldata via Binance Web3 DEX aggregator; local viem wallet signs/broadcasts.
 */
export async function createEvmWalletBridge(): Promise<McpBridge> {
  if (!isBinanceWeb3TradingConfigured()) {
    throw new Error(
      "BINANCE_WEB3_API_KEY and BINANCE_WEB3_API_SECRET are required — Pancake V2 direct pools are disabled"
    );
  }

  const wallet = await initAgentWallet();
  logger.info("EVM bridge using Binance Web3 DEX aggregator", {
    maxPriceImpactPct: MAX_PRICE_IMPACT_PCT,
  });

  return {
    async getTokenPrice(_chain: string, _token: string) {
      return null; // market data comes from CMC Pro hybrid
    },

    async getWalletBalance(_chain: string) {
      const bal = await wallet.publicClient.getBalance({ address: wallet.address });
      return { balance: formatEther(bal) };
    },

    async getSwapQuote(params: ReturnType<typeof buildQuoteParams>) {
      try {
        const fromIsNative = isNative(params.fromToken);
        const toIsNative = isNative(params.toToken);
        const fromResolved = fromIsNative
          ? WBNB
          : await resolveTokenWithCmc(params.fromToken);
        const toResolved = toIsNative
          ? WBNB
          : await resolveTokenWithCmc(params.toToken);
        const fromAgg = toAggregatorAddress(params.fromToken, fromResolved);
        const toAgg = toAggregatorAddress(params.toToken, toResolved);
        if (!fromAgg || !toAgg) {
          return { error: "unknown token", estimatedOutput: "0" };
        }

        const decimals = await getTokenDecimals(
          wallet,
          fromIsNative ? (AGGREGATOR_NATIVE as Address) : (fromResolved as Address)
        );
        const amountIn = parseUnits(params.amount, decimals);
        const quotes = await getAggregatedQuotes({
          amountWei: amountIn.toString(),
          fromTokenAddress: fromAgg,
          toTokenAddress: toAgg,
        });
        const best = pickBestQuote(quotes, MAX_PRICE_IMPACT_PCT);
        const outDecimals = await getTokenDecimals(
          wallet,
          toIsNative ? (AGGREGATOR_NATIVE as Address) : (toResolved as Address)
        );

        return {
          estimatedOutput: formatOutAmount(best, outDecimals),
          amountOut: best.toTokenAmount,
          quoteId: best.quoteId,
          vendor: best.vendorName,
          priceImpact: best.priceImpactPercent ?? "n/a",
          router: best.router,
        };
      } catch (err) {
        logger.warn("Aggregator swap quote failed", { error: String(err) });
        return { error: String(err), estimatedOutput: "0" };
      }
    },

    async executeSwap(params: ReturnType<typeof buildSwapParams>) {
      const fromIsNative = isNative(params.fromToken);
      const toIsNative = isNative(params.toToken);
      const fromResolved = fromIsNative
        ? WBNB
        : await resolveTokenWithCmc(params.fromToken);
      const toResolved = toIsNative
        ? WBNB
        : await resolveTokenWithCmc(params.toToken);
      const fromAgg = toAggregatorAddress(params.fromToken, fromResolved);
      const toAgg = toAggregatorAddress(params.toToken, toResolved);

      if (!fromAgg || !toAgg) {
        throw new Error(
          `Cannot resolve tokens: ${params.fromToken} → ${params.toToken}`
        );
      }

      const decimals = await getTokenDecimals(
        wallet,
        fromIsNative ? (AGGREGATOR_NATIVE as Address) : (fromResolved as Address)
      );
      const amountIn = parseUnits(params.amount, decimals);
      const slippagePct = Math.max(0.1, parseFloat(params.slippage) || 1);
      const txOpts = bscTxOptions(params);

      // Fresh quote immediately before build (quoteId TTL ~30s)
      const quotes = await getAggregatedQuotes({
        amountWei: amountIn.toString(),
        fromTokenAddress: fromAgg,
        toTokenAddress: toAgg,
      });
      const best = pickBestQuote(quotes, MAX_PRICE_IMPACT_PCT);

      if (!fromIsNative && fromResolved) {
        await ensureAggregatorAllowance(wallet, fromResolved, amountIn, txOpts);
      }

      const built = await buildSwapTransaction({
        amountWei: amountIn.toString(),
        fromTokenAddress: fromAgg,
        toTokenAddress: toAgg,
        slippagePercent: String(slippagePct),
        userWalletAddress: wallet.address,
        quoteId: best.quoteId,
        priceImpactProtectionPercent: String(MAX_PRICE_IMPACT_PCT),
      });

      const tx = built.tx;
      const value = BigInt(tx.value || "0");
      const sendOpts: Record<string, bigint> = { ...txOpts };
      // Never take aggregator gas price/limit — estimate locally when auto.
      if (!sendOpts.gas) {
        const estimated = await resolveGasLimit(
          wallet,
          { to: tx.to as Address, data: tx.data as Hex, value },
          undefined
        );
        if (estimated) sendOpts.gas = estimated;
      }

      const hash = await wallet.walletClient.sendTransaction({
        to: tx.to as Address,
        data: tx.data as Hex,
        value,
        account: wallet.account,
        chain: wallet.walletClient.chain,
        ...sendOpts,
      });

      const receipt = await wallet.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(`Swap reverted: ${hash}`);
      }

      const outDecimals = await getTokenDecimals(
        wallet,
        toIsNative ? (AGGREGATOR_NATIVE as Address) : (toResolved as Address)
      );
      const outAmount =
        built.routerResult?.toTokenAmount || best.toTokenAmount;
      const toAmount = formatUnits(BigInt(outAmount), outDecimals);

      logger.info("Aggregator swap executed", {
        txHash: hash,
        vendor: built.routerResult?.vendorName || best.vendorName,
        from: params.fromToken,
        to: params.toToken,
        amountIn: params.amount,
        priceImpact: best.priceImpactPercent,
      });

      return {
        txHash: hash,
        toAmount,
        fromAmount: params.amount,
        status: "confirmed",
        vendor: built.routerResult?.vendorName || best.vendorName,
      };
    },

    async getAddress(_chain: string) {
      return { address: wallet.address };
    },

    async x402Request(_url: string, _maxPayment: string) {
      return null;
    },

    async getTrendingTokens(_limit: number) {
      return null;
    },

    async checkTokenRisk(_chain: string, token?: string) {
      if (!token) return { isHoneypot: false, riskLevel: "unknown" };
      try {
        const tokenAddr = await resolveTokenWithCmc(token);
        if (!tokenAddr) {
          return { isHoneypot: true, riskLevel: "high", reason: "unknown token" };
        }
        const fromAgg = toAggregatorAddress(token, tokenAddr);
        const toAgg = BSC_USDT_ADDRESS as Address;
        if (!fromAgg) {
          return { isHoneypot: true, riskLevel: "high", reason: "unresolvable" };
        }
        const decimals = await getTokenDecimals(wallet, tokenAddr);
        const tiny = parseUnits("0.0001", decimals);
        const quotes = await getAggregatedQuotes({
          amountWei: tiny.toString(),
          fromTokenAddress: fromAgg,
          toTokenAddress: toAgg,
        });
        const best = quotes[0];
        if (best?.fromToken?.isHoneyPot || best?.toToken?.isHoneyPot) {
          return { isHoneypot: true, riskLevel: "high", reason: "aggregator honeypot flag" };
        }
        return { isHoneypot: false, riskLevel: "low", simulated: true, vendor: best?.vendorName };
      } catch (err) {
        return {
          isHoneypot: true,
          riskLevel: "high",
          reason: String(err),
        };
      }
    },

    async getStablecoinBalance(_chain: string) {
      try {
        const bal = await wallet.publicClient.readContract({
          address: BSC_USDT_ADDRESS as Address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [wallet.address],
        });
        const decimals = await getTokenDecimals(wallet, BSC_USDT_ADDRESS as Address);
        return { balance: Number(formatUnits(bal, decimals)), symbol: "USDT" };
      } catch {
        const fallback = await getBinanceUsdtBalance(wallet.address);
        return { balance: fallback, symbol: "USDT" };
      }
    },

    async getTokenBalance(_chain: string, symbol: string) {
      if (symbol.toUpperCase() === NATIVE) {
        const bal = await wallet.publicClient.getBalance({ address: wallet.address });
        return { symbol: NATIVE, amount: Number(formatEther(bal)) };
      }
      const addr = await resolveTokenWithCmc(symbol);
      if (!addr) return null;
      const bal = await wallet.publicClient.readContract({
        address: addr,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet.address],
      });
      const decimals = await getTokenDecimals(wallet, addr);
      return { symbol: symbol.toUpperCase(), amount: Number(formatUnits(bal, decimals)) };
    },

    async getPortfolio(_chain: string) {
      try {
        const holdings = await fetchBinanceWeb3Holdings(wallet.address);
        if (holdings.length > 0) return holdings;
      } catch (err) {
        logger.warn("Binance Web3 portfolio failed", { error: String(err) });
      }

      const result: PortfolioHolding[] = [];
      const bnb = await wallet.publicClient.getBalance({ address: wallet.address });
      if (bnb > 0n) {
        result.push({ symbol: NATIVE, amount: Number(formatEther(bnb)) });
      }
      try {
        const usdt = await wallet.publicClient.readContract({
          address: BSC_USDT_ADDRESS as Address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [wallet.address],
        });
        const decimals = await getTokenDecimals(wallet, BSC_USDT_ADDRESS as Address);
        const amt = Number(formatUnits(usdt, decimals));
        if (amt > 0) result.push({ symbol: "USDT", amount: amt });
      } catch {
        /* ignore */
      }
      return result.length > 0 ? result : null;
    },

    async getWalletStatus() {
      return {
        state: "unlocked",
        mode: "local",
        walletType: "evm-local",
        address: wallet.address,
        execution: "binance-web3-aggregator",
      };
    },
  };
}

/** Ensure wallet is ready without creating the full bridge. */
export async function ensureEvmWalletReady(): Promise<AgentWalletHandle> {
  try {
    return getAgentWallet();
  } catch {
    return initAgentWallet();
  }
}
