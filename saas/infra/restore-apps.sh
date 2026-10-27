#!/usr/bin/env bash
set -euo pipefail

# Puts the apps saved by inventory.sh back on a freshly built server.
# By default it only SHOWS what it would do. Nothing is changed until you add --apply.
#
#   sudo bash saas/infra/restore-apps.sh rebuild-srv1-20261030-1200.tgz            # look first
#   sudo bash saas/infra/restore-apps.sh rebuild-srv1-20261030-1200.tgz --apply    # restore app folders
#   ... --apply --install --nginx --certs --start                                  # and the rest
#
# --apply    copy each app folder back to where it was (skips a folder that already has files)
# --install  run npm ci in each restored app that has a package.json
# --nginx    put back the old nginx sites and snippets (never touches neural-* files; nginx -t first, undone if it fails)
# --certs    put back the Let's Encrypt certificates (never overwrites a certificate that already exists)
# --start    start the old pm2 apps again (not the neural-* ones: those are set up by bootstrap.sh)
# --volumes  put back saved Docker volumes      --compose  docker compose up -d in restored compose folders
# --ssh-keys add the old authorized_keys to this server's root account
# An encrypted archive (.enc) asks for its passphrase.

SRC=""; APPLY=0; INSTALL=0; NGINX=0; CERTS=0; START=0; VOLUMES=0; COMPOSE=0; SSHKEYS=0
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;; --install) INSTALL=1 ;; --nginx) NGINX=1 ;; --certs) CERTS=1 ;;
    --start) START=1 ;; --volumes) VOLUMES=1 ;; --compose) COMPOSE=1 ;; --ssh-keys) SSHKEYS=1 ;;
    -h|--help) sed -n 3,16p "$0"; exit 0 ;;
    -*) echo "Unknown option: $a" >&2; exit 1 ;;
    *) SRC="$a" ;;
  esac
done
die() { echo "✗ $*" >&2; exit 1; }
say() { echo "▸ $*"; }
do_() { if [[ $APPLY -eq 1 ]]; then "$@"; else echo "   (dry run) $*"; fi; }
[[ -n "$SRC" && -e "$SRC" ]] || die "give the path to the rebuild-*.tgz (or .tgz.enc) you saved"
[[ $EUID -eq 0 ]] || die "run as root (sudo)"
umask 077

WORK="$(mktemp -d /root/restore-work.XXXXXX)"
if [[ "$SRC" == *.enc ]]; then
  openssl enc -d -aes-256-cbc -pbkdf2 -in "$SRC" -out "$WORK/archive.tgz" || die "wrong passphrase, or the file is damaged"
  SRC="$WORK/archive.tgz"
fi
if [[ -d "$SRC" ]]; then B="$SRC"; else
  tar xzpf "$SRC" -C "$WORK" || die "could not read the archive"
  B="$(find "$WORK" -maxdepth 1 -type d -name 'rebuild-*' | head -1)"
fi
[[ -f "$B/MANIFEST.txt" ]] || die "this does not look like an inventory.sh archive"

say "Archive: $(head -1 "$B/MANIFEST.txt")"
sed -n '/^Warnings:/,$p' "$B/MANIFEST.txt" | sed 's/^/   /'
[[ $APPLY -eq 1 ]] || echo "   (dry run: add --apply to change anything)"

say "App folders"
while IFS=$'\t' read -r slug dir; do
  [[ -n "$slug" ]] || continue
  if [[ -d "$dir" && -n "$(ls -A "$dir" 2>/dev/null)" ]]; then
    echo "   skip   $dir  (already has files here)"
  else
    echo "   restore $dir"
    do_ tar xzpf "$B/apps/${slug}.tgz" -C /
  fi
done < "$B/apps/MAP.tsv"

if [[ $INSTALL -eq 1 ]]; then
  say "Installing dependencies"
  while IFS=$'\t' read -r _ dir; do
    [[ -f "$dir/package.json" ]] || continue
    if [[ -f "$dir/package-lock.json" ]]; then do_ bash -c "cd '$dir' && npm ci --no-audit --no-fund"
    else do_ bash -c "cd '$dir' && npm install --no-audit --no-fund"; fi
  done < "$B/apps/MAP.tsv"
fi

# Certificates first: the nginx sites point at them, and nginx -t fails without them.
if [[ $CERTS -eq 1 ]]; then
  say "Let's Encrypt certificates"
  if [[ -f "$B/etc/letsencrypt.tgz" ]]; then
    do_ tar xzpf "$B/etc/letsencrypt.tgz" -C / --skip-old-files
    echo "   afterwards check renewal works:  certbot renew --dry-run"
  else echo "   nothing saved"; fi
fi

