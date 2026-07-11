#!/usr/bin/env node
/**
 * Clear legacy paper trades / phantom NAV from Neon Postgres.
 *
 * Usage:
 *   npm run db:clear-paper --workspace=neural-alpha
 *   npm run db:clear-paper --workspace=neural-alpha -- --agent-id=35e32777-... --snapshots
 *   npm run db:clear-paper --workspace=neural-alpha -- --dry-run
 *
 * Flags:
 *   --agent-id=<id>   Scope to one agent (default: all agents)
 *   --snapshots       Also delete ALL nav_snapshots for scoped agent(s)
 *   --state           Reset nav_peak + position_entries in agent_state
 *   --dry-run         Print counts only, no deletes
 */
import "../src/load-env.js";
import { Pool } from "@neondatabase/serverless";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const wipeSnapshots = args.includes("--snapshots");
const resetState = args.includes("--state") || wipeSnapshots;
const agentArg = args.find((a) => a.startsWith("--agent-id="));
const agentId = agentArg?.split("=")[1]?.trim() || null;

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const pool = new Pool({ connectionString: url });

function agentClause(column: string, params: unknown[]): string {
  if (!agentId) return "";
  params.push(agentId);
  return ` AND ${column} = $${params.length}`;
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(sql, params);
  return parseInt(rows[0]?.n ?? "0", 10);
}

async function run() {
  console.log("Neural Alpha DB cleanup");
  console.log(`  agent scope: ${agentId ?? "ALL"}`);
  console.log(`  dry run: ${dryRun}`);

  const tradeParams: unknown[] = [];
  const tradeAgent = agentClause("agent_id", tradeParams);
  const paperTradeWhere = `(status = 'paper' OR tx_hash LIKE 'paper-%')${tradeAgent}`;

  const navParams: unknown[] = [];
  const navAgent = agentClause("agent_id", navParams);
  const paperNavWhere = `mode = 'paper'${navAgent}`;

  const phantomParams: unknown[] = [];
  const phantomAgent = agentClause("agent_id", phantomParams);
  const phantomNavWhere = `(total_nav_usd <= 0.01 AND total_pnl_usd <= -49)${phantomAgent}`;

  const nPaperTrades = await count(
    `SELECT COUNT(*)::text AS n FROM trades WHERE ${paperTradeWhere}`,
    tradeParams
  );
  const nPaperNav = await count(
    `SELECT COUNT(*)::text AS n FROM nav_snapshots WHERE ${paperNavWhere}`,
    navParams
  );
  const nPhantomNav = await count(
    `SELECT COUNT(*)::text AS n FROM nav_snapshots WHERE ${phantomNavWhere}`,
    phantomParams
  );

  let nAllSnapshots = 0;
  if (wipeSnapshots) {
    const snapParams: unknown[] = [];
    const snapAgent = agentClause("agent_id", snapParams);
    const snapWhere = snapAgent ? `WHERE 1=1${snapAgent}` : "";
    nAllSnapshots = await count(
      `SELECT COUNT(*)::text AS n FROM nav_snapshots ${snapWhere}`,
      snapParams
    );
  }

  const stateKeys: string[] = [];
  if (resetState) {
    if (agentId) {
      stateKeys.push(`${agentId}:nav_peak`, `${agentId}:position_entries`);
    } else {
      const { rows } = await pool.query<{ key: string }>(
        `SELECT key FROM agent_state
         WHERE key LIKE '%:nav_peak' OR key LIKE '%:position_entries'`
      );
      stateKeys.push(...rows.map((r) => r.key));
    }
  }

  console.log("\nWill remove:");
  console.log(`  paper trades:        ${nPaperTrades}`);
  console.log(`  paper nav snapshots: ${nPaperNav}`);
  console.log(`  phantom nav rows:    ${nPhantomNav} (NAV≈0, PnL≤−49)`);
  if (wipeSnapshots) console.log(`  all nav snapshots:   ${nAllSnapshots}`);
  if (resetState) console.log(`  agent_state keys:    ${stateKeys.length}`);

  if (dryRun) {
    console.log("\nDry run — no changes made.");
    await pool.end();
    return;
  }

  const delTrades = await pool.query(
    `DELETE FROM trades WHERE ${paperTradeWhere} RETURNING order_id`,
    tradeParams
  );
  const delPaperNav = await pool.query(
    `DELETE FROM nav_snapshots WHERE ${paperNavWhere} RETURNING id`,
    navParams
  );
  const delPhantomNav = await pool.query(
    `DELETE FROM nav_snapshots WHERE ${phantomNavWhere} RETURNING id`,
    phantomParams
  );

  let delAllNav = 0;
  if (wipeSnapshots) {
    const snapParams: unknown[] = [];
    const snapAgent = agentClause("agent_id", snapParams);
    const snapWhere = snapAgent ? `WHERE 1=1${snapAgent}` : "";
    const r = await pool.query(`DELETE FROM nav_snapshots ${snapWhere} RETURNING id`, snapParams);
    delAllNav = r.rowCount ?? 0;
  }

  let delState = 0;
  if (resetState && stateKeys.length > 0) {
    const r = await pool.query(
      `DELETE FROM agent_state WHERE key = ANY($1::text[]) RETURNING key`,
      [stateKeys]
    );
    delState = r.rowCount ?? 0;
  }

  console.log("\nDeleted:");
  console.log(`  paper trades:        ${delTrades.rowCount ?? 0}`);
  console.log(`  paper nav snapshots: ${delPaperNav.rowCount ?? 0}`);
  console.log(`  phantom nav rows:    ${delPhantomNav.rowCount ?? 0}`);
  if (wipeSnapshots) console.log(`  all nav snapshots:   ${delAllNav}`);
  if (resetState) console.log(`  agent_state keys:    ${delState}`);

  console.log("\nRestart your agent(s) so NAV rebuilds from the live wallet.");
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
