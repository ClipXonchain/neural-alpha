import { config } from "dotenv";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

for (const p of [
  resolve(repoRoot, ".env.local"),
  resolve(repoRoot, ".env"),
  resolve(process.cwd(), ".env.local"),
  resolve(process.cwd(), ".env"),
]) {
  if (existsSync(p)) {
    config({ path: p, override: false });
  }
}
