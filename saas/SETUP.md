# Setting up the SaaS, step by step

Follow in order. Each step says how to check it worked. For day-to-day running see
[OPERATIONS.md](OPERATIONS.md).

You need: a **mother** VPS (public site + router, runs no customer agents), one or more **cell** VPSes
(each runs about 20 customer agents), a domain, a BSC wallet address for fees, and a Telegram bot.
All servers: Ubuntu 22.04 or 24.04, root SSH access with a key.

## 0. Decide and collect (10 minutes)

| Item | Where from | Notes |
| --- | --- | --- |
| `CONTROL_API_SECRET` | `openssl rand -hex 32` | one value, shared by the mother and every cell |
| `SAAS_MONITOR_SECRET` | `openssl rand -hex 24` | read-only admin desk key |
| Treasury address | your fee wallet (BSC) | public address only; the private key never goes on a server |
| Bot token + username | @BotFather | for Telegram alerts |
| Backup key | `openssl rand -hex 32` | **store it somewhere that is not a server** (password manager) |

## 1. The mother

On the mother VPS:

```bash
git clone -b SaaS https://github.com/ClipXonchain/neural-alpha.git && cd neural-alpha
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs git rsync wireguard-tools
sudo npm install -g pm2
npm ci && npm run build --workspace=dashboard
```

Start the control process (the router) and the portal. Node 22 is required.

```bash
export CONTROL_API_SECRET=<secret> SAAS_MONITOR_SECRET=<monitor> SAAS_HOST_ID=mother SAAS_EDGE_ONLY=1 \
       SAAS_TREASURY_ADDRESS=0xYourFeeWallet SAAS_APP_URL=https://YOUR-DOMAIN/portal \
       TELEGRAM_BOT_TOKEN=<token> TELEGRAM_BOT_USERNAME=<username> TELEGRAM_BOT_POLL=1 \
       SAAS_BACKUP_KEY=<backup key> SAAS_BACKUP_DIR=/var/backups/neural-alpha

mkdir -p /var/backups/neural-alpha
# Run node directly. `pm2 start server.mjs` would load it through PM2's wrapper and it would never listen.
pm2 start "$(command -v node)" --interpreter none --name neural-saas-edge -- "$PWD/saas/control/server.mjs"

SAAS_CONTROL_URL=http://127.0.0.1:3910 CONTROL_API_SECRET=<secret> SAAS_MONITOR_SECRET=<monitor> \
  pm2 start "$PWD/node_modules/.bin/next" --interpreter none --name neural-portal --cwd "$PWD/dashboard" -- start -H 127.0.0.1 -p 3007
pm2 save && pm2 startup
```

`SAAS_EDGE_ONLY=1` means the mother never takes a customer itself; it only routes to cells.
`TELEGRAM_BOT_POLL=1` goes on exactly this one process.

Put nginx and TLS in front of port 3007 for your domain (certbot). Never expose port 3910.

**Check:** `curl -s -H "Authorization: Bearer <secret>" http://127.0.0.1:3910/capacity` returns JSON, and
`https://YOUR-DOMAIN/portal` shows the plan page.

> Already running the founder bot on this VPS (`neural-agent`, `neural-dashboard` on 3005/3006)? Leave them.
> The names and ports above do not clash. The founder bot stays on the `agentic-wallet` branch deploy.

## 2. The first cell

On a **new** VPS (16 GB RAM fits about 20 customers):

```bash
git clone -b SaaS https://github.com/ClipXonchain/neural-alpha.git && cd neural-alpha
sudo bash saas/join-mother.sh \
  --secret <CONTROL_API_SECRET> --treasury 0xYourFeeWallet \
  --mother-ssh root@MOTHER_IP --wireguard \
  --backup-key <backup key> --backup-rsync backup@MOTHER_IP:/var/backups/neural-alpha \
  --telegram-token <token> --telegram-username <username>
```

What it does: installs Docker, Node 22 and PM2 if missing; opens a private WireGuard tunnel to the mother;
builds the customer image; starts the cell; registers it. The cell's API listens on the tunnel address only.

Make sure the cell can SSH to the mother as root with a key (`ssh root@MOTHER_IP true` must work without a
prompt), and that **UDP 51820** is open on the mother's firewall.

**Check, on the mother:** `bash saas/link-vps.sh status --secret <secret>` lists the cell with 20 free seats.
From anywhere else, `curl http://<cell public ip>:3910` must be refused.

## 3. Test with one customer before real ones

1. In the portal, go through checkout with a small real payment, or on the cell create one directly while
   testing. Choose a 100 USDT size.
2. Sign in with the access code. Open **Settings**: Subscription shows 30 days; paid CoinMarketCap is on,
   Agent Studio is off.
3. **Link Telegram**, send the code to your bot. The panel flips to Linked and the bot answers `/status`.
4. Pair the Binance Agentic Wallet. Leave the agent in **paper** mode for at least a day.
5. Switch Studio on and off once and confirm the agent restarts (`docker ps` on the cell shows a fresh uptime).
6. Only then switch to live with a small amount.

## 4. Add more cells

Repeat step 2 on each new VPS. Nothing else changes. New signups go to a cell with free seats.

## 5. Standby mother (optional, recommended)

Do step 1 on a second VPS with a different `SAAS_HOST_ID` (for example `mother2`), same secrets, **without**
`TELEGRAM_BOT_POLL`. Then, for each new cell, pass both mothers:

```bash
--mother-ssh root@MOTHER1 --mother-ssh root@MOTHER2
```

For an existing cell see "Standby mother" in OPERATIONS.md. Point DNS at both mothers with a health check.
If the primary dies, set `TELEGRAM_BOT_POLL=1` on the standby.

## 6. Updating

```bash
bash saas/rollout.sh        # on each cell, one cell at a time
```

## What was tested, and what was not

Tested on a Mac with a Linux VM (Colima/Docker), real tools, no mocks for these:

- Every automated test (81 control tests, 38 agent tests), type checks, production build.
- The customer worker image: builds, and the agent boots in paper mode, runs a cycle, pulls live Binance bStock
  quotes, and answers the control plane's state request. (This found that the image needed Node 22.)
- `join-mother.sh` with `--wireguard` between two Linux containers: real WireGuard tunnels, real SSH, the cell
  registered and reachable from the mother in about 11 ms, and refused on its ordinary address. Re-running it is safe.
- Two mothers (primary and standby) joined by one cell on separate tunnels.
- `rollout.sh`, `restore-cell.sh` and the encrypted backups, including a wrong-key refusal.
- The live scheduler: reminders at 3 days, grace, lapse, and no repeats; Telegram linking, `/status`, strangers
  and group chats; renewal adding a month; the portal Settings page.

**Not tested** (needs real accounts or servers):

- A real payment on BSC, a real Binance Agentic Wallet pairing, and real paid CoinMarketCap / Agent Studio calls.
- The real Telegram servers (a local stand-in was used; message shapes match the Bot API).
- nginx + TLS in front of the portal, and `next start` behind it (dev mode and the production build were checked).
- A real VPS provider's firewall and `ufw` behaviour. In the containers `ufw` only recorded rules.
- Off-site backup with `rsync` over a real SSH link.
- Several customers on one cell under load, and the 7-minute cycle timing with the new data path.
