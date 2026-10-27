#!/usr/bin/env bash
set -euo pipefail

# Rebuild a cell on a replacement machine from its encrypted backups.
#
#   SAAS_BACKUP_KEY=<64 hex> bash saas/restore-cell.sh <backup-dir> <data-root>
#
# Puts the newest control database at <data-root>/control.sqlite and each customer
# folder (including the Binance wallet login) at <data-root>/<id>. Start the cell
# afterwards with the same SAAS_HOST_ID (or call POST /recovery/adopt if it changed).
# The data root must be empty: nothing is overwritten.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-}"; DEST="${2:-}"
[[ -d "$SRC" && -n "$DEST" ]] || { echo "usage: SAAS_BACKUP_KEY=<64 hex> bash saas/restore-cell.sh <backup-dir> <data-root>" >&2; exit 2; }
[[ "${SAAS_BACKUP_KEY:-}" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "✗ set SAAS_BACKUP_KEY (64 hex characters)" >&2; exit 2; }
if [[ -d "$DEST" && -n "$(ls -A "$DEST" 2>/dev/null)" ]]; then echo "✗ $DEST is not empty" >&2; exit 1; fi
mkdir -p "$DEST"

# Newest file per id: names sort by timestamp, so the last one for each prefix wins.
ls "$SRC" | grep -E '\.tar\.gz\.enc$' | sed -E 's/-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.enc$//' | sort -u | while read -r id; do
  file="$SRC/$(ls "$SRC" | grep -E "^${id}-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.enc$" | sort | tail -1)"
  if [[ "$id" == "control" ]]; then
    tmp="$(mktemp -d)/c"
    node "$ROOT/saas/control/tenant-backup.mjs" restore "$file" "$tmp"
    mv "$tmp/control.sqlite" "$DEST/control.sqlite"
    echo "✓ control database"
  else
    node "$ROOT/saas/control/tenant-backup.mjs" restore "$file" "$DEST/$id"
    echo "✓ customer $id"
  fi
done
echo "Done. Start the cell, then each customer's container resumes from its restored folder."
