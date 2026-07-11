import type { TradingAgent } from "../agent.js";
import { computeSignals, generateSignal, getTokenMomentumMetrics } from "../strategy/signals.js";
import { analyzeSingleSignal, isAiAnalysisEnabled } from "../strategy/ai-analyst.js";
import { buildMarketData, getLatestPrice } from "../data/market.js";
import { isEligibleToken, isStablecoin, getEligibleScanUniverse } from "../config.js";
import { getBinanceAlphaTokenCount } from "../integrations/binance-alpha-tokens.js";
import { hasBscSwapAddress, resolveBscTokenAddress } from "../integrations/bsc-token-addresses.js";
import { logger } from "../utils/logger.js";
import { isLlmConfigured, llmParseCommand, type LlmParsedIntent } from "./llm.js";

export interface CommandResult {
  ok: boolean;
  intent: string;
  message: string;
  data?: Record<string, unknown>;
  /** Short labels the dashboard can show as tappable follow-up actions */
  suggestions?: string[];
}

interface ParsedIntent {
  action: "buy" | "sell" | "swap" | "signal" | "analysis" | "portfolio" | "status" | "help" | "eligible" | "chat" | "unknown";
  symbol?: string;
  toSymbol?: string;
  amount?: number;
  chatReply?: string;
}

const TRADE_ACTION_RE = /\b(buy|sell|long|purchase|dump|exit|close)\b/i;

