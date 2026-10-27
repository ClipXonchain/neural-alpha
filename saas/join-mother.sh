#!/usr/bin/env bash
set -euo pipefail

# Join this fresh VPS to the mother (edge) as a customer cell, in one command.
#
#   git clone -b SaaS https://github.com/ClipXonchain/neural-alpha.git && cd neural-alpha
#   sudo bash saas/join-mother.sh \
#     --secret <mother CONTROL_API_SECRET> \
#     --treasury 0xTreasury \
#     --mother-ssh root@MOTHER_IP        # or --mother-url http://MOTHER:3910
#
# Cells must share the mother's CONTROL_API_SECRET: the edge calls every cell with it.
# Treasury is the same address on every cell.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SECRET="${CONTROL_API_SECRET:-}"; TREASURY="${SAAS_TREASURY_ADDRESS:-}"
HOST_ID=""; PUBLIC_IP=""; MOTHER_URL=""; MOTHER_SSH=""; MOTHER_IP=""; PORT="${SAAS_CONTROL_PORT:-3910}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --secret) SECRET="${2:-}"; shift 2 ;;
    --treasury) TREASURY="${2:-}"; shift 2 ;;
    --host-id) HOST_ID="${2:-}"; shift 2 ;;
    --public-ip) PUBLIC_IP="${2:-}"; shift 2 ;;
    --mother-url) MOTHER_URL="${2:-}"; shift 2 ;;
    --mother-ssh) MOTHER_SSH="${2:-}"; shift 2 ;;
    --mother-ip) MOTHER_IP="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    -h|--help) sed -n 3,12p "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

[[ -n "$SECRET" && -n "$TREASURY" ]] || { echo "✗ --secret and --treasury are required" >&2; exit 1; }
[[ "$TREASURY" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "✗ treasury must be a 0x BSC address" >&2; exit 1; }

# Cell id: cell-<hostname>, lowercased to the edge's [a-z0-9_-]{1,32} rule.
[[ -n "$HOST_ID" ]] || HOST_ID="$(printf 'cell-%s' "$(hostname -s)" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-' | cut -c1-32)"
[[ -n "$PUBLIC_IP" ]] || PUBLIC_IP="$(curl -fsS https://api.ipify.org || true)"
[[ -n "$PUBLIC_IP" ]] || { echo "✗ could not detect public IP; pass --public-ip" >&2; exit 1; }
CELL_URL="http://${PUBLIC_IP}:${PORT}"
SUDO=""; [[ $EUID -eq 0 ]] || SUDO="sudo"

echo "▸ Prerequisites (docker, node 22, pm2)"
command -v docker >/dev/null || curl -fsSL https://get.docker.com | $SUDO sh
# node:sqlite (used by saas/control) needs Node >= 22.5
if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi
command -v pm2 >/dev/null || $SUDO npm install -g pm2

if [[ -n "$MOTHER_IP" ]] && command -v ufw >/dev/null; then
  echo "▸ Firewall: port ${PORT} open to ${MOTHER_IP} only"
  $SUDO ufw allow from "$MOTHER_IP" to any port "$PORT" proto tcp >/dev/null
fi

echo "▸ Starting cell ${HOST_ID}"
bash "$ROOT/saas/link-vps.sh" init-cell --host-id "$HOST_ID" --treasury "$TREASURY" --secret "$SECRET" --port "$PORT"

echo "▸ Waiting for the cell to answer"
for _ in $(seq 1 30); do
  curl -fsS -H "Authorization: Bearer ${SECRET}" "http://127.0.0.1:${PORT}/capacity" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS -H "Authorization: Bearer ${SECRET}" "http://127.0.0.1:${PORT}/capacity" >/dev/null \
  || { echo "✗ cell did not start; see: pm2 logs neural-saas-cell" >&2; exit 1; }

BODY="{\"hostId\":\"${HOST_ID}\",\"baseUrl\":\"${CELL_URL}\"}"
echo "▸ Registering with the mother"
if [[ -n "$MOTHER_URL" ]]; then
  curl -fsS -X POST -H "Authorization: Bearer ${SECRET}" -H "Content-Type: application/json" -d "$BODY" "${MOTHER_URL%/}/cluster/nodes"
elif [[ -n "$MOTHER_SSH" ]]; then
  # The mother's control API listens on 127.0.0.1 only, so register through ssh.
  ssh "$MOTHER_SSH" "curl -fsS -X POST -H 'Authorization: Bearer ${SECRET}' -H 'Content-Type: application/json' -d '${BODY}' http://127.0.0.1:3910/cluster/nodes"
else
  echo "  No --mother-url/--mother-ssh. Run this on the mother:"
  echo "  bash saas/link-vps.sh join-edge --host-id ${HOST_ID} --cell-url ${CELL_URL} --secret <secret>"
  exit 0
fi
echo; echo "✓ ${HOST_ID} linked at ${CELL_URL}. Check on the mother: bash saas/link-vps.sh status --secret <secret>"
