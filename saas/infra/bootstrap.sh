#!/usr/bin/env bash
set -euo pipefail

# Takes a brand-new Ubuntu 22.04/24.04 server (root, ssh key login) to a hardened, running Neural Alpha server.
# Safe to run again: every step checks before it changes anything.
#
#   MOTHER (portal, router, nginx, HTTPS):
#     sudo bash saas/infra/bootstrap.sh --role mother --domain neuralalpha.io --email you@example.com \
#          --treasury 0xYourFeeWallet --ssh-key "ssh-ed25519 AAAA... you" \
#          --telegram-token <token> --telegram-username <bot> --telegram-ops-chat <id>
#
#   CELL (customer containers). Everything after -- goes to join-mother.sh:
#     sudo bash saas/infra/bootstrap.sh --role cell --ssh-key "ssh-ed25519 AAAA... you" -- \
#          --secret <mother CONTROL_API_SECRET> --treasury 0xYourFeeWallet \
#          --mother-ssh root@MOTHER_IP --wireguard
#
# Common:   --repo URL (default the Neural Alpha repo)  --branch NAME (SaaS)  --dir PATH (/opt/neural-alpha)
#           --ssh-key "..."   adds this key; password login is switched off only once a key is present
#           --docker          install Docker on a mother too       --no-harden   skip firewall/ssh/upgrades
#           --dry-run         print every step without doing it    --skip-app    server basics only (for tests)
#           --skip-code       use the folder at --dir as it is (you copied the repo there yourself)
# Mother:   --secret S --monitor-secret M (made for you if omitted, and printed ONCE)  --price-usd N
#           --telegram-token --telegram-username --telegram-ops-chat   --backup-key <64 hex>

ROLE=""; REPO="https://github.com/ClipXonchain/neural-alpha.git"; BRANCH="SaaS"; DIR="/opt/neural-alpha"
SSH_KEY=""; DOCKER=0; HARDEN=1; DRY=0; SKIP_APP=0; SKIP_CODE=0
DOMAIN=""; EMAIL=""; TREASURY=""; SECRET=""; MONITOR=""; PRICE="${SAAS_PRICE_USD:-15}"
TG_TOKEN=""; TG_USER=""; TG_OPS=""; BK_KEY=""; JOIN_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) ROLE="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --ssh-key) SSH_KEY="${2:-}"; shift 2 ;;
    --docker) DOCKER=1; shift ;;
    --no-harden) HARDEN=0; shift ;;
    --dry-run) DRY=1; shift ;;
    --skip-app) SKIP_APP=1; shift ;;
    --skip-code) SKIP_CODE=1; shift ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --treasury) TREASURY="${2:-}"; shift 2 ;;
    --secret) SECRET="${2:-}"; shift 2 ;;
    --monitor-secret) MONITOR="${2:-}"; shift 2 ;;
    --price-usd) PRICE="${2:-}"; shift 2 ;;
    --telegram-token) TG_TOKEN="${2:-}"; shift 2 ;;
    --telegram-username) TG_USER="${2:-}"; shift 2 ;;
    --telegram-ops-chat) TG_OPS="${2:-}"; shift 2 ;;
    --backup-key) BK_KEY="${2:-}"; shift 2 ;;
    --) shift; JOIN_ARGS=("$@"); break ;;
    -h|--help) sed -n 3,24p "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (use -- before join-mother options)" >&2; exit 1 ;;
  esac
done

die() { echo "✗ $*" >&2; exit 1; }
say() { echo "▸ $*"; }
run() { if [[ $DRY -eq 1 ]]; then echo "   (dry run) $*"; else "$@"; fi; }
sh_() { if [[ $DRY -eq 1 ]]; then echo "   (dry run) $*"; else bash -c "$*"; fi; }

