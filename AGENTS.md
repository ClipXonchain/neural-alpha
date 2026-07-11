# Agent Instructions

Instructions for AI coding agents working in this repository.

## Quick Reference

- **Project:** Neural Alpha — public multi-tenant platform for autonomous BSC trading agents
- **Repo:** https://github.com/ClipXonchain/agents
- **Data:** CMC Pro API + Binance Web3 trending (5m % sorted) via shared market feed sidecar
- **Execution:** Self-custodial EVM wallet (viem) + Binance Web3 DEX aggregator — no TWAK, no Pancake V2 direct pools
- **Auth:** SIWE wallet login; per-agent API secrets; `READONLY` env blocks proxy mutations
- **Production:** `SESSION_SECRET` / `WALLET_MASTER_SECRET` required; `AGENT_PRIVATE_KEY` + `DISABLE_DRAWDOWN_LIMIT` banned; Binance Web3 keys required for live swaps; multi-tenant uses `DISABLE_SINGLETON_AGENT=true`
- **Control plane:** Agent Supervisor (`agent-supervisor/`, `:4200`) owns process lifecycle; dashboard is UI + auth gateway
- **Safe token list:** Binance Spot ∪ Binance Alpha only — Alpha list auto-synced from Binance API (~300+ BSC tokens, 6h cache)
- **Agent categories (deploy-time):** Spot · Alpha · Default (both) · bStocks (on-chain equities) via `AGENT_UNIVERSE`
- **Mega-cap filter:** Top coins (BTC, ETH, SOL, BNB, etc.) excluded by default; optional `MAX_TRADABLE_MARKET_CAP_USD` ceiling ($10B default)
- **Tokenized stocks/ETFs:** Ondo `*ON` securities excluded from Spot/Alpha/Default; **bStocks Agent** trades the dedicated bStocks list (TSLAB, NVDAB, …) with Equity Trend strategy
- **Market feed:** Shared snapshot sidecar (`MARKET_FEED_URL`) — one CMC poll for all agents
- **Max drawdown:** 25% (enforced in `neural-alpha/src/risk/manager.ts`)

## Architecture (current)

```
User wallet (SIWE) → Next.js dashboard (:3000)
                         ↓
              Agent Supervisor (:4200) → PM2/detached neural-agent-{uuid}
                         ↓
              Market feed (:4100) ← shared by all agents
                         ↓
              viem keystore → Binance Web3 aggregator → BSC
```

**Not in scope anymore:** TWAK / Trust Wallet Agent Kit, paper trading mode, singleton-only deployment, Pancake V2 direct pool swaps, `npm run register` competition flow, `setsid` process launcher.

See `docs/AGENT-INFRA.md` for the full control-plane design.

## User-facing flows

| Route | Purpose |
|-------|---------|
| `/login` | WalletConnect / injected wallet + SIWE |
| `/deploy` | Create agent, pay deploy fee, show seed once |
| `/agents/{id}` | Control panel — start/stop, settings, live dashboard |
| `/profile` | Owner's agent list |
| `/explore` | Public agent directory |

## Key Files

| Path | Purpose |
|------|---------|
| `README.md` | Platform overview and quick start |
| `docs/AGENT-INFRA.md` | Control plane / fleet architecture |
| `deploy/DEPLOY.md` | VPS deployment, secrets, troubleshooting |
| `.env.example` | Full environment reference |
| `agent-supervisor/` | Process lifecycle control plane |
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
| `dashboard/src/lib/platform-db.ts` | Neon Postgres — agents, sessions, deploy fees |
| `dashboard/src/lib/supervisor-client.ts` | Dashboard → Supervisor HTTP client |
| `dashboard/src/lib/agent-process-manager.ts` | Local spawn fallback (PM2 / detached) |
| `dashboard/src/middleware.ts` | Session + route protection |
| `bnbagent-sidecar/` | Optional ERC-8004 identity registration hook (post-deploy) |

## Coding guidelines

1. **Minimize scope** — focused diffs; don't reintroduce TWAK or paper-mode paths
2. **Match conventions** — read surrounding code before adding abstractions
3. **Secrets** — never commit `.env`, keystores, or seed material; `data/agents/` stays gitignored
4. **Production guards** — respect checks in `neural-alpha/src/utils/production-guards.ts`
5. **Multi-tenant** — agent routes must verify SIWE session owner matches agent owner
6. **Market feed** — agents should read `MARKET_FEED_URL`, not poll CMC directly (unless feed unavailable)
7. **Process lifecycle** — prefer Supervisor APIs; do not reintroduce `setsid`

## Local dev

```bash
npm install
cp .env.example .env   # fill DATABASE_URL, secrets, API keys
# Ensure DISABLE_SINGLETON_AGENT=true and SUPERVISOR_URL=http://127.0.0.1:4200
npm run dev:all        # feed + supervisor + dashboard
```

Agents are spawned by the Supervisor on deploy/start from the web UI (not a singleton `neural-agent`).

## Deploy

See `deploy/DEPLOY.md`. Operator platform requires `DATABASE_URL`, `SESSION_SECRET`, `WALLET_MASTER_SECRET`, `SIWE_DOMAIN`, Binance Web3 keys, and the Supervisor (`neural-supervisor` in PM2).
