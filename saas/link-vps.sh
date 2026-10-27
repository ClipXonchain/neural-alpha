#!/usr/bin/env bash
set -euo pipefail

# Neural Alpha — Multi-VPS Customer Cell Setup & Edge Linker
#
# Easiest 2-step workflow to add a Customer Host VPS and link it to neuralalpha.io:
#
# Step 1 (Run on the Customer Host VPS, on branch `SaaS`):
#   bash saas/link-vps.sh init-cell \
#     --host-id cell-01 \
#     --treasury 0xYourBscTreasuryAddress \
#     --secret YOUR_CONTROL_API_SECRET \
#     --monitor-secret YOUR_MONITOR_SECRET
#
# Step 2 (Run on neuralalpha.io / Edge host to link the cell):
#   bash saas/link-vps.sh join-edge \
#     --host-id cell-01 \
#     --cell-url http://CELL_VPS_IP:3910 \
#     --secret YOUR_CONTROL_API_SECRET
#
# Check all linked VPS cells & free seats:
#   bash saas/link-vps.sh status --secret YOUR_CONTROL_API_SECRET

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACTION="${1:-help}"
shift || true

HOST_ID="${SAAS_HOST_ID:-cell-01}"
TREASURY="${SAAS_TREASURY_ADDRESS:-}"
SECRET="${CONTROL_API_SECRET:-}"
MONITOR_SECRET="${SAAS_MONITOR_SECRET:-}"
CELL_URL=""
EDGE_URL="${SAAS_EDGE_URL:-http://127.0.0.1:3910}"
BIND_HOST="${SAAS_BIND_HOST:-0.0.0.0}"
PORT="${SAAS_CONTROL_PORT:-3910}"
PRICE_USD="${SAAS_PRICE_USD:-15}"
DATA_ROOT="${SAAS_DATA_ROOT:-${REPO_ROOT}/saas/runtime}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host-id) HOST_ID="${2:-}"; shift 2 ;;
    --treasury) TREASURY="${2:-}"; shift 2 ;;
    --secret) SECRET="${2:-}"; shift 2 ;;
    --monitor-secret) MONITOR_SECRET="${2:-}"; shift 2 ;;
    --cell-url) CELL_URL="${2:-}"; shift 2 ;;
    --edge-url) EDGE_URL="${2:-}"; shift 2 ;;
    --bind) BIND_HOST="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --price-usd) PRICE_USD="${2:-}"; shift 2 ;;
    --data-root) DATA_ROOT="${2:-}"; shift 2 ;;
    -h|--help) ACTION="help"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

usage() {
  cat <<EOF
Neural Alpha — Multi-VPS Customer Cell & Edge Linker

Commands:
  init-cell   Initialize this VPS as a Customer Host Cell (builds Docker image + starts saas/control/server.mjs)
  join-edge   Register a Customer Host Cell VPS with the Edge router (e.g. on neuralalpha.io)
  status      Inspect cluster capacity, active customer containers, and free seats across all linked VPS cells

Examples:
  # 1. On the Customer Cell VPS:
  bash saas/link-vps.sh init-cell --host-id cell-01 --treasury 0xYourTreasury --secret <SECRET>

  # 2. On neuralalpha.io (Edge):
  bash saas/link-vps.sh join-edge --host-id cell-01 --cell-url http://10.0.0.2:3910 --secret <SECRET>

  # 3. View cluster seats:
  bash saas/link-vps.sh status --secret <SECRET>
EOF
}

case "$ACTION" in
  init-cell)
    if [[ -z "$TREASURY" ]]; then
      echo "✗ --treasury <0xBscAddress> is required for init-cell" >&2
      exit 1
    fi
    if [[ -z "$SECRET" ]]; then
      SECRET="$(openssl rand -hex 32)"
      echo "▸ Generated CONTROL_API_SECRET: ${SECRET}"
    fi
    if [[ -z "$MONITOR_SECRET" ]]; then
      MONITOR_SECRET="$(openssl rand -hex 24)"
      echo "▸ Generated SAAS_MONITOR_SECRET: ${MONITOR_SECRET}"
    fi

    mkdir -p "$DATA_ROOT"
    CELL_ENV="${DATA_ROOT}/cell.env"
    cat > "$CELL_ENV" <<EOF
