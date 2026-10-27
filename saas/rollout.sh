#!/usr/bin/env bash
set -euo pipefail

# Move this cell's customers to a new worker image, one at a time, canary first.
# Any failure puts that customer back on the previous image and stops.
#
#   bash saas/rollout.sh                      # pull, build, tag by git SHA, roll out
#   bash saas/rollout.sh --tenant ab12cd34    # name your own canary (first), others follow
#   bash saas/rollout.sh --tag 3f9c1a2b4d5e --no-pull --no-build   # roll BACK to an image you still have
#
# Several cells: run it on one, watch it, then the next. Never all at once.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CELL_ENV="${SAAS_DATA_ROOT:-$ROOT/saas/runtime}/cell.env"
[[ -f "$CELL_ENV" ]] && { set -a; source "$CELL_ENV"; set +a; }

SECRET="${CONTROL_API_SECRET:-}"
URL="http://127.0.0.1:${SAAS_CONTROL_PORT:-3910}"
TAG=""; SOAK=120; PULL=1; BUILD=1; TENANTS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --secret) SECRET="${2:-}"; shift 2 ;;
    --url) URL="${2:-}"; shift 2 ;;
    --tag) TAG="${2:-}"; shift 2 ;;
    --soak) SOAK="${2:-}"; shift 2 ;;
    --tenant) TENANTS+=("${2:-}"); shift 2 ;;
    --no-pull) PULL=0; shift ;;
    --no-build) BUILD=0; shift ;;
    -h|--help) sed -n 3,12p "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
[[ -n "$SECRET" ]] || { echo "✗ no CONTROL_API_SECRET (looked in $CELL_ENV)" >&2; exit 1; }

cd "$ROOT"
if [[ $PULL -eq 1 ]]; then
  echo "▸ git pull --ff-only"
  git pull --ff-only
fi
if [[ $BUILD -eq 1 ]]; then
  TAG="${TAG:-$(git rev-parse --short=12 HEAD)}"
  echo "▸ Building worker image ${TAG}"
  docker compose -f saas/worker/compose.yaml build
  # A sha tag is never overwritten, so an old one is always there to roll back to.
  docker tag neural-saas-worker:local "neural-saas-worker:${TAG}"
else
  [[ -n "$TAG" ]] || { echo "✗ --no-build needs --tag <existing image tag>" >&2; exit 1; }
  docker image inspect "neural-saas-worker:${TAG}" >/dev/null 2>&1 \
    || { echo "✗ image neural-saas-worker:${TAG} does not exist on this machine" >&2; exit 1; }
fi

IDS="[]"
if [[ ${#TENANTS[@]} -gt 0 ]]; then IDS="$(printf '%s\n' "${TENANTS[@]}" | node -e 'console.log(JSON.stringify(require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean)))')"; fi
BODY="{\"tag\":\"${TAG}\",\"soakSec\":${SOAK}$([[ "$IDS" != "[]" ]] && echo ",\"tenantIds\":${IDS}")}"

echo "▸ Rolling out ${TAG} (canary soak ${SOAK}s)"
curl -fsS -X POST -H "Authorization: Bearer ${SECRET}" -H "Content-Type: application/json" -d "$BODY" "${URL}/rollout" >/dev/null

while :; do
  sleep 5
  JOB="$(curl -fsS -H "Authorization: Bearer ${SECRET}" "${URL}/rollout")"
  STATUS="$(printf '%s' "$JOB" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(j.status)')"
  printf '%s' "$JOB" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log("  "+j.status+": "+(j.done||[]).length+"/"+j.total+" customers")'
  [[ "$STATUS" == "running" ]] || break
done

printf '%s\n' "$JOB"
[[ "$STATUS" == "done" ]] && { echo "✓ ${TAG} is live for every running customer on this cell"; exit 0; }
echo "✗ Rollout stopped. The failing customer was put back on its previous image; the rest were not touched." >&2
exit 1
