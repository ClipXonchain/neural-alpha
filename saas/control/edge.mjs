/**
 * Multi-VPS Edge Router & Cell Cluster Coordinator.
 *
 * Connects the public portal (e.g. neuralalpha.io) to one or more Customer Cell VPS
 * machines running `saas/control/server.mjs`.
 *
 * - Reads `/capacity` on each registered cell.
 * - Routes new checkouts to the first healthy cell with free seats (`tenants < maxTenants`)
 *   and available upstream call budget (`estimatedUsePerMin < upstreamBudgetPerMin`).
 * - Pins each provisioned customer to their cell via a compound token `<hostId>.<tenantId>.<accessToken>`
 *   so the customer portal always routes requests to the right VPS.
 */

const HOST_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

export function parseCellNodesEnv(raw = "") {
  const nodes = [];
  for (const part of String(raw || "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const hostId = trimmed.slice(0, eq).trim();
    const baseUrl = normalizeBaseUrl(trimmed.slice(eq + 1).trim());
    if (HOST_ID_RE.test(hostId) && baseUrl) {
      nodes.push({ hostId, baseUrl });
    }
  }
  return nodes;
}

export function normalizeBaseUrl(urlStr) {
  try {
    const u = new URL(String(urlStr || "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function formatCompoundToken(hostId, tenantId, accessToken) {
  return `${hostId}.${tenantId}.${accessToken}`;
}

export function parseCompoundToken(rawToken = "") {
  const trimmed = String(rawToken || "").trim();
  const parts = trimmed.split(".");
  if (parts.length === 3 && HOST_ID_RE.test(parts[0]) && /^[a-z0-9]{8}$/.test(parts[1]) && /^[a-f0-9]{64}$/i.test(parts[2])) {
    return {
      compound: true,
      hostId: parts[0],
      tenantId: parts[1],
      accessToken: parts[2].toLowerCase(),
    };
  }
  return {
    compound: false,
    hostId: null,
    tenantId: null,
    accessToken: trimmed,
  };
}

export function createEdgeCluster({ store, config, localCapacity, fetchImpl = globalThis.fetch }) {
  function listRegisteredNodes() {
    const byHost = new Map();
    for (const node of parseCellNodesEnv(config.cellNodesEnv)) {
      byHost.set(node.hostId, { hostId: node.hostId, baseUrl: node.baseUrl, source: "env" });
    }
    if (typeof store.listNodes === "function") {
      for (const row of store.listNodes()) {
        if (row.status === "active" && row.host_id && row.base_url) {
          byHost.set(row.host_id, { hostId: row.host_id, baseUrl: row.base_url, source: "db", updatedAt: row.updated_at });
        }
      }
    }
    return [...byHost.values()];
  }

  async function probeNode(node) {
    const headers = config.apiSecret ? { authorization: `Bearer ${config.apiSecret}` } : {};
    const started = Date.now();
    try {
      const res = await fetchImpl(`${node.baseUrl}/capacity`, { headers });
      if (!res.ok) {
        return {
          hostId: node.hostId,
          baseUrl: node.baseUrl,
          reachable: false,
          reason: `HTTP ${res.status}`,
          latencyMs: Date.now() - started,
        };
      }
      const cap = await res.json();
      const maxTenants = Number(cap.maxTenants) || 0;
      const tenants = Number(cap.tenants) || 0;
      const freeSeats = Math.max(0, maxTenants - tenants);
      const use = Number(cap.estimatedUsePerMin) || 0;
      const budget = Number(cap.upstreamBudgetPerMin) || 60;
      return {
        hostId: cap.hostId || node.hostId,
        baseUrl: node.baseUrl,
        reachable: true,
        local: false,
        maxTenants,
        tenants,
        running: Number(cap.running) || 0,
        freeSeats,
        estimatedUsePerMin: use,
        upstreamBudgetPerMin: budget,
        withinBudget: use < budget,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      return {
        hostId: node.hostId,
        baseUrl: node.baseUrl,
        reachable: false,
        local: false,
        reason: err instanceof Error ? err.message : "unreachable",
        latencyMs: Date.now() - started,
      };
    }
  }

  async function clusterStatus() {
    const remoteNodes = listRegisteredNodes().filter((n) => n.hostId !== config.hostId);
    const localCap = await localCapacity();
    const localFreeSeats = Math.max(0, (Number(localCap.maxTenants) || 0) - (Number(localCap.tenants) || 0));
    const localNode = {
      hostId: config.hostId,
      baseUrl: "local",
      reachable: true,
      local: true,
      maxTenants: Number(localCap.maxTenants) || 0,
      tenants: Number(localCap.tenants) || 0,
      running: Number(localCap.running) || 0,
      freeSeats: localFreeSeats,
      estimatedUsePerMin: Number(localCap.estimatedUsePerMin) || 0,
      upstreamBudgetPerMin: Number(localCap.upstreamBudgetPerMin) || 60,
      withinBudget: (Number(localCap.estimatedUsePerMin) || 0) <= (Number(localCap.upstreamBudgetPerMin) || 60),
      latencyMs: 0,
    };

    const probed = await Promise.all(remoteNodes.map(probeNode));
    const nodes = config.edgeOnly ? probed : [localNode, ...probed];
    const eligible = nodes.filter((n) => n.reachable && n.freeSeats > 0 && n.withinBudget);
    const selected = eligible[0] || null;

    return {
      edgeHostId: config.hostId,
      totalNodes: nodes.length,
      reachableNodes: nodes.filter((n) => n.reachable).length,
      totalMaxTenants: nodes.filter((n) => n.reachable).reduce((sum, n) => sum + n.maxTenants, 0),
      totalActiveTenants: nodes.filter((n) => n.reachable).reduce((sum, n) => sum + n.tenants, 0),
      totalFreeSeats: nodes.filter((n) => n.reachable).reduce((sum, n) => sum + n.freeSeats, 0),
      selectedHostId: selected ? selected.hostId : null,
      nodes,
    };
  }

  function resolveNodeUrl(hostId) {
    if (!hostId || hostId === config.hostId) return null;
    const found = listRegisteredNodes().find((n) => n.hostId === hostId);
    return found ? found.baseUrl : null;
  }

  async function forwardJson(hostId, method, path, body, authHeader) {
    const baseUrl = resolveNodeUrl(hostId);
    if (!baseUrl) {
      throw Object.assign(new Error(`unknown cell hostId: ${hostId}`), { status: 404 });
    }
    const headers = {
      ...(authHeader ? { authorization: authHeader } : config.apiSecret ? { authorization: `Bearer ${config.apiSecret}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    };
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: text || `cell ${hostId} HTTP ${res.status}` };
    }
    return { status: res.status, body: json };
  }

  return {
    listRegisteredNodes,
    clusterStatus,
    resolveNodeUrl,
    forwardJson,
  };
}
