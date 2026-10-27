#!/usr/bin/env bash
set -euo pipefail

# Join this fresh VPS to the mother (edge) as a customer cell, in one command.
#
#   git clone -b SaaS https://github.com/ClipXonchain/neural-alpha.git && cd neural-alpha
#   sudo bash saas/join-mother.sh \
#     --secret <mother CONTROL_API_SECRET> --treasury 0xTreasury \
#     --mother-ssh root@MOTHER_IP --wireguard \
#     --backup-rsync backup@MOTHER_IP:/var/backups/neural-alpha \
#     --telegram-token <bot token> --telegram-username NeuralAlphaBot
#
# Cells share the mother's CONTROL_API_SECRET: the mother calls every cell with it.
# Pass --mother-ssh more than once to register with a standby mother too.
# --wireguard puts the control API on a private tunnel instead of the public internet.
#
# Optional:
#   --backup-key <64 hex>   key for encrypted customer backups (made for you if omitted: SAVE IT)
#   --telegram-ops-chat ID  chat that receives ops alerts          --host-id NAME  --port N
#   --mother-url URL        register over HTTP instead of ssh      --public-ip IP  --mother-ip IP

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SECRET="${CONTROL_API_SECRET:-}"; TREASURY="${SAAS_TREASURY_ADDRESS:-}"
HOST_ID=""; PUBLIC_IP=""; MOTHER_URL=""; MOTHER_IP=""; PORT="${SAAS_CONTROL_PORT:-3910}"
MOTHERS=(); WG=0
TG_TOKEN="${TELEGRAM_BOT_TOKEN:-}"; TG_USER="${TELEGRAM_BOT_USERNAME:-}"; TG_OPS="${TELEGRAM_OPS_CHAT_ID:-}"
BK_KEY="${SAAS_BACKUP_KEY:-}"; BK_RSYNC="${SAAS_BACKUP_RSYNC:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --secret) SECRET="${2:-}"; shift 2 ;;
    --treasury) TREASURY="${2:-}"; shift 2 ;;
    --host-id) HOST_ID="${2:-}"; shift 2 ;;
    --public-ip) PUBLIC_IP="${2:-}"; shift 2 ;;
    --mother-url) MOTHER_URL="${2:-}"; shift 2 ;;
    --mother-ssh) MOTHERS+=("${2:-}"); shift 2 ;;
    --mother-ip) MOTHER_IP="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --wireguard) WG=1; shift ;;
    --telegram-token) TG_TOKEN="${2:-}"; shift 2 ;;
    --telegram-username) TG_USER="${2:-}"; shift 2 ;;
    --telegram-ops-chat) TG_OPS="${2:-}"; shift 2 ;;
    --backup-key) BK_KEY="${2:-}"; shift 2 ;;
    --backup-rsync) BK_RSYNC="${2:-}"; shift 2 ;;
    -h|--help) sed -n 3,22p "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