SAAS_HOST_ID=${HOST_ID}
SAAS_DATA_ROOT=${DATA_ROOT}
SAAS_TREASURY_ADDRESS=${TREASURY}
SAAS_PRICE_USD=${PRICE_USD}
CONTROL_API_SECRET=${SECRET}
SAAS_MONITOR_SECRET=${MONITOR_SECRET}
SAAS_BIND_HOST=${BIND_HOST}
SAAS_CONTROL_PORT=${PORT}
EOF
    # Optional settings picked up from the environment (join-mother.sh sets them).
    for var in TELEGRAM_BOT_TOKEN TELEGRAM_BOT_USERNAME TELEGRAM_OPS_CHAT_ID TELEGRAM_BOT_POLL \
      SAAS_BACKUP_KEY SAAS_BACKUP_DIR SAAS_BACKUP_RSYNC SAAS_EDGE_ONLY SAAS_APP_URL; do
      [[ -n "${!var:-}" ]] && printf '%s=%s\n' "$var" "${!var}" >> "$CELL_ENV"
    done
    chmod 600 "$CELL_ENV"
    echo "✓ Wrote cell config to ${CELL_ENV}"

    if command -v docker &>/dev/null; then
      echo "▸ Building customer worker & bridge Docker images..."
      (cd "$REPO_ROOT" && docker compose -f saas/worker/compose.yaml build)
      echo "✓ Worker images ready"
    else
      echo "⚠ Docker not found on PATH; install Docker before provisioning tenant containers."
    fi

    if command -v pm2 &>/dev/null; then
      echo "▸ Starting neural-saas-cell under PM2 (other PM2 apps untouched)..."
      pm2 delete neural-saas-cell >/dev/null 2>&1 || true
      (
        set -a
        # shellcheck disable=SC1090
        source "$CELL_ENV"
        set +a
        # Run node directly (like ecosystem.config.cjs does). PM2's own wrapper would load the
        # ES module without making it the main program, so the server would never start.
        pm2 start "$(command -v node)" --interpreter none --name neural-saas-cell --cwd "${REPO_ROOT}" -- "${REPO_ROOT}/saas/control/server.mjs"
        pm2 save >/dev/null 2>&1 || true
      )
      echo "✓ neural-saas-cell is running on ${BIND_HOST}:${PORT} (hostId=${HOST_ID})"
    else
      echo "▸ PM2 not installed. Start manually with:"
      echo "  set -a && source ${CELL_ENV} && set +a && node saas/control/server.mjs"
    fi

    echo ""
    echo "────────────────────────────────────────────────────────────"
    echo "Next step — run this on your Edge / neuralalpha.io VPS:"
    echo "  bash saas/link-vps.sh join-edge \\"
    echo "    --host-id ${HOST_ID} \\"
    echo "    --cell-url http://<THIS_VPS_IP>:${PORT} \\"
    echo "    --secret ${SECRET}"
    echo "────────────────────────────────────────────────────────────"
    ;;

  join-edge)
    if [[ -z "$CELL_URL" || -z "$SECRET" ]]; then
      echo "✗ --cell-url <http://ip:3910> and --secret <CONTROL_API_SECRET> are required" >&2
      exit 1
    fi
    echo "▸ Verifying reachability of cell ${HOST_ID} at ${CELL_URL}..."
    CAP_JSON="$(curl -fsS -H "Authorization: Bearer ${SECRET}" "${CELL_URL%/}/capacity")"
    echo "  ✓ Cell answered: ${CAP_JSON}"

    echo "▸ Registering ${HOST_ID} (${CELL_URL}) on Edge (${EDGE_URL})..."
    REG_JSON="$(curl -fsS -X POST \
      -H "Authorization: Bearer ${SECRET}" \
      -H "Content-Type: application/json" \
      -d "{\"hostId\":\"${HOST_ID}\",\"baseUrl\":\"${CELL_URL%/}\"}" \
      "${EDGE_URL%/}/cluster/nodes")"
    echo "  ✓ Registered: ${REG_JSON}"

    echo "▸ Fetching updated cluster capacity..."
    curl -fsS -H "Authorization: Bearer ${SECRET}" "${EDGE_URL%/}/cluster/capacity"
    echo ""
    ;;

  status)
    if [[ -z "$SECRET" ]]; then
      echo "✗ --secret <CONTROL_API_SECRET> is required" >&2
      exit 1
    fi
    curl -fsS -H "Authorization: Bearer ${SECRET}" "${EDGE_URL%/}/cluster/capacity"
    echo ""
    ;;

  *)
    usage
    ;;
esac
