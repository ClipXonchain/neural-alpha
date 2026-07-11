#!/usr/bin/env bash
set -euo pipefail

# Fast production update — skip nginx/ssl/pm2 bootstrap (use after initial deploy/setup.sh).
# Usage: bash deploy/update.sh

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

echo "▸ Syncing dashboard env from .env..."
mkdir -p dashboard
grep -E '^(NEXT_PUBLIC_READONLY|READONLY|API_SECRET|AGENT_API_URL|DATABASE_URL|SESSION_SECRET|WALLET_MASTER_SECRET|SIWE_DOMAIN|CMC_PRO_API_KEY|CMC_API_KEY|BINANCE_WEB3_API_KEY|BINANCE_WEB3_API_SECRET|MARKET_FEED_URL|NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID|PLATFORM_TREASURY_ADDRESS|SKIP_DEPLOY_FEE|DEPLOY_FEE_BNB|BSC_RPC_URL|DISABLE_SINGLETON_AGENT|NODE_ENV|PUBLIC_BASE_URL)=' .env \
  > dashboard/.env.local 2>/dev/null || true

echo "▸ Installing dependencies..."
# Include devDependencies: Next build needs tailwind/postcss/typescript; agents run via tsx.
npm ci 2>/dev/null || npm install

echo "▸ Building dashboard (no build-time Binance/DB side effects)..."
set -a
# shellcheck disable=SC1091
source .env
set +a
# Low-memory VPS: single worker avoids OOM thrashing during page-data collection
export NEXT_BUILD_WORKERS="${NEXT_BUILD_WORKERS:-1}"
npm run dashboard:build

echo "▸ Restarting PM2 processes..."
set -a
# shellcheck disable=SC1091
source .env
set +a
pm2 delete neural-market-feed neural-agent neural-dashboard 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

echo "✓ Update complete — curl https://your.domain/api/health"
