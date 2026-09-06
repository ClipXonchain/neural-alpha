#!/usr/bin/env bash
set -euo pipefail

# Neural Alpha — VPS deploy / update
#
# Safe on a shared box: never runs `pm2 restart all`, never deletes
# unrelated apps (clipx-news-brain, etc.). Only manages:
#   neural-agent  ·  neural-dashboard
# and retires leftover TWAK names (neural-market-feed, hashed neural-agent-*).
#
# Public dashboard is always read-only (agents.clipx.app).
#
# Usage:
#   bash deploy/setup.sh
#   bash deploy/setup.sh --branch agentic-wallet --reset
#   bash deploy/setup.sh --skip-nginx --skip-ssl
#
# Existing VPS (~/neural-alpha with old code):
#   cd ~/neural-alpha
#   cp -a .env /tmp/neural-alpha.env
#   git fetch origin
#   git checkout -B agentic-wallet origin/agentic-wallet
#   git reset --hard origin/agentic-wallet
#   cp /tmp/neural-alpha.env .env
#   bash deploy/setup.sh

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="${DOMAIN:-agents.clipx.app}"
BRANCH=""
RESET=0
SKIP_NGINX=0
SKIP_SSL=0
SKIP_GIT=0

OUR_APPS=(neural-agent neural-dashboard)
LEGACY_APPS=(neural-market-feed)

usage() {
  cat <<'EOF'
Neural Alpha VPS setup

  bash deploy/setup.sh [options]

  --branch <name>   Fetch origin/<name> and check it out before building
  --reset           Discard local code changes (keeps .env). Use on the old VPS tree
  --skip-nginx      Do not install/reload Nginx
  --skip-ssl        Do not request a Let's Encrypt cert
  --skip-git        Do not fetch/checkout even if --branch is set
  -h, --help        Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --reset) RESET=1; shift ;;
    --skip-nginx) SKIP_NGINX=1; shift ;;
    --skip-ssl) SKIP_SSL=1; shift ;;
    --skip-git) SKIP_GIT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

echo "╔══════════════════════════════════════════════════╗"
echo "║   Neural Alpha — Production Setup                ║"
echo "╚══════════════════════════════════════════════════╝"

cd "$APP_DIR"

# ─── helpers ───────────────────────────────────────────────────
env_upsert() {
  node -e '
    const fs = require("fs");
    const file = ".env";
    const key = process.argv[1];
    const val = process.argv[2];
    let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (text && !text.endsWith("\n")) text += "\n";
    const re = new RegExp("^" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=.*$", "m");
    if (re.test(text)) text = text.replace(re, key + "=" + val);
    else text += key + "=" + val + "\n";
    fs.writeFileSync(file, text);
  ' "$1" "$2"
}

env_get() {
  node -e '
    const fs = require("fs");
    const key = process.argv[1];
    if (!fs.existsSync(".env")) process.exit(0);
    for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
      if (line.startsWith(key + "=")) {
        process.stdout.write(line.slice(key.length + 1));
        break;
      }
    }
  ' "$1"
}

pm2_names() {
  node -e '
    const { execSync } = require("child_process");
    let apps = [];
    try { apps = JSON.parse(execSync("pm2 jlist", { encoding: "utf8" }) || "[]"); }
    catch { process.exit(0); }
    for (const a of apps) if (a && a.name) console.log(a.name);
  '
}

# ─── 1. Prerequisites ──────────────────────────────────────────
echo ""
echo "▸ Checking prerequisites..."

for cmd in node npm pm2; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "  ✗ $cmd not found."
    if [[ "$cmd" == "pm2" ]]; then
      echo "    → npm install -g pm2"
    fi
    exit 1
  fi
done

NODE_VER="$(node -v | sed 's/v//' | cut -d. -f1)"
if [[ "$NODE_VER" -lt 20 ]]; then
  echo "  ✗ Node.js 20+ required (found $(node -v))"
  exit 1
fi

if [[ "$SKIP_NGINX" -eq 0 ]] && ! command -v nginx &>/dev/null; then
  echo "  ✗ nginx not found (or pass --skip-nginx)"
  exit 1
fi
if [[ "$SKIP_SSL" -eq 0 ]] && ! command -v certbot &>/dev/null; then
  echo "  ⚠ certbot not found — skipping SSL (pass --skip-ssl to silence)"
  SKIP_SSL=1
fi

echo "  ✓ Node $(node -v) · npm $(npm -v) · pm2 $(pm2 -v | head -1)"

