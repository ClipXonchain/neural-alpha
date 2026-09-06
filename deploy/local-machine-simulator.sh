#!/usr/bin/env bash
set -euo pipefail

# Local machine simulator — control the VPS agent from this laptop.
# Tunnels the live agent API, checks health, then opens the operator dashboard.
#
#   bash deploy/local-machine-simulator.sh
#
# Do not run `npm run dev` at the same time — that starts a local paper agent
# on :3847 and you would control the laptop, not the VPS.

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SSH_TARGET="${SSH_TARGET:-root@agents.clipx.app}"
LOCAL_PORT="${LOCAL_PORT:-3847}"
TUNNEL_PID=""

cleanup() {
  if [[ -n "${TUNNEL_PID}" ]] && kill -0 "${TUNNEL_PID}" 2>/dev/null; then
    echo "Closing SSH tunnel (${TUNNEL_PID})..."
    kill "${TUNNEL_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

health() {
  curl -sS --max-time 5 "http://127.0.0.1:${LOCAL_PORT}/api/health" || true
}

echo "Local machine simulator → ${SSH_TARGET} :${LOCAL_PORT}"
cd "${APP_DIR}"

if [[ "$(health)" == *"\"status\":\"ok\""* ]]; then
  echo "Agent API already reachable on :${LOCAL_PORT} — skipping new tunnel."
  health
  echo
else
  if lsof -iTCP:"${LOCAL_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port ${LOCAL_PORT} is in use but /api/health failed."
    echo "Stop local \`npm run dev\` (paper agent) and try again."
    exit 1
  fi

  echo "Opening SSH tunnel: ssh -N -L ${LOCAL_PORT}:127.0.0.1:3847 ${SSH_TARGET}"
  ssh -N -L "${LOCAL_PORT}:127.0.0.1:3847" "${SSH_TARGET}" &
  TUNNEL_PID=$!

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if [[ "$(health)" == *"\"status\":\"ok\""* ]]; then
      break
    fi
    sleep 0.5
  done

  echo
  curl -sS "http://127.0.0.1:${LOCAL_PORT}/api/health"
  echo
  echo
fi

export NEXT_PUBLIC_READONLY=false
echo "Starting operator dashboard (http://localhost:3000)..."
echo "Stop/start, buy/sell, wallet — these hit the VPS agent."
echo
npm run dashboard
