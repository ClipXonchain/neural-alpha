import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backupAll, backupDir, parseBackupKey, restoreDir, syncOffsite } from "./tenant-backup.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "na-bk-"));
function tenantFolder() {
  const dir = tmp();
  mkdirSync(join(dir, "home", ".baw"), { recursive: true });
  mkdirSync(join(dir, "book"), { recursive: true });
  writeFileSync(join(dir, "home", ".baw", "session.json"), '{"token":"wallet-login-secret"}');
  writeFileSync(join(dir, "book", "neural-alpha.sqlite"), randomBytes(5000));
  writeFileSync(join(dir, "tenant.env"), "AGENT_MODE=live\n");
  return dir;
}
const key = randomBytes(32);

test("a backup restores byte for byte and the file holds no readable secret", async () => {
  const src = tenantFolder();
  const file = join(tmp(), "t.tar.gz.enc");
  await backupDir({ dataDir: src, file, key });
  assert.equal(readFileSync(file).includes("wallet-login-secret"), false);
  const dest = join(tmp(), "restored");
  await restoreDir({ file, key, destDir: dest });
  assert.equal(readFileSync(join(dest, "home/.baw/session.json"), "utf8"), '{"token":"wallet-login-secret"}');
  assert.deepEqual(readFileSync(join(dest, "book/neural-alpha.sqlite")), readFileSync(join(src, "book/neural-alpha.sqlite")));
  assert.equal(readFileSync(join(dest, "tenant.env"), "utf8"), "AGENT_MODE=live\n");
});

test("the wrong key, or a damaged file, restores nothing", async () => {
  const src = tenantFolder();
  const file = join(tmp(), "t.tar.gz.enc");
  await backupDir({ dataDir: src, file, key });

  const wrong = join(tmp(), "wrong");
  await assert.rejects(restoreDir({ file, key: randomBytes(32), destDir: wrong }), /did not verify/);
  assert.equal(existsSync(wrong), false);
  assert.equal(existsSync(`${wrong}.restoring`), false);

  const bytes = readFileSync(file);
  bytes[bytes.length - 40] ^= 0xff;
  const bad = join(tmp(), "bad.tar.gz.enc");
  writeFileSync(bad, bytes);
  const dest = join(tmp(), "damaged");
  await assert.rejects(restoreDir({ file: bad, key, destDir: dest }));
  assert.equal(existsSync(dest), false);
});

test("restore refuses a folder that already has files", async () => {
  const file = join(tmp(), "t.tar.gz.enc");
  await backupDir({ dataDir: tenantFolder(), file, key });
  const dest = tmp();
  writeFileSync(join(dest, "keep.txt"), "x");
  await assert.rejects(restoreDir({ file, key, destDir: dest }), /not empty/);
  assert.equal(readFileSync(join(dest, "keep.txt"), "utf8"), "x");
});

test("backupAll keeps the newest copies per tenant and reports a missing folder without stopping", async () => {
  const out = tmp();
  const rows = [{ id: "aaaa1111", data_dir: tenantFolder() }, { id: "bbbb2222", data_dir: join(tmp(), "gone") }];
  for (let i = 1; i <= 4; i++) {
    const r = await backupAll({ rows, outDir: out, key, keep: 2, now: new Date(Date.UTC(2026, 10, i)) });
    assert.equal(r.ok.length, 1);
    assert.equal(r.failed[0].id, "bbbb2222");
  }
  const left = readdirSync(out).filter((f) => f.startsWith("aaaa1111-")).sort();
  assert.deepEqual(left.map((f) => f.slice(9, 17)), ["20261103", "20261104"]);
  assert.equal(readdirSync(out).some((f) => f.startsWith("bbbb2222-")), false);
});

test("key and rsync target are validated", async () => {
  assert.equal(parseBackupKey("abc"), null);
  assert.equal(parseBackupKey("ab".repeat(32)).length, 32);
  await assert.rejects(syncOffsite({ outDir: "/x", target: "--rsh=evil:/y", run: async () => {} }), /user@host/);
  await assert.rejects(syncOffsite({ outDir: "/x", target: "no-colon", run: async () => {} }), /user@host/);
  let args;
  await syncOffsite({ outDir: "/b", target: "bk@mother:/var/na", run: async (cmd, a) => { args = [cmd, a]; } });
  assert.equal(args[0], "rsync");
  assert.equal(args[1].at(-1), "bk@mother:/var/na/");
});
