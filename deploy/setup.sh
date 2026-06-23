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

echo "  ✓ Environment configured"

# ─── 3. Install dependencies ───────────────────────────────────
echo ""
echo "▸ Installing dependencies..."
npm ci --omit=dev 2>/dev/null || npm install --omit=dev
echo "  ✓ Dependencies installed"

# ─── 4. Build dashboard ────────────────────────────────────────
echo ""
echo "▸ Building dashboard..."
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

pm2 delete neural-agent neural-dashboard 2>/dev/null || true
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
echo "║   Health:    https://$DOMAIN/api/health║"
echo "║                                                  ║"
echo "║   PM2 commands:                                  ║"
echo "║     pm2 status                                   ║"
echo "║     pm2 logs neural-agent                        ║"
echo "║     pm2 restart all                              ║"
echo "╚══════════════════════════════════════════════════╝"