# ─── 2. Git (optional) ─────────────────────────────────────────
if [[ -n "$BRANCH" && "$SKIP_GIT" -eq 0 ]]; then
  echo ""
  echo "▸ Syncing git branch '$BRANCH'..."
  if [[ ! -d .git ]]; then
    echo "  ✗ $APP_DIR is not a git repo"
    exit 1
  fi

  ENV_BAK="$(mktemp /tmp/neural-alpha.env.XXXXXX)"
  if [[ -f .env ]]; then
    cp -a .env "$ENV_BAK"
    echo "  ✓ .env backed up → $ENV_BAK"
  fi

  git fetch origin

  if ! git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
    echo "  ✗ origin/$BRANCH not found. Push the branch first, then re-run."
    rm -f "$ENV_BAK"
    exit 1
  fi

  if [[ "$RESET" -eq 1 ]]; then
    git checkout -B "$BRANCH" "origin/$BRANCH"
    git reset --hard "origin/$BRANCH"
    echo "  ✓ Reset to origin/$BRANCH (code only)"
  else
    if [[ -n "$(git status --porcelain)" ]]; then
      echo "  ✗ Working tree is dirty. Re-run with --reset to discard local code"
      echo "    (your .env is preserved). Or commit/stash first."
      rm -f "$ENV_BAK"
      exit 1
    fi
    git checkout -B "$BRANCH" "origin/$BRANCH"
    git pull --ff-only origin "$BRANCH"
    echo "  ✓ Checked out origin/$BRANCH"
  fi

  if [[ -f "$ENV_BAK" ]]; then
    cp -a "$ENV_BAK" .env
    echo "  ✓ .env restored"
  fi
fi

# ─── 3. Environment ────────────────────────────────────────────
echo ""
echo "▸ Checking environment..."

if [[ ! -f .env ]]; then
  echo "  ✗ .env not found."
  echo "    On this VPS, restore the previous .env or: cp .env.example .env"
  exit 1
fi

# Public site is always monitoring-only. Force these; never wipe other secrets.
env_upsert NODE_ENV production
env_upsert READONLY true
env_upsert NEXT_PUBLIC_READONLY true

if [[ -z "$(env_get API_SECRET)" ]]; then
  SECRET="$(openssl rand -hex 32)"
  env_upsert API_SECRET "$SECRET"
  echo "  ⚠ API_SECRET was empty — generated a new one"
  echo "    $SECRET"
else
  echo "  ✓ API_SECRET already set (kept)"
fi

if [[ -z "$(env_get CORS_ORIGINS)" ]]; then
  env_upsert CORS_ORIGINS "https://${DOMAIN},http://localhost:3000"
  echo "  ✓ CORS_ORIGINS added"
fi

if [[ -z "$(env_get AGENT_API_URL)" ]]; then
  env_upsert AGENT_API_URL "http://127.0.0.1:3847"
fi

# Next.js inlines NEXT_PUBLIC_* at build time from dashboard/.env.local
mkdir -p dashboard
node -e '
  const fs = require("fs");
  const keys = ["NEXT_PUBLIC_READONLY", "READONLY", "API_SECRET", "AGENT_API_URL"];
  const src = fs.readFileSync(".env", "utf8");
  const map = {};
  for (const line of src.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0 || line.startsWith("#")) continue;
    map[line.slice(0, i)] = line.slice(i + 1);
  }
  const out = keys
    .filter((k) => map[k] != null && String(map[k]).trim() !== "")
    .map((k) => k + "=" + map[k])
    .join("\n") + "\n";
  fs.writeFileSync("dashboard/.env.local", out);
'
echo "  ✓ dashboard/.env.local synced (API_SECRET + read-only flags only)"
echo "  ✓ Public dashboard: READONLY=true · NEXT_PUBLIC_READONLY=true"

# ─── 4. Optional baw check ─────────────────────────────────────
MODE="$(env_get AGENT_MODE)"
if [[ "${MODE}" == "live" ]]; then
  echo ""
  echo "▸ Live mode — Binance Agentic Wallet..."
  if ! command -v baw &>/dev/null; then
    echo "  ⚠ baw CLI not on PATH. Install: npm i -g @binance/agentic-wallet"
    echo "    Then: bash deploy/baw-connect.sh"
  else
    echo "  ✓ baw: $(baw --version 2>/dev/null || echo found)"
    if baw wallet status --json >/dev/null 2>&1; then
      echo "  ✓ baw wallet status ok"
    else
      echo "  ⚠ baw not signed in. After deploy: bash deploy/baw-connect.sh"
    fi
  fi
fi

# ─── 5. Dependencies ───────────────────────────────────────────
echo ""
echo "▸ Installing dependencies..."
# Do NOT use --omit=dev: agent runs via tsx (devDependency).
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
echo "  ✓ Dependencies installed"

