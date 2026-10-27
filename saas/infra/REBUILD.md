# Rebuilding both servers from scratch

You run the commands and paste me anything that looks wrong. Everything below was rehearsed in a Linux
container first (see "What was tested"). Plan about 2 hours for the main server (`srv…`) and 1 hour for the
customer server (`vim…`). Downtime is fine for you, so there is no clever cut-over: save, wipe, rebuild, restore.

## What the new setup fixes

| What went wrong before | What stops it now |
| --- | --- |
| Control process grew to 8.3 GB | PM2 restarts it above 1.5 GB; the backup reads only the newest rows and runs at most every 5 minutes |
| A customer agent sat at 100% CPU and moved 95 GB | Every customer container is stopped at 1 GiB RAM, capped at 1 CPU and 512 processes; the watchdog alerts you after 15 minutes at 90% CPU |
| Container logs could fill the disk | Docker rotates them (10 MB × 3); so do PM2 logs, journald and the watchdog log |
| A hand-made `pm2-entry.mjs` no one remembered | One file in git: `saas/infra/ecosystem.config.cjs` |
| No backups of wallet logins | Daily encrypted backups, plus this inventory step before any wipe |
| No firewall or login protection | Firewall denies everything except what each server needs, fail2ban, key-only SSH, automatic security updates |
| A guesser could lock every customer out of sign-in | nginx rate-limits sign-in routes per visitor and passes the visitor's address through |
| Nobody told you when something broke | `hostwatch` messages your ops Telegram chat about disk, memory, a down app or a runaway container |

## Before you start (20 minutes)

1. **Decide the portal domain** (for example `neuralalpha.io`) and make sure you can edit its DNS.
2. **Have ready:** your fee wallet address (public `0x…` only), a Telegram bot token + username + your ops chat id,
   and your SSH public key (`cat ~/.ssh/id_ed25519.pub` on your Mac).
3. **Take a provider snapshot of both servers** if your host offers it. It is the only true undo.
4. **Get the code onto your Mac's disk**: this repo, branch `SaaS`. The new servers fetch it from GitHub, so
   either run `git push origin SaaS` first (recommended), or copy it by hand with `--skip-code` (step B3).
5. **The founder bot** (`neural-agent`, branch `agentic-wallet`) is *not* part of this rebuild. Its wallet login
   is saved in the archive (`home/baw`) so nothing is lost; to bring the bot back later use its own `deploy.sh`.

## A. Save everything from each old server

On **each** old server (srv first, then vim). If the new scripts are not on the server yet, copy them from your Mac:

```bash
scp -r "/Users/captainx/Neural Alpha/saas/infra" root@OLD_SERVER_IP:/root/infra
```

Then on the server:

```bash
sudo bash /root/infra/inventory.sh --encrypt        # asks for a passphrase: put it in your password manager
```

It prints the archive path and a checksum. **Copy it off the server now** and check it, from your Mac:

```bash
scp root@OLD_SERVER_IP:/root/rebuild-*.tgz.enc ~/Desktop/
shasum -a 256 ~/Desktop/rebuild-*.tgz.enc          # must equal the line the server printed
```

Read the "Read these before you wipe" lines it prints. If it says a database is running (PostgreSQL, MySQL,
Redis, MongoDB), **dump it yourself** (`pg_dumpall`, `mysqldump --all-databases`, `redis-cli SAVE`): this script
does not copy databases. Copy anything else you care about by hand.

## B. Rebuild the main server (`srv…`): portal, nginx, HTTPS

1. In your provider's panel, **re-install Ubuntu 24.04** on the server and add your SSH key.
2. **Point DNS now:** an `A` record for your domain to this server's IP. (Certbot needs it; if you forget, the
   script tells you the one command to run later.)
3. Get the code and run the bootstrap. From your Mac, copy the repo (skip this if you pushed and want a clone):

```bash
cd "/Users/captainx/Neural Alpha"
rsync -a --exclude node_modules --exclude .next --exclude .git --exclude 'saas/runtime' --exclude '.env*' ./ root@SRV_IP:/opt/neural-alpha/
```

   On the server:

```bash
sudo bash /opt/neural-alpha/saas/infra/bootstrap.sh --role mother --skip-code \
  --domain YOUR.DOMAIN --email you@example.com \
  --treasury 0xYourFeeWallet \
  --ssh-key "ssh-ed25519 AAAA... you@mac" \
  --telegram-token <bot token> --telegram-username <BotUsername> --telegram-ops-chat <your chat id>
```

   (Left out `--skip-code`, it clones the repo from GitHub instead.)
4. **Save the three secrets it prints at the end** (shown once): the control secret (every cell needs it), the monitor
   secret, and the backup key. Without the backup key, backups cannot be opened.
