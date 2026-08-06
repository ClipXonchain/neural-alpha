import OpenAI from "openai";
import { logger } from "../utils/logger.js";

export interface LlmParsedIntent {
  action: "buy" | "sell" | "swap" | "signal" | "analysis" | "portfolio" | "status" | "help" | "eligible" | "chat";
  symbol?: string;
  toSymbol?: string;
  amount?: number;
  chatReply?: string;
}

const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "execute_action",
      description: "Execute a trading action or query based on the user's natural language command.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["buy", "sell", "swap", "signal", "analysis", "portfolio", "status", "help", "eligible", "chat"],
            description: "The intent: buy/sell/swap execute trades. signal = technical analysis for a token. analysis = broad market overview. portfolio = show positions & PnL. status = agent health. eligible = list tradeable allowlist tokens. help = list commands. chat = general conversation or question that doesn't map to a specific action.",
          },
          symbol: {
            type: "string",
            description: "Primary token symbol (e.g. ETH, BTC, 1INCH). Uppercase, no $ prefix. Required for buy/sell/signal. Optional for analysis.",
          },
          toSymbol: {
            type: "string",
            description: "Destination token symbol for swap (e.g. 'swap ETH for USDT' → toSymbol=USDT).",
          },
          amount: {
            type: "number",
            description:
              "Trade amount in USD — only when the user specifies a dollar value. Examples: 'buy $50 SIREN' → amount=50, 'sell $25 ETH' → amount=25. Omit for 'sell all ETH', 'sell LINK', or any sell without a $ amount (full position). Never invent a default amount.",
          },
          chatReply: {
            type: "string",
            description: "For action=chat only. A helpful, concise reply to the user's general question about crypto, trading, or the agent. Keep it under 200 words.",
          },
        },
        required: ["action"],
      },
    },
  },
];

let client: OpenAI | null = null;
let llmModel: string = "gpt-4o-mini";

export function isLlmConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
    });
    llmModel = process.env.OPENAI_MODEL || "gpt-4o-mini";
  }
  return client;
}

function buildSystemPrompt(context: string): string {
  return `You are the AI assistant for Neural Alpha, an autonomous BSC (BNB Smart Chain) crypto trading agent. You help the operator control and understand their trading bot.

AGENT CONTEXT (live state):
${context}

RULES:
- Map user messages to one of these actions via the execute_action tool: buy, sell, swap, signal, analysis, portfolio, status, help, chat
- For trade commands (buy/sell/swap), extract the token symbol and USD amount when given
- Command format is: [buy|sell] [amount] [token] — e.g. "buy 50$ siren", "buy $50 SIREN", "sell 25 USDT worth of ETH"
- When the user specifies a dollar amount, you MUST pass it as amount (number)
- For sells without a dollar amount ('sell all LINK', 'sell ETH'), omit amount — the agent sells the full position
- Never invent or default a trade amount (e.g. do not use 100 unless the user said $100)
- Token symbols must be uppercase (ETH, BTC, TWT, 1INCH, etc.)
- ANY token can be traded as long as it has a verified BEP-20 contract on BSC — you are NOT limited to a fixed allowlist. If the user names a token, extract its ticker and let the agent resolve the contract address. Never refuse a trade just because a token "isn't on the list"; pass the symbol through and the agent will resolve/route it (or report if it truly can't).
- BNB is eligible — buys use USDT; wallet BNB is tracked as gas reserve (user DOES hold BNB — report it from context, not as an open trade position)
- USDT and other stables are settlement currency — use buy <TOKEN> for trades
- If the user asks what they can trade, use action=eligible
- If the user asks a general crypto/trading question, use action=chat and write a helpful chatReply
- If the user says something ambiguous, ask for clarification via chatReply with action=chat
- Be concise and trading-focused
- Always call the execute_action tool — never respond with plain text`;
}

export async function llmParseCommand(
  raw: string,
  agentContext: string,
): Promise<LlmParsedIntent> {
  const ai = getClient();

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(agentContext) },
    { role: "user", content: raw },
  ];

  try {
    const response = await ai.chat.completions.create({
      model: llmModel,
      messages,
      tools: TOOLS,
      tool_choice: { type: "function", function: { name: "execute_action" } },
      temperature: 0.1,
      max_tokens: 500,
    });

    const toolCall = response.choices[0]?.message?.tool_calls?.[0] as
      | { type: "function"; function: { name: string; arguments: string } }
      | undefined;
    if (toolCall?.type === "function" && toolCall.function?.arguments) {
      const parsed = JSON.parse(toolCall.function.arguments) as LlmParsedIntent;
      logger.info("LLM parsed command", {
        raw,
        action: parsed.action,
        symbol: parsed.symbol,
        amount: parsed.amount,
        model: llmModel,
      });
      return parsed;
    }

    // Fallback: if the model replied with text instead of a tool call
    const text = response.choices[0]?.message?.content;
    if (text) {
      return { action: "chat", chatReply: text };
    }

    return { action: "chat", chatReply: "I couldn't process that. Try something like \"buy ETH $5\" or \"signal BTC\"." };
  } catch (err) {
    logger.warn("LLM parse failed, falling back to regex", { error: String(err) });
    throw err;
  }
}
