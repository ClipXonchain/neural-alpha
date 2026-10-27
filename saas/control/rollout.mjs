/**
 * Moves customers to a new worker image one at a time.
 *
 * The first customer is the canary: after it comes up (and, optionally, a soak
 * wait) it must still answer before anyone else is touched. Any failure puts
 * that customer back on the previous image and stops. Rolling back later is the
 * same call with the old tag.
 */
export const TAG_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * @param {{ rows: object[], tag: string, apply: (row: object, tag: string) => Promise<void>,
 *           ready: (row: object) => Promise<boolean>, soakMs?: number,
 *           sleep?: (ms: number) => Promise<void>, onProgress?: (done: string[]) => void }} input
 */
export async function rollout({ rows, tag, apply, ready, soakMs = 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onProgress = () => {} }) {
  if (!TAG_RE.test(tag)) throw Object.assign(new Error("tag must be letters, digits, . _ - (max 64)"), { status: 400 });
  const done = [];
  for (const [i, row] of rows.entries()) {
    const previous = row.image_tag || "";
    let ok = false;
    let reason = "did not come back in time";
    try {
      await apply(row, tag);
      ok = await ready(row);
      if (ok && i === 0 && soakMs > 0) {
        await sleep(soakMs);
        ok = await ready(row);
        if (!ok) reason = "stopped answering during the soak wait";
      }
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
    if (!ok) {
      let rolledBack = true;
      try {
        await apply(row, previous);
      } catch {
        rolledBack = false;
      }
      return { ok: false, tag, failed: row.id, reason, rolledBack, done };
    }
    done.push(row.id);
    onProgress([...done]);
  }
  return { ok: true, tag, done };
}