5. **Put your other apps back** (clipx-app, clipx-bot, desk). Copy the archive up, look first, then restore:

```bash
scp ~/Desktop/rebuild-srv*.tgz.enc root@SRV_IP:/root/
sudo bash /opt/neural-alpha/saas/infra/restore-apps.sh /root/rebuild-srv*.tgz.enc            # a dry run: changes nothing
sudo bash /opt/neural-alpha/saas/infra/restore-apps.sh /root/rebuild-srv*.tgz.enc --apply --install --certs --nginx --start
```

   Apps you had stopped on purpose stay stopped. Apps that took settings from pm2's own environment (not from a
   `.env` file) need them added again; the old values are in the archive under `pm2/jlist.json`.
6. **Check the main server:**

```bash
pm2 ls                         # neural-saas-edge, neural-portal, and your old apps online
nginx -t && curl -sI https://YOUR.DOMAIN/portal | head -1
ufw status                     # 22, 80, 443 and 51820/udp only
```

## C. Rebuild the customer server (`vim…`)

1. Re-install Ubuntu 24.04 with your SSH key.
2. **Let the cell reach the main server over SSH** (it uses this to register itself). On the new cell:

```bash
ssh-keygen -t ed25519 -N '' -f /root/.ssh/id_ed25519 && cat /root/.ssh/id_ed25519.pub
```

   Paste that line into `/root/.ssh/authorized_keys` **on the main server**, then check `ssh root@SRV_IP true` works from the cell.
3. Copy the repo up as in B3 (to `/opt/neural-alpha` on the cell), then:

```bash
sudo bash /opt/neural-alpha/saas/infra/bootstrap.sh --role cell --skip-code \
  --ssh-key "ssh-ed25519 AAAA... you@mac" -- \
  --secret <control secret from step B4> --treasury 0xYourFeeWallet \
  --mother-ssh root@SRV_IP --wireguard \
  --telegram-token <bot token> --telegram-username <BotUsername> --telegram-ops-chat <your chat id>
```

   It prints the cell's backup key if you did not give one: **save it**.
4. **Put your other apps back** (ponsla-web, cashpot-api): copy up the vim archive, then
   `restore-apps.sh <archive> --apply --install --certs --nginx --start --volumes --compose`.
5. **Check:** on the main server, `bash /opt/neural-alpha/saas/link-vps.sh status --secret <control secret>` lists the
   cell with 20 free seats. On the cell, `ufw status` shows port 3910 reachable only over the private tunnel.

## D. Prove it works before you trust it

1. Open `https://YOUR.DOMAIN/portal`, buy an agent (a small real payment, or the sandbox).
2. In Settings link Telegram, link a browser wallet, switch the signal sources.
3. Pair the Binance wallet and leave the agent in **paper** mode for a day.
4. Test the alarm: `pm2 stop neural-portal`, run `node /opt/neural-alpha/saas/infra/hostwatch.mjs`, expect a message in
   your ops chat; then `pm2 start neural-portal`.
5. Run one backup by hand: `curl -X POST -H "Authorization: Bearer <control secret>" http://127.0.0.1:3910/backups/run`.

## If something goes wrong

* **Before you wipe**, nothing is changed: the inventory only reads. If the archive does not check out, stop there.
* **After you wipe**, the undo is your provider snapshot, or restoring from the archive with `restore-apps.sh`.
* `bootstrap.sh` can be run again safely. `--dry-run` prints every step without doing it.
* Lost the SSH connection after hardening? Use your provider's web console. Password login is only switched off
  when a key is already in `authorized_keys`, so this should not happen if you passed `--ssh-key`.

## What was tested, and what was not

Tested in a clean Ubuntu container, with real tools, in one scripted rehearsal: build a fake old server with three
pm2 apps (one stopped on purpose), nginx, a certificate, and a wallet login, run the inventory, wipe it, run the
bootstrap twice, then restore. Everything came back, the stopped app stayed stopped, the new portal site was left
alone, and `nginx -t` passed. Also tested for real: the customer container limits (Docker stopped a memory hog),
the PM2 file starting a control server, the watchdog's alert rules, and every script's input checks. 106 automated tests pass.

**Not tested** (a container has no real firewall, systemd, DNS or provider):

* Re-imaging at your provider, real DNS, and a real Let's Encrypt certificate (certbot is only prepared and dry-run).
* `ufw`, `fail2ban`, the SSH hardening and swap steps (skipped in the container; the logic is guarded, not exercised).
* Installing Docker and the WireGuard link from `bootstrap.sh --role cell` on a real server (the pieces were tested earlier).
* Restoring Docker volumes and compose projects (no Docker inside the container).
* The Next.js portal build on the new server (it builds here, but not on that machine).
