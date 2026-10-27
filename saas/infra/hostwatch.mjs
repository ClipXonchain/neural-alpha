#!/usr/bin/env node
/**
 * Watches the server itself, every 5 minutes (cron). Tells the ops Telegram chat once when something
 * goes wrong and once when it recovers. It would have caught: a container pinned at 100% CPU, a
 * process growing toward the whole RAM, a full disk, a Neural Alpha app that is down.
 *
 * Only apps whose name starts with HOSTWATCH_PM2 (default "neural-") are watched, so an app you
 * stopped on purpose (clipx-bot, say) never alerts.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const LIMITS = { diskOpen: 85, diskClear: 80, memAvailMinPct: 10, containerCpu: 90, containerCpuChecks: 3, restartStorm: 5 };

/**
 * @param {{ diskPct: number, memAvailPct: number, pm2: {name: string, status: string, restarts: number}[],
 *           containers: {name: string, cpu: number, state: string}[] }} m
 * @param {{ open?: Record<string, number>, hot?: Record<string, number>, restarts?: Record<string, number> }} prev
 */
export function evaluate(m, prev = {}, now = Date.now(), prefix = "neural-") {
  const open = { ...(prev.open || {}) };
  const hot = {};
  const restarts = {};
  const events = [];
  const set = (key, on, text) => {
    if (on && !open[key]) {
      open[key] = now;
      events.push({ type: "open", key, text });
    } else if (!on && open[key]) {
      delete open[key];
      events.push({ type: "resolved", key, text: `recovered: ${key}` });
    }
  };

  // Disk has a gap between "open" and "clear" so it does not flap around the line.
  set("disk", m.diskPct >= LIMITS.diskOpen || (open.disk && m.diskPct >= LIMITS.diskClear), `disk is ${m.diskPct}% full`);
  set("memory", m.memAvailPct < LIMITS.memAvailMinPct, `only ${m.memAvailPct}% of RAM is available`);

  for (const app of m.pm2.filter((a) => a.name.startsWith(prefix))) {
    set(`pm2:${app.name}`, app.status !== "online", `${app.name} is ${app.status}`);
    const before = prev.restarts?.[app.name];
    restarts[app.name] = app.restarts;
    set(`restarts:${app.name}`, before !== undefined && app.restarts - before >= LIMITS.restartStorm, `${app.name} restarted ${app.restarts - (before ?? app.restarts)} times in 5 minutes`);
  }

  for (const c of m.containers) {
    set(`container-state:${c.name}`, /restarting|dead/i.test(c.state), `container ${c.name} is ${c.state}`);
    // One busy cycle is normal. Pinned for three checks in a row (15 minutes) is not.
    hot[c.name] = c.cpu >= LIMITS.containerCpu ? (prev.hot?.[c.name] || 0) + 1 : 0;
    set(`container-cpu:${c.name}`, hot[c.name] >= LIMITS.containerCpuChecks, `container ${c.name} has been at ${Math.round(c.cpu)}% CPU for ${hot[c.name] * 5}+ minutes`);
  }
  return { state: { open, hot, restarts }, events };
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] });

export function collect() {
  const diskPct = Number(sh("df", ["-P", "/"]).trim().split("\n").pop().split(/\s+/)[4].replace("%", ""));
  const mem = Object.fromEntries(readFileSync("/proc/meminfo", "utf8").split("\n").map((l) => l.split(/:\s+/)).filter((p) => p[1]).map(([k, v]) => [k, parseInt(v, 10)]));
  const memAvailPct = Math.round((mem.MemAvailable / mem.MemTotal) * 100);
  let pm2 = [];
  try {
    const raw = sh("pm2", ["jlist"]);
    pm2 = JSON.parse(raw.slice(raw.indexOf("["))).map((a) => ({ name: a.name, status: a.pm2_env?.status, restarts: a.pm2_env?.restart_time ?? 0 }));
  } catch { /* pm2 not installed here */ }
  let containers = [];
  try {
    const states = Object.fromEntries(sh("docker", ["ps", "-a", "--format", "{{.Names}}\t{{.Status}}"]).trim().split("\n").filter(Boolean).map((l) => l.split("\t")));
    const cpu = Object.fromEntries(sh("docker", ["stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}"]).trim().split("\n").filter(Boolean).map((l) => { const [n, p] = l.split("\t"); return [n, parseFloat(p)]; }));
    containers = Object.keys(states).filter((n) => n.startsWith("na-")).map((n) => ({ name: n, state: states[n], cpu: cpu[n] ?? 0 }));
  } catch { /* docker not installed here */ }
  return { diskPct, memAvailPct, pm2, containers };
}

async function notify(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_OPS_CHAT_ID;
  console.log(`[hostwatch] ${text}`);
  if (!token || !chat) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: `${process.env.HOSTWATCH_NAME || "server"}: ${text}` }),
  }).catch(() => {});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.env.HOSTWATCH_STATE || "/var/tmp/hostwatch.json";
  let prev = {};
  try { if (existsSync(file)) prev = JSON.parse(readFileSync(file, "utf8")); } catch { /* start fresh */ }
  const { state, events } = evaluate(collect(), prev, Date.now(), process.env.HOSTWATCH_PM2 || "neural-");
  writeFileSync(file, JSON.stringify(state));
  for (const e of events) await notify(e.text);
}
