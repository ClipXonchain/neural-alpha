# Runs the agent from this checkout (neural-alpha/), so one commit ships
# the agent, control plane and portal together. Build context: repo root.

# Node 22: the agent uses the built-in node:sqlite, which Node 20 does not have.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
  && npm install -g @binance/agentic-wallet@1.12.0 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/neural-alpha
# Manifests first so the npm layer is cached; dashboard's is needed for the lockfile.
COPY package.json package-lock.json ./
COPY neural-alpha/package.json neural-alpha/
COPY dashboard/package.json dashboard/
RUN npm ci --workspace=neural-alpha

COPY neural-alpha neural-alpha
RUN npm run build --workspace=neural-alpha

COPY saas/worker/entrypoint.sh /usr/local/bin/neural-saas-entrypoint
RUN chmod +x /usr/local/bin/neural-saas-entrypoint

ENV HOME=/data/home \
    AGENT_MODE=paper \
    DASHBOARD_PORT=3847 \
    SQLITE_PATH=/data/book/neural-alpha.sqlite \
    EXTERNAL_FLOWS_FILE=/data/book/external-flows.json

VOLUME ["/data"]
ENTRYPOINT ["neural-saas-entrypoint"]
