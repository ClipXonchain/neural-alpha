# SaaS branch

Hosted Neural Alpha lives on this branch. Customers sign in, confirm one Binance pairing code, and fund their own Agentic Wallet.

`agentic-wallet` is the VPS deploy (`agents.clipx.app`, PM2, Nginx). This branch does not change that. Do not merge product work onto `agentic-wallet` or `hackathon` until you mean to.

The worker image clones `agentic-wallet` at build time and starts it unchanged. The agent API stays on `127.0.0.1:3847`. `worker/bridge.mjs` shares that network namespace and listens on `3848` for the control plane.

Each tenant volume holds:

- `/data/home/.baw` — that customer's Agentic Wallet session
- `/data/book` — trade state (symlinked over the upstream `data/` directory)
- `/data/tenant.env` — copied to the upstream `.env` on start, because that process loads `.env` with override

## Run one paper tenant

From the repo root, on this branch:

```bash
docker compose -f saas/worker/compose.yaml up --build
```

The example publishes the bridge on `127.0.0.1:3848` only. `AGENT_MODE=paper` does not broadcast.

To build against another upstream ref:

```bash
docker compose -f saas/worker/compose.yaml build --build-arg UPSTREAM_REF=hackathon
```
