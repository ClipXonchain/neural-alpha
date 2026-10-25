FROM node:20-bookworm-slim
WORKDIR /app
COPY saas/worker/bridge.mjs ./bridge.mjs
ENV AGENT_PORT=3847 BRIDGE_PORT=3848
EXPOSE 3848
CMD ["node", "bridge.mjs"]
