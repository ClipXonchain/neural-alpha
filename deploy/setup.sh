#!/usr/bin/env bash
set -euo pipefail

# Neural Alpha — VPS Deployment Script
# Usage: bash deploy/setup.sh
# Prerequisites: Node.js 20+, npm, pm2, nginx, certbot

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="agents.clipx.app"

echo "╔══════════════════════════════════════════════════╗"
echo "║   Neural Alpha — Production Setup                ║"
echo "╚══════════════════════════════════════════════════╝"

cd "$APP_DIR"

# ─── 1. Check prerequisites ────────────────────────────────────
echo ""
echo "▸ Checking prerequisites..."

for cmd in node npm pm2 nginx certbot; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "  ✗ $cmd not found. Install it first."
    if [ "$cmd" = "pm2" ]; then
      echo "    → npm install -g pm2"
    fi
    exit 1
  fi
done

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 20 ]; then
  echo "  ✗ Node.js 20+ required (found $(node -v))"
  exit 1
fi

echo "  ✓ All prerequisites met"

# ─── 2. Check .env ─────────────────────────────────────────────
echo ""
echo "▸ Checking environment..."

if [ ! -f .env ]; then
  echo "  ✗ .env not found. Copy .env.example → .env and fill in secrets."
  exit 1
fi

if ! grep -q "^API_SECRET=" .env || [ -z "$(grep '^API_SECRET=' .env | cut -d= -f2)" ]; then
  SECRET=$(openssl rand -hex 32)
  echo ""
  echo "  ⚠ API_SECRET not set. Generating one..."
  echo "API_SECRET=$SECRET" >> .env
  echo "  ✓ API_SECRET added to .env"
  echo "  → Value: $SECRET"
  echo "  → Keep this safe — dashboard uses it to authenticate with agent API"
fi

if ! grep -q "^NODE_ENV=" .env; then
  echo "NODE_ENV=production" >> .env
  echo "  ✓ NODE_ENV=production added to .env"
fi

# Production secrets — generate if missing (operator platform)
if ! grep -q "^SESSION_SECRET=" .env || [ -z "$(grep '^SESSION_SECRET=' .env | cut -d= -f2-)" ]; then
  SESSION_SECRET=$(openssl rand -hex 32)
  echo "SESSION_SECRET=$SESSION_SECRET" >> .env
  echo "  ✓ SESSION_SECRET generated and added to .env"
fi

if ! grep -q "^WALLET_MASTER_SECRET=" .env || [ -z "$(grep '^WALLET_MASTER_SECRET=' .env | cut -d= -f2-)" ]; then
  WALLET_MASTER_SECRET=$(openssl rand -hex 32)
  echo "WALLET_MASTER_SECRET=$WALLET_MASTER_SECRET" >> .env
  echo "  ✓ WALLET_MASTER_SECRET generated and added to .env"
fi

if ! grep -q "^MARKET_FEED_URL=" .env; then
  echo "MARKET_FEED_URL=http://127.0.0.1:4100" >> .env
  echo "  ✓ MARKET_FEED_URL added to .env"
fi

if ! grep -q "^BRIDGE_MODE=" .env; then
  echo "BRIDGE_MODE=evm" >> .env
  echo "  ✓ BRIDGE_MODE=evm added to .env"
fi

# Public dashboard — default OPERATOR mode (full controls).
# For a public monitor showcase, set both to true explicitly before build.
if ! grep -q "^NEXT_PUBLIC_READONLY=" .env; then
  echo "NEXT_PUBLIC_READONLY=false" >> .env
  echo "  ✓ NEXT_PUBLIC_READONLY=false (operator) added to .env"
fi
if ! grep -q "^READONLY=" .env; then
  echo "READONLY=false" >> .env
  echo "  ✓ READONLY=false (operator) added to .env"
fi

# Multi-tenant: skip singleton neural-agent when DATABASE_URL is configured
if grep -q "^DATABASE_URL=.\+" .env 2>/dev/null; then
  if ! grep -q "^DISABLE_SINGLETON_AGENT=" .env; then
    echo "DISABLE_SINGLETON_AGENT=true" >> .env
    echo "  ✓ DISABLE_SINGLETON_AGENT=true (multi-tenant) added to .env"
  fi
  if ! grep -q "^SUPERVISOR_URL=" .env; then
    echo "SUPERVISOR_URL=http://127.0.0.1:4200" >> .env
    echo "  ✓ SUPERVISOR_URL=http://127.0.0.1:4200 added to .env"
  fi