die() { echo "✗ $*" >&2; exit 1; }
[[ -n "$SECRET" && -n "$TREASURY" ]] || die "--secret and --treasury are required"
[[ "$TREASURY" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "treasury must be a 0x BSC address"
[[ $WG -eq 0 || ${#MOTHERS[@]} -gt 0 ]] || die "--wireguard needs --mother-ssh"
[[ -z "$BK_KEY" || "$BK_KEY" =~ ^[0-9a-fA-F]{64}$ ]] || die "--backup-key must be 64 hex characters"
[[ -z "$BK_RSYNC" || "$BK_RSYNC" =~ ^[A-Za-z0-9._@-]+:[A-Za-z0-9._/~-]+$ ]] || die "--backup-rsync must look like user@host:/path"

# Cell id: cell-<hostname>, lowercased to the edge's [a-z0-9_-]{1,32} rule.
[[ -n "$HOST_ID" ]] || HOST_ID="$(printf 'cell-%s' "$(hostname -s)" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n-' '-' | cut -c1-32)"
SUDO=""; [[ $EUID -eq 0 ]] || SUDO="sudo"

echo "▸ Prerequisites (docker, node 22, pm2, rsync)"
command -v docker >/dev/null || curl -fsSL https://get.docker.com | $SUDO sh
# node:sqlite (used by saas/control) needs Node >= 22.5
if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi
command -v pm2 >/dev/null || $SUDO npm install -g pm2
[[ -z "$BK_RSYNC" ]] || command -v rsync >/dev/null || $SUDO apt-get install -y -qq rsync

# ---- how the mothers will reach this cell ----------------------------------------
BIND="0.0.0.0"; LOCAL_IP="127.0.0.1"
declare -a CELL_URLS=()   # one per mother, same order as MOTHERS
if [[ $WG -eq 1 ]]; then
  echo "▸ WireGuard: private link to ${#MOTHERS[@]} mother(s)"
  FIRST_WG=""
  for i in "${!MOTHERS[@]}"; do
    WG_OUT="$($SUDO bash "$ROOT/saas/wg-link.sh" cell --mother-ssh "${MOTHERS[$i]}" --iface "wg$i" --subnet "10.$((88 + i)).0" --name "$HOST_ID")"
    echo "$WG_OUT" | grep -v '^WG_ADDR=' || true
    ADDR="$(sed -n 's/^WG_ADDR=//p' <<<"$WG_OUT")"
    [[ -n "$ADDR" ]] || die "WireGuard setup for ${MOTHERS[$i]} did not return an address"
    CELL_URLS+=("http://${ADDR}:${PORT}")
    [[ -n "$FIRST_WG" ]] || FIRST_WG="$ADDR"
  done
  if [[ ${#MOTHERS[@]} -eq 1 ]]; then
    BIND="$FIRST_WG"; LOCAL_IP="$FIRST_WG"        # reachable only on the private link
  else
    # More than one tunnel: listen on all, and let the firewall allow only the tunnels.
    command -v ufw >/dev/null || die "several mothers need ufw to keep port ${PORT} private"
    for i in "${!MOTHERS[@]}"; do $SUDO ufw allow in on "wg$i" to any port "$PORT" proto tcp >/dev/null; done
    $SUDO ufw deny "$PORT"/tcp >/dev/null
  fi
else
  [[ -n "$PUBLIC_IP" ]] || PUBLIC_IP="$(curl -fsS https://api.ipify.org || true)"
  [[ -n "$PUBLIC_IP" ]] || die "could not detect public IP; pass --public-ip"
  for _ in "${MOTHERS[@]:-x}"; do CELL_URLS+=("http://${PUBLIC_IP}:${PORT}"); done
  if [[ -n "$MOTHER_IP" ]] && command -v ufw >/dev/null; then
    echo "▸ Firewall: port ${PORT} open to ${MOTHER_IP} only (plain HTTP: prefer --wireguard)"
    $SUDO ufw allow from "$MOTHER_IP" to any port "$PORT" proto tcp >/dev/null
  fi
fi

# ---- backups: ciphertext only ever leaves this machine ---------------------------
if [[ -z "$BK_KEY" ]]; then
  BK_KEY="$(openssl rand -hex 32)"
  echo "────────────────────────────────────────────────────────────"
  echo "BACKUP KEY (save it somewhere that is NOT this server):"
  echo "  ${BK_KEY}"
  echo "Without it the encrypted customer backups cannot be restored."
  echo "────────────────────────────────────────────────────────────"
fi
BK_DIR="${SAAS_BACKUP_DIR:-$ROOT/saas/backups}"
mkdir -p "$BK_DIR"; chmod 700 "$BK_DIR"

echo "▸ Starting cell ${HOST_ID}"
export SAAS_BACKUP_KEY="$BK_KEY" SAAS_BACKUP_DIR="$BK_DIR" SAAS_BACKUP_RSYNC="$BK_RSYNC"
export TELEGRAM_BOT_TOKEN="$TG_TOKEN" TELEGRAM_BOT_USERNAME="$TG_USER" TELEGRAM_OPS_CHAT_ID="$TG_OPS"
bash "$ROOT/saas/link-vps.sh" init-cell --host-id "$HOST_ID" --treasury "$TREASURY" --secret "$SECRET" --port "$PORT" --bind "$BIND"

echo "▸ Waiting for the cell to answer"
for _ in $(seq 1 30); do
  curl -fsS -H "Authorization: Bearer ${SECRET}" "http://${LOCAL_IP}:${PORT}/capacity" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS -H "Authorization: Bearer ${SECRET}" "http://${LOCAL_IP}:${PORT}/capacity" >/dev/null \
  || die "cell did not start; see: pm2 logs neural-saas-cell"

register() { # $1 = mother ssh target, $2 = this cell's url as seen from that mother
  local body="{\"hostId\":\"${HOST_ID}\",\"baseUrl\":\"$2\"}"
  # The mother's control API listens on 127.0.0.1 only, so register through ssh.
  ssh -o BatchMode=yes "$1" "curl -fsS -X POST -H 'Authorization: Bearer ${SECRET}' -H 'Content-Type: application/json' -d '${body}' http://127.0.0.1:3910/cluster/nodes"
}

echo "▸ Registering with the mother(s)"
if [[ -n "$MOTHER_URL" ]]; then
  curl -fsS -X POST -H "Authorization: Bearer ${SECRET}" -H "Content-Type: application/json" \
    -d "{\"hostId\":\"${HOST_ID}\",\"baseUrl\":\"${CELL_URLS[0]}\"}" "${MOTHER_URL%/}/cluster/nodes"; echo
elif [[ ${#MOTHERS[@]} -gt 0 ]]; then
  for i in "${!MOTHERS[@]}"; do register "${MOTHERS[$i]}" "${CELL_URLS[$i]}"; echo; done
else
  echo "  No --mother-url/--mother-ssh. Run this on the mother:"
  echo "  bash saas/link-vps.sh join-edge --host-id ${HOST_ID} --cell-url ${CELL_URLS[0]} --secret <secret>"
  exit 0
fi
echo "✓ ${HOST_ID} linked. Check on the mother: bash saas/link-vps.sh status --secret <secret>"
[[ -n "$TG_TOKEN" ]] || echo "ℹ No Telegram token given: customers cannot link the bot on this cell yet."
