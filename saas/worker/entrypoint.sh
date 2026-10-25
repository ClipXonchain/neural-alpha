#!/bin/sh
# Prepare a private data dir and baw home, then start upstream unchanged.
set -eu

delay=$(printf '%s' "${SAAS_START_DELAY_SEC:-0}" | tr -cd '0-9')
if [ -n "$delay" ] && [ "$delay" -gt 0 ] && [ "$delay" -le 60 ]; then
  sleep "$delay"
fi

mkdir -p /data/home /data/book

src_data=/opt/neural-alpha/neural-alpha/data
if [ ! -L "$src_data" ]; then
  if [ -d "$src_data" ]; then
    cp -an "$src_data/." /data/book/ 2>/dev/null || true
    rm -rf "$src_data"
  fi
  ln -s /data/book "$src_data"
fi

if [ -f /data/tenant.env ]; then
  cp /data/tenant.env /opt/neural-alpha/.env
fi

export HOME=/data/home
cd /opt/neural-alpha
exec npm run start --workspace=neural-alpha
