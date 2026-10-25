/**
 * Same-network bridge for the agent API.
 * Upstream listens on 127.0.0.1 only. This process shares that network
 * namespace and exposes a local port for the SaaS control plane.
 */
import http from "node:http";

const agentPort = process.env.AGENT_PORT || "3847";
const bridgePort = Number(process.env.BRIDGE_PORT || "3848");

const server = http.createServer((req, res) => {
  const headers = { ...req.headers, host: `127.0.0.1:${agentPort}` };
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: agentPort,
      path: req.url,
      method: req.method,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "agent unreachable" }));
  });
  req.pipe(upstream);
});

server.listen(bridgePort, "0.0.0.0", () => {
  console.log(`bridge listening on ${bridgePort} -> 127.0.0.1:${agentPort}`);
});
