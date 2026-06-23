import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { LogEntry } from "./types.js";

const LOG_FILE = process.env.LOG_FILE || "./logs/agent.jsonl";
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

const LEVEL_PRIORITY: Record<string, number> = {
  error: 0,
  risk: 1,
  warn: 2,
  trade: 3,
  signal: 4,
  info: 5,
  debug: 6,
};

const configuredPriority = LEVEL_PRIORITY[LOG_LEVEL] ?? 5;

function shouldLog(level: string): boolean {
  return (LEVEL_PRIORITY[level] ?? 5) <= configuredPriority;
}

function ensureLogDir() {
  const dir = dirname(LOG_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function formatEntry(entry: LogEntry): string {
  return JSON.stringify(entry);
}

function writeToFile(entry: LogEntry) {
  try {
    ensureLogDir();
    appendFileSync(LOG_FILE, formatEntry(entry) + "\n");
  } catch {
    // Silently continue if file write fails
  }
}

export type LogListener = (entry: LogEntry) => void;
const listeners: LogListener[] = [];

export function addLogListener(fn: LogListener) {
  listeners.push(fn);
}

export function removeLogListener(fn: LogListener) {
  const idx = listeners.indexOf(fn);
  if (idx >= 0) listeners.splice(idx, 1);
}

function log(level: LogEntry["level"], event: string, data?: Record<string, unknown>, txHash?: string) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...(data && { data }),
    ...(txHash && { txHash }),
  };

  // Notify all listeners (for web UI streaming)
  for (const fn of listeners) {
    try { fn(entry); } catch { /* don't break logging */ }
  }

  if (!shouldLog(level)) {
    writeToFile(entry);
    return;
  }

  const prefix = {
    info: "\x1b[36m[INFO]\x1b[0m",
    warn: "\x1b[33m[WARN]\x1b[0m",
    error: "\x1b[31m[ERROR]\x1b[0m",
    trade: "\x1b[32m[TRADE]\x1b[0m",
    signal: "\x1b[35m[SIGNAL]\x1b[0m",
    risk: "\x1b[33m[RISK]\x1b[0m",
  }[level];

  const txSuffix = txHash ? ` tx:${txHash}` : "";
  console.log(`${prefix} ${entry.timestamp} ${event}${txSuffix}`, data ? JSON.stringify(data) : "");

  writeToFile(entry);
}

export const logger = {
  info: (event: string, data?: Record<string, unknown>) => log("info", event, data),
  warn: (event: string, data?: Record<string, unknown>) => log("warn", event, data),
  error: (event: string, data?: Record<string, unknown>) => log("error", event, data),
  trade: (event: string, data?: Record<string, unknown>, txHash?: string) => log("trade", event, data, txHash),
  signal: (event: string, data?: Record<string, unknown>) => log("signal", event, data),
  risk: (event: string, data?: Record<string, unknown>) => log("risk", event, data),
};
