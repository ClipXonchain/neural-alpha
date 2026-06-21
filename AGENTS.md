# Agent Instructions



## Quick Reference

- **Project:** Neural Alpha — autonomous BSC trading agent 
- **Data:** CMC Pro API + ClipX news sentiment
- **Execution:** TWAK local wallet (self-custody)
- **Eligible tokens:** 149 BEP-20 tokens listed in `neural-alpha/src/config.ts`
- **Max drawdown:** 25% (enforced in `neural-alpha/src/risk/manager.ts`)
- **Competition contract:** `0x212c61b9b72c95d95bf29cf032f5e5635629aed5` on BSC

## Key Files

| Path | Purpose |
|------|---------|
| `neural-alpha/src/agent.ts` | Core trading loop + MCP bridge interface |
| `neural-alpha/src/config.ts` | Token allowlist, config loading |
| `neural-alpha/src/strategy/` | Signal generation + scoring |
| `neural-alpha/src/risk/manager.ts` | Risk guardrails (drawdown, limits) |
| `neural-alpha/src/execution/executor.ts` | TWAK swap builder |
| `dashboard/` | Next.js live monitoring UI |

