/**
 * PM2 Ecosystem Configuration — Neural Alpha
 * Deploy: pm2 start ecosystem.config.cjs
 * Docs:   https://pm2.keymetrics.io/docs/usage/application-declaration/
 */
module.exports = {
  apps: [
    {
      name: "neural-agent",
      cwd: "./neural-alpha",
      script: "node",
      args: "--import tsx src/index.ts",
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
      error_file: "./logs/agent-error.log",
      out_file: "./logs/agent-out.log",
      merge_logs: true,
      kill_timeout: 10000,
    },
    {
      name: "neural-dashboard",
      cwd: "./dashboard",
      script: "node_modules/.bin/next",
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
      error_file: "./logs/dashboard-error.log",
      out_file: "./logs/dashboard-out.log",
      merge_logs: true,
      kill_timeout: 5000,
    },
  ],
};
