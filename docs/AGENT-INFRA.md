# Neural Alpha — Agent Infrastructure

Professional multi-tenant control plane for one-click agent deploy and ~100 concurrent traders on a single VPS.

## Mental model

```
┌──────────────────────────────────────────────────────────────┐
│  PLATFORM (one secrets file, one Postgres, one market feed)  │
├──────────────────────────────────────────────────────────────┤
│  Supervisor = babysitter (starts/stops/watchdog)  :4200      │
│  Dashboard  = product UI + auth gateway           :3000      │
│  Market feed = shared quotes                      :4100      │
├──────────────────────────────────────────────────────────────┤
│  AGENT (per user deploy) = trader brain + wallet + API       │
│    • own PM2 process (neural-agent-{uuid})                   │
│    • own port (4000–5099)                                    │
│    • own encrypted keystore                                  │
│    • own API secret (derived from WALLET_MASTER_SECRET)      │
│    • shared market data (read-only)                          │
└──────────────────────────────────────────────────────────────┘
```

## Process model

| App | Port | Role |
|-----|------|------|
| `neural-market-feed` | 4100 | Shared CMC/Binance snapshot |
| `neural-supervisor` | 4200 | Lifecycle API + 30s reconcile |
| `neural-dashboard` | 3000 | SIWE UI + owner-gated proxy |
| `neural-agent-{uuid}` | 4000+ | Per-tenant trader |

**No singleton agent** when `DATABASE_URL` is set (`DISABLE_SINGLETON_AGENT` auto-true in ecosystem).

**Launcher:** PM2 preferred; native Node `detached` spawn fallback (macOS-safe). **No `setsid`.**

## Supervisor API (`127.0.0.1:4200`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness |
| GET | `/v1/agents` | Fleet summary |
| GET | `/v1/agents/:id/runtime` | Live port/pid/health |
| POST | `/v1/agents/:id/start` | Spawn + wait healthy |
| POST | `/v1/agents/:id/stop` | SIGTERM / PM2 delete |
| POST | `/v1/agents/:id/restart` | Stop then start |
| POST | `/v1/reconcile` | Respawn expected-running agents |

Auth: `Authorization: Bearer $SUPERVISOR_SECRET` (optional in dev; **required** when `NODE_ENV=production`).

## Isolation

- Proxy path **must** include agent UUID; owner SIWE checked on mutations
- Per-agent bearer secret; never inject another agent's secret
- Ports resolved from Supervisor registry → disk `api-port` → DB
- Singleton `/api/agent/*` proxy disabled when `DATABASE_URL` is set
- `WALLET_MASTER_SECRET` never written to per-agent `.env`; never sent over Supervisor HTTP

## UI semantics

| UI action | Meaning |
|-----------|---------|
| **Start agent process** | OS process up (Supervisor start) |
| **Start trading** | In-process autonomous loop (`/api/control/start`) |
| **Pause trading** | Loop off; process stays up (`/api/control/stop`) |
| **Stop / archive** | Kill process via Supervisor |

## Scaling (~100 agents)

- Staggered starts: max 5 parallel (`SUPERVISOR_MAX_PARALLEL_STARTS`)
- PM2 `max_memory_restart` default `256M` per agent
- Shared market feed (1 CMC poll for the fleet)
- Neon pooler for DB; agent-side pools stay small
- Recommended VPS: 32 GB RAM / 8 vCPU

## Local dev

```bash
npm install
# .env: DATABASE_URL, WALLET_MASTER_SECRET, SESSION_SECRET, CMC + Binance keys
# DISABLE_SINGLETON_AGENT=true
# SUPERVISOR_URL=http://127.0.0.1:4200
npm run dev:all   # feed + supervisor + dashboard
```

Then deploy/start agents from the web UI.

## Production

```bash
bash deploy/setup.sh
# PM2: neural-market-feed, neural-supervisor, neural-dashboard
```
