# Deploying Neural Alpha on VPS

**Stack:** Node.js 20+ · PM2 · Nginx · Let's Encrypt · Neon Postgres · Self-custodial EVM wallet (viem + Binance Web3 aggregator)

Neural Alpha is a **public multi-tenant agents platform**: users SIWE-login, deploy agents, fund encrypted trading wallets, and control them from the dashboard. A shared **market feed** polls CMC/Binance once for all agents.

Platform overview: [`README.md`](../README.md) · AI agent notes: [`AGENTS.md`](../AGENTS.md)

---

## Deploy modes

| Mode | Use case | Key env |
|------|----------|---------|
| **Public monitor** | Read-only showcase (e.g. `agents.clipx.app`) | `READONLY=true`, `NEXT_PUBLIC_READONLY=true` |
| **Operator platform** | Owners deploy & control their own agents | `READONLY=false`, `DATABASE_URL`, `WALLET_MASTER_SECRET`, `SESSION_SECRET`, `SIWE_DOMAIN` |

---

## Prerequisites

```bash
# Node.js 20+ (via nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install 20 && nvm alias default 20

# PM2
npm install -g pm2

# Nginx + Certbot
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
```

---

## Quick deploy

```bash
git clone <your-repo-url> ~/neural-alpha
cd ~/neural-alpha

cp .env.example .env
nano .env   # fill required values (see checklist below)

bash deploy/setup.sh
```

The script installs deps, builds the dashboard, configures Nginx/SSL, and starts PM2 (`neural-market-feed`, `neural-supervisor`, `neural-dashboard`, and optionally `neural-agent` when `DISABLE_SINGLETON_AGENT` is unset and `DATABASE_URL` is absent).

Per-tenant agents are spawned by the **Agent Supervisor** (`neural-supervisor` on `:4200`) as `neural-agent-<uuid>`.

See [`docs/AGENT-INFRA.md`](../docs/AGENT-INFRA.md) for the control-plane design.

---

## Production secrets checklist

Generate unique values — **never reuse the same secret for multiple roles**:

```bash
openssl rand -hex 32   # run 3× for API_SECRET, SESSION_SECRET, WALLET_MASTER_SECRET
```

### Required (all production deploys)

| Variable | Description |
|----------|-------------|
| `NODE_ENV` | `production` |
| `CMC_PRO_API_KEY` | CoinMarketCap Pro API key |
| `BINANCE_WEB3_API_KEY` | Binance Web3 Trading API key (DEX aggregator) |
| `BINANCE_WEB3_API_SECRET` | Binance Web3 Trading API secret |
| `BRIDGE_MODE` | `evm` (self-custodial BSC wallet) |
| `MARKET_FEED_URL` | `http://127.0.0.1:4100` (shared CMC poll) |

### Required (operator / multi-tenant platform)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Neon Postgres (`sslmode=require`) |
| `SESSION_SECRET` | ≥32 chars — encrypts SIWE cookies (**≠ API_SECRET**) |
| `WALLET_MASTER_SECRET` | ≥32 chars — derives per-agent keystore passwords (**≠ API_SECRET**) |
| `SIWE_DOMAIN` | Public hostname only, e.g. `trading.example.com` (no `https://`) |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect Cloud project ID |

### Required (singleton agent on VPS)

| Variable | Description |
|----------|-------------|
| `API_SECRET` | Bearer token for agent API (`openssl rand -hex 32`) |

Per-agent processes spawned by the dashboard get their own derived `API_SECRET` automatically.

### Public monitor only

| Variable | Description |
|----------|-------------|
| `READONLY` / `NEXT_PUBLIC_READONLY` | Operator: `false` (default). Public monitor: `true` |
| `DISABLE_SINGLETON_AGENT` | `true` when using multi-tenant `DATABASE_URL` (skips PM2 `neural-agent`) |

### Optional