# ─── 6. Build dashboard (read-only flags baked in) ─────────────
echo ""
echo "▸ Building dashboard..."
export NODE_ENV=production
export NEXT_PUBLIC_READONLY=true
export READONLY=true
npm run dashboard:build
echo "  ✓ Dashboard built (public read-only)"

# ─── 7. Logs ───────────────────────────────────────────────────
mkdir -p logs neural-alpha/logs dashboard/logs
echo "  ✓ Log directories ready"

# ─── 8. Nginx ──────────────────────────────────────────────────
if [[ "$SKIP_NGINX" -eq 0 ]]; then
  echo ""
  echo "▸ Nginx ($DOMAIN)..."
  NGINX_CONF="/etc/nginx/sites-available/$DOMAIN"
  if [[ ! -f "$NGINX_CONF" ]]; then
    if [[ "$(id -u)" -eq 0 ]]; then
      cp deploy/nginx.conf "$NGINX_CONF"
      ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/
    else
      sudo cp deploy/nginx.conf "$NGINX_CONF"
      sudo ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/
    fi
    echo "  ✓ Nginx config installed"
  else
    echo "  → Existing $NGINX_CONF left untouched (certbot SSL stays intact)"
  fi
  if [[ "$(id -u)" -eq 0 ]]; then
    nginx -t && systemctl reload nginx
  else
    sudo nginx -t && sudo systemctl reload nginx
  fi
  echo "  ✓ Nginx reloaded"
fi

# ─── 9. SSL ────────────────────────────────────────────────────
if [[ "$SKIP_SSL" -eq 0 ]]; then
  echo ""
  echo "▸ SSL certificate..."
  if [[ ! -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
    CERTBOT=(certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect)
    if [[ "$(id -u)" -ne 0 ]]; then CERTBOT=(sudo "${CERTBOT[@]}"); fi
    echo "  → Requesting certificate for $DOMAIN..."
    "${CERTBOT[@]}"
    echo "  ✓ SSL certificate installed"
  else
    echo "  → Certificate already exists"
  fi
fi

# ─── 10. PM2 — only our apps ───────────────────────────────────
echo ""
echo "▸ Starting Neural Alpha via PM2..."
echo "  (will not touch clipx-news-brain or other apps)"

EXISTING_NAMES="$(pm2_names || true)"

# Retire old TWAK / hashed agent processes
while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  retire=0
  for legacy in "${LEGACY_APPS[@]}"; do
    [[ "$name" == "$legacy" ]] && retire=1
  done
  # hashed leftover: neural-agent-<uuid>
  if [[ "$name" =~ ^neural-agent-[0-9a-fA-F-]{8,} ]]; then
    retire=1
  fi
  if [[ "$retire" -eq 1 ]]; then
    echo "  → Retiring leftover process: $name"
    pm2 delete "$name" >/dev/null 2>&1 || true
  fi
done <<< "$EXISTING_NAMES"

for name in "${OUR_APPS[@]}"; do
  pm2 delete "$name" >/dev/null 2>&1 || true
done

pm2 start "$APP_DIR/ecosystem.config.cjs"
pm2 save
echo "  ✓ neural-agent + neural-dashboard started"
echo "  ✓ pm2 dump saved (other apps unchanged)"

# ─── 11. Health ────────────────────────────────────────────────
echo ""
echo "▸ Health check..."
sleep 3
if curl -fsS --max-time 5 http://127.0.0.1:3847/api/health >/dev/null; then
  echo "  ✓ Agent API  http://127.0.0.1:3847/api/health"
else
  echo "  ⚠ Agent API not up yet — check: pm2 logs neural-agent --lines 80"
fi
if curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:3000/; then
  echo "  ✓ Dashboard  http://127.0.0.1:3000"
else
  echo "  ⚠ Dashboard not up yet — check: pm2 logs neural-dashboard --lines 50"
fi

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   ✓ Deployment complete                          ║"
echo "║                                                  ║"
echo "║   Public (read-only):  https://$DOMAIN"
echo "║   Agent API (local):   http://127.0.0.1:3847/api ║"
echo "║   Health:              https://$DOMAIN/api/health"
echo "║                                                  ║"
echo "║   pm2 status                                     ║"
echo "║   pm2 logs neural-agent --lines 80               ║"
echo "║   pm2 restart neural-agent neural-dashboard      ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "Verify read-only:"
echo "  curl -sS -X POST https://$DOMAIN/api/agent/control/stop"
echo "  → must return 401 Unauthorized"
echo ""
echo "Operator controls stay on localhost (SSH tunnel), not the public URL."
