<p align="center">
  <strong>N E U R A L &nbsp; A L P H A</strong>
</p>

<p align="center">
  Autonomous bStock trading agent for Binance Agentic Wallet — signals, risk, FIFO PnL.
</p>

<p align="center">
  <a href="https://agents.clipx.app">Live Dashboard</a> &middot;
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#deployment">Deployment</a> &middot;
  <a href="#security">Security</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/chain-BNB_Smart_Chain-F0B90B?style=flat-square" alt="BSC" />
  <img src="https://img.shields.io/badge/runtime-Node.js_20+-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/dashboard-Next.js_15-000000?style=flat-square&logo=nextdotjs" alt="Next.js" />
  <img src="https://img.shields.io/badge/execution-Binance_Agentic_Wallet-F0B90B?style=flat-square" alt="Agentic Wallet" />
  <img src="https://img.shields.io/badge/assets-bStock-17181b?style=flat-square" alt="bStock" />
</p>

---

## Overview

Neural Alpha is an autonomous trading agent for **tokenized US stocks (bStock)** on BNB Smart Chain. It scores markets, enforces risk in code, and executes swaps through **Binance Agentic Wallet** (`baw` CLI) — MPC keyless, no local private keys.

Built for the **[bStock AI-Powered PnL Contest](https://web3.binance.com/en/dev-docs/products/agentic-wallet/use-cases/campaigns/bstock-pnl-contest)** (Binance Wallet × bStocks × BNB Chain Agent Studio × CoinMarketCap), 17 Aug – 1 Sep 2026 UTC.

**Production deployment:** [agents.clipx.app](https://agents.clipx.app)

---

## Table of Contents

- [Key Features](#key-features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Strategy Engine](#strategy-engine)
- [Risk Management](#risk-management)
- [Dashboard](#dashboard)
- [Deployment](#deployment)
- [Security](#security)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [NPM Scripts](#npm-scripts)
- [Troubleshooting](#troubleshooting)
- [Competition](#competition)
- [License](#license)

---

## Key Features

**Signal Engine**
- 9-factor scoring: RSI, MACD, EMA crossover, Bollinger Bands, momentum, volume spikes, mcap:volume turnover, Fear & Greed index, and ClipX news sentiment
- Optional AI technical analysis (GPT-4o-mini or any OpenAI-compatible model) overlaid on top signals each cycle
- Tiered token scanning — active watchlist (15 tokens) every cycle + full scan of all 149 eligible BEP-20 tokens every 3 cycles

**Strategy Presets**
- Three risk-tiered profiles: **SafeTrade** (capital preservation), **Medium** (balanced), **Momentum** (return-seeking)
- Each preset configures signal weights, position sizing, stop-loss/take-profit, trailing stops, and portfolio limits
- Hot-switchable from the dashboard without restart

**Risk Guardrails (enforced in code, not prompts)**
- Max drawdown cap with emergency buy-halt
- Per-trade position limits, daily trade caps, on-chain tx budget
- Stop-loss, take-profit, and trailing stop exits
- Honeypot detection before every live swap
- Weekly eligible **bStock** allowlist (type=3 contracts + campaign list)

**Execution**
- Self-custody via Binance Agentic Wallet — MPC keyless, keys never held by the agent
- Paper mode (simulated) and live mode (real BSC swaps)
- On-chain portfolio reconciliation with Binance Web3 Wallet API
- Startup cooldown, failed-swap cooldown, and autonomous trade pacing

**Dashboard**
- Real-time Next.js dashboard with SSE streaming
- Portfolio metrics, equity/drawdown charts, signal monitor, trade history, activity feed
- Wallet panel with on-chain balances, competition registration
- Natural language command assistant (AI-powered when OpenAI key is set)
- Agent controls for live parameter tuning

**Production-Ready**
- API authentication (Bearer token)
- CORS origin restriction, rate limiting, request size limits
- PM2 process management, Nginx reverse proxy, Let's Encrypt SSL
- Neon Postgres persistence for trades, NAV snapshots, and chain sync state
- Graceful shutdown with SIGTERM/SIGINT handling

---

## Architecture

Neural Alpha runs an autonomous loop: **read markets → score signals → validate risk → execute on BSC → reconcile portfolio**. The diagram below is the core agent workflow (one cycle repeats every 30s in paper mode, 60 min in live mode).

### Core Agent Workflow

```mermaid
flowchart TB
    subgraph SOURCES["Data sources"]
        CMC["CoinMarketCap Pro / x402<br/>Quotes · Trending · Fear & Greed"]
        NEWS["ClipX News<br/>Per-token sentiment"]
        WALLET["BSC Wallet<br/>USDT · BNB · token holdings"]
    end

    subgraph LOOP["Neural Alpha — trading cycle"]
        direction TB
        S1["① Ingest<br/>Watchlist + full 149-token scan"]
        S2["② Analyze<br/>9-factor signals · optional AI review"]
        S3["③ Decide<br/>Rank buys/sells · stop-loss · take-profit"]
        S4{"④ Risk gate<br/>Drawdown · limits · allowlist"}
        S5["⑤ Execute<br/>Eligible bStock → baw market-order swap"]
        S6["⑥ Reconcile<br/>Sync on-chain · NAV snapshot · persist"]

        S1 --> S2 --> S3 --> S4
        S4 -->|Rejected| S6
        S4 -->|Approved| S5 --> S6
    end

    subgraph OUTPUTS["Outputs"]
        UI["Dashboard + SSE<br/>State · trades · logs"]
        DB[("Neon Postgres<br/>Trades · NAV · sync")]
        TX["BSC mainnet<br/>Signed BEP-20 swaps"]
    end

    CMC --> S1
    NEWS --> S1
    WALLET --> S6
    S5 --> TX
    TX -.->|Confirm balances| WALLET
    S6 --> UI
    S6 --> DB
    S6 -->|Wait interval · repeat| S1

    style S4 fill:#e94560,stroke:#fff,color:#fff
    style S5 fill:#f0b90b,stroke:#1a1a2e,color:#1a1a2e
    style TX fill:#f0b90b,stroke:#1a1a2e,color:#1a1a2e
```

**In plain terms:**

| Step | What happens |
|------|----------------|
| **Ingest** | Pull prices for the active watchlist; every 3rd cycle, scan all 149 eligible BEP-20 tokens |
| **Analyze** | Blend RSI, MACD, EMA, Bollinger, momentum, volume, news, and Fear & Greed into a score per token |
| **Decide** | Pick the best trades; optional protective exits (stop-loss / take-profit / trailing) run first |
| **Risk gate** | Block trades that breach drawdown, daily caps, position size, token allowlist, or tx budget |
| **Execute** | Live mode: `baw market-order swap` on BSC, poll until FINISHED/FAILED. Paper mode: simulated fill |
| **Reconcile** | Match portfolio to chain, update NAV, stream to dashboard, save to Postgres, sleep, repeat |

**Operator path:** Browser → [agents.clipx.app](https://agents.clipx.app) → Next.js dashboard → authenticated proxy → agent API (`127.0.0.1:3847`). Manual commands (`buy`, `sell`, `portfolio`) use the same risk and execution path as autonomous trades.

---

## Prerequisites

| Requirement | Purpose |
|---|---|
| **Node.js >= 20** | Runtime (ESM, `import.meta`) |
| **npm >= 9** | Package manager (workspaces) |
| **[baw CLI](https://www.binance.com/en/skills/detail/binance-web3/binance-agentic-wallet)** | Binance Agentic Wallet — sign-in, balances, market-order swaps, x402 |

```bash
# Install Binance Agentic Wallet CLI
npm i -g @binance/agentic-wallet
baw --version

# Sign in (QR in Binance App)
baw auth signin
baw wallet status --json
baw wallet address --json
```
| **USDT / USDC / U / USD1 on BSC** | Campaign payment capital (live mode) |

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/your-org/neural-alpha.git
cd neural-alpha
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Minimum configuration:

```bash
# Required
CMC_PRO_API_KEY=<your-key>
PAYMENT_TOKEN=USDT
BRIDGE_MODE=auto          # auto-detects baw + CMC Pro

# Mode
AGENT_MODE=paper          # "paper" for simulation, "live" for real BSC trading

# Optional: AI assistant
OPENAI_API_KEY=sk-...     # enables NL commands + AI signal analysis
```

### 3. Run (development)

```bash
npm run dev
```

| Service | URL |
|---|---|
| **Dashboard** | http://localhost:3000 |
| **Agent API** | http://localhost:3847/api/health |

The dashboard header shows **LIVE** when connected to the agent, **DEMO** when offline.

### 4. Run (production)

```bash
npm run prod:build
npm run prod:start      # starts via PM2
```

See [Deployment](#deployment) for full VPS setup.

---

## Configuration

### Paper vs Live Mode

| | Paper (`AGENT_MODE=paper`) | Live (`AGENT_MODE=live`) |
|---|---|---|
| Swaps | Simulated (`paper-*` tx hash) | Real BSC transactions via Agentic Wallet |
| Capital | Uses `INITIAL_CASH_USD` | Syncs from on-chain USDT balance |
| Cycle interval | 30s default | 60 min default |
| Portfolio | In-memory only | Reconciled with on-chain state each cycle |

### Environment Variables

All variables are documented in `.env.example`. Key ones:

| Variable | Default | Description |
|---|---|---|
| `AGENT_MODE` | `paper` | `paper` or `live` |
| `BRIDGE_MODE` | `auto` | `auto` / `baw` / `cmc-pro` / `mock` |
| `CMC_PRO_API_KEY` | — | CoinMarketCap Pro API key |
| `PAYMENT_TOKEN` | `USDT` | Campaign payment token: BNB / USDT / USDC / U / USD1 |
| `BAW_CLI` | `baw` | Binance Agentic Wallet CLI |
| `AGENT_WALLET_ADDRESS` | — | BSC wallet address (auto-detected from `baw`) |
| `API_SECRET` | — | **Required in production** — Bearer token for API auth |
| `NODE_ENV` | — | Set to `production` on VPS |
| `STRATEGY` | `medium` | `safe` / `medium` / `momentum` |
| `TRADE_INTERVAL_MS` | 30s/60min | Cycle frequency |
| `MAX_DRAWDOWN_PCT` | `20` | Hard drawdown cap (%) |
| `MAX_POSITION_SIZE_USD` | `100` | Per-trade limit (USD) |
| `MAX_DAILY_TRADES` | `10` | Daily autonomous trade cap (set in `.env`; dashboard reads from agent config) |
| `STOP_LOSS_PCT` | `8` | Stop-loss threshold (%) |
| `TAKE_PROFIT_PCT` | `15` | Take-profit threshold (%) |
| `MIN_BUY_CONFIDENCE` | `0.55` | Minimum signal confidence to buy |
| `AUTO_EXIT_ENABLED` | `false` | Enable autonomous stop-loss/take-profit exits |
| `OPENAI_API_KEY` | — | Enables AI assistant + signal analysis |
| `OPENAI_MODEL` | `gpt-4o-mini` | Any OpenAI-compatible chat model |
| `DATABASE_URL` | — | Neon Postgres connection string |
| `CORS_ORIGINS` | — | Additional allowed CORS origins (comma-separated) |
| `DASHBOARD_PORT` | `3847` | Agent API port (internal) |
| `LOG_LEVEL` | `info` | `error` / `warn` / `trade` / `signal` / `info` / `debug` |

---

## Strategy Engine

### Signal Pipeline (9 factors)

| Factor | Weight (Medium) | Source |
|---|---|---|
| RSI (14) | 15 | Price history |
| MACD (12/26/9) | 13 | Price history |
| EMA Crossover (12/26) | 11 | Price history |
| Bollinger Bands (20,2) | 6 | Price history |
| Momentum (10-period) | 18 | Price history |
| Volume Spike | 18 | Volume vs 20-bar avg |
| MCap:Volume Turnover | 7 | CMC |
| Fear & Greed Index | 6 | CMC |
| News Sentiment | 10 | ClipX API |

Weights vary by strategy preset. Signals are ranked by absolute score, then validated by the risk manager before execution.

### Strategy Presets

| Preset | Philosophy | Max DD | Daily Trades | Position Size | Stop/TP |
|---|---|---|---|---|---|
| **SafeTrade** | Capital preservation, confirmed mean-reversion, tight stops | 12% | 3 | 0.6x | 5% / 10% |
| **Medium** | Balanced trend + momentum + volume | 20% | 5 | 0.85x | 8% / 15% |
| **Momentum** | Return-seeking, chases breakouts and volume spikes | 28% | 6 | 1.1x | 10% / 28% |

Switch presets at runtime from the dashboard Agent Controls panel or via the API.

### AI Signal Analysis (Optional)

When `OPENAI_API_KEY` is set and `AI_SIGNAL_ANALYSIS=true`:

- Top N signals per cycle are sent to the LLM with full technical context
- AI returns verdict (bullish/bearish/neutral), confidence, risks, and a one-line summary
- AI insight is overlaid on the signal score and surfaced on the dashboard

---

## Risk Management

All guardrails are enforced in code (`neural-alpha/src/risk/manager.ts`), not prompts:

| Rule | Default | Effect |
|---|---|---|
| Max drawdown | 20% (Medium) | Emergency mode — new buys halted, positions held |
| Stop-loss | 8% | Protective sell triggered |
| Take-profit | 15% | Protective sell triggered |
| Trailing stop | 6% activate / 3% giveback | Locks in gains after activation |
| Daily trade cap | 5/day | Autonomous trades blocked after cap |
| On-chain tx budget | 10/day | Prevents excessive gas spend |
| Max positions | 3 tokens | Portfolio concentration limit |
| Min trade size | $5 | Dust prevention |
| Max position size | $100 | Per-trade cap |
| Confidence gate | 55% | Weak signals filtered |
| Token allowlist | 149 BEP-20 | Ineligible tokens rejected |
| Eligible-list check | Skip audit for current-week bStocks; otherwise fail-closed |
| Startup cooldown | 120s | Autonomous trades paused after restart |
| Failed swap cooldown | 30 min | Same token not retried immediately |

---

## Dashboard

The Next.js dashboard at `https://agents.clipx.app` provides:

| Panel | Description |
|---|---|
| **Metric Cards** | Portfolio NAV, PnL, drawdown, win rate, daily trades |
| **Equity Chart** | Live portfolio value over time |
| **Drawdown Chart** | Max drawdown visualization |
| **Allocation Chart** | Portfolio composition by token |
| **Signal Monitor** | RSI, MACD, momentum, news sentiment, AI verdict per token |
| **Positions Table** | Open positions with entry price, PnL, weight |
| **Trade History** | Full trade log with BSCScan links for live trades |
| **Activity Feed** | Filterable real-time log stream |
| **Wallet Panel** | Address, BNB/USDT balances, sync, competition registration |
| **Agent Controls** | Max position, interval, drawdown, slippage, strategy preset |
| **Command Panel** | Natural language assistant (AI-powered with OpenAI key) |

The dashboard connects via SSE for real-time streaming — no polling.

---

## Deployment

### Production Architecture

```
Internet → Nginx (SSL) → Next.js :3000 → Agent API :3847 (localhost only) → baw → BSC
```

- **Agent API** binds to `127.0.0.1` only — never directly exposed to the internet
- **Dashboard** proxy authenticates with the agent using `API_SECRET`
- **Nginx** terminates SSL, routes traffic, adds security headers

### Existing VPS (`~/neural-alpha`)

Public site is **read-only**. Other PM2 apps (e.g. `clipx-news-brain`) are not restarted.

```bash
cd ~/neural-alpha
cp -a .env /tmp/neural-alpha.env
git fetch origin
git checkout -B agentic-wallet origin/agentic-wallet
git reset --hard origin/agentic-wallet
cp /tmp/neural-alpha.env .env
bash deploy/setup.sh
```

### Fresh VPS

```bash
git clone -b agentic-wallet <repo-url> ~/neural-alpha && cd ~/neural-alpha
cp .env.example .env && nano .env
bash deploy/setup.sh
```

The script forces `READONLY=true` / `NEXT_PUBLIC_READONLY=true`, keeps `API_SECRET`, and starts only `neural-agent` + `neural-dashboard`.

### Manual Deploy

```bash
# Install dependencies
npm ci

# Build everything
npm run prod:build

# Start with PM2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

### PM2 Operations

```bash
pm2 status                                      # all processes
pm2 logs neural-agent --lines 100
pm2 logs neural-dashboard
pm2 restart neural-agent neural-dashboard       # do not use restart all
```

### Health Check

```bash
curl https://agents.clipx.app/api/health
# → {"status":"ok","running":true,"uptime":12345,"timestamp":...}
```

### Updating

```bash
cd ~/neural-alpha
bash deploy/setup.sh --branch agentic-wallet --reset
```

Full deployment documentation: [`deploy/DEPLOY.md`](./deploy/DEPLOY.md)

---

## Security

### Authentication

All agent API endpoints (except `/api/health`) require authentication:

```bash
# Set in .env
API_SECRET=<generated-with-openssl-rand-hex-32>
```

The dashboard proxy automatically attaches the token. Direct API calls require:

```
Authorization: Bearer <API_SECRET>
```

### Hardening

| Measure | Implementation |
|---|---|
| API authentication | Bearer token on all mutating/read endpoints |
| CORS restriction | Origin whitelist (`agents.clipx.app` + `localhost`) |
| Rate limiting | 120 req/min per IP (in-memory token bucket) |
| Body size limits | 64KB max request body |
| SSE connection cap | 20 concurrent clients |
| Localhost binding | Agent API on `127.0.0.1` only |
| Security headers | `X-Frame-Options`, `X-Content-Type-Options`, `HSTS`, `Referrer-Policy` |
| Error sanitization | No stack traces in production responses |
| Input validation | Whitelist of allowed config keys, command length limits |
| Agentic Wallet | MPC keyless — agent never holds private keys |
| Graceful shutdown | SIGTERM/SIGINT handlers with timeout |

### Best Practices

- **Never commit** `.env`, session tokens, or `~/.baw/`
- Use a **dedicated hot wallet** with limited funds
- Token allowlist enforced in code — ineligible tokens rejected
- Honeypot screening before every live swap
- Drawdown cap enforced in code, not prompts

---

## API Reference

All endpoints are prefixed with `/api/`. Authentication required unless noted.

### Read Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check (no auth) |
| `GET` | `/api/state` | Full agent state snapshot |
| `GET` | `/api/logs` | Last 100 log entries |
| `GET` | `/api/events` | SSE stream (state + log events) |
| `GET` | `/api/wallet` | Wallet address, BNB/USDT balances |
| `GET` | `/api/competition/status` | Competition registration status |

### Control Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/control/start` | Start trading loop |
| `POST` | `/api/control/stop` | Pause trading loop |
| `POST` | `/api/control/restart` | Reset portfolio and restart |
| `POST` | `/api/control/resync` | Force on-chain portfolio reconciliation |
| `POST` | `/api/control/config` | Update agent configuration |
| `POST` | `/api/control/watchlist` | Set token watchlist |
| `POST` | `/api/command` | Execute NL command |
| `POST` | `/api/wallet/sync` | Sync USDT balance from chain |
| `POST` | `/api/wallet/mode` | Switch wallet mode (local/walletconnect) |
| `POST` | `/api/competition/register` | Submit on-chain competition registration |

---

## Project Structure

```
neural-alpha/
├── ecosystem.config.cjs          # PM2 process configuration
├── package.json                   # Monorepo root (npm workspaces)
├── .env.example                   # Environment template
├── deploy/
│   ├── DEPLOY.md                  # Deployment documentation
│   ├── nginx.conf                 # Nginx reverse proxy config
│   └── setup.sh                   # One-command deploy script
│
├── neural-alpha/                  # Autonomous trading agent
│   ├── package.json
│   └── src/
│       ├── index.ts               # Entry point + graceful shutdown
│       ├── agent.ts               # Core trading loop + state management
│       ├── config.ts              # bStock watchlist, configuration
│       ├── execution/
│       │   └── executor.ts        # baw market-order builder + result processor
│       ├── integrations/
│       │   ├── create-bridge.ts   # Bridge factory (baw / CMC Pro / mock)
│       │   ├── agentic-wallet-bridge.ts # Binance Agentic Wallet CLI
│       ├── commands/
│       │   ├── handler.ts         # NL command router + trade execution
│       │   └── llm.ts             # OpenAI-compatible assistant
│       ├── data/
│       │   ├── market.ts          # CMC quotes, price history, F&G
│       │   └── news.ts            # ClipX news fetcher
│       ├── db/
│       │   ├── schema.sql         # Neon Postgres schema
│       │   └── store.ts           # Persistence layer (trades, NAV, sync)
│       ├── risk/
│       │   ├── manager.ts         # Risk validation + emergency mode
│       │   └── portfolio.ts       # PnL tracking, snapshots, reconciliation
│       ├── strategy/
│       │   ├── index.ts           # Strategy orchestrator
│       │   ├── signals.ts         # 9-factor signal scoring
│       │   ├── presets.ts         # SafeTrade / Medium / Momentum profiles
│       │   ├── ai-analyst.ts      # GPT-powered technical analysis
│       │   ├── news-sentiment.ts  # ClipX NLP sentiment analyzer
│       │   └── indicators.ts      # RSI, MACD, EMA, BB, ATR
│       ├── utils/
│       │   ├── logger.ts          # Structured logging + SSE fan-out
│       │   └── types.ts           # Shared TypeScript interfaces
│       └── web/
│           └── server.ts          # Agent HTTP API + SSE + auth + rate limiting
│
└── dashboard/                     # Next.js 15 live monitoring UI
    ├── package.json
    ├── next.config.ts             # Security headers, production config
    └── src/
        ├── app/
        │   ├── page.tsx           # Main dashboard page
        │   ├── layout.tsx         # Root layout
        │   └── api/agent/[...path]/
        │       └── route.ts       # Authenticated proxy to agent API
        ├── components/dashboard/  # 13 UI panels
        ├── hooks/
        │   └── useAgentConnection.ts  # SSE client + state management
        └── lib/
            ├── agent-api.ts       # Typed API client
            ├── agent-url.ts       # Agent URL resolution
            ├── map-agent-state.ts # API → dashboard state mapping
            └── mock-data.ts       # Offline demo data
```

---

## NPM Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start agent + dashboard together (development) |
| `npm run agent` | Agent only |
| `npm run agent:dev` | Agent with hot reload |
| `npm run dashboard` | Dashboard dev server |
| `npm run build` | Build all workspaces |
| `npm run register` | Competition registration helper |
| `npm run prod:build` | Production build (agent + dashboard) |
| `npm run prod:start` | Start via PM2 |
| `npm run prod:stop` | Stop via PM2 |
| `npm run prod:restart` | Restart via PM2 |
| `npm run prod:logs` | PM2 log viewer |
| `npm run prod:status` | PM2 process status |
| `npm run prod:deploy` | Full deployment script |

---

## Troubleshooting

### Dashboard shows DEMO / offline

The agent isn't running. Start both services:

```bash
npm run dev
```

### Trades show no BSC tx hash in live mode

1. Confirm `AGENT_MODE=live` in `.env`
2. Ensure wallet has both USDT (trading capital) and BNB (gas)
3. Restart the agent after funding
4. Check logs: `pm2 logs neural-agent` or `tail -f neural-alpha/logs/agent.jsonl`

### API returns 401 Unauthorized

`API_SECRET` mismatch between agent and dashboard. Ensure both read the same `.env` file, or set `API_SECRET` in the dashboard's environment.

### Port 3847 already in use

The agent automatically retries ports 3847-3852. If all are taken, stop other agent processes:

```bash
pm2 stop neural-agent
# or
lsof -i :3847
```

### Agentic Wallet issues

```bash
baw wallet status --json
baw wallet address --json
baw wallet balance --binanceChainId 56 --json
```

If status is `UNCONNECTED`, run `baw auth signin` and confirm in the Binance App.

---

## Competition

### bStock AI-Powered PnL Contest

| Field | Value |
|---|---|
| Window | 2026-08-17 09:00 UTC – 2026-09-01 00:00 UTC |
| Ranking | Realized PnL (FIFO), Top 100 |
| Prize | Up to 100,000 USDC |
| Docs | [bstock-pnl-contest](https://web3.binance.com/en/dev-docs/products/agentic-wallet/use-cases/campaigns/bstock-pnl-contest) |

### Competition Rules Enforcement

| Rule | Implementation |
|---|---|
| Register before trading | Join Now on campaign page + `CAMPAIGN_REGISTERED=true` |
| Eligible bStock only | type=3 API + `data/eligible-bstocks.json` |
| Payment BNB/USDT/USDC/U/USD1 | `PAYMENT_TOKEN` + executor |
| Agentic Wallet execution | `baw market-order swap` |
| FIFO realized PnL | `risk/portfolio.ts` lots |
| ≥3 CMC + ≥3 Studio x402 | `campaign-x402.ts` / dashboard |

### Registration

```bash
npm run register
# Then tap Join Now and bind this Agentic Wallet.
```

### baw CLI commands used

| Command | Purpose |
|---|---|
| `wallet status/address/balance` | Connection + holdings |
| `market-order quote/swap/list` | Price + execute + confirm |
| `x402-payment preview/sign` | Campaign CMC / Agent Studio payments |
| `auth signin/verify` | Binance App QR session |

---

## Resources

| Resource | URL |
|---|---|
| Live Dashboard | https://agents.clipx.app |
| Campaign docs | https://web3.binance.com/en/dev-docs/products/agentic-wallet/use-cases/campaigns/bstock-pnl-contest |
| Agentic Wallet skill | https://github.com/binance/binance-skills-hub/tree/main/skills/binance-web3/binance-agentic-wallet |
| CMC Agent Hub | https://coinmarketcap.com/api/agent |
| Deployment Guide | [deploy/DEPLOY.md](./deploy/DEPLOY.md) |

---


