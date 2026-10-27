#!/usr/bin/env bash
set -euo pipefail

# Private WireGuard link between a mother and a cell, so the control API, the
# customer tokens and the shared secret never cross the internet in clear text.
#
# Run on the CELL (as root). The mother side is set up for you over ssh:
#   sudo bash saas/wg-link.sh cell --mother-ssh root@MOTHER_IP
#
# A standby mother gets its own interface and subnet, so a cell can have both:
#   sudo bash saas/wg-link.sh cell --mother-ssh root@STANDBY_IP --iface wg1 --subnet 10.89.0
#
# Prints WG_ADDR=<this cell's private address> when done.

CMD="${1:-help}"; shift || true
IFACE=wg0; SUBNET=10.88.0; PORT=51820; MOTHER_SSH=""; PUBKEY=""; NAME="$(hostname -s)"; ENDPOINT="${WG_ENDPOINT:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mother-ssh) MOTHER_SSH="${2:-}"; shift 2 ;;
    --iface) IFACE="${2:-}"; shift 2 ;;
    --subnet) SUBNET="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --pubkey) PUBKEY="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --endpoint) ENDPOINT="${2:-}"; shift 2 ;;
    -h|--help) CMD=help; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

die() { echo "✗ $*" >&2; exit 1; }
[[ "$IFACE" =~ ^wg[0-9]{1,2}$ ]] || die "--iface must look like wg0"
[[ "$SUBNET" =~ ^10\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || die "--subnet must look like 10.88.0"
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || die "--port must be a number"
NAME="$(printf '%s' "$NAME" | tr -c 'A-Za-z0-9_-' '-' | cut -c1-32)"

usage() { sed -n 3,13p "$0"; }
[[ "$CMD" == help || "$CMD" == -* ]] && { usage; exit 0; }
[[ $EUID -eq 0 ]] || die "run as root (sudo)"

install_wg() {
  command -v wg-quick >/dev/null && return
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq wireguard
}

case "$CMD" in
  mother-add)
    [[ "$PUBKEY" =~ ^[A-Za-z0-9+/]{43}=$ ]] || die "--pubkey is not a WireGuard public key"
    install_wg
    umask 077; mkdir -p /etc/wireguard
    CONF="/etc/wireguard/${IFACE}.conf"
    if [[ ! -f "$CONF" ]]; then
      wg genkey | tee "/etc/wireguard/${IFACE}.key" | wg pubkey > "/etc/wireguard/${IFACE}.pub"
      printf '[Interface]\nAddress = %s.1/24\nListenPort = %s\nPrivateKey = %s\n' \
        "$SUBNET" "$PORT" "$(cat "/etc/wireguard/${IFACE}.key")" > "$CONF"
      systemctl enable --now "wg-quick@${IFACE}" >/dev/null 2>&1 || wg-quick up "$IFACE"
    fi
    ADDR="$(awk -v k="$PUBKEY" '$1=="PublicKey" && $3==k {f=1} f && $1=="AllowedIPs" {print $3; exit}' "$CONF" | sed 's#/32##')"
    if [[ -z "$ADDR" ]]; then
      n=2
      while grep -qE "${SUBNET//./\\.}\\.${n}/32" "$CONF"; do n=$((n + 1)); done
      [[ $n -le 254 ]] || die "no free address left in ${SUBNET}.0/24"
      ADDR="${SUBNET}.${n}"
      printf '\n# %s\n[Peer]\nPublicKey = %s\nAllowedIPs = %s/32\n' "$NAME" "$PUBKEY" "$ADDR" >> "$CONF"
      wg set "$IFACE" peer "$PUBKEY" allowed-ips "${ADDR}/32"
    fi
    if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow "${PORT}/udp" >/dev/null; fi
    : "${ENDPOINT:=$(curl -fsS https://api.ipify.org):${PORT}}"
    echo "WG_ADDR=${ADDR}"
    echo "WG_SERVER_PUB=$(cat "/etc/wireguard/${IFACE}.pub")"
    echo "WG_ENDPOINT=${ENDPOINT}"
    ;;

  cell)
    [[ -n "$MOTHER_SSH" ]] || die "--mother-ssh user@host is required"
    install_wg
    umask 077; mkdir -p /etc/wireguard
    KEY="/etc/wireguard/${IFACE}.key"
    [[ -f "$KEY" ]] || wg genkey > "$KEY"
    PUB="$(wg pubkey < "$KEY")"
    ARGS="mother-add --pubkey '${PUB}' --name '${NAME}' --iface '${IFACE}' --subnet '${SUBNET}' --port '${PORT}'"
    echo "▸ Asking ${MOTHER_SSH} to add this cell as a WireGuard peer"
    OUT="$(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$MOTHER_SSH" \
      "if [ \"\$(id -u)\" -eq 0 ]; then bash -s -- ${ARGS}; else sudo bash -s -- ${ARGS}; fi" < "$0")"
    ADDR="$(sed -n 's/^WG_ADDR=//p' <<<"$OUT")"
    SPUB="$(sed -n 's/^WG_SERVER_PUB=//p' <<<"$OUT")"
    EP="$(sed -n 's/^WG_ENDPOINT=//p' <<<"$OUT")"
    [[ "$ADDR" =~ ^10\.[0-9]+\.[0-9]+\.[0-9]+$ && "$SPUB" =~ ^[A-Za-z0-9+/]{43}=$ && "$EP" =~ ^[A-Za-z0-9.:-]+:[0-9]+$ ]] \
      || die "the mother answered with something unexpected: ${OUT}"
    printf '[Interface]\nAddress = %s/24\nPrivateKey = %s\n\n[Peer]\nPublicKey = %s\nEndpoint = %s\nAllowedIPs = %s.1/32\nPersistentKeepalive = 25\n' \
      "$ADDR" "$(cat "$KEY")" "$SPUB" "$EP" "$SUBNET" > "/etc/wireguard/${IFACE}.conf"
    wg show "$IFACE" >/dev/null 2>&1 && wg-quick down "$IFACE" >/dev/null 2>&1 || true
    wg-quick up "$IFACE" >/dev/null
    systemctl enable "wg-quick@${IFACE}" >/dev/null 2>&1 || true
    ping -c1 -W3 "${SUBNET}.1" >/dev/null 2>&1 \
      && echo "✓ Private link up: this cell is ${ADDR}, the mother is ${SUBNET}.1" \
      || echo "⚠ Link configured but the mother did not answer a ping yet. Check udp ${PORT} on the mother's firewall." >&2
    echo "WG_ADDR=${ADDR}"
    ;;

  *) usage; exit 1 ;;
esac
