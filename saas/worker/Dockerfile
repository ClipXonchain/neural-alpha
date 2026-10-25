# Runs ClipXonchain/neural-alpha at a pinned ref.
# Built from the SaaS branch. Does not patch the deployed tree.

FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
  && npm install -g @binance/agentic-wallet \
  && rm -rf /var/lib/apt/lists/*

ARG UPSTREAM_REPO=https://github.com/ClipXonchain/neural-alpha.git
ARG UPSTREAM_REF=agentic-wallet

WORKDIR /opt/neural-alpha
RUN git clone --depth 1 --branch "$UPSTREAM_REF" "$UPSTREAM_REPO" .

RUN npm ci && npm run build --workspace=neural-alpha

COPY saas/worker/entrypoint.sh /usr/local/bin/neural-saas-entrypoint
RUN chmod +x /usr/local/bin/neural-saas-entrypoint

ENV HOME=/data/home \
    AGENT_MODE=paper \
    DASHBOARD_PORT=3847 \
    SQLITE_PATH=/data/book/neural-alpha.sqlite \
    EXTERNAL_FLOWS_FILE=/data/book/external-flows.json

VOLUME ["/data"]
ENTRYPOINT ["neural-saas-entrypoint"]
