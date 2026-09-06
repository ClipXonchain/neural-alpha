# Deploying Neural Alpha on VPS

**Target:** `agents.clipx.app` (public **read-only** dashboard)
**Stack:** Node.js 20+ · PM2 · Nginx · Let's Encrypt · Neon Postgres

This box already runs other PM2 apps (e.g. `clipx-news-brain`). Deploy **never** runs `pm2 restart all`.

---

## Existing VPS (`~/neural-alpha`) — switch to `agentic-wallet`

The old tree stays in the same directory. `.env` is kept. Leftover TWAK processes (`neural-market-feed`, hashed `neural-agent-<uuid>`) are retired. `clipx-news-brain` is left alone.

```bash
cd ~/neural-alpha

# 1. Keep secrets
cp -a .env /tmp/neural-alpha.env

# 2. Fetch the new branch into this dir
git fetch origin
git checkout -B agentic-wallet origin/agentic-wallet
git reset --hard origin/agentic-wallet

# 3. Restore secrets (reset does not keep untracked .env if it was ignored — restore anyway)
cp /tmp/neural-alpha.env .env

# 4. Build + start (read-only public dashboard)
bash deploy/setup.sh
```

Later updates:

```bash
cd ~/neural-alpha
bash deploy/setup.sh --branch agentic-wallet --reset
```

`--reset` discards **code** changes only. `.env` is backed up and restored.

Confirm public site cannot control the agent:

```bash
curl -sS -X POST https://agents.clipx.app/api/agent/control/stop
# → {"error":"Unauthorized"}
```

Operator controls: SSH tunnel to `:3847` and run the dashboard locally **without** `READONLY=true`.

---

## Prerequisites (new box only)

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install 20 && nvm alias default 20
npm install -g pm2
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
```

## Fresh install

```bash
git clone -b agentic-wallet https://github.com/ClipXonchain/neural-alpha.git ~/neural-alpha
cd ~/neural-alpha
cp .env.example .env
nano .env   # API_SECRET, DATABASE_URL, AGENT_MODE, baw, campaign flags
bash deploy/setup.sh
```

The script sets `READONLY=true` and `NEXT_PUBLIC_READONLY=true` on the VPS (baked into the Next.js build).

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `API_SECRET` | **YES** | Auth for POST / control. Generate: `openssl rand -hex 32` |
| `NODE_ENV` | **YES** | `production` (script sets this) |
| `READONLY` / `NEXT_PUBLIC_READONLY` | **YES (public)** | Script forces `true` on this host |
| `BAW_CLI` | YES (live) | Path to `baw` (default `baw`) |
| `PAYMENT_TOKEN` | YES (live) | USDT / USDC / U / USD1 / BNB |
| `CAMPAIGN_REGISTERED` | YES (live) | `true` after Join Now |
| `AGENT_MODE` | YES | `live` or `paper` |
| `DATABASE_URL` | Recommended | Neon Postgres |
| `CORS_ORIGINS` | Optional | Defaults to `https://agents.clipx.app,http://localhost:3000` |

### Binance Agentic Wallet on VPS (live)

Session lives on the OS user that runs PM2 (`root` on this box). A VPS has no
browser, and the public dashboard is read-only, so do **not** use interactive
`baw auth signin` (it tries to open a browser and each run creates a new code).

**Easiest — pair on your laptop, copy the session:**

```bash
# Mac / PC (has a browser)
baw auth signin
baw wallet status --json    # CONNECTED

# Copy the session to the VPS as the same user that runs PM2
scp -r ~/.baw root@YOUR_VPS:~/.baw
ssh root@YOUR_VPS 'baw wallet status --json && pm2 restart neural-agent'
```

**On the VPS only — one command, confirm in the Binance App:**

```bash
bash deploy/baw-connect.sh
```

That starts **one** pairing session, prints the pairing code + `urlForWeb`,
waits for you to confirm in the app, then restarts `neural-agent`.

Do not run `baw auth signin` again while it is waiting — that invalidates the code.

## What `deploy/setup.sh` does

1. Optional `--branch` fetch / `--reset` (keeps `.env`)
2. Forces public read-only env flags; keeps existing `API_SECRET`
3. `npm ci` (**includes** `tsx` — do not use `--omit=dev`)
4. Builds the dashboard with `NEXT_PUBLIC_READONLY=true`
5. Installs Nginx **only if** `sites-available/agents.clipx.app` is missing (won't wipe certbot SSL)
6. Requests Let's Encrypt **only if** no cert exists
7. Deletes leftover `neural-market-feed` + hashed `neural-agent-*`
8. Restarts **only** `neural-agent` and `neural-dashboard`
9. Hits `/api/health`

Flags: `--skip-nginx` `--skip-ssl` `--skip-git` `--help`

## Operations

```bash
pm2 status
pm2 logs neural-agent --lines 100
pm2 logs neural-dashboard --lines 50
pm2 restart neural-agent neural-dashboard

# Health
curl http://127.0.0.1:3847/api/health
curl https://agents.clipx.app/api/health
```

Do **not** `pm2 restart all` or `pm2 stop all` — that would bounce `clipx-news-brain`.

## Architecture

```
Internet
  │
  ▼
[Nginx :443] ── SSL · agents.clipx.app
  │
  └─ /* → [Next.js :3000] ── read-only UI
              │
              └─ /api/agent/* → [Agent API :3847 localhost]
```

- Agent API binds `127.0.0.1:3847` — not on the public internet
- GET (state / logs / SSE) is public for monitoring
- POST (start / stop / trade / config) requires `API_SECRET`
- Public proxy **does not** inject the secret on `agents.clipx.app`

## Security

- CORS allowlist, 120 req/min/IP, 64KB bodies, 20 SSE clients
- Nginx: existing certbot HTTPS + this site's `server_name` only
- Never commit `.env` or `~/.baw/`
