# Operations runbook

First time? Start with [SETUP.md](SETUP.md). Rebuilding or replacing a server? See [infra/REBUILD.md](infra/REBUILD.md).

Everything here lives on the `SaaS` branch. Commands run from the repo root.

## Add a server (about 5 minutes)

```bash
git clone -b SaaS https://github.com/ClipXonchain/neural-alpha.git && cd neural-alpha
sudo bash saas/join-mother.sh \
  --secret <mother CONTROL_API_SECRET> --treasury 0xTreasury \
  --mother-ssh root@MOTHER_IP --wireguard \
  --backup-rsync backup@MOTHER_IP:/var/backups/neural-alpha \
  --telegram-token <bot token> --telegram-username NeuralAlphaBot
```

It installs what is missing, opens a private WireGuard tunnel to the mother, starts the cell,
registers it, and turns on encrypted backups. **Save the backup key it prints, somewhere that is not
that server.** Without it the backups cannot be opened.

If a mother should be dialled by a DNS name or private address instead of its public IP, add `--mother-endpoint host:51820` (once per `--mother-ssh`, same order).

Without `--wireguard` the cell speaks plain HTTP with a shared secret, so traffic (including customer
tokens) is readable on the way. Use it only for a first test.

## Standby mother (no single point of failure for signup and the portal)

The mother holds almost no state: an order lives on the cell that took it, and a customer's session is
a self-contained token. So a standby is just a second edge.

1. Second VPS, same repo, same `CONTROL_API_SECRET` and `SAAS_MONITOR_SECRET`, `SAAS_EDGE_ONLY=1`,
   same dashboard build.
2. New cells: pass `--mother-ssh` twice (primary, then standby). Each tunnel gets its own interface and
   subnet (`wg0` / 10.88.0.x, `wg1` / 10.89.0.x), and the cell is registered on both mothers.
3. Existing cells: on each, `sudo bash saas/wg-link.sh cell --mother-ssh root@STANDBY --iface wg1 --subnet 10.89.0`,
   then on the standby `bash saas/link-vps.sh join-edge --host-id <cell> --cell-url http://<wg1 address>:3910 --secret <secret>`.
4. DNS: two A records with health checks (or a load balancer) for the portal host.
5. Only one process may poll Telegram. If the primary dies, set `TELEGRAM_BOT_POLL=1` on the standby.

## Telegram bot

One bot for the whole service.

1. Create it with @BotFather. You get a token and a username.
2. **Every cell** gets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME` (it sends that cell's alerts and makes link codes).
3. **Exactly one process** (the mother) also gets `TELEGRAM_BOT_POLL=1`. It reads messages and hands each to the cell that owns the chat.
4. Optional: `TELEGRAM_OPS_CHAT_ID` = a chat that receives ops alerts (message your bot, then open
   `https://api.telegram.org/bot<token>/getUpdates` and read `chat.id`).

A customer presses **Link Telegram** in Settings, gets a one-time code (15 minutes), and sends it to the bot.
The bot answers in private chats only, and it only reports: `/status`, `/unlink`, `/help`. It cannot trade or change settings.

## What gets alerted

| Customer gets | When |
| --- | --- |
| Trade messages | each new buy or sell (history is never replayed when they link) |
| "Not responding" / "stopped" / "no cycle for a while" | the check fails two minutes in a row; one message, then one "back to normal" |
| Renewal reminders | 7, 3 and 1 day before the month ends |
| Grace notice | the month ended; trading continues 3 more days |
| "New buys stopped" | the grace is over (or at once if they chose not to renew) |

Ops (the ops chat, and `alerts` on `/admin/overview`) get the problem alerts and any failed backup.
The maintenance pass runs every 60 seconds (`SAAS_MAINTENANCE_MS`).

Open positions are never sold when a subscription lapses. New buys stop; exits keep running.

## Subscription

30 days from payment. Renewing adds a month after the current one, so nothing is lost. The portal
**Renew** button opens `/portal?renew=1` (plan and payment for the same agent). **Don't renew** skips
the grace and the reminders and stops new buys when the month ends; **Keep my subscription** undoes it.

## Signing in, and getting back in

A customer can open their agent three ways, and up to **3 browsers** stay signed in at once (signing in on a
new device does not sign out the others; the oldest one makes room for a fourth):

1. **Access code**, shown once at checkout (with a download and a "I saved it" box). They can make a new one
   any time from Settings; it replaces the old one.
2. **The wallet that paid.** Sign in with your wallet signs a plain message with the wallet that sent the fee.
   Not available if they paid from an exchange, because the exchange's address cannot sign.
