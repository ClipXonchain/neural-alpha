#!/usr/bin/env bash
set -euo pipefail

# Run this on a server BEFORE you wipe it. It changes nothing: it only reads, and writes one archive.
#
#   sudo bash saas/infra/inventory.sh                 # then copy the archive OFF the server
#   sudo bash saas/infra/inventory.sh --encrypt       # asks for a passphrase; recommended (it holds secrets)
#
# It saves what the rebuild needs to put your other apps back: every pm2 app's folder (without
# node_modules), the pm2 app list, nginx and certbot config, Let's Encrypt certificates, cron jobs,
# custom systemd units, Docker containers/compose folders/volumes, ssh keys and the Binance wallet
# login. It does NOT dump databases: it warns if one is running so you can dump it yourself.
#
# Options: --out DIR (default /root)   --max-gb N (default 8)   --force   --encrypt
#          --no-git (leave .git folders out)   --docker-images (also save container images)

OUT_BASE=/root; MAX_GB=8; FORCE=0; ENCRYPT=0; NO_GIT=0; IMAGES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT_BASE="${2:-}"; shift 2 ;;
    --max-gb) MAX_GB="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --encrypt) ENCRYPT=1; shift ;;
    --no-git) NO_GIT=1; shift ;;
    --docker-images) IMAGES=1; shift ;;
    -h|--help) sed -n 3,17p "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
die() { echo "✗ $*" >&2; exit 1; }
note() { echo "▸ $*"; }
warn() { echo "⚠ $*" >&2; WARNINGS+=("$*"); }
WARNINGS=()
[[ $EUID -eq 0 ]] || die "run as root (sudo)"
[[ "$MAX_GB" =~ ^[0-9]+$ ]] || die "--max-gb must be a number"
umask 077

HOST="$(hostname -s)"; STAMP="$(date +%Y%m%d-%H%M)"
DIR="${OUT_BASE%/}/rebuild-${HOST}-${STAMP}"
mkdir -p "$DIR"/{system,pm2,apps,etc,docker,home}
cd "$DIR"

note "System facts"
{ hostname; echo; cat /etc/os-release; echo; uname -a; } > system/os.txt
ip -br addr > system/ip.txt 2>&1 || true
ss -ltnp > system/listening.txt 2>&1 || true
df -h > system/df.txt; free -h > system/mem.txt
crontab -l > system/crontab-root.txt 2>/dev/null || echo "(no root crontab)" > system/crontab-root.txt
[[ -d /etc/cron.d ]] && cp -a /etc/cron.d system/cron.d
systemctl list-unit-files --state=enabled --no-pager > system/enabled-units.txt 2>/dev/null || true
# custom services (real files, not the symlinks systemd creates when enabling)
mkdir -p etc/systemd
find /etc/systemd/system -maxdepth 1 -type f -name '*.service' -exec cp -a {} etc/systemd/ \; 2>/dev/null || true

note "Databases and other servers that need their own backup"
for spec in 5432:PostgreSQL 3306:MySQL/MariaDB 6379:Redis 27017:MongoDB; do
  port="${spec%%:*}"; name="${spec#*:}"
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}$"; then
    warn "${name} is listening on port ${port}. This script does NOT dump it. Dump it yourself before you wipe (e.g. pg_dumpall, mysqldump --all-databases, redis-cli SAVE)."
  fi
done

