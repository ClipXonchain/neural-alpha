import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../../.env") });

import { initAgentStore } from "../src/db/store.js";

async function main() {
  const store = await initAgentStore();
  console.log("SQLite:", store.sqlitePath);
  console.log("SQLite enabled:", store.enabled);
  console.log("Neon backup:", store.backupEnabled);
  if (!store.enabled) {
    console.log("SQLite failed to open. Check SQLITE_PATH and file permissions.");
    process.exit(1);
  }
  const nav = await store.loadNavState();
  const trades = await store.loadRecentTrades(5);
  const entries = await store.loadPositionEntries();
  if (entries && Object.keys(entries).length > 0) {
    await store.savePositionEntries(entries);
  }
  console.log("Nav state:", nav ?? "(empty — first run)");
  console.log("Recent trades in DB:", trades.length);
  console.log("Position entries:", entries && Object.keys(entries).length > 0 ? Object.keys(entries).join(", ") : "(none)");
  console.log(store.backupEnabled ? "OK — SQLite live, Neon backup scheduled." : "OK — SQLite live. DATABASE_URL unset, Neon backup off.");
}

main().catch((err) => {
  console.error("DB test failed:", err);
  process.exit(1);
});
