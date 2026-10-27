/**
 * PM2 definitions for a SaaS server. One file, no hand-made entry scripts.
 *
 *   NA_ROLE=mother pm2 start saas/infra/ecosystem.config.cjs   # router + portal
 *   NA_ROLE=cell   pm2 start saas/infra/ecosystem.config.cjs   # customer-container host
 *
 * Node is run directly (interpreter "none"): PM2's own wrapper would load an ES module without
 * making it the main program, so the server would never start.
 * Every process has a memory ceiling, so a leak restarts that process instead of the whole host.
 * Secrets are not here: the control server reads saas/runtime/cell.env, the portal reads
 * dashboard/.env.production.local.
 */
const path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const role = process.env.NA_ROLE || "cell";

const common = {
  interpreter: "none",
  exec_mode: "fork",
  instances: 1,
  autorestart: true,
  min_uptime: "20s",
  max_restarts: 15,
  restart_delay: 5000,
  kill_timeout: 15000,
  time: true,
  merge_logs: true,
  watch: false,
};

const control = (name) => ({
  ...common,
  name,
  cwd: ROOT,
  script: process.execPath,
  args: [path.join(ROOT, "saas/control/server.mjs")],
  max_memory_restart: "1500M", // a healthy control process stays far below this
  env: { NODE_ENV: "production" },
});

const apps =
  role === "mother"
    ? [
        control("neural-saas-edge"),
        {
          ...common,
          name: "neural-portal",
          cwd: path.join(ROOT, "dashboard"),
          script: path.join(ROOT, "node_modules/.bin/next"),
          args: ["start", "-H", "127.0.0.1", "-p", process.env.NA_PORTAL_PORT || "3007"],
          max_memory_restart: "1200M",
          env: { NODE_ENV: "production", SAAS_CONTROL_URL: "http://127.0.0.1:3910" },
        },
      ]
    : [control("neural-saas-cell")];

module.exports = { apps };
