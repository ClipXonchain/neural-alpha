# SaaS payment and host plan

The software fee and the trading money are two different transfers. The fee is paid to a company wallet on BSC. The money the agent trades with stays in the customer’s own Binance Agentic Wallet. A container is created only after the fee transfer is confirmed on chain.

When `SAAS_TREASURY_ADDRESS` is configured, `POST /checkout` creates a 10-minute locked payment quote. Stablecoins use a 3-digit unique marker (for example, `15.184` USDT) so the amount is exactly three decimal places. BNB quotes convert the $15 fee at the official Binance `BNBUSDT` price and put that same 3-digit marker on the live equivalent. `SAAS_BNB_PRICE_USD` is only the fallback until that price arrives. The background BSC watcher starts with the control server and scans every 15 seconds. It verifies matching transfers before provisioning. The portal polls the open order and advances when the watcher marks it paid. That exact-amount match does not ask for a wallet signature. A transfer mined before the quote expires may finish its 15-block confirmation period during a 15-minute settlement grace window.

## Receiving wallet

Use one BSC address as the fee wallet, chain id 56. Put only the public address in `SAAS_TREASURY_ADDRESS` on every cell. The private key stays off the customer machines, on a machine you control. When the balance grows, sweep it to a cold address. Customers never send trading funds there.

Pin one contract per asset in config: USDT, USDC, BNB, U, and USD1. BNB is the native coin. The others are BEP-20 transfers. BSC USDT and USDC use 18 decimals, so the amount check has to use those units.

## How a payment gets verified

1. The customer picks the asset and the size preset. The server writes an unpaid order: asset, exact amount, price, and a 10-minute expiry. No folder and no container yet.
2. The pay screen shows the treasury address (including a QR of that address), the asset, and the exact amount. For a stablecoin the price is the software price plus a 3-digit marker, for example `15.184` USDT. For BNB the amount is the same dollar fee at the current Binance BNBUSDT price, plus a 3-digit marker, quoted at checkout and locked for those 10 minutes. Simultaneous payments are matched on that exact amount.
3. They send that transfer from Binance or any BSC wallet before the quote expires.
4. The cell's automatically started watcher reads incoming transfers to the treasury. The portal keeps the payment screen open, polls the order, and opens it after the watcher provisions it. The receipt must pass all of these:
   - status is success
   - the RPC reports BNB Smart Chain chain id `56`
   - the token matches the order
   - the configured BEP-20 token reports 18 decimals
   - the receiver is the treasury
   - the amount equals the quote exactly
   - the transaction was mined after the quote was created and no later than its expiry
   - the receipt and transaction agree on block/hash and that block is canonical
   - the block has at least 15 confirmations
   - that hash is not already stored
5. Only then does the cell create the customer: one folder, one container named `na-` plus 8 characters, one access token, paper mode, and `PAYMENT_TOKEN` set to the asset they paid with. That token is what the agent spends inside their wallet. It is not the fee.

If the receipt fails, the order stays unpaid and nothing is provisioned. Underpayments and overpayments do not qualify for automatic activation; overpayments need manual review. The fee does not buy trading capital. After the container exists they confirm one Binance pairing code, then send trading funds into that Agentic Wallet and keep some BNB there for gas.

## Binance Pay status

The portal shows Binance Pay as coming soon. It can be added once the merchant account and server-side credentials are approved. Binance Pay's native flow is merchant-created orders that return a hosted checkout, QR code, or deeplink; the buyer pays in Binance Pay and the merchant receives the funds. The backend should bind the provider order to the existing checkout id, accept only a valid signed webhook, then confirm the provider order status and exact amount before calling the same one-time fulfillment path. Do not treat a browser redirect as proof of payment. Keep Binance Pay API credentials on the server and verify webhook signatures using Binance's documented RSA/SHA256 procedure.

