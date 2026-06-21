# Neural Alpha

Autonomous BSC trading agent with live dashboard and news-driven sentiment.

Built for **[BNB Hack: AI Trading Agent Edition](https://dorahacks.io/hackathon/bnbhack-twt-cmc/)** (CoinMarketCap × Trust Wallet × BNB Chain), Track 1.

**Stack:** CoinMarketCap Pro API · Trust Wallet Agent Kit (TWAK) · ClipX News · Next.js Dashboard · BSC

---

## Features

- **7-factor signal engine:** RSI, MACD, Bollinger Bands, EMA crossover, momentum, Fear & Greed, and **ClipX news sentiment**
- **Tiered token scanning:** Active watchlist (15 tokens) every cycle + full scan of all **149 eligible BEP-20** tokens every 3 cycles
- **Risk guardrails in code:** 25% max drawdown, daily trade limits, position sizing, honeypot checks, token allowlist
- **TWAK execution:** Self-custody local signing — no custodial intermediaries
- **Live dashboard:** Single UI at `http://localhost:3000` — portfolio, charts, signals, trade history, logs, agent controls

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Next.js Dashboard (:3000)                      │
│   Metrics · Equity · Signals · Trades · Logs · Wallet · Agent Controls  │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ /api/agent/* (proxy)
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Neural Alpha Agent API (:3847)                      │
│  ┌──────────┐  ┌─────────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │ ClipX    │  │ CMC Pro /   │  │ Strategy │  │   Risk   │  │ TWAK   │ │
│  │ News     │─▶│ x402 Data   │─▶│ Engine   │─▶│ Manager  │─▶│ MCP    │ │
│  └──────────┘  └─────────────┘  └──────────┘  └──────────┘  └───┬────┘ │
└──────────────────────────────────────────────────────────────────────│────┘
                                                                       ▼
                                                              BSC (BEP-20 swaps)
```

**Data path (default `BRIDGE_MODE=auto` + `CMC_PRO_API_KEY`):**

- Market data → CMC Pro API (hackathon key)
- Execution → TWAK MCP (`twak serve`) over stdio
- News → ClipX public feed

---

## Prerequisites

| Requirement | Purpose |
|-------------|---------|
| **Node.js ≥ 18** | Runtime |
| **[TWAK CLI](https://portal.trustwallet.com)** (`twak`) | Wallet + MCP server for swaps |
| **CMC Pro API key** | Real market data (hackathon key) |
| **BNB on BSC** | Gas for registration + live swaps |
| **USDT on BSC** | Trading capital (live mode) |

Install TWAK globally (if not already):

```bash
npm install -g @trustwallet/cli
twak --version
```

---

## Quick Start

### 1. Clone and install

```bash
git clone <your-repo-url>
cd neural-alpha
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` — minimum for local development:

```bash
AGENT_MODE=paper          # use "live" for real BSC trading
BRIDGE_MODE=auto
CMC_PRO_API_KEY=<your-hackathon-key>
TWAK_MCP_COMMAND=twak
TWAK_MCP_ARGS=serve
```

See [Environment Variables](#environment-variables) for the full list.

### 3. Set up TWAK wallet (first time only)

```bash
twak wallet create          # if no wallet yet
twak wallet status
twak wallet address --chain bsc
```

Wallet files live at `~/.twak/` (encrypted, **never commit these**).

### 4. Run everything (recommended)

Starts the **agent backend** and **dashboard** together:

```bash
npm run dev
```

| Service | URL |
|---------|-----|
| **Dashboard** | http://localhost:3000 |
| **Agent API** | http://localhost:3847/api/state |

The dashboard header shows **LIVE** when connected to the agent, **DEMO** when offline.

---

## Paper vs Live Mode

| | Paper (`AGENT_MODE=paper`) | Live (`AGENT_MODE=live`) |
|---|---------------------------|--------------------------|
| Swaps | Simulated (`paper-*` tx hash) | Real BSC via TWAK |
| Wallet USDT | Uses `INITIAL_CASH_USD` | Syncs from on-chain USDT |
| Cycle interval | 30s default | 5 min default |
| Competition scoring | No | Yes (June 22–28 window) |

**How to confirm real live trades:**

1. Header badge: **LIVE** (agent connected)
2. Wallet panel shows on-chain BNB + USDT balances
3. Trade History shows `0x...` hashes that open on [BSCScan](https://bscscan.com)

---

## Competition Setup

### On-chain registration (required before live window)

```bash
# Fund agent wallet with BNB (gas) first
twak wallet balance --chain bsc

npm run register
twak compete register
twak compete status    # registered: true
```

**Competition contract (BSC):** `0x212c61b9b72c95d95bf29cf032f5e5635629aed5`

### DoraHacks submission

Submit your BUIDL at: https://dorahacks.io/hackathon/bnbhack-twt-cmc/

Include:

- Public GitHub repo URL
- Agent wallet address (`twak wallet address --chain bsc`)
- Short strategy description

### Live trading week rules (June 22–28)

| Rule | Agent enforcement |
|------|-------------------|
| ≥ 1 trade per day, ≥ 7 total | Daily trade floor in live mode |
| Only 149 eligible BEP-20 tokens | Hard-coded allowlist in `config.ts` |
| Max drawdown ~30% (DQ) | 25% cap in `risk/manager.ts` |
| TWAK self-custody execution | All swaps via TWAK MCP |
| Real BSC tx hashes | Logged to `logs/agent.jsonl` |

### Fund the agent wallet

Send **BNB** (gas) and **USDT** (BEP-20 on BSC) to your agent address:

```bash
twak wallet address --chain bsc
```

Transfer USDT out (example — use contract address, not symbol):

```bash
twak transfer \
  --to <destination> \
  --amount 10 \
  --chain bsc \
  --token 0x55d398326f99059fF775485246999027B3197955 \
  --decimals 18
```

---

## Signal Pipeline

| Component | Weight | Source |
|-----------|--------|--------|
| RSI (14) | 17 | Price history |
| MACD (12/26/9) | 17 | Price history |
| Bollinger Bands | 8 | Price history |
| EMA crossover (12/26) | 13 | Price history |
| Momentum (10-period) | 22 | Price history |
| Fear & Greed | 8 | CMC |
| **News sentiment** | **15** | ClipX API |

Signals are ranked by absolute score. The risk manager validates every trade before TWAK execution.

---

## Risk Guardrails

Enforced in code (`neural-alpha/src/risk/manager.ts`), not prompts:

| Rule | Default | Effect |
|------|---------|--------|
| Max drawdown | 25% | Halt trading; force-liquidate at limit |
| Safety buffer | 20% drawdown | No new buys |
| Daily trades | 10/day | Blocked after cap |
| Max position | $100 | Per-trade cap |
| Min trade | $5 | Dust prevention |
| Max positions | 5 tokens | Portfolio limit |
| Confidence gate | 40% | Weak signals filtered |
| Token allowlist | 149 tokens | Ineligible rejected |
| Honeypot check | TWAK `check_token_risk` | Blocked before swap |

Adjust live parameters from the dashboard **Agent Controls** panel (applied next cycle).

---

## Dashboard

The Next.js dashboard (`dashboard/`) provides:

- **Metric cards** — portfolio value, PnL, drawdown, win rate
- **Equity & drawdown charts** — live portfolio snapshots
- **Signal Monitor** — RSI, MACD, news sentiment per token
- **Trade History** — BSCScan links for live trades
- **Activity Feed** — filterable live log viewer
- **Wallet Panel** — address, BNB/USDT balances, sync, competition register
- **Agent Controls** — max position, interval, drawdown, slippage, daily trades

---

## Environment Variables

Copy from `.env.example`. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_MODE` | `paper` | `paper` or `live` |
| `BRIDGE_MODE` | `auto` | `auto`, `twak`, `cmc-pro`, `mock` |
| `CMC_PRO_API_KEY` | — | Hackathon CMC Pro API key |
| `TWAK_MCP_COMMAND` | `twak` | TWAK binary for MCP |
| `TWAK_MCP_ARGS` | `serve` | MCP server args |
| `TWAK_WALLET_PASSWORD` | — | For headless/VPS (optional on macOS with Keychain) |
| `TRADE_INTERVAL_MS` | 30s paper / 5m live | Cycle frequency |
| `MAX_DRAWDOWN_PCT` | `25` | Hard drawdown cap |
| `MAX_POSITION_SIZE_USD` | `100` | Per-trade limit |
| `MAX_DAILY_TRADES` | `10` | Daily trade cap |
| `SLIPPAGE_TOLERANCE` | `1.5` | Swap slippage % |
| `BASE_CURRENCY` | `USDT` | Quote asset |
| `INITIAL_CASH_USD` | `1000` | Paper mode starting cash |
| `CLIPX_NEWS_URL` | ClipX feed | News sentiment source |
| `DASHBOARD_PORT` | `3847` | Agent API port |
| `LOG_LEVEL` | `info` | `error`, `warn`, `trade`, `signal`, `info` |
| `LOG_FILE` | `./logs/agent.jsonl` | Structured log output |

---

## NPM Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Agent + dashboard together (recommended) |
| `npm run agent` | Agent only |
| `npm run agent:dev` | Agent with hot reload |
| `npm run dashboard` | Dashboard only |
| `npm run register` | Competition registration helper |
| `npm run build` | Build all workspaces |

---

## Project Structure

```
neural-alpha/
├── package.json                 # Monorepo root (npm workspaces)
├── .env.example                 # Environment template
├── BNBHACK.md                   # Hackathon specification
├── AGENTS.md                    # AI agent instructions
├── README.md                    # This file
│
├── neural-alpha/                # Autonomous trading agent
│   ├── src/
│   │   ├── index.ts             # Entry point
│   │   ├── agent.ts             # Core trading loop + state API
│   │   ├── config.ts            # Eligible tokens, watchlists, settings
│   │   ├── register.ts          # Competition registration helper
│   │   ├── strategy/
│   │   │   ├── index.ts         # Strategy orchestrator
│   │   │   ├── signals.ts       # 7-factor signal scorer
│   │   │   ├── news-sentiment.ts# ClipX news NLP analyzer
│   │   │   └── indicators.ts    # RSI, MACD, EMA, BB, ATR
│   │   ├── data/
│   │   │   ├── market.ts        # CMC quotes, price history
│   │   │   └── news.ts          # ClipX news fetcher
│   │   ├── execution/
│   │   │   └── executor.ts      # TWAK swap builder
│   │   ├── risk/
│   │   │   ├── manager.ts       # Risk validation
│   │   │   └── portfolio.ts     # PnL + position tracking
│   │   ├── integrations/
│   │   │   ├── create-bridge.ts # Bridge selection (TWAK + CMC Pro)
│   │   │   ├── twak-mcp-bridge.ts
│   │   │   └── cmc-pro-bridge.ts
│   │   └── web/
│   │       └── server.ts        # Agent HTTP API + SSE
│   └── logs/                    # agent.jsonl (gitignored)
│
└── dashboard/                   # Next.js live monitoring UI
    ├── src/
    │   ├── app/                 # Pages + layout
    │   ├── components/dashboard/# UI panels
    │   ├── hooks/               # useAgentConnection
    │   └── lib/                 # API client, state mapping
    └── next.config.ts           # Proxies /api/agent → agent backend
```

---

## TWAK MCP Tools Used

| Tool | Purpose |
|------|---------|
| `get_token_price` | BSC spot prices |
| `get_swap_quote` | Pre-trade quote |
| `swap` | Execute BEP-20 swap |
| `wallet_balance` | BNB balance |
| `get_balance` | USDT balance |
| `check_token_risk` | Honeypot screening |
| `get_trending_tokens` | Watchlist discovery |
| `x402_request` | CMC Agent Hub (when no Pro key) |
| `competition_register` | On-chain registration |
| `competition_status` | Registration check |

---

## VPS / Production Deployment

1. Copy repo + install dependencies
2. Copy `~/.twak/` to the server (encrypted wallet)
3. Set `TWAK_WALLET_PASSWORD` in `.env`
4. Set `AGENT_MODE=live`
5. Run with a process manager:

```bash
npm run dev
# or separately:
npm run agent &
npm run dashboard &
```

Use a reverse proxy for port 3000 if exposing publicly. **Never commit `.env` or wallet files.**

---

## Troubleshooting

### Dashboard shows DEMO / offline

```bash
npm run dev    # starts both agent (:3847) and dashboard (:3000)
```

### Trades show no BSC tx hash in live mode

- Confirm `AGENT_MODE=live` and wallet has USDT + BNB
- Restart agent after funding
- Check logs: `tail -f neural-alpha/logs/agent.jsonl`

### `twak transfer` fails for USDT

Use the **contract address**, not the symbol:

```bash
--chain bsc --token 0x55d398326f99059fF775485246999027B3197955 --decimals 18
```

### Header LIVE but portfolio looks simulated

- **LIVE badge** = connected to agent API
- **Real money** = live mode + on-chain USDT + `0x` tx hashes in trade history

### TWAK testnet warning

```
could not register testnet node for smartchain-testnet
```

Harmless on mainnet — can be ignored.

---

## Security

- **Never commit** `.env`, private keys, seed phrases, or `~/.twak/`
- All signing through TWAK local wallet (self-custody)
- Token allowlist enforced in code
- Honeypot check before every live swap
- Drawdown cap enforced in code, not prompts
- Use a dedicated hot wallet with limited funds for the competition

---

## On-Chain Proof

- **Competition contract:** [`0x212c61b9b72c95d95bf29cf032f5e5635629aed5`](https://bsctrace.com/address/0x212c61b9b72c95d95bf29cf032f5e5635629aed5)
- Every live trade logged with BSC transaction hash in `logs/agent.jsonl`

---

## Resources

| Resource | URL |
|----------|-----|
| Hackathon (DoraHacks) | https://dorahacks.io/hackathon/bnbhack-twt-cmc/ |
| CMC Agent Hub | https://coinmarketcap.com/api/agent |
| Trust Wallet Agent Kit | https://portal.trustwallet.com |
| BNB AI Agent SDK | https://github.com/bnb-chain/bnbagent-sdk |
| Telegram community | https://t.me/+MhiOLT0YUnlmNWFk |
| Full hackathon spec | [BNBHACK.md](./BNBHACK.md) |

---

## License

Private — BNB Hack submission. See hackathon terms for usage.
