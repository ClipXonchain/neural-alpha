/**
 * PM2 Ecosystem — Neural Alpha (public read-only dashboard)
 *
 * Manages ONLY:
 *   neural-agent       — trading loop + localhost API :3847
 *   neural-dashboard   — Next.js :3000 (READONLY)
 *
 * Never start this file with `pm2 restart all` on a shared VPS.
 */
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;

function bin(name) {
  const candidates = [
    path.join(ROOT, "node_modules", ".bin", name),
    path.join(ROOT, "dashboard", "node_modules", ".bin", name),
    path.join(ROOT, "neural-alpha", "node_modules", ".bin", name),
  ];
  return candidates.find((p) => fs.existsSync(p)) || name;
}

module.exports = {
  apps: [
    {
      name: "neural-agent",
      cwd: path.join(ROOT, "neural-alpha"),
      script: bin("tsx"),
      args: "--import ./src/load-env.ts src/index.ts",
      interpreter: "none",
      env: {
        NODE_ENV: "production",
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
      error_file: path.join(ROOT, "logs/agent-error.log"),
      out_file: path.join(ROOT, "logs/agent-out.log"),
      merge_logs: true,
      kill_timeout: 10000,
    },
    {
      name: "neural-dashboard",
      cwd: path.join(ROOT, "dashboard"),
      script: bin("next"),
      args: "start -p 3000",
      interpreter: "none",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
        READONLY: "true",
        NEXT_PUBLIC_READONLY: "true",
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
      error_file: path.join(ROOT, "logs/dashboard-error.log"),
      out_file: path.join(ROOT, "logs/dashboard-out.log"),
      merge_logs: true,
      kill_timeout: 5000,
    },
  ],
};
