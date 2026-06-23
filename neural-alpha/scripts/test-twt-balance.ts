import { getTokenBalanceViaCli } from "../src/integrations/twak-cli-balance.js";
import { BSC_TOKEN_ADDRESSES } from "../src/integrations/bsc-token-addresses.js";
import { createTwakMcpBridge } from "../src/integrations/twak-mcp-bridge.js";

const addr = "0x6bcF0027f1d151d8CBc8d6Ff07915b0BA9616b1E";

const cli = await getTokenBalanceViaCli("bsc", addr, BSC_TOKEN_ADDRESSES.TWT, "TWT");
console.log("CLI", cli);

const bridge = await createTwakMcpBridge();
const mcp = await bridge.getTokenBalance("bsc", "TWT");
console.log("MCP getTokenBalance", mcp);

process.exit(0);
