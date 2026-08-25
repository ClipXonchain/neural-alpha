# Agent Instructions

## Quick Reference

- **Project:** Neural Alpha — autonomous bStock trading agent
- **Data:** Binance Web3 bStock quotes (type=3) + CMC sentiment / campaign x402
- **Execution:** Binance Agentic Wallet CLI (`baw market-order swap`) on BSC (chainId `56`)
- **Eligible assets:** tokenized US stocks with suffix `B` (bStock), weekly list + type=3 API
- **Payment tokens (campaign PnL):** BNB, USDT, USDC, U, USD1 only
- **Campaign:** [bStock AI-Powered PnL Contest](https://web3.binance.com/en/dev-docs/products/agentic-wallet/use-cases/campaigns/bstock-pnl-contest) (2026-08-17 09:00 → 2026-09-01 00:00 UTC)

## Campaign rules (enforced in code)

1. Register on the official page (Join Now) **before** scored trades. Wallet cannot change after bind.
2. ≥3 paid CMC MCP x402 calls (`execute_skill`, `get_crypto_metrics`, `get_global_metrics_latest`, `get_upcoming_macro_events`).
3. ≥3 paid BNB Chain Agent Studio stock-analysis x402 calls.
4. Realized PnL ≥ 0 at the end, FIFO lot matching, gas not counted.
5. Only eligible bStocks via Agentic Wallet count. Ondo (`…on`) and xStocks (`…x`) do not.
6. Keep BNB for gas. AI x402 payments are gasless.

## Key Files

| Path | Purpose |
|------|---------|
| `neural-alpha/src/agent.ts` | Core trading loop |
| `neural-alpha/src/integrations/agentic-wallet-bridge.ts` | `baw` CLI bridge |
| `neural-alpha/src/integrations/bstock.ts` | type=3 universe + eligibility |
| `neural-alpha/src/integrations/campaign-x402.ts` | CMC + Agent Studio paid calls |
| `neural-alpha/src/execution/executor.ts` | market-order swap builder |
| `neural-alpha/src/risk/portfolio.ts` | FIFO realized PnL |
| `dashboard/` | Next.js live monitoring UI |
