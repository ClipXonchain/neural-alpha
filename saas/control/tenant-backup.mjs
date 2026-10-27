import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { runCommand } from "./docker.mjs";

/**
 * Encrypted copies of each customer's data folder (the Binance wallet login in
 * home/, the trade book, the container env).
 *
 * The wallet login is the one thing a lost disk cannot get back, so it is
 * encrypted here with AES-256-GCM before it goes anywhere. The key lives on the
 * cell (SAAS_BACKUP_KEY) and with you. The machine that stores the copies holds
 * only ciphertext. File: "NABK1" + 12-byte IV + ciphertext + 16-byte GCM tag.
 */
const MAGIC = Buffer.from("NABK1");
const HEADER = MAGIC.length + 12;
const TAG = 16;
const SUFFIX = ".tar.gz.enc";

export function parseBackupKey(hex) {
  const value = String(hex || "").trim();
  return /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, "hex") : null;
}

export async function backupDir({ dataDir, file, key }) {
  if (!existsSync(dataDir)) throw new Error(`${dataDir} does not exist`);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const tar = spawn("tar", ["-czf", "-", "-C", dataDir, "."], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  tar.stderr.on("data", (c) => (stderr += c));
  const exited = new Promise((resolve, reject) => {
    tar.on("error", reject);
    tar.on("close", resolve);
  });
  const out = createWriteStream(file, { mode: 0o600 });
  out.write(Buffer.concat([MAGIC, iv]));
  const written = new Promise((resolve, reject) => {
    out.on("error", reject);
    cipher.on("error", reject);
    cipher.on("end", () => out.end(cipher.getAuthTag(), resolve));
  });
  cipher.pipe(out, { end: false });
  tar.stdout.pipe(cipher);
  try {
    const [code] = await Promise.all([exited, written]);
    // tar exits 1 when a file changed while it was being read; the agent is live, so that is normal.
    if (code > 1) throw new Error(stderr.trim() || `tar exited ${code}`);
  } catch (err) {
    rmSync(file, { force: true });
    throw err;
  }
  return file;
}

export async function restoreDir({ file, key, destDir }) {
  const size = statSync(file).size;
  if (size < HEADER + TAG) throw new Error("backup file is too short");
  const fd = openSync(file, "r");
  const head = Buffer.alloc(HEADER);
  const tag = Buffer.alloc(TAG);
  try {
    readSync(fd, head, 0, HEADER, 0);
    readSync(fd, tag, 0, TAG, size - TAG);
  } finally {
    closeSync(fd);
  }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a Neural Alpha backup");
  if (existsSync(destDir) && readdirSync(destDir).length > 0) throw new Error(`${destDir} is not empty`);

  const staging = `${destDir}.restoring`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const decipher = createDecipheriv("aes-256-gcm", key, head.subarray(MAGIC.length));
  decipher.setAuthTag(tag);
  const tar = spawn("tar", ["-xzf", "-", "-C", staging], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  tar.stderr.on("data", (c) => (stderr += c));
  try {
    await new Promise((resolve, reject) => {
      tar.on("error", reject);
      tar.stdin.on("error", () => {});
      decipher.on("error", (e) => {
        tar.kill();
        reject(new Error(`backup did not verify (wrong key or damaged file): ${e.message}`));
      });
      tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `tar exited ${code}`))));
      createReadStream(file, { start: HEADER, end: size - TAG - 1 }).pipe(decipher).pipe(tar.stdin);
    });
    mkdirSync(dirname(destDir), { recursive: true });
    rmSync(destDir, { recursive: true, force: true });
    renameSync(staging, destDir);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  return destDir;
}

export function pruneBackups(outDir, id, keep) {
  const files = readdirSync(outDir).filter((f) => f.startsWith(`${id}-`) && f.endsWith(SUFFIX)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(outDir, old), { force: true });
}

export async function backupAll({ rows, outDir, key, now = new Date(), keep = 7 }) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const ok = [];
  const failed = [];
  for (const row of rows) {
    try {
      ok.push(await backupDir({ dataDir: row.data_dir, file: join(outDir, `${row.id}-${stamp}${SUFFIX}`), key }));
      pruneBackups(outDir, row.id, keep);
    } catch (err) {
      failed.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { ok, failed };
}

/** user@host:/path only. A leading dash would let a config typo become an rsync flag. */
export const RSYNC_TARGET_RE = /^[\w.@-]+:[\w./~-]+$/;

export async function syncOffsite({ outDir, target, run = runCommand }) {
  if (!RSYNC_TARGET_RE.test(target || "")) throw new Error("SAAS_BACKUP_RSYNC must look like user@host:/path");
  await run("rsync", ["-a", "--partial", "-e", "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new", `${outDir}/`, `${target.replace(/\/?$/, "/")}`], {
    timeoutMs: 600_000,
  });
}

// node saas/control/tenant-backup.mjs restore <file> <destDir>   (key from SAAS_BACKUP_KEY)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, file, dest] = process.argv.slice(2);
  const key = parseBackupKey(process.env.SAAS_BACKUP_KEY);
  if (cmd !== "restore" || !file || !dest || !key) {
    console.error("usage: SAAS_BACKUP_KEY=<64 hex> node saas/control/tenant-backup.mjs restore <file.tar.gz.enc> <empty-dest-dir>");
    process.exit(2);
  }
  restoreDir({ file, key, destDir: dest }).then(
    () => console.log(`restored into ${dest}`),
    (err) => {
      console.error(`restore failed: ${err.message}`);
      process.exit(1);
    },
  );
}