fi

# Next.js reads dashboard/.env.local at build time for server + NEXT_PUBLIC_* vars
mkdir -p dashboard
grep -E '^(NEXT_PUBLIC_READONLY|READONLY|API_SECRET|AGENT_API_URL|DATABASE_URL|SESSION_SECRET|WALLET_MASTER_SECRET|SIWE_DOMAIN|CMC_PRO_API_KEY|CMC_API_KEY|BINANCE_WEB3_API_KEY|BINANCE_WEB3_API_SECRET|MARKET_FEED_URL|NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID|PLATFORM_TREASURY_ADDRESS|SKIP_DEPLOY_FEE|DEPLOY_FEE_BNB|BSC_RPC_URL|DISABLE_SINGLETON_AGENT|SUPERVISOR_URL|SUPERVISOR_SECRET|NODE_ENV|PUBLIC_BASE_URL)=' .env > dashboard/.env.local 2>/dev/null || true
echo "  ✓ dashboard/.env.local synced from .env"

echo "  ✓ Environment configured"

# ─── 3. Install dependencies ───────────────────────────────────
echo ""
echo "▸ Installing dependencies..."
# Include devDependencies: Next build needs tailwind/postcss/typescript; agents run via tsx.
npm ci 2>/dev/null || npm install
echo "  ✓ Dependencies installed"

# ─── 4. Build dashboard ────────────────────────────────────────
echo ""
echo "▸ Building dashboard..."
set -a
# shellcheck disable=SC1091
source .env
set +a
npm run dashboard:build
echo "  ✓ Dashboard built"

# ─── 5. Create log directory ───────────────────────────────────
mkdir -p logs
echo "  ✓ Log directory ready"

# ─── 6. Setup Nginx ────────────────────────────────────────────
echo ""
echo "▸ Setting up Nginx..."

NGINX_CONF="/etc/nginx/sites-available/$DOMAIN"
if [ ! -f "$NGINX_CONF" ]; then
  sudo cp deploy/nginx.conf "$NGINX_CONF"
  sudo ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/
  echo "  ✓ Nginx config installed"
else
  echo "  → Nginx config already exists at $NGINX_CONF"
fi

sudo nginx -t && sudo systemctl reload nginx
echo "  ✓ Nginx reloaded"

# ─── 7. SSL Certificate ────────────────────────────────────────
echo ""
echo "▸ SSL certificate..."

if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  echo "  → Requesting SSL certificate for $DOMAIN..."
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect
  echo "  ✓ SSL certificate installed"
else
  echo "  → SSL certificate already exists"
fi

# ─── 8. Start with PM2 ─────────────────────────────────────────
echo ""
echo "▸ Starting services with PM2..."

pm2 delete neural-market-feed neural-agent neural-dashboard 2>/dev/null || true
set -a
# shellcheck disable=SC1091
source .env
set +a
pm2 start ecosystem.config.cjs
pm2 save

echo "  ✓ Services started"

# ─── 9. Setup PM2 startup ──────────────────────────────────────
echo ""
echo "▸ Enabling PM2 startup on boot..."
pm2 startup 2>/dev/null || echo "  → Run the pm2 startup command above if prompted"
pm2 save

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   ✓ Deployment complete!                         ║"
echo "║                                                  ║"
echo "║   Dashboard: https://$DOMAIN           ║"
echo "║   Agent API: http://127.0.0.1:3847/api          ║"
echo "║   Health:    https://$DOMAIN/api/health          ║"
echo "║   Market feed: http://127.0.0.1:4100/health      ║"
echo "║                                                  ║"
echo "║   Operator platform: SIWE_DOMAIN=$DOMAIN         ║"
echo "║   READONLY=false (default). Monitor: set true.   ║"
echo "║   DISABLE_SINGLETON_AGENT=true with DATABASE_URL ║"
echo "║   Required: SESSION_SECRET, WALLET_MASTER_SECRET ║"
echo "║   BINANCE_WEB3_API_KEY + SECRET, CMC_PRO_API_KEY ║"
echo "║   PM2 commands:                                  ║"
echo "║     pm2 status                                   ║"
echo "║     pm2 logs neural-agent                        ║"
echo "║     pm2 restart all                              ║"
echo "╚══════════════════════════════════════════════════╝"
