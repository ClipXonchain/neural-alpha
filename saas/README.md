# SaaS branch

Hosted Neural Alpha. One backend on each server starts a private container per customer, keeps Binance and CMC calls inside a shared budget, and writes the risk cap into that container.

This branch is self-contained: agent, control plane, portal, admin desk and VPS linking all live here. The customer image is built from this checkout (`saas/worker/Dockerfile`, repo-root build context), not cloned from another branch. `agentic-wallet` is untouched and still the founder-bot deploy.

## Add a VPS in one command

On the new server (Ubuntu/Debian), with the mother's `CONTROL_API_SECRET`:

```bash
git clone -b SaaS https://github.com/ClipXonchain/neural-alpha.git && cd neural-alpha
sudo bash saas/join-mother.sh --secret <mother secret> --treasury 0xTreasury \
  --mother-ssh root@MOTHER_IP --mother-ip MOTHER_IP
```

It installs Docker, Node 22 and PM2 if missing, builds the worker image, starts the cell (`cell-<hostname>`), limits port 3910 to the mother with ufw, waits for `/capacity`, then registers the cell through `POST /cluster/nodes` on the mother. Use `--mother-url` instead of `--mother-ssh` if the mother's control port is reachable. Check with `bash saas/link-vps.sh status --secret <secret>` on the mother.

## What the backend owns

`saas/control/server.mjs` is the only way to start a customer.

- The container name is `na-` plus an 8 character id. The project name and the folder are that same id. Two customers cannot receive the same folder.
- The trade loop is sized for a full server. On a 16 GB host the default is 20 customers and one cycle about every 7 minutes, which stays near 60 upstream calls a minute. Signing another customer up does not make the others poll faster.
- A risk preset caps each automatic buy: cautious $50, normal $100, active $250. In closed/overnight sessions a smaller per-order cap applies ($15/$25/$40). This is not a portfolio balance or loss limit. A position may grow above its entry cap, and full sells remain allowed.
- A customer pays in USDT, USDC, BNB, U, or USD1. Creating a customer requires that asset and a transaction hash. The same hash cannot start a second customer. The trading balance they send into the Agentic Wallet is separate from this fee.
- The control service starts a BSC treasury watcher automatically and scans about every 15 seconds. It provisions only after a successful BSC receipt has at least 15 confirmations, the configured token contract and treasury match, and the amount equals the quote exactly. A transfer mined before quote expiry gets a 15-minute confirmation grace period. Customers can still paste a transaction hash if automatic matching has not completed.
- Each customer gets their own access token. That token opens only their id. A token for someone else gets the same answer as a missing customer. Customer containers do not share a Docker network, and each one has its own API secret.
- The control API listens on `127.0.0.1:3910`. Create is limited to 10 calls a minute. Everything else is 120 a minute.
- The admin desk is the dashboard at `/admin` (`http://127.0.0.1:3000/admin` locally). It uses `SAAS_MONITOR_SECRET`, which can only read. The page has no pause, trade, pair, or size controls. Put the monitor key in the browser. Keep `CONTROL_API_SECRET` off that page. The control process keeps the read APIs and redirects `/admin` to that dashboard.
- A stopped container is not started again by a reboot. A running one is.
- Paid signals are per customer. `POST /tenants/:id/signals` with `{"cmc":false}` or `{"studio":true}` (or the portal Settings switches) rewrites `CMC_X402_ENABLED` / `STUDIO_X402_ENABLED` and restarts that one container. Both default on. Calls are paid from the customer's own Agentic Wallet through `baw x402-payment`; there is no CMC API key.

## Run the backend

From the repo root, on this branch:

```bash
node saas/control/server.mjs
```

`CONTROL_API_SECRET` operates the API. `SAAS_MONITOR_SECRET` is the read-only admin desk. `SAAS_HOST_ID` names the server. `SAAS_DATA_ROOT` is the folder of customer directories. `TENANT_DATABASE_URL` is copied into each container so the trade book also lands in Neon.

```bash
curl -s -H "Authorization: Bearer $SAAS_MONITOR_SECRET" http://127.0.0.1:3910/admin/overview
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"paymentAsset":"USDT","paymentTx":"0xabc...64 hex chars"}' \
  http://127.0.0.1:3910/tenants
```

Paper mode is the start. After `pair/start` and `pair/verify`, `mode` can be set to `live`.

## Another VPS

Customer funds stay in Binance. Copy `SAAS_DATA_ROOT` and start the backend with the same `SAAS_HOST_ID`. If this machine is the replacement, adopt the rows, then resume each customer:

```bash
curl -s -X POST -H "Authorization: Bearer $CONTROL_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"confirm":"adopt-this-host"}' \
  http://127.0.0.1:3910/recovery/adopt
```

`GET /capacity` lists `orphans`: containers named `na-` that have no row. The backend does not attach those to a customer.

If the folder did not survive, the wallet login did not either. That customer pairs again. The USDT is still in their Agentic Wallet.