| Variable | Description |
|----------|-------------|
| `PLATFORM_TREASURY_ADDRESS` | BSC address for deploy fee |
| `DEPLOY_FEE_BNB` | Default `0.01` |
| `SKIP_DEPLOY_FEE` | Dev only — **ignored when `NODE_ENV=production`** |
| `OPENAI_API_KEY` | AI assistant commands |
| `BSC_RPC_URL` | Default: `https://bsc-dataseed.binance.org` |
| `CORS_ORIGINS` | Extra allowed origins (comma-separated) |
| `AGENT_DATA_DIR` | Default `./data/agents` |
| `BINANCE_ALPHA_CACHE_MS` | Alpha token list refresh (default 6h) |

### Removed (do not set)

| Variable | Notes |
|----------|-------|
| `TW_ACCESS_ID` / `TW_HMAC_SECRET` | TWAK removed |
| `AGENT_MODE=paper` | Paper mode removed — live only |
| `INITIAL_CASH_USD=50` | Causes phantom PnL — leave unset or `0` |

---

## Example `.env` — operator platform

```bash
NODE_ENV=production
BRIDGE_MODE=evm

# Secrets (generate unique values for each)
SESSION_SECRET=<64-char-hex>
WALLET_MASTER_SECRET=<64-char-hex>
API_SECRET=<64-char-hex>          # singleton fallback; per-agent secrets auto-derived on deploy

# Platform
DATABASE_URL=postgresql://...@.../neondb?sslmode=require
SIWE_DOMAIN=trading.example.com
CMC_PRO_API_KEY=...
BINANCE_WEB3_API_KEY=...
BINANCE_WEB3_API_SECRET=...
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=...

# Market feed (one CMC poll → all agents)
MARKET_FEED_URL=http://127.0.0.1:4100
MARKET_FEED_PORT=4100

# Operator UI (owners deploy & control agents)
READONLY=false
NEXT_PUBLIC_READONLY=false

# Deploy fee (production)
PLATFORM_TREASURY_ADDRESS=0x...
DEPLOY_FEE_BNB=0.01
```

## Example `.env` — public monitor

```bash
NODE_ENV=production
READONLY=true
NEXT_PUBLIC_READONLY=true
API_SECRET=<64-char-hex>
CMC_PRO_API_KEY=...
BINANCE_WEB3_API_KEY=...
BINANCE_WEB3_API_SECRET=...
MARKET_FEED_URL=http://127.0.0.1:4100
```

---

## Manual deploy steps

### 1. Install & build

```bash
npm ci
npm run prod:build
mkdir -p logs data/agents
```

### 2. Sync dashboard env

Root `.env` is hydrated into Next.js via `next.config.ts`. For production builds, also sync platform vars:

```bash
# Minimal sync (setup.sh does this automatically)
grep -E '^(DATABASE_URL|SESSION_SECRET|WALLET_MASTER_SECRET|SIWE_DOMAIN|CMC_PRO_API_KEY|BINANCE_WEB3_API_KEY|BINANCE_WEB3_API_SECRET|NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID|MARKET_FEED_URL|READONLY|NEXT_PUBLIC_READONLY)=' .env \
  > dashboard/.env.local
```

Set `NEXT_PUBLIC_READONLY=false` in `dashboard/.env.local` for operator UI, then **rebuild** the dashboard.

### 3. Nginx

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/your.domain.com
sudo ln -sf /etc/nginx/sites-available/your.domain.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 4. SSL

```bash
sudo certbot --nginx -d your.domain.com
```

