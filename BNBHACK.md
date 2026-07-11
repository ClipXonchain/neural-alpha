# Legacy: BNB Hack Submission Notes

> **Status:** Archived. This project has evolved into a **public multi-tenant agents platform**.
>
> For current documentation, see:
> - [`README.md`](./README.md) — platform overview
> - [`AGENTS.md`](./AGENTS.md) — AI coding agent instructions
> - [`deploy/DEPLOY.md`](./deploy/DEPLOY.md) — production deployment

---

## What changed since the hackathon build

| Area | Hackathon (2026) | Current platform |
|------|------------------|------------------|
| Execution | Trust Wallet Agent Kit (TWAK) MCP | Self-custodial EVM keystore + Binance Web3 aggregator |
| Deployment | Single agent on VPS | Multi-tenant — users deploy their own agents |
| Auth | API secret only | SIWE wallet login + per-agent API secrets |
| Mode | Paper + live | Live only |
| Market data | Per-agent CMC polls | Shared market feed sidecar |
| Wallet | TWAK CLI / MCP | Encrypted BIP-39 keystore per agent (`data/agents/{id}/`) |
| UI | Single dashboard | Login, deploy, profile, explore, per-agent control |

TWAK-related env vars (`TW_ACCESS_ID`, `TW_HMAC_SECRET`), paper mode, competition registration (`npm run register`, `twak compete register`), and `twak-mcp-bridge.ts` have been **removed**.

---

## Original hackathon context (historical)

Neural Alpha was initially built for **BNB Hack: AI Trading Agent Edition** (CoinMarketCap × Trust Wallet × BNB Chain), Track 1 — autonomous trading agents with self-custody execution and CMC market data.

That submission validated the core signal engine, risk manager, and dashboard UX. The public platform reuses those components under a new execution and tenancy layer.

If you need hackathon-specific scoring criteria or TWAK integration docs, refer to git history before the multi-tenant migration commit.
