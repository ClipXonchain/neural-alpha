import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../../.env") });

import { initAgentStore } from "../src/db/store.js";

async function main() {
  const store = await initAgentStore();
  console.log("DB enabled:", store.enabled);
  if (!store.enabled) {
    console.log("Set DATABASE_URL in .env and retry.");
    process.exit(1);
  }
  const nav = await store.loadNavState();
  const trades = await store.loadRecentTrades(5);
  console.log("Nav state:", nav ?? "(empty — first run)");
  console.log("Recent trades in DB:", trades.length);
  console.log("OK — Neon connection working.");
}

main().catch((err) => {
  console.error("DB test failed:", err);
  process.exit(1);
});