function extractAmount(text: string): number | undefined {
  const patterns = [
    /\$\s*([\d.]+)/, // $50
    /([\d.]+)\s*\$/, // 50$
    /([\d.]+)\s*(?:usd|usdt|dollars?)\b/i,
    /\b(?:buy|sell|long|purchase|dump|exit|close|swap)\s+\$?\s*([\d.]+)\b/i, // buy 50 SIREN
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      const n = parseFloat(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

const TOKEN_STOP_WORDS = [
  "BUY", "SELL", "SWAP", "FOR", "WITH", "TO", "OF", "THE", "AND",
  "TOKEN", "TOKENS", "SIGNAL", "SIGNALS", "ANALYSIS", "MARKET",
  "DETAIL", "DETAILS", "WORTH", "USD", "USDT", "STATUS", "PORTFOLIO",
  "PNL", "HELP", "SHOW", "GET", "CHECK", "WHAT", "HOW", "ABOUT",
  "MUCH", "PRICE", "IS", "ME", "MY", "ALL", "CAN", "YOU", "DO", "RUN",
  "TOP", "OPPORTUNITIES", "OVERVIEW", "SHOULD", "TRADE", "AGENT",
  "PLEASE", "COULD", "WOULD", "WANT", "NEED", "SOME", "ANY", "ARE",
  "LONG", "PURCHASE", "DUMP", "EXIT", "CLOSE", "INTO", "FROM",
];

function tokenStopSet(exclude?: Set<string>): Set<string> {
  return new Set([...TOKEN_STOP_WORDS, ...(exclude ? [...exclude] : [])]);
}

/** First ticker-like word (legacy — prefer extractTradeSymbol for buy/sell). */
function extractToken(text: string, exclude?: Set<string>): string | undefined {
  const words = text.toUpperCase().match(/\b[A-Z]{2,10}\b/g) ?? [];
  const stop = tokenStopSet(exclude);
  return words.find((w) => !stop.has(w) && w.length >= 2);
}

/**
 * Resolve trade token from NL commands. Prefers ticker after "$200 SKYAI",
 * otherwise the last ticker-like word ("can you buy $200 SKYAI" → SKYAI).
 */
function extractTradeSymbol(text: string, excludeVerb?: string): string | undefined {
  const upper = text.toUpperCase();
  const stop = tokenStopSet(
    excludeVerb ? new Set([excludeVerb.toUpperCase()]) : undefined
  );

  const afterMoney = upper.match(
    /\$\s*[\d.]+\s*(?:WORTH\s+OF\s+|OF\s+)?([A-Z]{2,10})\b/
  );
  if (afterMoney?.[1] && !stop.has(afterMoney[1])) {
    return afterMoney[1];
  }

  const afterUsd = upper.match(
    /[\d.]+\s*(?:USD|USDT|DOLLARS?)\s+(?:WORTH\s+OF\s+|OF\s+)?([A-Z]{2,10})\b/
  );
  if (afterUsd?.[1] && !stop.has(afterUsd[1])) {
    return afterUsd[1];
  }

  const words = upper.match(/\b[A-Z]{2,10}\b/g) ?? [];
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (!stop.has(w) && w.length >= 2) return w;
  }
  return undefined;
}

/** Parse explicit trade commands: [buy|sell] [amount] [token] */
function parseTradeCommand(text: string): ParsedIntent | undefined {
  const lower = text.toLowerCase().trim();
  const actionMatch = lower.match(TRADE_ACTION_RE);
  if (!actionMatch) return undefined;

  const verb = actionMatch[1];
  const action: ParsedIntent["action"] =
    /^(buy|long|purchase)$/i.test(verb) ? "buy" : "sell";

  const amount = extractAmount(text);
  const symbol = extractTradeSymbol(text, verb);

  if (symbol || amount !== undefined) {
    return { action, symbol, amount };
  }
  return { action };
}

export function parseCommand(raw: string): ParsedIntent {
  const text = raw.trim();
  const lower = text.toLowerCase();

  if (/^help\b/.test(lower) || lower === "?") {
    return { action: "help" };
  }

  if (/\b(portfolio|positions?|holdings?|balance)\b/.test(lower)) {
    return { action: "portfolio" };
  }

  if (/\b(status|state|health)\b/.test(lower)) {
    return { action: "status" };
  }

  if (/\b(eligible|allowlist|allowed\s+tokens?|tradeable\s+tokens?)\b/.test(lower)) {
    return { action: "eligible" };
  }

  // swap X for/with/to Y
  const swapMatch = lower.match(
    /\bswap\s+(\w+)\s+(?:for|with|to|into)\s+(\w+)/
  );
  if (swapMatch) {
    return {
      action: "swap",
      symbol: swapMatch[1].toUpperCase(),
      toSymbol: swapMatch[2].toUpperCase(),
      amount: extractAmount(text),
    };
  }

  // buy / sell — [action] [amount] [token]
  const trade = parseTradeCommand(text);
  if (trade) return trade;

  if (/\b(buy|long|purchase|opportunit)/i.test(lower)) {
    const symbol = extractTradeSymbol(text, "buy");
    return { action: "buy", symbol, amount: extractAmount(text) };
  }
  if (/\b(sell|dump|exit|close)\b/.test(lower)) {
    const symbol = extractTradeSymbol(text, "sell");
    return { action: "sell", symbol, amount: extractAmount(text) };
  }

  // "top signals" or signal for a specific token
  if (/\b(signal|indicator|technical|top\s+signal)/i.test(lower)) {
    const symbol = extractToken(text);
    return { action: "signal", symbol };
  }
  if (/\b(analy[sz]|market|overview|sentiment|summary)\b/.test(lower)) {
    const symbol = extractToken(text);
    return { action: "analysis", symbol };
  }

  // "what should I trade/buy" → show buy opportunities
  if (/\b(what\s+should|recommend|suggest|trade)\b/i.test(lower)) {
    return { action: "buy" };
  }

  // price check — treat as signal
  if (/\b(price|quote)\b/.test(lower)) {
    const symbol = extractToken(text);
    return { action: "signal", symbol };
  }

  return { action: "unknown" };
}

/**
 * BNB is tracked as gas reserve, not an open position — use Binance Web3 or gasReserve.
 */
function formatBnbHolding(agent: TradingAgent): string {
  const state = agent.getStateSnapshot();
  const binanceBnb = state.binancePositions?.find((p) => p.symbol === "BNB");
  if (binanceBnb && binanceBnb.remainQty > 0) {
    const val =
      binanceBnb.valueUsd > 0 ? binanceBnb.valueUsd : binanceBnb.remainQty * binanceBnb.price;
    return `${binanceBnb.remainQty.toFixed(4)} (~$${val.toFixed(2)})`;
  }
  const gas = agent.getPortfolio().gasReserve;
  if (gas.amount > 0 || gas.valueUsd > 0) {
    return `${gas.amount.toFixed(4)} (~$${gas.valueUsd.toFixed(2)})`;
  }
  const gasUsd = state.portfolio.gasReserveUsd ?? 0;
  if (gasUsd > 0) {
    return `~$${gasUsd.toFixed(2)} (gas reserve in NAV)`;
  }
  return "none detected";
}

function formatWalletHoldingsLines(agent: TradingAgent): string[] {
  const state = agent.getStateSnapshot();
  const portfolio = agent.getPortfolio();
  const lines: string[] = [];

  const bnb = formatBnbHolding(agent);
  if (bnb !== "none detected") {
    lines.push(`  BNB (gas):     ${bnb}`);
  }

  const binanceUsdt = state.binancePositions?.find((p) => p.symbol === "USDT");
  if (binanceUsdt && binanceUsdt.remainQty > 0) {
    lines.push(`  USDT (cash):   ${binanceUsdt.remainQty.toFixed(2)}`);
  } else if (state.portfolio.cashUsd > 0) {
    lines.push(`  USDT (cash):   $${state.portfolio.cashUsd.toFixed(2)}`);
  }

  for (const [sym, pos] of portfolio.getAllPositions()) {
    const px = getLatestPrice(sym) ?? pos.avgEntryPrice;
    lines.push(`  ${sym.padEnd(6)}       ${pos.amount.toFixed(4)} (~$${(pos.amount * px).toFixed(2)})`);
  }

  if (lines.length === 0) {
    lines.push(`  none tracked yet`);
  }

  return lines;
}

/**
 * Build a short context string about the agent's current state
 * so the LLM can ground its responses.
 */
function buildAgentContext(agent: TradingAgent): string {
  const state = agent.getStateSnapshot();
  const snap = state.portfolio;
  const positions = [...agent.getPortfolio().getAllPositions().entries()]
    .map(([sym, pos]) => {
      const px = getLatestPrice(sym) ?? pos.avgEntryPrice;
      return `${sym}: ${pos.amount.toFixed(4)} @ $${px.toFixed(2)}`;
    })
    .join(", ");

  return [
    `Mode: ${state.mode} | Running: ${state.running}`,
    `NAV: $${snap.totalValueUsd.toFixed(2)} | Cash: $${snap.cashUsd.toFixed(2)}`,
    `BNB gas reserve: ${formatBnbHolding(agent)}`,
    `Drawdown: ${snap.maxDrawdownPct.toFixed(1)}% | PnL: $${(snap.realizedPnl ?? 0).toFixed(2)}`,
    `Open token positions: ${positions || "none"}`,
    `Fear & Greed: ${state.fearGreedIndex ?? "N/A"}`,
    `Watchlist: ${state.watchlist.slice(0, 15).join(", ")}`,
    `Cycle: #${state.cycleCount}`,
  ].join("\n");
}

/**
 * Execute a parsed command against the live agent.
 * Uses LLM parsing when OPENAI_API_KEY is set, regex fallback otherwise.
 */
export async function executeCommand(
  agent: TradingAgent,
  raw: string,
): Promise<CommandResult> {
  let intent: ParsedIntent;

  const regexIntent = parseCommand(raw);

  if (isLlmConfigured()) {
    try {
      const context = buildAgentContext(agent);
      const llmIntent = await llmParseCommand(raw, context);
      intent = llmIntent;
      // User's literal $ amount and ticker beat LLM guesses (e.g. "$200" not default $50).
      const rawAmount = extractAmount(raw);
      if (rawAmount !== undefined) {
        intent.amount = rawAmount;
      }
      if (
        (regexIntent.action === "buy" || regexIntent.action === "sell") &&
        TRADE_ACTION_RE.test(raw)
      ) {
        intent.action = regexIntent.action;
        const verb = regexIntent.action === "buy" ? "buy" : "sell";
        intent.symbol =
          extractTradeSymbol(raw, verb) ??
          regexIntent.symbol ??
          intent.symbol;
      } else {
        if (regexIntent.symbol && !intent.symbol) {
          intent.symbol = regexIntent.symbol;
        }
      }
      if (
        (intent.action === "chat" || intent.action === "unknown") &&
        (regexIntent.action === "buy" || regexIntent.action === "sell")
      ) {
        intent.action = regexIntent.action;
        intent.symbol ??= regexIntent.symbol;
        intent.amount ??= regexIntent.amount;
      }
    } catch {
      intent = regexIntent;
    }
  } else {
    intent = regexIntent;
  }

  // Sells without an explicit $ amount mean "full position" — override LLM defaults.
  if (intent.action === "sell" && extractAmount(raw) === undefined) {
    intent.amount = undefined;
  }

  logger.info("Command received", {
    raw,
    intent: intent.action,
    symbol: intent.symbol,
    amount: intent.amount,
    llm: isLlmConfigured(),
  });

  switch (intent.action) {
    case "help":
      return {
        ok: true,
        intent: "help",
        message: [
          "📖 COMMAND REFERENCE",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          "",
          "▸ Trading",
          "  buy              → Top buy opportunities",
          "  buy $50 SIREN    → Buy $50 of a token",
          "  buy 50$ siren     → Same (amount before or after $)",
          "  sell              → Sellable positions",
          "  sell $25 ETH      → Sell $25 worth of a token",
          "  sell SIREN        → Sell full position",
          "  swap ETH for BNB  → Swap between tokens",
          "",
          "▸ Analysis",
          "  signal            → Top signals overview",
          "  signal BTC        → Detailed technical analysis",
          "  market analysis   → Market overview & trends",
          "",
          "▸ Account",
          "  portfolio         → Positions, PnL & balances",
          "  status            → Agent health & config",
          "  eligible tokens   → Allowlist & your holdings",
          "",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          "💡 You can also ask in natural language!",
        ].join("\n"),
      };

    case "buy":
    case "sell":
      return executeTrade(agent, intent);

    case "swap":
      return executeSwap(agent, intent);

    case "signal":
      return getSignalDetail(agent, intent.symbol);

    case "analysis":
      return getMarketAnalysis(agent, intent.symbol);

    case "portfolio":
      return getPortfolioSummary(agent);

    case "status":
      return getStatusSummary(agent);

    case "eligible":
      return getEligibleTokensSummary(agent);

    case "chat":
      return {
        ok: true,
        intent: "chat",
        message: intent.chatReply || "I'm not sure how to answer that. Try asking about a specific token, your portfolio, or say \"help\".",
      };

    default:
      return {
        ok: false,
        intent: "unknown",
        message: [
          `❓ DIDN'T CATCH THAT`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          isLlmConfigured()
            ? `I couldn't figure out what you meant.`
            : `Command not recognized.`,
          ``,
          `Try one of these:`,
          `  • "signal"           — Top signals`,
          `  • "buy"              — Buy opportunities`,
          `  • "portfolio"        — Your positions`,
          `  • "market analysis"  — Market overview`,
          `  • "help"             — All commands`,
        ].join("\n"),
      };
  }
}

function ineligibleTokenResponse(
  agent: TradingAgent,
  symbol: string,
  intent: string,
): CommandResult {
  const held = [...agent.getPortfolio().getAllPositions().keys()];
  const heldEligible = held.filter((s) => isEligibleToken(s));
  const sample = getEligibleScanUniverse().filter((t) => !isStablecoin(t)).slice(0, 10).join(", ");

  if (isStablecoin(symbol)) {
    return {
      ok: false,
      intent,
      message: [
        `⚠️ ${symbol} IS BASE CURRENCY`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `${symbol} settles trades — the agent buys tokens with USDT and sells back to USDT.`,
        `You don't need to "buy" ${symbol} directly.`,
        ``,
        `Cash (USDT): $${agent.getStateSnapshot().portfolio.cashUsd.toFixed(2)}`,
      ].join("\n"),
      suggestions: ["Buy opportunities", "portfolio"],
    };
  }

  const heldHint =
    heldEligible.length > 0
      ? `You hold: ${heldEligible.join(", ")} — try "sell ${heldEligible[0]}" or "signal ${heldEligible[0]}".`
      : "";

  return {
    ok: false,
    intent,
    message: [
      `⚠️ ${symbol} NOT ON SAFE LIST`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `Only Binance Spot + Binance Alpha tokens are tradable (lower risk vs unknown coins).`,
      heldHint,
      ``,
      `Examples: ${sample}…`,
      `Ask "eligible tokens" for the full list.`,
    ].filter(Boolean).join("\n"),
    suggestions: [
      "eligible tokens",
      "Buy opportunities",
      heldEligible.length > 0 ? `sell ${heldEligible[0]}` : "Top signals",
    ],
  };
}

function getEligibleTokensSummary(agent: TradingAgent): CommandResult {
  const tradeable = getEligibleScanUniverse().filter((t) => !isStablecoin(t));
  const held = [...agent.getPortfolio().getAllPositions().keys()]
    .filter((s) => isEligibleToken(s));
  const watchlist = agent.getStateSnapshot().watchlist.slice(0, 12);
  const alphaLive = getBinanceAlphaTokenCount();

  const lines = [
    `📋 SAFE TOKEN LIST`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `${tradeable.length} tokens: Binance Spot ∪ Binance Alpha on BSC (USDT settlement).`,
    `  Alpha: ~${alphaLive} live BSC listings (synced from Binance API).`,
    ``,
    `▸ Settlement only`,
    `  USDT / stables — not bought directly`,
    ``,
    `▸ Note`,
    `  BNB is eligible; wallet BNB is tracked as gas reserve`,
    ``,
    `▸ Your Wallet`,
    ...formatWalletHoldingsLines(agent),
    ``,
    `▸ Your holdings (safe-list tokens)`,
    held.length > 0 ? `  ${held.join(", ")}` : `  none`,
    ``,
    `▸ Active watchlist`,
    `  ${watchlist.join(", ")}`,
    ``,
    `▸ Sample allowlist`,
    `  ${tradeable.slice(0, 15).join(", ")}…`,
  ];

  const suggestions = ["Buy opportunities", "Top signals"];
  if (held.length > 0) suggestions.push(`signal ${held[0]}`);
  else if (watchlist.length > 0) suggestions.push(`signal ${watchlist[0]}`);

  return { ok: true, intent: "eligible", message: lines.join("\n"), suggestions };
}

async function ensureSellablePosition(
  agent: TradingAgent,
  symbol: string
): Promise<{ ok: boolean; message?: string }> {
  const portfolio = agent.getPortfolio();
  const pos = portfolio.getAllPositions().get(symbol);
  if (pos && pos.amount > 0) return { ok: true };

  try {
    if (await agent.ensureTrackedPosition(symbol)) return { ok: true };
  } catch {
    /* fall through */
  }

  const state = agent.getStateSnapshot();
  const onChain = state.binancePositions?.find((p) => p.symbol === symbol);
  if (onChain && onChain.remainQty > 0) {
    return {
      ok: false,
      message: [
        `Wallet shows ${onChain.remainQty.toFixed(4)} ${symbol} on-chain`,
        `but the agent could not read a transferable balance yet.`,
        `Try again in a moment or use the wallet resync button.`,
      ].join("\n"),
    };
  }

  return { ok: false };
}

async function executeTrade(
  agent: TradingAgent,
  intent: ParsedIntent,
): Promise<CommandResult> {
  if (!intent.symbol) {
    if (intent.action === "buy") {
      return getBuyOpportunities(agent);
    }
    return getSellablePositions(agent);
  }

  const symbol = intent.symbol.toUpperCase();
  // Buys: Binance Spot ∪ Alpha only. Sells: allow unwinding held tokens even if
  // they later leave the allowlist (still need a routable BSC contract).
  if (intent.action === "buy" && !isEligibleToken(symbol)) {
    return ineligibleTokenResponse(agent, symbol, intent.action);
  }
  if (intent.action === "buy" && isStablecoin(symbol)) {
    return ineligibleTokenResponse(agent, symbol, intent.action);
  }
  if (!isEligibleToken(symbol) && intent.action === "sell") {
    let routable = hasBscSwapAddress(symbol);
    if (!routable) {
      try {
        routable = (await resolveBscTokenAddress(symbol)) !== undefined;
      } catch (err) {
        logger.warn("Token address resolve failed for manual sell", {
          symbol,
          error: String(err),
        });
      }
    }
    if (!routable) {
      return ineligibleTokenResponse(agent, symbol, intent.action);
    }
  }

  const config = agent.getConfig();

  if (intent.action === "sell") {
    const sellable = await ensureSellablePosition(agent, symbol);
    if (!sellable.ok) {
      return {
        ok: false,
        intent: "sell",
        message: [
          `⚠️ NO POSITION FOUND`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          sellable.message ?? `You don't hold any ${symbol} to sell.`,
          ``,
          `💡 Try "portfolio" to see your positions`,
          `   or "sell" to see sellable tokens.`,
        ].join("\n"),
        suggestions: ["portfolio", "sell", "Eligible tokens"],
      };
    }
  }

  const requestedUsd = intent.amount;
  const displayUsd = requestedUsd ?? config.maxPositionSizeUsd;

  const signal = {
    symbol,
    action: intent.action as "buy" | "sell",
    strength: (intent.action === "buy" ? "strong_buy" : "strong_sell") as
      | "strong_buy"
      | "strong_sell",
    score: intent.action === "buy" ? 80 : -80,
    reasons: [`Manual ${intent.action} command from operator`],
    targetAllocationPct: 10,
    confidence: 1.0,
  };

  try {
    const sellAll = intent.action === "sell" && intent.amount === undefined;
    const { result, violations, tradeSizeUsd } = await agent.executeManualTrade(signal, {
      amountUsd: requestedUsd,
      sellAll,
    });
    const sizeUsd = tradeSizeUsd ?? displayUsd;
    if (!result) {
      const reason =
        violations?.length
          ? violations.join("; ")
          : "Rejected by risk manager or no quote available";
      return {
        ok: false,
        intent: intent.action,
        message: [
          `⚠️ ${intent.action.toUpperCase()} REJECTED`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `Token:     ${symbol}`,
          `Requested: ${requestedUsd !== undefined ? `$${requestedUsd.toFixed(2)}` : "(full position)"}`,
          `Size:      $${sizeUsd.toFixed(2)}`,
          `Reason:    ${reason}`,
          ``,
          ...(intent.action === "sell"
            ? [`💡 Swaps to USDT: "sell ${symbol}" or "swap ${symbol} for USDT"`]
            : [`💡 Check USDT balance, blacklist, or on-chain routing.`]),
        ].join("\n"),
        suggestions:
          intent.action === "sell"
            ? ["portfolio", `signal ${symbol}`]
            : ["Buy opportunities", "status"],
      };
    }
    const r = result;
    if (r.success) {
      const spentUsd =
        intent.action === "buy" && r.fromAmount && parseFloat(r.fromAmount) > 0
          ? parseFloat(r.fromAmount)
          : sizeUsd;
      const qtyLine =
        intent.action === "buy"
          ? `Spent:   $${spentUsd.toFixed(2)}`
          : r.fromAmount && parseFloat(r.fromAmount) > 0
            ? `${parseFloat(r.fromAmount).toFixed(4)} ${symbol}`
            : `$${sizeUsd.toFixed(2)}`;
      const partialNote =
        requestedUsd !== undefined &&
        requestedUsd > spentUsd + 0.01
          ? [`Note:    Requested $${requestedUsd.toFixed(2)} — only $${spentUsd.toFixed(2)} USDT available.`]
          : [];
      return {
        ok: true,
        intent: intent.action,
        message: [
          `✅ ${intent.action.toUpperCase()} EXECUTED`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `Token:   ${symbol}`,
          qtyLine,
          ...partialNote,
          `Tx:      ${r.txHash ?? "confirmed"}`,
          ``,
          `💡 Check "portfolio" to see updated positions.`,
        ].join("\n"),
        data: { ...r } as Record<string, unknown>,
      };
    }
    return {
      ok: false,
      intent: intent.action,
      message: [
        `❌ ${intent.action.toUpperCase()} FAILED`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `Token:   ${symbol}`,
        `Error:   ${r.error ?? "unknown error"}`,
      ].join("\n"),
      data: { ...r } as Record<string, unknown>,
    };
  } catch (err) {
    return {
      ok: false,
      intent: intent.action,
      message: [
        `❌ ${intent.action.toUpperCase()} ERROR`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `Token:   ${symbol}`,
        `Error:   ${String(err)}`,
      ].join("\n"),
    };
  }
}

async function getBuyOpportunities(agent: TradingAgent): Promise<CommandResult> {
  const state = agent.getStateSnapshot();
  const fgi = state.fearGreedIndex;
  const cashUsd = state.portfolio.cashUsd;
  const spendableUsd = typeof state.risk.spendableCashUsd === "number"
    ? state.risk.spendableCashUsd
    : cashUsd;

  const opportunities: { sym: string; price: number; score: number; action: string; confidence: number; reasons: string[] }[] = [];

  for (const sym of state.watchlist.slice(0, 20)) {
    const price = getLatestPrice(sym);
    if (!price) continue;
    const t = computeSignals(sym);
    const m = buildMarketData(sym, price);
    const s = generateSignal(m, t, fgi, null, state.config.strategy);
    if (s.action === "buy" && s.score > 0) {
      opportunities.push({ sym, price, score: s.score, action: s.action, confidence: s.confidence, reasons: s.reasons });
    }
  }

  opportunities.sort((a, b) => b.score - a.score);
  const top = opportunities.slice(0, 5);

  const lines = [
    `🛒 BUY OPPORTUNITIES`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Swap balance:    $${spendableUsd.toFixed(2)} (USDT + BNB)`,
    `  USDT cash:       $${cashUsd.toFixed(2)}`,
    `Fear & Greed:    ${fgi ?? "N/A"} ${fgi ? (fgi < 30 ? "(Fear)" : fgi < 55 ? "(Neutral)" : "(Greed)") : ""}`,
    ``,
  ];

  if (top.length === 0) {
    lines.push("No strong buy signals right now.");
    lines.push("", `💡 The agent scans ${state.watchlist.length} tokens each cycle.`);
    lines.push(`   Wait for the next cycle or try "market analysis".`);
  } else {
    lines.push(`▸ Top ${top.length} Buy Signals`);
    lines.push(`${"Token".padEnd(8)} ${"Price".padEnd(14)} ${"Score".padEnd(8)} ${"Confidence".padEnd(12)}`);
    lines.push(`${"─".repeat(8)} ${"─".repeat(14)} ${"─".repeat(8)} ${"─".repeat(12)}`);
    for (const o of top) {
      const priceStr = `$${o.price.toFixed(o.price < 1 ? 6 : 2)}`;
      lines.push(`${o.sym.padEnd(8)} ${priceStr.padEnd(14)} ${o.score.toFixed(0).padEnd(8)} ${(o.confidence * 100).toFixed(0)}%`);
    }
    lines.push(``);
    lines.push(`💡 To buy: "buy ${top[0].sym} $5"`);
  }

  return { ok: true, intent: "buy", message: lines.join("\n") };
}

function getSellablePositions(agent: TradingAgent): Promise<CommandResult> {
  const portfolio = agent.getPortfolio();
  const positions = portfolio.getAllPositions();
  const fgi = agent.getFearGreedIndex();

  const lines = [
    `📤 SELLABLE POSITIONS`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
  ];

  if (positions.size === 0) {
    lines.push("You don't hold any tokens to sell.");
    lines.push("", `💡 Try "buy" to see buy opportunities.`);
  } else {
    lines.push(`${"Token".padEnd(8)} ${"Amount".padEnd(12)} ${"Value".padEnd(12)} ${"PnL".padEnd(10)}`);
    lines.push(`${"─".repeat(8)} ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(10)}`);
    for (const [sym, pos] of positions) {
      const price = getLatestPrice(sym) ?? pos.avgEntryPrice;
      const value = pos.amount * price;
      const pnl = pos.amount * (price - pos.avgEntryPrice);
      const pnlSign = pnl >= 0 ? "+" : "";
      lines.push(
        `${sym.padEnd(8)} ${pos.amount.toFixed(4).padEnd(12)} $${value.toFixed(2).padEnd(11)} ${pnlSign}$${pnl.toFixed(2)}`
      );
    }
    const first = [...positions.keys()][0];
    lines.push(``, `💡 To sell: "sell ${first}"`);
  }

  return Promise.resolve({ ok: true, intent: "sell", message: lines.join("\n") });
}

async function executeSwap(
  agent: TradingAgent,
  intent: ParsedIntent,
): Promise<CommandResult> {
  if (!intent.symbol || !intent.toSymbol) {
    return {
      ok: false,
      intent: "swap",
      message: [
        `⚠️ MISSING TOKENS`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `Specify both tokens for a swap.`,
        ``,
        `💡 Example: "swap ETH for USDT"`,
      ].join("\n"),
    };
  }

  const from = intent.symbol.toUpperCase();
  const to = intent.toSymbol.toUpperCase();

  if (isStablecoin(from) && !isStablecoin(to)) {
    return executeTrade(agent, { action: "buy", symbol: to, amount: intent.amount });
  }
  if (!isStablecoin(from) && isStablecoin(to)) {
    const sellable = await ensureSellablePosition(agent, from);
    if (!sellable.ok) {
      return {
        ok: false,
        intent: "swap",
        message: [
          `⚠️ CANNOT SWAP ${from}`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          sellable.message ?? `No ${from} balance to swap.`,
          ``,
          `💡 Use "portfolio" to verify holdings.`,
        ].join("\n"),
        suggestions: ["portfolio", "sell"],
      };
    }
    return executeTrade(agent, { action: "sell", symbol: from, amount: intent.amount });
  }

  return {
    ok: false,
    intent: "swap",
    message: [
      `⚠️ SWAP NOT SUPPORTED`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `Direct ${from} → ${to} swap is not available.`,
      ``,
      `💡 Try: sell ${from} first, then buy ${to}.`,
    ].join("\n"),
  };
}

async function getSignalDetail(
  agent: TradingAgent,
  symbol?: string,
): Promise<CommandResult> {
  if (!symbol) {
    return getTopSignals(agent);
  }

  const upper = symbol.toUpperCase();

  let price = getLatestPrice(upper);
  if (price === null) {
    // Resolve contract + live price on demand (CMC → bridge) for any eligible
    // token that isn't currently on the watchlist.
    const primed = await agent.primeTokenForTrade(upper);
    price = primed.price ?? getLatestPrice(upper);
  }

  if (price === null) {
    return {
      ok: false,
      intent: "signal",
      message: [
        `⚠️ NO DATA`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `No price data available for ${upper}.`,
        `It may not be listed on CMC/BSC.`,
        ``,
        `💡 Try "signal" to see all available signals.`,
      ].join("\n"),
    };
  }

  const technicals = computeSignals(upper);
  const market = buildMarketData(upper, price);
  const signal = generateSignal(market, technicals, agent.getFearGreedIndex(), null, agent.getConfig().strategy);
  const { momentum, atrPct } = getTokenMomentumMetrics(upper);

  let aiBlock: string[] = [];
  if (isAiAnalysisEnabled()) {
    const ai = await analyzeSingleSignal(signal, market, technicals, agent.getFearGreedIndex());
    if (ai) {
      const verdictIcon =
        ai.verdict === "bullish" ? "🟢" : ai.verdict === "bearish" ? "🔴" : ai.verdict === "caution" ? "⚠️" : "🟡";
      aiBlock = [
        ``,
        `▸ AI Technical Analysis`,
        `  Verdict:     ${verdictIcon} ${ai.verdict.toUpperCase()}`,
        `  Agrees:      ${ai.agreesWithSignal ? "Yes ✓" : "No — review carefully"}`,
        `  AI Conf:     ${(ai.confidence * 100).toFixed(0)}%`,
        `  Summary:     ${ai.summary}`,
        ...(ai.risks.length > 0 ? [`  Risks:       ${ai.risks.join("; ")}`] : []),
      ];
    }
  }

  const actionIcon = signal.action === "buy" ? "🟢" : signal.action === "sell" ? "🔴" : "🟡";

  const lines = [
    `📊 SIGNAL ANALYSIS — ${upper}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `▸ Overview`,
    `  Price:       $${price.toFixed(price < 1 ? 6 : 2)}`,
    `  Action:      ${actionIcon} ${signal.action.toUpperCase()}`,
    `  Strength:    ${signal.strength}`,
    `  Score:       ${signal.score.toFixed(0)}/100`,
    `  Confidence:  ${(signal.confidence * 100).toFixed(0)}%`,
    ``,
    `▸ Technical Indicators`,
    `  RSI(14):     ${technicals.rsi !== null ? technicals.rsi.toFixed(1) : "N/A"}`,
    `  MACD:        ${technicals.macd ? `${technicals.macd.histogram > 0 ? "+" : ""}${technicals.macd.histogram.toFixed(4)}` : "N/A"}`,
    `  EMA 12/26:   ${technicals.ema ? `${technicals.ema.fast.toFixed(4)} / ${technicals.ema.slow.toFixed(4)}` : "N/A"}`,
    `  Bollinger:   ${technicals.bollingerBands ? `${technicals.bollingerBands.lower.toFixed(4)} — ${technicals.bollingerBands.upper.toFixed(4)}` : "N/A"}`,
    `  ATR(14):     ${technicals.atr !== null ? technicals.atr.toFixed(4) : "N/A"} ${atrPct !== null ? `(${atrPct.toFixed(1)}%)` : ""}`,
    `  Vol Ratio:   ${technicals.volumeRatio !== null ? technicals.volumeRatio.toFixed(2) + "x" : "N/A"}`,
    `  Momentum:    ${momentum !== null ? (momentum > 0 ? "+" : "") + momentum.toFixed(1) + "%" : "N/A"}`,
    ``,
    `▸ Reasoning`,
    ...signal.reasons.map((r) => `  • ${r}`),
    ...aiBlock,
  ];

  return {
    ok: true,
    intent: "signal",
    message: lines.join("\n"),
    data: { signal, technicals, price },
  };
}

async function getTopSignals(agent: TradingAgent): Promise<CommandResult> {
  const state = agent.getStateSnapshot();
  const fgi = state.fearGreedIndex;

  const signals: { sym: string; price: number; action: string; score: number; confidence: number }[] = [];

  for (const sym of state.watchlist.slice(0, 20)) {
    const price = getLatestPrice(sym);
    if (!price) continue;
    const t = computeSignals(sym);
    const m = buildMarketData(sym, price);
    const s = generateSignal(m, t, fgi, null, state.config.strategy);
    signals.push({ sym, price, action: s.action, score: s.score, confidence: s.confidence });
  }

  signals.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  const top = signals.slice(0, 8);

  const lines = [
    `📊 TOP SIGNALS OVERVIEW`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Scanning:      ${state.watchlist.length} tokens`,
    `Fear & Greed:  ${fgi ?? "N/A"} ${fgi ? (fgi < 30 ? "(Fear)" : fgi < 55 ? "(Neutral)" : "(Greed)") : ""}`,
    ``,
  ];

  if (top.length === 0) {
    lines.push("No signals available — waiting for price data.");
  } else {
    lines.push(`${"Token".padEnd(8)} ${"Price".padEnd(14)} ${"Signal".padEnd(8)} ${"Score".padEnd(8)} ${"Conf".padEnd(6)}`);
    lines.push(`${"─".repeat(8)} ${"─".repeat(14)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(6)}`);
    for (const s of top) {
      const icon = s.action === "buy" ? "🟢" : s.action === "sell" ? "🔴" : "🟡";
      const priceStr = `$${s.price.toFixed(s.price < 1 ? 6 : 2)}`;
      lines.push(
        `${s.sym.padEnd(8)} ${priceStr.padEnd(14)} ${icon} ${s.action.toUpperCase().padEnd(5)} ${s.score.toFixed(0).padStart(4)}     ${(s.confidence * 100).toFixed(0)}%`
      );
    }
    lines.push(``);
    lines.push(`💡 For details: "signal ${top[0].sym}"`);
  }

  return { ok: true, intent: "signal", message: lines.join("\n") };
}

async function getMarketAnalysis(
  agent: TradingAgent,
  symbol?: string,
): Promise<CommandResult> {
  if (symbol) {
    return getSignalDetail(agent, symbol);
  }

  const state = agent.getStateSnapshot();
  const positions = agent.getPortfolio().getAllPositions();
  const fgi = state.fearGreedIndex;

  const buySignals: string[] = [];
  const sellSignals: string[] = [];

  for (const sym of state.watchlist.slice(0, 15)) {
    const price = getLatestPrice(sym);
    if (!price) continue;
    const t = computeSignals(sym);
    const m = buildMarketData(sym, price);
    const s = generateSignal(m, t, fgi, null, state.config.strategy);
    const priceStr = `$${price.toFixed(price < 1 ? 4 : 2)}`;
    if (s.action === "buy") {
      buySignals.push(`  🟢 ${sym.padEnd(6)} ${priceStr.padEnd(12)} score ${s.score.toFixed(0)}`);
    } else if (s.action === "sell") {
      sellSignals.push(`  🔴 ${sym.padEnd(6)} ${priceStr.padEnd(12)} score ${s.score.toFixed(0)}`);
    }
  }

  const fgiLabel = fgi ? (fgi < 25 ? "Extreme Fear" : fgi < 40 ? "Fear" : fgi < 55 ? "Neutral" : fgi < 75 ? "Greed" : "Extreme Greed") : "N/A";

  const lines = [
    `🌐 MARKET OVERVIEW`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `▸ Your Wallet`,
    ...formatWalletHoldingsLines(agent),
    ``,
    `▸ Market Sentiment`,
    `  Fear & Greed:    ${fgi ?? "N/A"} — ${fgiLabel}`,
    `  Cycle:           #${state.cycleCount}`,
    `  Tokens Tracked:  ${state.watchlist.length}`,
    `  Open Positions:  ${positions.size} (trade tokens; BNB gas listed above)`,
    ``,
  ];

  if (buySignals.length > 0) {
    lines.push(`▸ Buy Signals (${buySignals.length})`);
    lines.push(...buySignals);
    lines.push(``);
  }
  if (sellSignals.length > 0) {
    lines.push(`▸ Sell Signals (${sellSignals.length})`);
    lines.push(...sellSignals);
    lines.push(``);
  }
  if (buySignals.length === 0 && sellSignals.length === 0) {
    lines.push(`No strong signals this cycle — all tokens on HOLD.`);
    lines.push(``);
  }

  lines.push(`💡 For token details: "signal <TOKEN>"`);

  return { ok: true, intent: "analysis", message: lines.join("\n") };
}

function getPortfolioSummary(agent: TradingAgent): CommandResult {
  const prices = new Map<string, number>();
  const portfolio = agent.getPortfolio();
  for (const [sym] of portfolio.getAllPositions()) {
    const p = getLatestPrice(sym);
    if (p !== null) prices.set(sym, p);
  }

  const snap = portfolio.snapshot(prices);
  const gas = portfolio.gasReserve;
  const trades = portfolio.getTradeHistory();
  const realizedPnl = snap.realizedPnl ?? 0;
  const pnlIcon = realizedPnl >= 0 ? "📈" : "📉";

  const lines = [
    `💼 PORTFOLIO SUMMARY`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `▸ Balances`,
    `  Total NAV:     $${snap.totalValueUsd.toFixed(2)}`,
    `  Cash (USDT):   $${snap.cashUsd.toFixed(2)}`,
    `  Swap balance:  $${portfolio.getSpendableCash().toFixed(2)} (USDT + spendable BNB)`,
  ];

  if (gas.valueUsd > 0) {
    lines.push(`  Gas (${gas.symbol}):     ${gas.amount.toFixed(4)} (~$${gas.valueUsd.toFixed(2)})`);
  } else {
    const bnb = formatBnbHolding(agent);
    if (bnb !== "none detected") {
      lines.push(`  Gas (BNB):     ${bnb}`);
    }
  }

  lines.push(
    ``,
    `▸ Performance`,
    `  Realized PnL:  ${pnlIcon} ${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(2)}`,
    `  Max Drawdown:  ${snap.maxDrawdownPct.toFixed(1)}%`,
    `  Total Trades:  ${trades.length}`,
    ``,
  );

  if (snap.positions.length > 0) {
    lines.push(`▸ Open Positions (${snap.positions.length})`);
    lines.push(`  ${"Token".padEnd(7)} ${"Qty".padEnd(10)} ${"Price".padEnd(10)} ${"PnL".padEnd(10)} ${"Weight"}`);
    lines.push(`  ${"─".repeat(7)} ${"─".repeat(10)} ${"─".repeat(10)} ${"─".repeat(10)} ${"─".repeat(6)}`);
    for (const pos of snap.positions) {
      const pnlSign = pos.unrealizedPnl >= 0 ? "+" : "";
      lines.push(
        `  ${pos.symbol.padEnd(7)} ${pos.amount.toFixed(4).padEnd(10)} $${pos.currentPrice.toFixed(2).padEnd(9)} ${pnlSign}$${pos.unrealizedPnl.toFixed(2).padEnd(9)} ${pos.weight.toFixed(1)}%`
      );
    }
  } else {
    lines.push(`▸ No open positions`);
  }

  return { ok: true, intent: "portfolio", message: lines.join("\n") };
}

function getStatusSummary(agent: TradingAgent): CommandResult {
  const state = agent.getStateSnapshot();
  const snap = state.portfolio;
  const uptime = state.startedAt ? Math.floor((Date.now() - state.startedAt) / 60000) : 0;

  const uptimeStr = uptime >= 60
    ? `${Math.floor(uptime / 60)}h ${uptime % 60}m`
    : `${uptime}m`;

  const lines = [
    `⚙️ AGENT STATUS`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `▸ Runtime`,
    `  Mode:          ${state.mode}`,
    `  Running:       ${state.running ? "🟢 YES" : "🔴 NO"}`,
    `  Uptime:        ${uptimeStr}`,
    `  Cycle:         #${state.cycleCount}`,
    ``,
    `▸ Financial`,
    `  NAV:           $${snap.totalValueUsd.toFixed(2)}`,
    `  Max Drawdown:  ${snap.maxDrawdownPct.toFixed(1)}%`,
    ``,
    `▸ Data Sources`,
    `  Bridge:        ${state.bridgeSource ?? "unknown"}`,
    `  Watchlist:     ${state.watchlist.length} tokens`,
    `  Fear & Greed:  ${state.fearGreedIndex ?? "N/A"}`,
  ];

  return { ok: true, intent: "status", message: lines.join("\n") };
}
