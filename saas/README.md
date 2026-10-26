# SaaS branch

Hosted Neural Alpha. One backend on each server starts a private container per customer, keeps Binance and CMC calls inside a shared budget, and writes the risk cap into that container.

`agentic-wallet` stays the VPS deploy. This branch does not change it. The customer container clones that ref and runs it unchanged.

## What the backend owns

`saas/control/server.mjs` is the only way to start a customer.

- The container name is `na-` plus an 8 character id. The project name and the folder are that same id. Two customers cannot receive the same folder.
- The trade loop is sized for a full server. On a 16 GB host the default is 20 customers and one cycle about every 7 minutes, which stays near 60 upstream calls a minute. Signing another customer up does not make the others poll faster.
- A risk preset caps each automatic buy: cautious $50, normal $100, active $250. In closed/overnight sessions a smaller per-order cap applies ($15/$25/$40). This is not a portfolio balance or loss limit. A position may grow above its entry cap, and full sells remain allowed.
- A customer pays in USDT, USDC, BNB, U, or USD1. Creating a customer requires that asset and a transaction hash. The same hash cannot start a second customer. The trading balance they send into the Agentic Wallet is separate from this fee.
- The control service starts a BSC treasury watcher automatically and scans about every 15 seconds. It provisions only after a successful BSC receipt has at least 15 confirmations, the configured token contract and treasury match, and the amount equals the quote exactly. A transfer mined before quote expiry gets a 15-minute confirmation grace period. Customers can still paste a transaction hash if automatic matching has not completed.
- Each customer gets their own access token. That token opens only their id. A token for someone else gets the same answer as a missing customer. Customer containers do not share a Docker network, and each one has its own API secret.
- The control API listens on `127.0.0.1:3910`. Create is limited to 10 calls a minute. Everything else is 120 a minute.
- The admin desk is `http://127.0.0.1:3910/admin`. It uses `SAAS_MONITOR_SECRET`, which can only read. The page has no pause, trade, pair, or size controls. Put the monitor key in the browser. Keep `CONTROL_API_SECRET` off that page.
- A stopped container is not started again by a reboot. A running one is.

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