[[ "$ROLE" == mother || "$ROLE" == cell ]] || die "--role mother or --role cell is required"
[[ "$DIR" == /* ]] || die "--dir must be an absolute path"
[[ -z "$SSH_KEY" || "$SSH_KEY" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+)\ [A-Za-z0-9+/=]+ ]] || die "--ssh-key does not look like a public key"
if [[ "$ROLE" == mother ]]; then
  [[ -n "$DOMAIN" && "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "--domain is required for a mother (e.g. neuralalpha.io)"
  [[ -n "$EMAIL" && "$EMAIL" == *@* ]] || die "--email is required for a mother (Let's Encrypt notices)"
  [[ "$TREASURY" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "--treasury must be your 0x BSC fee wallet address"
  [[ -z "$BK_KEY" || "$BK_KEY" =~ ^[0-9a-fA-F]{64}$ ]] || die "--backup-key must be 64 hex characters"
else
  [[ ${#JOIN_ARGS[@]} -gt 0 || $SKIP_APP -eq 1 ]] || die "a cell needs join-mother options after --  (see the header of this script)"
fi

[[ $EUID -eq 0 || $DRY -eq 1 ]] || die "run as root (sudo)"
SYSTEMD=0; [[ -d /run/systemd/system ]] && SYSTEMD=1
export DEBIAN_FRONTEND=noninteractive

# ---- 1. system basics, upgrades, firewall, ssh, fail2ban --------------------------------------
say "System packages and updates"
run apt-get update -qq
run apt-get install -y -qq curl git ca-certificates gnupg openssl jq rsync ufw fail2ban unattended-upgrades chrony wireguard-tools cron logrotate
[[ $HARDEN -eq 1 ]] && run apt-get upgrade -y -qq

if [[ -n "$SSH_KEY" ]]; then
  say "ssh key"
  sh_ "mkdir -p /root/.ssh && chmod 700 /root/.ssh && touch /root/.ssh/authorized_keys && grep -qxF '$SSH_KEY' /root/.ssh/authorized_keys || echo '$SSH_KEY' >> /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys"
fi

if [[ $HARDEN -eq 1 ]]; then
  say "Swap, journal size, automatic security updates"
  if [[ -z "$(swapon --show 2>/dev/null)" && $SYSTEMD -eq 1 ]]; then
    sh_ "fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile && grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab"
  fi
  sh_ "echo 'vm.swappiness=10' > /etc/sysctl.d/90-neural.conf && sysctl -p /etc/sysctl.d/90-neural.conf >/dev/null 2>&1 || true"
  sh_ "mkdir -p /etc/systemd/journald.conf.d && printf '[Journal]\nSystemMaxUse=500M\n' > /etc/systemd/journald.conf.d/neural.conf"
  sh_ "printf 'APT::Periodic::Update-Package-Lists \"1\";\nAPT::Periodic::Unattended-Upgrade \"1\";\n' > /etc/apt/apt.conf.d/20auto-upgrades"
  if [[ $SYSTEMD -eq 1 ]]; then
    say "Firewall (deny by default), fail2ban, ssh"
    run ufw default deny incoming; run ufw default allow outgoing
    run ufw limit 22/tcp
    if [[ "$ROLE" == mother ]]; then run ufw allow 80/tcp; run ufw allow 443/tcp; run ufw allow 51820/udp; fi
    run ufw --force enable
    run systemctl enable --now fail2ban
    run systemctl enable --now chrony
    # Password login is only switched off when a key is already in place, so this cannot lock you out.
    if [[ -s /root/.ssh/authorized_keys || $DRY -eq 1 ]]; then
      sh_ "printf 'PasswordAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/99-neural.conf && sshd -t && systemctl reload ssh 2>/dev/null || systemctl reload sshd"
    else
      echo "   ssh password login left ON: no key found in /root/.ssh/authorized_keys (pass --ssh-key)"
    fi
  else
    echo "   (no systemd here: skipping firewall, fail2ban and ssh changes)"
  fi
fi

# ---- 2. Node 22, pm2 with log rotation --------------------------------------------------------
say "Node 22 and pm2"
if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null; then
  sh_ "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null && apt-get install -y -qq nodejs"
fi
command -v pm2 >/dev/null 2>&1 || run npm install -g pm2
if ! pm2 ls 2>/dev/null | grep -q pm2-logrotate; then
  run pm2 install pm2-logrotate
  run pm2 set pm2-logrotate:max_size 20M; run pm2 set pm2-logrotate:retain 7; run pm2 set pm2-logrotate:compress true
fi
[[ $SYSTEMD -eq 1 ]] && run pm2 startup systemd -u root --hp /root

# ---- 3. Docker with rotated logs (cells, or --docker) -----------------------------------------
if [[ "$ROLE" == cell || $DOCKER -eq 1 ]]; then
  say "Docker (log rotation on, containers survive a daemon restart)"
  command -v docker >/dev/null 2>&1 || sh_ "curl -fsSL https://get.docker.com | sh"
  sh_ "mkdir -p /etc/docker && printf '{\n  \"log-driver\": \"json-file\",\n  \"log-opts\": { \"max-size\": \"10m\", \"max-file\": \"3\" },\n  \"live-restore\": true\n}\n' > /etc/docker/daemon.json"
  [[ $SYSTEMD -eq 1 ]] && run systemctl restart docker
fi

# ---- 4. the code ------------------------------------------------------------------------------
say "Code: $REPO ($BRANCH) in $DIR"
if [[ $SKIP_CODE -eq 1 ]]; then [[ -d "$DIR/saas" ]] || die "--skip-code, but $DIR has no saas/ folder"; echo "   using $DIR as it is"
elif [[ -d "$DIR/.git" ]]; then run git -C "$DIR" fetch origin "$BRANCH"; run git -C "$DIR" checkout "$BRANCH"; run git -C "$DIR" merge --ff-only "origin/$BRANCH"
else run git clone --branch "$BRANCH" "$REPO" "$DIR"; fi

# ---- 5. role-specific -------------------------------------------------------------------------
gen() { openssl rand -hex "$1"; }
if [[ "$ROLE" == mother ]]; then
  [[ -n "$SECRET" ]] || SECRET="$(gen 32)"; [[ -n "$MONITOR" ]] || MONITOR="$(gen 24)"; [[ -n "$BK_KEY" ]] || BK_KEY="$(gen 32)"
  say "Mother: config, build, pm2"
  if [[ $SKIP_APP -eq 0 ]]; then
    sh_ "mkdir -p '$DIR/saas/runtime' /var/backups/neural-alpha && chmod 700 /var/backups/neural-alpha"
    sh_ "umask 077; cat > '$DIR/saas/runtime/cell.env' <<EOT
SAAS_HOST_ID=mother
SAAS_EDGE_ONLY=1
SAAS_DATA_ROOT=$DIR/saas/runtime
SAAS_TREASURY_ADDRESS=$TREASURY
SAAS_PRICE_USD=$PRICE
SAAS_APP_URL=https://$DOMAIN/portal
CONTROL_API_SECRET=$SECRET
SAAS_MONITOR_SECRET=$MONITOR
SAAS_BIND_HOST=127.0.0.1
SAAS_CONTROL_PORT=3910
SAAS_BACKUP_KEY=$BK_KEY
SAAS_BACKUP_DIR=/var/backups/neural-alpha
${TG_TOKEN:+TELEGRAM_BOT_TOKEN=$TG_TOKEN
TELEGRAM_BOT_USERNAME=$TG_USER
TELEGRAM_BOT_POLL=1
}${TG_OPS:+TELEGRAM_OPS_CHAT_ID=$TG_OPS
}EOT"
    sh_ "umask 077; printf 'SAAS_CONTROL_URL=http://127.0.0.1:3910\nCONTROL_API_SECRET=$SECRET\nSAAS_MONITOR_SECRET=$MONITOR\n' > '$DIR/dashboard/.env.production.local'"
    sh_ "cd '$DIR' && npm ci --no-audit --no-fund && npm run build --workspace=dashboard"
    run pm2 delete neural-saas-edge neural-portal 2>/dev/null || true
    sh_ "cd '$DIR' && NA_ROLE=mother pm2 start saas/infra/ecosystem.config.cjs && pm2 save"
  fi

  say "nginx and HTTPS"
  run apt-get install -y -qq nginx certbot python3-certbot-nginx
  sh_ "mkdir -p /etc/nginx/snippets && cp '$DIR/saas/infra/nginx/limits.conf' /etc/nginx/conf.d/neural-limits.conf && cp '$DIR/saas/infra/nginx/neural-proxy.conf' /etc/nginx/snippets/neural-proxy.conf"
  sh_ "sed -e 's#__DOMAIN__#$DOMAIN#g' -e 's#__PORT__#3007#g' '$DIR/saas/infra/nginx/portal.conf.tmpl' > /etc/nginx/sites-available/neural-portal && ln -sfn /etc/nginx/sites-available/neural-portal /etc/nginx/sites-enabled/neural-portal && rm -f /etc/nginx/sites-enabled/default"
  run nginx -t
  [[ $SYSTEMD -eq 1 ]] && run systemctl enable --now nginx && run systemctl reload nginx
  me="$(curl -fsS https://api.ipify.org 2>/dev/null || true)"; there="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
  if [[ -n "$me" && "$me" == "$there" ]] || [[ $DRY -eq 1 ]]; then
    run certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --no-eff-email --redirect --non-interactive
  else
    echo "   ⚠ $DOMAIN points to '${there:-nothing}', not to this server (${me:-unknown})."
    echo "     Point the DNS A record here, then run:  certbot --nginx -d $DOMAIN -m $EMAIL --agree-tos --redirect"
  fi
else
  if [[ $SKIP_APP -eq 0 ]]; then
    say "Cell: join the mother"
    run bash "$DIR/saas/join-mother.sh" "${JOIN_ARGS[@]}"
  fi
fi

# ---- 6. host watchdog -------------------------------------------------------------------------
say "Host watchdog (every 5 minutes: disk, memory, apps, runaway containers)"
sh_ "cat > /etc/cron.d/neural-hostwatch <<'EOT'
*/5 * * * * root cd $DIR && set -a && . saas/runtime/cell.env 2>/dev/null; set +a; HOSTWATCH_NAME=\$(hostname -s) /usr/bin/env node saas/infra/hostwatch.mjs >> /var/log/neural-hostwatch.log 2>&1
EOT
chmod 644 /etc/cron.d/neural-hostwatch
printf '/var/log/neural-hostwatch.log {\n  weekly\n  rotate 4\n  compress\n  missingok\n  notifempty\n}\n' > /etc/logrotate.d/neural-hostwatch"

echo
echo "────────────────────────────────────────────────────────────────"
if [[ "$ROLE" == mother && $DRY -eq 0 && $SKIP_APP -eq 0 ]]; then
  echo "Mother is up at https://${DOMAIN}/portal  (if the DNS points here)."
  echo
  echo "SAVE THESE NOW in your password manager, then delete this screen. They are shown once:"
  echo "  CONTROL_API_SECRET   = $SECRET     (every cell needs this one)"
  echo "  SAAS_MONITOR_SECRET  = $MONITOR"
  echo "  BACKUP KEY           = $BK_KEY     (without it backups cannot be opened)"
  echo
  echo "Now build the cell, then: bash saas/infra/restore-apps.sh <your saved archive> to bring your other apps back."
fi
echo "Check anything, any time:  pm2 ls    nginx -t    ufw status    tail /var/log/neural-hostwatch.log"
echo "────────────────────────────────────────────────────────────────"
