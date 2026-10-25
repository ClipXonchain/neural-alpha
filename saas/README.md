# SaaS branch

Hosted Neural Alpha. One backend on each server starts a private container per customer, keeps Binance and CMC calls inside a shared budget, and writes the risk cap into that container.

`agentic-wallet` stays the VPS deploy. This branch does not change it. The customer container clones that ref and runs it unchanged.

## What the backend owns

`saas/control/server.mjs` is the only way to start a customer.

- The container name is `na-` plus an 8 character id. The project name and the folder are that same id. Two customers cannot receive the same folder.
- The trade loop is sized for a full server. On a 16 GB host the default is 20 customers and one cycle about every 7 minutes, which stays near 60 upstream calls a minute. Signing another customer up does not make the others poll faster.
- Risk is one of three presets: cautious, normal, active. The loosest position is $250, and drawdown protection stays on. The backend writes those values into the customer folder. The trading code reads them as it already does.
- The control API listens on `127.0.0.1:3910`. Create is limited to 10 calls a minute. Everything else is 120 a minute.
- A stopped container is not started again by a reboot. A running one is.

## Run the backend

From the repo root, on this branch:

```bash
node saas/control/server.mjs
```

`CONTROL_API_SECRET` is required before this port is reachable by anything except this machine. `SAAS_HOST_ID` names the server. `SAAS_DATA_ROOT` is the folder of customer directories. `TENANT_DATABASE_URL` is copied into each container so the trade book also lands in Neon.

```bash
curl -s -H "Authorization: Bearer $CONTROL_API_SECRET" http://127.0.0.1:3910/capacity
curl -s -X POST -H "Authorization: Bearer $CONTROL_API_SECRET" http://127.0.0.1:3910/tenants
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
