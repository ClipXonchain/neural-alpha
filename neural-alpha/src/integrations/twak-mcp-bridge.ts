import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpBridge } from "../agent.js";
import { buildQuoteParams, buildSwapParams } from "../execution/executor.js";
import { BSC_CHAIN, BSC_USDT_ADDRESS } from "../config.js";
import { logger } from "../utils/logger.js";

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

/**
 * Connect to TWAK MCP server (`twak serve`) and expose McpBridge methods.
 * CMC Agent Hub data flows through x402_request per
 * https://coinmarketcap.com/api/agent/#dev-steps
 */
export async function createTwakMcpBridge(): Promise<McpBridge> {
  const command = process.env.TWAK_MCP_COMMAND || "twak";
  const args = (process.env.TWAK_MCP_ARGS || "serve").split(" ").filter(Boolean);

  const transport = new StdioClientTransport({ command, args });
  const client = new Client(
    { name: "neural-alpha", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  logger.info("Connected to TWAK MCP server", { command, args: args.join(" ") });

  const callTool = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown> | null> => {
    try {
      const result = (await client.callTool({ name, arguments: args })) as ToolResult;
      if (result.isError) {
        logger.warn(`TWAK MCP tool error: ${name}`, { args });
        return null;
      }
      return parseToolResult(result);
    } catch (err) {
      logger.warn(`TWAK MCP call failed: ${name}`, { error: String(err) });
      return null;
    }
  };

  return {
    async getTokenPrice(chain: string, token: string) {
      const r = await callTool("get_token_price", { chain, token });
      if (!r) return null;
      const price = r.price ?? r.usdPrice ?? r.value;
      if (price === undefined || price === null) return null;
      return { price: Number(price) };
    },

    async getWalletBalance(chain: string) {
      const r = await callTool("wallet_balance", { chain });
      if (!r) return null;
      const balance = r.balance ?? r.amount ?? r.value;
      return balance !== undefined ? { balance: String(balance) } : null;
    },

    async getSwapQuote(params: ReturnType<typeof buildQuoteParams>) {
      return callTool("get_swap_quote", params);
    },

    async executeSwap(params: ReturnType<typeof buildSwapParams>) {
      const r = await callTool("swap", params);
      return r ?? { error: "swap returned empty result" };
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

      const bal = await callTool("get_balance", {
        chain,
        address: String(addr.address),
        tokenAddress: BSC_USDT_ADDRESS,
      });

      const raw = bal?.balance ?? bal?.amount ?? bal?.value;
      if (raw === undefined) return null;
      return { balance: parseFloat(String(raw)) || 0, symbol: "USDT" };
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
