# Deploying Neural Alpha on VPS

**Target:** `agents.clipx.app`
**Stack:** Node.js 20+ · PM2 · Nginx · Let's Encrypt · Neon Postgres

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

## Quick Deploy

```bash
# 1. Clone repo on VPS
git clone <your-repo-url> ~/neural-alpha
cd ~/neural-alpha

# 2. Configure environment
cp .env.example .env
nano .env   # fill in all required values (see below)

# 3. Run deploy script
bash deploy/setup.sh
```

The deploy script handles: dependencies, build, Nginx, SSL, PM2 startup.

## Manual Deploy Steps

### 1. Environment

Required `.env` variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `API_SECRET` | **YES** | Auth token for agent API. Generate: `openssl rand -hex 32` |
| `NODE_ENV` | **YES** | Set to `production` |
| `CMC_API_KEY` | YES | CoinMarketCap API key |
| `TW_ACCESS_ID` | YES | TWAK access ID |
| `TW_HMAC_SECRET` | YES | TWAK HMAC secret |
| `AGENT_WALLET_ADDRESS` | YES | BSC wallet address |
| `AGENT_MODE` | YES | `live` or `paper` |
| `DATABASE_URL` | Recommended | Neon Postgres connection string |
| `OPENAI_API_KEY` | Optional | For AI assistant commands |
| `CORS_ORIGINS` | Optional | Extra allowed origins (comma-separated) |
| `TWAK_WALLET_MODE` | Optional | `local` (default) — auto-binds TWAK HD wallet on agent start |
| `NEXT_PUBLIC_READONLY` | **YES (public)** | Set `true` on agents.clipx.app — hides control UI |
| `READONLY` | **YES (public)** | Set `true` on agents.clipx.app — blocks proxy auth injection |

### 1b. TWAK wallet on VPS (required for live trading)

The agent spawns `twak serve` via MCP. TWAK needs a **local wallet created on the same machine** as PM2:

```bash
# On the VPS (once, as the same user PM2 runs as — usually root)
twak wallet create
twak wallet address --chain bsc    # copy into AGENT_WALLET_ADDRESS in .env
twak wallet balance --chain bsc     # fund with USDT + BNB

# Restart agent after wallet exists
pm2 restart neural-agent
```

If you see `No wallet mode selected` in logs, the wallet was never created or `switch_wallet_mode` failed.
The agent now calls `switch_wallet_mode({ mode: "local" })` automatically on startup.

### 2. Install & Build

```bash
npm ci
npm run prod:build
```

### 3. Nginx

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/agents.clipx.app
sudo ln -sf /etc/nginx/sites-available/agents.clipx.app /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 4. SSL

```bash
sudo certbot --nginx -d agents.clipx.app
```

### 5. Start with PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup    # follow the printed command
```

## Operations

```bash
# Status
pm2 status

# Logs
pm2 logs neural-agent --lines 100
pm2 logs neural-dashboard --lines 50

# Restart
pm2 restart neural-agent
pm2 restart all

# Stop
pm2 stop all

# Health check
curl http://127.0.0.1:3847/api/health

# Health check (external)
curl https://agents.clipx.app/api/health
```

## Architecture

```
Internet
  │
  ▼
[Nginx :443] ── SSL termination
  │
  ├─ /api/agent/* → [Next.js :3000] ── API proxy (adds Bearer auth)
  │                       │
  │                       └─ /api/* → [Agent API :3847 localhost only]
  │
  └─ /* → [Next.js :3000] ── Dashboard UI
```

- **Agent API** (`neural-agent`) binds to `127.0.0.1:3847` — not exposed to internet
- **Dashboard** (`neural-dashboard`) binds to `:3000`
- **Nginx** terminates SSL, routes traffic, adds security headers
- Dashboard proxy authenticates with agent API using `API_SECRET`

## Security Notes

- Agent API requires `Authorization: Bearer <API_SECRET>` on all endpoints except `/api/health`
- CORS restricted to `agents.clipx.app` and `localhost:3000`
- Rate limited to 120 requests/min per IP
- Request bodies capped at 64KB
- SSE connections capped at 20 concurrent
- Error messages sanitized in production (no stack traces)
- Nginx adds HSTS, X-Frame-Options, CSP headers

## Updating

```bash
cd ~/neural-alpha
git pull
npm ci
npm run prod:build
pm2 restart all
```