3. **A wallet they linked** in Settings, up to 3. This is the answer for exchange payers: link a browser wallet once
   and a lost code no longer matters. If one wallet opens several agents, the portal lists them to choose from.

A browser wallet is used for **identity and the one fee payment only**. Signing in or linking asks for a message
signature, which cannot move funds. "Pay with wallet" sends exactly the quoted amount to the treasury and nothing
else. It never asks for a token approval, never trades, and never touches the Binance Agentic Wallet.

Wrong access codes are limited to 8 a minute **per visitor address**, so one guesser never blocks another customer.
That needs the proxy headers in SETUP.md.

**A customer is locked out** (no code, no signed-in browser, no linked wallet): have them send the fee
transaction hash, find the agent with `GET /tenants` (the operator view lists `payment_tx`), check the amount
and time match, then mint a code and send it privately:

```bash
curl -X POST -H "Authorization: Bearer $CONTROL_API_SECRET" http://${SAAS_BIND_HOST:-127.0.0.1}:3910/tenants/<id>/access-code
```

Their money and the running agent are unaffected throughout; they only lose the portal until they are back in.
Sign-in works through the mother: it asks the cells when it has no record of an agent.

## Backups and disaster recovery

A customer's Binance wallet login lives only in their data folder. If a disk dies, that login is gone
and the customer must pair again, unless there is a backup.

- Every `SAAS_BACKUP_HOURS` (24) each cell writes `<id>-<time>.tar.gz.enc` per customer **and** a
  `control-<time>.tar.gz.enc` copy of its database, into `SAAS_BACKUP_DIR`. Newest 7 of each are kept.
- Files are AES-256-GCM encrypted on the cell. `SAAS_BACKUP_KEY` stays on the cell and with you.
  The machine that stores the copies sees ciphertext only.
- `SAAS_BACKUP_RSYNC=user@host:/path` copies them off the machine after each run.
- Run one now: `curl -X POST -H "Authorization: Bearer $CONTROL_API_SECRET" http://${SAAS_BIND_HOST:-127.0.0.1}:3910/backups/run` (a `--wireguard` cell listens on its private address, not 127.0.0.1)

Restore onto a replacement machine:

```bash
SAAS_BACKUP_KEY=<64 hex> bash saas/restore-cell.sh /path/to/backups /new/data/root
# start the cell with the same SAAS_HOST_ID and SAAS_DATA_ROOT=/new/data/root
# (if the host id changed: POST /recovery/adopt {"confirm":"adopt-this-host"})
```

Customers' containers resume from the restored folders, wallet login included. Anything that
happened after the last backup (up to a day of trades) is not in the folder, but the trade book is
also copied to Neon when `DATABASE_URL` is set.

## Rolling out a new version

```bash
bash saas/rollout.sh          # pull, build, tag by git SHA, canary first, then one at a time
bash saas/rollout.sh --tenant ab12cd34 --soak 300      # pick your own canary and watch it longer
bash saas/rollout.sh --tag <old sha> --no-pull --no-build   # roll back to an image you still have
```

Paper agents go first. A new image must come up and answer; if the canary or any later customer does
not, that customer is put back on its previous image and the rollout stops. Do one cell, watch it,
then the next. Never all cells at once.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` | unset | the one bot; alerts are off without them |
| `TELEGRAM_BOT_POLL` | unset | `1` on exactly one process |
| `TELEGRAM_OPS_CHAT_ID` | unset | where ops alerts go |
| `SAAS_MAINTENANCE_MS` | 60000 | reminders and watchdog pass |
| `SAAS_BACKUP_KEY`, `SAAS_BACKUP_DIR` | unset | both needed to turn backups on |
| `SAAS_BACKUP_HOURS` | 24 | how often |
| `SAAS_BACKUP_RSYNC` | unset | `user@host:/path` off-site copy |
| `SAAS_ROLLOUT_POLL_MS`, `SAAS_ROLLOUT_TIMEOUT_MS` | 5000, 150000 | how long a new image gets to come up |

## Setup and what was tested

First-time setup, in order, is in [SETUP.md](SETUP.md), with an honest list of what was and was not
tested on real machines.

## The server watchdog

`saas/infra/hostwatch.mjs` runs every 5 minutes (cron, installed by `bootstrap.sh`) and messages the ops chat once
when something goes wrong and once when it recovers: a disk at 85%, under 10% RAM available, a `neural-*` app that is
down or restarting in a loop, a customer container restarting, or one pinned at 90% CPU for 15 minutes. Apps you stopped
on purpose (anything not named `neural-*`) never alert. Its log is `/var/log/neural-hostwatch.log`.