### 5. Start with PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup    # follow the printed command
```

Processes:

| PM2 name | Port | Binding |
|----------|------|---------|
| `neural-market-feed` | 4100 | `127.0.0.1` only |
| `neural-agent` | 3847+ | `127.0.0.1` only |
| `neural-dashboard` | 3000 | Nginx front |

---

## User flow (operator platform)

1. Visit `/login` → connect wallet (Browser or WalletConnect) → SIWE sign-in
2. `/deploy` → pay deploy fee (if treasury set) → agent provisioned
3. **Save seed phrase** shown once — never stored in DB
4. Fund agent trading wallet: **USDT** (trades) + **BNB** (gas)
5. `/agents/{id}` → backup seed, settings, start trading

---

## Wallet & execution (EVM — not TWAK)

- Each agent gets an **encrypted BIP-39 keystore** under `data/agents/{id}/keystore.json`
- Unlock password derived from `WALLET_MASTER_SECRET` + `agent_id`
- Swaps execute via **viem + Binance Web3 DEX aggregator** on BSC mainnet (no direct Pancake V2 pools)
- Private keys never leave the server filesystem (encrypted at rest)

**Fund the trading wallet** (shown after deploy):

```
USDT  — swap currency (e.g. $50–500 to start)
BNB   — gas reserve (≥ $5 worth)
```

---

## Architecture

```
Internet
  │
  ▼
