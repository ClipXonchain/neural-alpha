#!/usr/bin/env bash
set -euo pipefail

# Pair Binance Agentic Wallet on a headless VPS.
# One session only — prints pairing code + URL, then waits for the app.
#
#   bash deploy/baw-connect.sh
#   bash deploy/baw-connect.sh --status   # check only

json_field() {
  node -e '
    const fs = require("fs");
    const key = process.argv[1];
    let raw = fs.readFileSync(0, "utf8").trim();
    const start = raw.indexOf("{");
    if (start > 0) raw = raw.slice(start);
    const j = JSON.parse(raw);
    const d = j.data && typeof j.data === "object" ? j.data : j;
    const v = d[key] ?? j[key] ?? "";
    process.stdout.write(String(v));
  ' "$1"
}

if ! command -v baw >/dev/null 2>&1; then
  echo "baw CLI not found. Install first:"
  echo "  npm i -g @binance/agentic-wallet"
  exit 1
fi

if [[ "${1:-}" == "--status" || "${1:-}" == "-s" ]]; then
  baw wallet status --json
  baw wallet address --json 2>/dev/null || true
  exit 0
fi

STATUS="$(baw wallet status --json 2>/dev/null || true)"
CURRENT="$(printf '%s' "$STATUS" | json_field status || true)"
if [[ "${CURRENT^^}" == "CONNECTED" ]]; then
  echo "Already CONNECTED."
  baw wallet address --json 2>/dev/null || true
  echo "If the agent still shows UNCONNECTED: pm2 restart neural-agent"
  exit 0
fi

echo "Starting one pairing session (do not run signin again)..."
SIGNIN="$(baw auth signin --json)"
QR="$(printf '%s' "$SIGNIN" | json_field qrCodeId)"
CODE="$(printf '%s' "$SIGNIN" | json_field pairingCode)"
URL="$(printf '%s' "$SIGNIN" | json_field urlForWeb)"

if [[ -z "$QR" || -z "$CODE" ]]; then
  echo "signin did not return qrCodeId / pairingCode:"
  echo "$SIGNIN"
  exit 1
fi

echo ""
echo "=========================================================="
echo "  1. Open this URL on your phone:"
echo "     $URL"
echo ""
echo "  2. Confirm this pairing code in the Binance App:"
echo ""
echo "        >>>  ${CODE}  <<<"
echo ""
echo "  Waiting for you to confirm (do not Ctrl+C)..."
echo "=========================================================="
echo ""

if command -v qrencode >/dev/null 2>&1 && [[ -n "$URL" ]]; then
  qrencode -t ANSIUTF8 "$URL" || true
fi

baw auth verify --qrCodeId "$QR" --json
echo ""
baw wallet status --json
baw wallet address --json

if command -v pm2 >/dev/null 2>&1 && pm2 describe neural-agent >/dev/null 2>&1; then
  echo ""
  echo "Restarting neural-agent so it picks up the session..."
  pm2 restart neural-agent
fi

echo ""
echo "Done. Wallet session is on this user only (usually root)."
