# Agent Instructions



## Quick Reference

- **Project:** Neural Alpha — autonomous BSC trading agent (public multi-tenant platform)
- **Data:** CMC Pro API + Binance Web3 trending (5m % sorted, Spot/Alpha only)
- **Execution:** Self-custodial EVM wallet (viem) + Binance Web3 DEX aggregator — Pancake V2 direct pools removed
- **Auth:** SIWE wallet login; per-agent API secrets; `READONLY` env blocks proxy mutations
- **Production:** `SESSION_SECRET` / `WALLET_MASTER_SECRET` required; `AGENT_PRIVATE_KEY` + `DISABLE_DRAWDOWN_LIMIT` banned; Binance Web3 keys required for live swaps; multi-tenant uses `DISABLE_SINGLETON_AGENT`
- **Safe token list:** Binance Spot ∪ Binance Alpha only — Alpha list auto-synced from Binance API (~300+ BSC tokens, 6h cache)
- **Agent categories (deploy-time):** Spot · Alpha · Default (both) · bStocks (on-chain equities) via `AGENT_UNIVERSE`
- **Mega-cap filter:** Top coins (BTC, ETH, SOL, BNB, etc.) excluded by default; optional `MAX_TRADABLE_MARKET_CAP_USD` ceiling ($10B default)
- **Tokenized stocks/ETFs:** Ondo `*ON` securities excluded from Spot/Alpha/Default; **bStocks Agent** trades the dedicated bStocks list (TSLAB, NVDAB, …) with Equity Trend strategy
- **Market feed:** Shared snapshot sidecar (`MARKET_FEED_URL`) — one CMC poll for all agents
- **Max drawdown:** 25% (enforced in `neural-alpha/src/risk/manager.ts`)

## Key Files

| Path | Purpose |
|------|---------|
| `neural-alpha/src/agent.ts` | Core trading loop + bridge interface |
| `neural-alpha/src/market-feed/` | Shared market snapshot (quotes, OHLCV, news, F&G) |
| `neural-alpha/src/wallet/` | Encrypted keystore + viem wallet manager |
| `neural-alpha/src/integrations/evm-wallet-bridge.ts` | Execution bridge (signs aggregator calldata) |
| `neural-alpha/src/integrations/binance-web3-trading.ts` | Binance Web3 Trading API (quote / swap / approve) |
| `neural-alpha/src/integrations/binance-alpha-tokens.ts` | Live Binance Alpha BSC sync (API) |
| `neural-alpha/src/config.ts` | Token allowlist (Spot static + Alpha dynamic), config loading |
| `neural-alpha/src/strategy/` | Signal generation + scoring |
| `neural-alpha/src/risk/manager.ts` | Risk guardrails (drawdown, limits) |
| `neural-alpha/src/execution/executor.ts` | Swap builder + result processor |
| `dashboard/` | Next.js UI — login, deploy, profile, per-agent control |
| `bnbagent-sidecar/` | ERC-8004 identity registration hook |
