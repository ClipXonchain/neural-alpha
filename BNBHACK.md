# bStock AI-Powered PnL Contest

**Purpose:** Source of truth for this repo’s campaign integration. Official rules: [campaign docs](https://web3.binance.com/en/dev-docs/products/agentic-wallet/use-cases/campaigns/bstock-pnl-contest) and the `binance-agentic-wallet` skill [campaign.md](https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/references/campaign.md).

| Field | Value |
| --- | --- |
| Window | 2026-08-17 09:00:00 → 2026-09-01 00:00:00 UTC |
| Ranking | Realized PnL (absolute), FIFO lots, gas excluded |
| Prize | Up to 100,000 USDC, Top 100, AUM-tiered pool |
| Execution | **Binance Agentic Wallet only** — Alpha / third-party dApps do not count |
| Assets | Current-week eligible **bStock** (`…B`), not Ondo (`…on`) or xStocks (`…x`) |
| Payment | **BNB / USDT / USDC / U / USD1** only |

## Hard requirements

1. Create + sign in to an Agentic Wallet (`baw auth signin`).
2. Tap Join Now on the campaign page and bind **this** wallet. Pre-registration trades do not count.
3. ≥3 valid **CMC** x402 calls (`execute_skill`, `get_crypto_metrics`, `get_global_metrics_latest`, `get_upcoming_macro_events`) via `https://mcp.coinmarketcap.com/x402/mcp`.
4. ≥3 valid **Agent Studio** x402 analysis jobs via `https://stock-agent.bnbchain.org`.
5. Realized PnL ≥ 0 at the deadline (unsold inventory does not rank).

`x402` and `b402` are the same protocol. Pay with `baw x402-payment preview/sign`. Prefer U / USD1 (EIP-3009, no Permit2).

## This repo

| Layer | Implementation |
| --- | --- |
| Wallet | `neural-alpha/src/integrations/agentic-wallet-bridge.ts` (`baw`) |
| Universe | `bstock.ts` type=3 API + `data/eligible-bstocks.json` |
| Swaps | `baw market-order swap` + poll `market-order list` until FINISHED/FAILED |
| PnL | FIFO lots in `risk/portfolio.ts` |
| AI tasks | `campaign-x402.ts` + `POST /api/campaign/ai-tasks` |

Do not trade Ondo as a fallback. Do not silently pick a non-eligible payment token.