References: [Binance Pay native APIs](https://merchant.binance.com/en/docs/functionalities/single-payment/native-apis), [Binance Pay webhooks](https://merchant.binance.com/en/docs/functionalities/webhooks), and [Binance Pay API common rules](https://developers.binance.com/en/docs/products/binance-pay-merchant/api-common).

## How the VPS machines are used

Each customer cell is one VPS running the `SaaS` branch. A 16 GB cell, with 512 MB reserved per customer and 30% of RAM held back, holds 20 customers. The whole machine shares 60 upstream calls a minute, so a full cell cycles about every 7 minutes. Adding a person does not make the others poll faster. One container is one Binance session. Do not put several customers inside one process.

The VPS that already runs your own bot stays on `agentic-wallet`. It is not a customer cell.

A small edge machine is the public site. It does not run containers. It asks each cell for free seats and sends the new customer to a cell that still has room and is inside the call budget. That customer stays on that cell. The edge remembers the host id and the customer id so the portal knows where to look.

A second VPS is a new cell: new `SAAS_HOST_ID`, its own disk, its own database, the same treasury address. Register it with the edge. New signups land there when the first cell is full. People already running on the first cell stay there.

If a cell dies, the trading funds are still in Binance. Restore that cell’s `SAAS_DATA_ROOT`. If the replacement machine has a new host id, adopt the rows with `POST /recovery/adopt` and `{"confirm":"adopt-this-host"}`, then start the containers again. The Binance login does not come with the disk copy, so each customer confirms a pairing code again. A Neon copy of the trade book is a backup of the history, not of that login.

## Implemented modules & endpoints

1. **Treasury address, pinned BSC contracts, and pricing config** (`saas/control/policy.mjs`, `saas/control/server.mjs`):
   - `SAAS_TREASURY_ADDRESS`, `SAAS_PRICE_USD` (default `15`), `SAAS_BNB_PRICE_USD` (fallback `600`, replaced by the Binance BNBUSDT price every 4 hours), `SAAS_MIN_CONFIRMATIONS` (default `15`), `SAAS_BSC_RPC_URL`.
   - Pinned BSC contracts (18 decimals): `USDT`, `USDC`, `U`, `USD1`, plus native `BNB`.
2. **Unpaid checkout orders** (`POST /checkout`, `GET /checkout/:id`):
   - Writes an unpaid row in `orders` with a 3-digit unique payment marker and 10-minute expiry. `POST /tenants` refuses an unverified hash whenever `SAAS_TREASURY_ADDRESS` is configured.
3. **BSC receipt verifier & treasury watcher** (`saas/control/payments.mjs`, `POST /checkout/:id/verify`, `POST /watcher/scan`, `POST /checkout/:id/claim`):
   - Starts automatically with the control service and scans every 15 seconds. Its last safe block is saved in SQLite so a process restart resumes the scan; a new database with pending orders looks back about 45 minutes. Verifies chain id `56`, receipt success, canonical block references, 15 confirmations, exact token contract and treasury destination, exact 18-decimal amount, quote time window, one payer address, and unused transaction hash. Unmatched values stay unpaid; a browser can claim the one-time access token after the watcher marks the order paid.
4. **Multi-VPS Edge Router & Cell Linker** (`saas/control/edge.mjs`, `saas/link-vps.sh`, `POST /cluster/nodes`, `GET /cluster/capacity`):
   - Polls `/capacity` across linked cells, routes new checkouts to a cell with free seats and call budget, and issues a compound token (`<hostId>.<tenantId>.<accessToken>`) so requests automatically route to the customer's pinned cell.
5. **Dedicated Customer Portal & Dashboard** (`GET /portal` redirects to the Next.js portal, `GET /tenants/:id/state`):
   - Self-serve checkout, Binance Agentic Wallet pairing (`pair/start` & `pair/verify`), mode/preset controls, and live per-container portfolio/FIFO PnL telemetry.
6. **Subscription expiry (`paid_until`)** (`POST /subscriptions/sweep`):
   - Each verified payment grants 30 days (`paid_until`). When lapsed, `buys_halted = 1` writes `DISABLE_NEW_BUYS=true` and `MAX_POSITION_SIZE_USD=0` to stop new buys while leaving existing positions untouched.

The admin desk lives in the dashboard at `/admin`. The control process redirects `/admin` there and keeps the read-only APIs. It shows the fee hash, the asset, and the BscScan link. It does not move the treasury key and it does not start a customer by hand.

## Easiest 2-step process to link a Customer Host VPS with `neuralalpha.io`

```bash
# Step 1 — Run on the Customer Host VPS (on branch `SaaS`):
bash saas/link-vps.sh init-cell \
  --host-id cell-01 \
  --treasury 0xYourTreasuryBscAddress \
  --secret YOUR_CONTROL_API_SECRET \
  --monitor-secret YOUR_MONITOR_SECRET

# Step 2 — Run on neuralalpha.io (Edge) to link the new VPS cell:
bash saas/link-vps.sh join-edge \
  --host-id cell-01 \
  --cell-url http://CELL_VPS_IP:3910 \
  --secret YOUR_CONTROL_API_SECRET

# Inspect all linked VPS cells & free seats:
bash saas/link-vps.sh status --secret YOUR_CONTROL_API_SECRET
```

## Reference numbers

| Item | Value |
| --- | --- |
| Chain | BSC, chain id 56 |
| Confirmations before provision | 15 blocks |
| Customers per 16 GB cell | 20 |
| RAM per customer | 512 MB, plus 30% of host RAM held back |
| Upstream call budget | 60 per minute for the whole cell |
| Cycle when the cell is full | about 7 minutes |
| Checkout expiry | 30 minutes |
| Container name | `na-` plus 8 hex characters |
| Founder bot branch | `agentic-wallet` (not a customer cell) |
| Customer cell branch | `SaaS` |
