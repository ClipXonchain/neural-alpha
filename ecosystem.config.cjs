/**
 * PM2 Ecosystem Configuration — Neural Alpha
 * Deploy: pm2 start ecosystem.config.cjs
 *
 * Multi-tenant: per-agent processes are started via `pm2 start` (name neural-agent-<uuid>)
 * so `pm2 restart neural-dashboard` does NOT kill traders. Fallback: nohup+setsid.
 * Set DISABLE_SINGLETON_AGENT=true (default when DATABASE_URL is set in setup.sh)
 * so only market-feed + dashboard are in ecosystem.config.cjs.
 *
 * Operator platform: READONLY=false (default).
 * Public monitor: READONLY=true NEXT_PUBLIC_READONLY=true
 */
const disableSingleton =
  process.env.DISABLE_SINGLETON_AGENT === "true" ||
  process.env.DISABLE_SINGLETON_AGENT === "1";

const readonly =
  process.env.READONLY === "true" || process.env.NEXT_PUBLIC_READONLY === "true"
    ? "true"
    : "false";

const apps = [
  {
    name: "neural-market-feed",
    cwd: "./neural-alpha",
    script: "node",
    args: "--import ./src/load-env.ts --import tsx src/market-feed/index.ts",
    interpreter: "none",
    env: {
      NODE_ENV: "production",
      MARKET_FEED_PORT: "4100",
    },
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    max_restarts: 10,
    min_uptime: "10s",
    restart_delay: 5000,
    max_memory_restart: "512M",
    watch: false,
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    error_file: "./logs/market-feed-error.log",
    out_file: "./logs/market-feed-out.log",
    merge_logs: true,
    kill_timeout: 10000,
  },
];

if (!disableSingleton) {
  apps.push({
    name: "neural-agent",
    cwd: "./neural-alpha",
    script: "node",
    args: "--import ./src/load-env.ts --import tsx src/index.ts",
    interpreter: "none",
    env: {
      NODE_ENV: "production",
      MARKET_FEED_URL: "http://127.0.0.1:4100",
    },
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    max_restarts: 10,
    min_uptime: "10s",
    restart_delay: 5000,
    max_memory_restart: "512M",
    watch: false,
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    error_file: "./logs/agent-error.log",
    out_file: "./logs/agent-out.log",
    merge_logs: true,
    kill_timeout: 10000,
  });
}

apps.push({
  name: "neural-dashboard",
  cwd: "./dashboard",
  // Workspaces hoist `next` to repo root — not dashboard/node_modules
  script: "node",
  args: "../node_modules/next/dist/bin/next start -p 3000",
  interpreter: "none",
  env: {
    NODE_ENV: "production",
    PORT: "3000",
    // Do not hardcode READONLY — inherit from shell/.env (operator default: false)
    READONLY: readonly,
    NEXT_PUBLIC_READONLY: readonly,
    MARKET_FEED_URL: "http://127.0.0.1:4100",
  },
  instances: 1,
  exec_mode: "fork",
  autorestart: true,
  max_restarts: 10,
  min_uptime: "5s",
  restart_delay: 3000,
  max_memory_restart: "384M",
  watch: false,
  log_date_format: "YYYY-MM-DD HH:mm:ss Z",
  error_file: "./logs/dashboard-error.log",
  out_file: "./logs/dashboard-out.log",
  merge_logs: true,
  kill_timeout: 5000,
});

module.exports = { apps };