[Nginx :443] ── SSL termination
  │
  ├─ /api/agent/* → [Next.js :3000] ── authenticated proxy
  │                       │
  │                       ├─ READONLY: GET only, no API secret
  │                       ├─ Operator: SIWE session required for mutations
  │                       └─ → [Agent API :3847 localhost]
  │
  ├─ /api/agents/* → [Next.js] ── deploy, backup, config (owner session)
  ├─ /api/auth/*   → [Next.js] ── SIWE login
  │
  └─ /* → [Next.js :3000] ── Dashboard UI

[Market feed :4100] ── localhost ── one CMC/Binance/ClipX poll
       ▲
       └── all agent processes read MARKET_FEED_URL snapshot
```

---

## Security model

| Control | Behavior |
|---------|----------|
| Agent API bind | `127.0.0.1` only — not internet-facing |
| Market feed bind | `127.0.0.1:4100` only |
| `API_SECRET` | Required in production; agent rejects unauthenticated POST |
| `READONLY` | Blocks proxy mutations; no bearer injection |
| SIWE session | Required for deploy, backup, config, agent control |
| Owner isolation | Agent UUID routes require matching wallet session |
| Safe token list | Binance Spot ∪ Alpha only (~300+ live-synced) |
| Keystore | AES-256-GCM; master secret separate from API secret |
| Deploy fee | Verified on-chain in production |

### Clear legacy paper / phantom DB data

```bash
npm run db:clear-paper --workspace=neural-alpha -- --state
```

---

## Operations

```bash
pm2 status
pm2 logs neural-market-feed --lines 50
pm2 logs neural-agent --lines 100
pm2 logs neural-dashboard --lines 50

pm2 restart all

# Health
curl http://127.0.0.1:4100/health      # market feed
curl http://127.0.0.1:3000/api/health  # dashboard (+ feed status)
curl https://your.domain.com/api/health
# Singleton agent (only if DISABLE_SINGLETON_AGENT unset):
# curl http://127.0.0.1:3847/api/health
```

### Update deployment

**Option A — git pull on VPS** (server has repo clone):

```bash
cd ~/neural-alpha
git pull
bash deploy/update.sh   # fast path: sync env, build, pm2 restart
```

**Option B — push from your laptop (no git pull on VPS)**:

```bash
# One-time: ensure SSH key works
ssh-copy-id root@YOUR_VPS_IP

# From your local repo:
VPS_HOST=root@YOUR_VPS_IP bash deploy/sync-to-vps.sh
```

This `rsync`s code (excludes `node_modules`, `.next`, `.env`, `data/agents/`), then SSHs in and runs `deploy/update.sh`.

Useful variants:

```bash
# Preview what would sync
DRY_RUN=1 VPS_HOST=root@YOUR_VPS_IP bash deploy/sync-to-vps.sh

# Sync files only — build manually on VPS later
SKIP_BUILD=1 VPS_HOST=root@YOUR_VPS_IP bash deploy/sync-to-vps.sh
ssh root@YOUR_VPS_IP 'cd ~/neural-alpha && bash deploy/update.sh'

# Custom remote path
VPS_HOST=ubuntu@YOUR_VPS_IP VPS_PATH=/var/www/neural-alpha bash deploy/sync-to-vps.sh
```

Manual rsync (same excludes as the script):

```bash
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude .git \
  --exclude .env --exclude .env.local --exclude data/agents \
  ./ root@YOUR_VPS_IP:~/neural-alpha/
ssh root@YOUR_VPS_IP 'cd ~/neural-alpha && bash deploy/update.sh'
```

Or manually on VPS after git pull:

```bash
cd ~/neural-alpha
git pull
npm ci
npm run prod:build
pm2 restart all
```

**Slow build at “Collecting page data”?** Older builds pre-fetched the Binance Alpha token list during `next build` (no timeout — could hang on some VPS regions). Current code skips that; alpha tokens load on first request with a 6h cache header. Agent reconcile also no longer runs during build.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `SESSION_SECRET required in production` | Set `SESSION_SECRET` (≥32 chars) in `.env`, rebuild dashboard |
| `WALLET_MASTER_SECRET required` | Set unique 32+ byte hex secret; restart agents |
| `SIWE_DOMAIN must be set` | Set to your public hostname (no scheme) |
| Deploy fails `DATABASE_URL required` | Set Neon URL in root `.env` + `dashboard/.env.local` |
| Agent won't start trades | Fund wallet USDT + BNB; check `BRIDGE_MODE=evm` |
| CMC 402 errors | Verify `CMC_PRO_API_KEY` plan/credits |
| Swap quote / bridge init fails | Set `BINANCE_WEB3_API_KEY` + `BINANCE_WEB3_API_SECRET` |
| Phantom −$50 PnL | Run `db:clear-paper`; ensure `INITIAL_CASH_USD` unset |
| 401 on agent commands | Log in via SIWE; operator mode requires session |
| Config hot-reload fails | Redeploy agent or check `data/agents/{id}/.env` has `API_SECRET` |
| 502 Bad Gateway on `/api/health` | Dashboard may be up — test `curl http://127.0.0.1:3000/api/health` on VPS. If OK: fix nginx HTTPS proxy (`sudo cp deploy/nginx.conf /etc/nginx/sites-available/agents.clipx.app && sudo nginx -t && sudo systemctl reload nginx`). If fail: `pm2 logs neural-dashboard` |

---

## Pre-launch checklist

- [ ] `NODE_ENV=production`
- [ ] `SESSION_SECRET`, `WALLET_MASTER_SECRET` set (unique, ≥32 chars)
- [ ] `SIWE_DOMAIN` matches public hostname
- [ ] `DATABASE_URL` with `sslmode=require`
- [ ] `DISABLE_SINGLETON_AGENT=true` when multi-tenant (dashboard spawns agents)
- [ ] `CMC_PRO_API_KEY` valid
- [ ] `BINANCE_WEB3_API_KEY` / `BINANCE_WEB3_API_SECRET` set
- [ ] HTTPS + HSTS via Certbot
- [ ] `data/agents/` not in git; directory permissions restricted
- [ ] Operator: `READONLY=false` / `NEXT_PUBLIC_READONLY=false` (default). Monitor showcase: both `true`
- [ ] Never set `DISABLE_DRAWDOWN_LIMIT` or `AGENT_PRIVATE_KEY` in production
- [ ] Dashboard rebuilt after changing `NEXT_PUBLIC_*` vars
- [ ] PM2: market-feed + dashboard (+ singleton agent only if not multi-tenant)
- [ ] Legacy paper DB cleared (`db:clear-paper`)
- [ ] `.env` never committed
- [ ] Agents survive `pm2 restart neural-dashboard` (listed as `neural-agent-<uuid>` in `pm2 status`)
- [ ] Deploy fee txs cannot be reused (unique `deploy_fee_txs.tx_hash`)

---

## Files

| Path | Purpose |
|------|---------|
| `deploy/setup.sh` | One-command VPS setup |
| `deploy/nginx.conf` | Nginx reverse proxy |
| `ecosystem.config.cjs` | PM2 process definitions |
| `.env.example` | Full env reference |
| `neural-alpha/scripts/clear-paper-db.ts` | Remove legacy paper/NAV data |