APP_DIRS=()
if command -v pm2 >/dev/null 2>&1; then
  note "pm2 apps"
  pm2 jlist 2>/dev/null | sed -n '/^\[/,$p' > pm2/jlist.json || true
  [[ -f "$HOME/.pm2/dump.pm2" ]] && cp -a "$HOME/.pm2/dump.pm2" pm2/dump.pm2
  [[ -f "$HOME/.pm2/module_conf.json" ]] && cp -a "$HOME/.pm2/module_conf.json" pm2/module_conf.json
  if [[ -s pm2/jlist.json ]] && command -v node >/dev/null 2>&1; then
    while IFS= read -r d; do [[ -n "$d" ]] && APP_DIRS+=("$d"); done < <(node -e '
      const apps = JSON.parse(require("fs").readFileSync("pm2/jlist.json", "utf8"));
      const dirs = new Set(apps.map((a) => a.pm2_env && a.pm2_env.pm_cwd).filter((d) => d && d !== "/" && d !== process.env.HOME));
      console.log([...dirs].join("\n"));')
  fi
fi

note "nginx, certbot, Let's Encrypt"
[[ -d /etc/nginx ]] && cp -a /etc/nginx etc/nginx
[[ -d /etc/letsencrypt ]] && tar czpf etc/letsencrypt.tgz -C / etc/letsencrypt
[[ -d /var/www ]] && { APP_DIRS+=("/var/www"); }

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  note "Docker"
  docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' > docker/ps.txt
  docker volume ls > docker/volumes.txt
  ids="$(docker ps -aq)"
  if [[ -n "$ids" ]]; then
    # shellcheck disable=SC2086
    docker inspect $ids > docker/inspect.json
    while IFS= read -r d; do [[ -n "$d" && -d "$d" ]] && APP_DIRS+=("$d"); done < <(
      # shellcheck disable=SC2086
      docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' $ids | sort -u | grep -v '^$' || true)
  fi
  for v in $(docker volume ls -q); do
    docker run --rm -v "$v":/v:ro -v "$DIR/docker":/o busybox tar czf "/o/vol-$v.tgz" -C /v . 2>/dev/null \
      || warn "could not save Docker volume '$v' (no network to pull busybox? back it up by hand)"
  done
  if [[ $IMAGES -eq 1 && -n "$ids" ]]; then
    note "Docker images (large)"
    # shellcheck disable=SC2046
    docker save $(docker inspect -f '{{.Config.Image}}' $ids | sort -u) | gzip > docker/images.tgz || warn "could not save Docker images"
  fi
fi

note "Home files: ssh keys, Binance wallet login"
[[ -f "$HOME/.ssh/authorized_keys" ]] && cp -a "$HOME/.ssh/authorized_keys" home/authorized_keys
[[ -d "$HOME/.baw" ]] && cp -a "$HOME/.baw" home/baw

# ---- app folders ---------------------------------------------------------------------------
mapfile -t APP_DIRS < <(printf '%s\n' "${APP_DIRS[@]:-}" | grep -v '^$' | sort -u)
total_mb=0
for d in "${APP_DIRS[@]:-}"; do
  [[ -n "$d" && -d "$d" ]] || continue
  total_mb=$((total_mb + $(du -sm --exclude=node_modules --exclude=.next/cache "$d" 2>/dev/null | cut -f1)))
done
note "Apps to save: ${#APP_DIRS[@]} folder(s), about ${total_mb} MB without node_modules"
if (( total_mb > MAX_GB * 1024 )) && [[ $FORCE -eq 0 ]]; then
  die "that is more than ${MAX_GB} GB. Check the list (cat ${DIR}/apps/WILL-SAVE.txt), then re-run with --force or a bigger --max-gb."
fi
printf '%s\n' "${APP_DIRS[@]:-}" > apps/WILL-SAVE.txt

: > apps/MAP.tsv
for d in "${APP_DIRS[@]:-}"; do
  [[ -n "$d" && -d "$d" ]] || continue
  slug="$(echo "$d" | sed 's#^/##; s#[^A-Za-z0-9._-]#_#g')"
  excl=(--exclude=node_modules --exclude=.next/cache --exclude='*.log' --exclude=logs)
  [[ $NO_GIT -eq 1 ]] && excl+=(--exclude=.git)
  tar czpf "apps/${slug}.tgz" "${excl[@]}" -C / "${d#/}" || warn "tar reported a problem saving ${d}"
  printf '%s\t%s\n' "$slug" "$d" >> apps/MAP.tsv
  # What each git folder was on, so nothing depends on memory.
  if [[ -d "$d/.git" ]]; then
    { echo "== $d"; git -C "$d" remote -v | head -2; git -C "$d" rev-parse --abbrev-ref HEAD; git -C "$d" rev-parse HEAD; git -C "$d" status --porcelain | head -20; } >> apps/git-state.txt 2>&1 || true
  fi
done

{
  echo "Rebuild backup of ${HOST}, made ${STAMP}"
  echo; echo "App folders:"; cut -f2 apps/MAP.tsv
  echo; echo "Warnings:"; printf ' - %s\n' "${WARNINGS[@]:-none}"
} > MANIFEST.txt

cd "$OUT_BASE"
ARCHIVE="${DIR}.tgz"
tar czpf "$ARCHIVE" -C "$(dirname "$DIR")" "$(basename "$DIR")"
if [[ $ENCRYPT -eq 1 ]]; then
  openssl enc -aes-256-cbc -pbkdf2 -salt -in "$ARCHIVE" -out "${ARCHIVE}.enc" || die "encryption failed"
  rm -f "$ARCHIVE"; ARCHIVE="${ARCHIVE}.enc"
fi
chmod 600 "$ARCHIVE"
SUM="$(sha256sum "$ARCHIVE" | cut -d' ' -f1)"

echo
echo "────────────────────────────────────────────────────────────────"
echo "Saved: $ARCHIVE  ($(du -h "$ARCHIVE" | cut -f1))"
echo "SHA-256: $SUM"
echo
echo "NOW, before you wipe anything, copy it OFF this server. From your own computer:"
echo "    scp root@<this-server>:${ARCHIVE} ."
echo "then check:  shasum -a 256 $(basename "$ARCHIVE")   (must equal the line above)"
[[ $ENCRYPT -eq 1 ]] || echo "It holds secrets (.env files, wallet login, certificate keys). Keep it private; --encrypt is safer."
if ((${#WARNINGS[@]})); then echo; echo "Read these before you wipe:"; printf '  ⚠ %s\n' "${WARNINGS[@]}"; fi
echo "────────────────────────────────────────────────────────────────"