if [[ $NGINX -eq 1 ]]; then
  say "nginx sites"
  if [[ ! -d "$B/etc/nginx" ]]; then echo "   nothing saved"; else
    BEFORE="$WORK/nginx-before"; cp -a /etc/nginx "$BEFORE"
    for sub in sites-available conf.d snippets; do
      [[ -d "$B/etc/nginx/$sub" ]] || continue
      for f in "$B/etc/nginx/$sub"/*; do
        [[ -e "$f" ]] || continue
        case "$(basename "$f")" in neural-*|default) echo "   keep   $sub/$(basename "$f") (new design)"; continue ;; esac
        echo "   copy   $sub/$(basename "$f")"
        do_ cp -a "$f" "/etc/nginx/$sub/"
      done
    done
    if [[ -d "$B/etc/nginx/sites-enabled" ]]; then
      for l in "$B/etc/nginx/sites-enabled"/*; do
        [[ -L "$l" ]] || continue
        n="$(basename "$l")"; case "$n" in neural-*|default) continue ;; esac
        do_ ln -sfn "/etc/nginx/sites-available/$n" "/etc/nginx/sites-enabled/$n"
      done
    fi
    if [[ $APPLY -eq 1 ]]; then
      if nginx -t 2>/dev/null; then systemctl reload nginx 2>/dev/null || nginx -s reload || true; echo "   nginx test passed and reloaded"
      else
        echo "✗ nginx -t failed: putting the previous config back" >&2
        cp -a "$BEFORE/." /etc/nginx/
        die "nginx restore undone; run nginx -t to see why"
      fi
    fi
  fi
fi

if [[ $VOLUMES -eq 1 ]]; then
  say "Docker volumes"
  for f in "$B"/docker/vol-*.tgz; do
    [[ -e "$f" ]] || { echo "   none saved"; break; }
    v="$(basename "$f" .tgz)"; v="${v#vol-}"
    do_ docker volume create "$v"
    do_ docker run --rm -v "$v":/v -v "$B/docker":/o busybox tar xzf "/o/vol-$v.tgz" -C /v
  done
fi
if [[ $COMPOSE -eq 1 ]]; then
  say "Compose projects"
  while IFS=$'\t' read -r _ dir; do
    for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do
      [[ -f "$dir/$f" ]] && { do_ bash -c "cd '$dir' && docker compose up -d"; break; }
    done
  done < "$B/apps/MAP.tsv"
fi

if [[ $START -eq 1 ]]; then
  say "pm2 apps"
  if [[ -s "$B/pm2/jlist.json" ]]; then
    node -e '
      const fs = require("fs");
      const apps = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const out = apps.filter((a) => !a.name.startsWith("neural-")).map((a) => {
        const e = a.pm2_env || {};
        const o = { name: a.name, script: e.pm_exec_path, cwd: e.pm_cwd, exec_mode: e.exec_mode === "cluster_mode" ? "cluster" : "fork" };
        if (e.exec_interpreter && e.exec_interpreter !== "node") o.interpreter = e.exec_interpreter;
        if (e.args && e.args.length) o.args = e.args;
        if (e.instances > 1) o.instances = e.instances;
        o.autorestart = e.autorestart !== false;
        return o;
      });
      fs.writeFileSync(process.argv[2], JSON.stringify({ apps: out }, null, 2));
      // Bring things back as they were: an app you had stopped on purpose stays stopped.
      const stopped = apps.filter((a) => !a.name.startsWith("neural-") && a.pm2_env && a.pm2_env.status !== "online").map((a) => a.name);
      fs.writeFileSync(process.argv[3], stopped.map((n) => n + "\n").join(""));
      console.log(out.map((o) => "   " + o.name + "  " + o.script + (stopped.includes(o.name) ? "  (was stopped: will stay stopped)" : "")).join("\n") || "   (none besides neural-*)");
    ' "$B/pm2/jlist.json" "$WORK/restored.ecosystem.json" "$WORK/stopped.txt"
    echo "   Apps that read settings from the old pm2 environment (not from .env files) need them added again."
    echo "   The old values are in $B/pm2/jlist.json."
    do_ pm2 start "$WORK/restored.ecosystem.json"
    while IFS= read -r n || [[ -n "$n" ]]; do [[ -n "$n" ]] && do_ pm2 stop "$n"; done < "$WORK/stopped.txt"
    do_ pm2 save
  else echo "   no pm2 list saved"; fi
fi

if [[ $SSHKEYS -eq 1 && -f "$B/home/authorized_keys" ]]; then
  say "ssh keys"
  do_ mkdir -p /root/.ssh
  do_ bash -c "cat '$B/home/authorized_keys' >> /root/.ssh/authorized_keys && sort -u -o /root/.ssh/authorized_keys /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys"
fi

if [[ -d "$B/home/baw" ]]; then
  say "Binance wallet login (the founder bot) was saved in: $B/home/baw"
  echo "   Copy it to /root/.baw only if the bot should keep its old login, then run: baw wallet status"
fi
if [[ -s "$B/docker/ps.txt" ]]; then say "Docker containers that existed (re-create them from their compose folder, or by hand):"; sed 's/^/   /' "$B/docker/ps.txt"; fi
[[ $APPLY -eq 1 ]] && echo "Working files are in $WORK (delete them when you are done: they hold secrets)."
exit 0
