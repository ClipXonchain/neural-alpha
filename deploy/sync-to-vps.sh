#!/usr/bin/env bash
set -euo pipefail

# Push local repo to VPS over SSH (no git pull on server).
#
# Usage:
#   VPS_HOST=user@your.vps.ip bash deploy/sync-to-vps.sh
#   VPS_HOST=root@1.2.3.4 VPS_PATH=/root/neural-alpha bash deploy/sync-to-vps.sh
#
# Optional:
#   VPS_PATH     Remote app directory (default: ~/neural-alpha)
#   SKIP_BUILD=1 rsync only — skip npm build + pm2 restart on VPS
#   DRY_RUN=1    Show rsync changes without copying

if [[ -z "${VPS_HOST:-}" ]]; then
  echo "Set VPS_HOST, e.g.: VPS_HOST=root@1.2.3.4 bash deploy/sync-to-vps.sh"
  exit 1
fi

VPS_PATH="${VPS_PATH:-~/neural-alpha}"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# macOS ships BSD rsync — avoid GNU-only flags like --info=stats2
RSYNC_FLAGS=(-az --delete --progress)
if [[ "${DRY_RUN:-}" == "1" ]]; then
  RSYNC_FLAGS+=(--dry-run)
fi

echo "▸ Syncing ${LOCAL_DIR} → ${VPS_HOST}:${VPS_PATH}"

rsync "${RSYNC_FLAGS[@]}" \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude '.next/' \
  --exclude 'dist/' \
  --exclude 'build/' \
  --exclude 'out/' \
  --exclude 'logs/' \
  --exclude 'data/agents/' \
  --exclude '.env' \
  --exclude '.env.local' \
  --exclude '.env.*.local' \
  --exclude 'dashboard/.env.local' \
  --exclude '.DS_Store' \
  --exclude '.cursor/' \
  --exclude '.pm2/' \
  --exclude 'coverage/' \
  --exclude '*.log' \
  "${LOCAL_DIR}/" "${VPS_HOST}:${VPS_PATH}/"

if [[ "${DRY_RUN:-}" == "1" ]]; then
  echo "✓ Dry run complete (no remote build)"
  exit 0
fi

if [[ "${SKIP_BUILD:-}" == "1" ]]; then
  echo "✓ Sync complete (SKIP_BUILD=1 — run bash deploy/update.sh on VPS when ready)"
  exit 0
fi

echo "▸ Building + restarting on VPS..."
ssh "${VPS_HOST}" "cd ${VPS_PATH} && bash deploy/update.sh"

echo "✓ Deployed to ${VPS_HOST}:${VPS_PATH}"
