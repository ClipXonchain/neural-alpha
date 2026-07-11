import "server-only";
import { createHash, randomUUID } from "crypto";
import { getAgentApiSecret, deriveAgentApiSecret, requireWalletMasterSecret } from "./agent-secrets";
import {
  getAgentDataDir,
  getAgentDir,
  hotReloadAgent,
  isProcessAlive,
  probeAgentHealth,
  readAgentApiPort,
  readAgentPid,
  resolveRuntimeUrl,
  waitForAgentHealth,
  writeAgentEnvFile,
  type HotReloadResult,
} from "./agent-runtime";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import {
  launchDetachedAgent,
  terminateDetachedAgent,
} from "./agent-process-manager";
import {
  createPublicClient,
  http,
  parseEther,
  formatEther,
  type Hash,
  type Address,
} from "viem";
import { bsc } from "viem/chains";
import { ensurePlatformSchema, getPlatformPool } from "./platform-db";
import { getServerEnv, isNextProductionBuild } from "./server-env";
import { getBalancedPresetValues, getBstocksPresetValues } from "./settings-presets";
import {
  resolveAgentUniverse,
  type AgentUniverse,
} from "./agent-universe";

export interface AgentRow {
  id: string;
  owner_wallet: string;
  trading_wallet: string | null;
  display_name: string | null;
  status: string;
  erc8004_agent_id: string | null;
  agent_number: number | null;
  api_secret_hash: string | null;
  runtime_url: string | null;
  runtime_port: number | null;
  public_meta: boolean;
  created_at: string;
  deployed_at: string | null;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function getTreasury(): Address | null {
  const addr = getServerEnv("PLATFORM_TREASURY_ADDRESS");
  if (addr && /^0x[a-fA-F0-9]{40}$/.test(addr)) return addr as Address;
  return null;
}

export function getDeployFeeBnb(): string {
  return getServerEnv("DEPLOY_FEE_BNB") || "0.01";
}

function rpcUrl(): string {
  return (
    getServerEnv("BSC_RPC_URL") ||
    getServerEnv("RPC_URL") ||
    "https://bsc-dataseed.binance.org"
  );
}

export function shouldSkipDeployFee(): boolean {
  if (getServerEnv("SKIP_DEPLOY_FEE") === "true") {
    return process.env.NODE_ENV !== "production";
  }
  if (!getTreasury() && process.env.NODE_ENV !== "production") {
    return true;
  }
  return false;
}

export async function verifyDeployFeeTx(
  txHash: string,
  fromWallet: string
): Promise<{ ok: true; valueBnb: string } | { ok: false; error: string }> {
  const treasury = getTreasury();
  if (!treasury) {
    // Dev mode: skip on-chain check when treasury unset
    if (shouldSkipDeployFee()) {
      return { ok: true, valueBnb: getDeployFeeBnb() };
    }
    return { ok: false, error: "PLATFORM_TREASURY_ADDRESS not configured" };
  }

  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return { ok: false, error: "Invalid fee tx hash" };
  }

  // Public RPCs often lag right after wallet broadcast — wait + retry
  const client = createPublicClient({
    chain: bsc,
    transport: http(rpcUrl(), { timeout: 30_000, retryCount: 3, retryDelay: 1_000 }),
  });

  try {
    const receipt = await client.waitForTransactionReceipt({
      hash: txHash as Hash,
      confirmations: 1,
      timeout: 90_000,
      pollingInterval: 1_500,
    });

    if (receipt.status !== "success") {
      return { ok: false, error: "Fee transaction failed on-chain" };
    }

    // Prefer receipt fields; fall back to getTransaction with short retries
    let tx = await client.getTransaction({ hash: txHash as Hash }).catch(() => null);
    if (!tx) {
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        tx = await client.getTransaction({ hash: txHash as Hash }).catch(() => null);
        if (tx) break;
      }
    }
    if (!tx) {
      // Receipt succeeded — use receipt.from / receipt.to when tx body still lagging
      if (receipt.from.toLowerCase() !== fromWallet.toLowerCase()) {
        return { ok: false, error: "Fee tx sender does not match connected wallet" };
      }
      if (!receipt.to || receipt.to.toLowerCase() !== treasury.toLowerCase()) {
        return { ok: false, error: "Fee was not sent to platform treasury" };
      }
      return {
        ok: false,
        error:
          "Fee tx confirmed but RPC has not indexed transfer details yet — wait ~15s and retry deploy with the same tx hash",
      };
    }

    if (tx.from.toLowerCase() !== fromWallet.toLowerCase()) {
      return { ok: false, error: "Fee tx sender does not match connected wallet" };
    }
    if (!tx.to || tx.to.toLowerCase() !== treasury.toLowerCase()) {
      return { ok: false, error: "Fee was not sent to platform treasury" };
    }
    const min = parseEther(getDeployFeeBnb());
    if (tx.value < min) {
      return {
        ok: false,
        error: `Fee too low: got ${formatEther(tx.value)} BNB, need ${getDeployFeeBnb()}`,
      };
    }
    return { ok: true, valueBnb: formatEther(tx.value) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/could not be found|Timed out|Timeout/i.test(msg)) {
      return {
        ok: false,
        error:
          "Fee transaction not visible on BSC RPC yet. Wait for the tx to confirm on BscScan, then try Deploy again (same payment can be reused only once it is indexed).",
      };
    }
    return { ok: false, error: msg };
  }
}

async function audit(
  action: string,
  ownerWallet: string,
  agentId?: string,
  payload?: Record<string, unknown>
) {
  const pool = getPlatformPool();
  if (!pool) return;
  await pool.query(
    `INSERT INTO audit_log (agent_id, owner_wallet, action, payload) VALUES ($1,$2,$3,$4)`,
    [agentId ?? null, ownerWallet.toLowerCase(), action, payload ? JSON.stringify(payload) : null]
  );
}

export async function upsertUser(wallet: string): Promise<void> {
  await ensurePlatformSchema();
  const pool = getPlatformPool();
  if (!pool) return;
  await pool.query(
    `INSERT INTO users (wallet_address, last_login)
     VALUES ($1, NOW())
     ON CONFLICT (wallet_address) DO UPDATE SET last_login = NOW()`,
    [wallet.toLowerCase()]
  );
}

export async function listAgentsForOwner(ownerWallet: string): Promise<AgentRow[]> {
  await ensurePlatformSchema();
  const pool = getPlatformPool();
  if (!pool) return [];
  const { rows } = await pool.query<AgentRow>(
    `SELECT * FROM agents WHERE LOWER(owner_wallet) = $1 AND status <> 'archived'
     ORDER BY created_at DESC`,
    [ownerWallet.toLowerCase()]
  );
  return rows;
}

export async function listPublicAgents(limit = 50): Promise<AgentRow[]> {
  await ensurePlatformSchema();
  const pool = getPlatformPool();
  if (!pool) return [];
  const { rows } = await pool.query<AgentRow>(
    `SELECT id, owner_wallet, trading_wallet, display_name, status,
            erc8004_agent_id, agent_number, runtime_url, runtime_port,
            public_meta, created_at, deployed_at, api_secret_hash
     FROM agents
     WHERE public_meta = true AND status IN ('running', 'stopped')
     ORDER BY deployed_at DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getAgent(agentId: string): Promise<AgentRow | null> {
  await ensurePlatformSchema();
  const pool = getPlatformPool();
  if (!pool) return null;
  const { rows } = await pool.query<AgentRow>(
    `SELECT * FROM agents WHERE id = $1 LIMIT 1`,
    [agentId]
  );
  return rows[0] ?? null;
}

export async function assertAgentOwner(
  agentId: string,
  ownerWallet: string
): Promise<AgentRow> {
  const agent = await getAgent(agentId);
  if (!agent) throw new Error("Agent not found");
  if (agent.owner_wallet.toLowerCase() !== ownerWallet.toLowerCase()) {
    throw new Error("Forbidden: not agent owner");
  }
  return agent;
}

async function allocateAgentPort(): Promise<number> {
  const base = parseInt(getServerEnv("AGENT_PORT_BASE") || "4000", 10);
  const max = parseInt(getServerEnv("AGENT_PORT_MAX") || "5999", 10);
  const pool = getPlatformPool();
  if (pool) {
    const { rows } = await pool.query<{ runtime_port: number }>(
      `SELECT runtime_port FROM agents WHERE runtime_port IS NOT NULL`
    );
    const used = new Set(rows.map((r) => r.runtime_port));
    for (let p = base; p <= max; p++) {
      if (!used.has(p)) return p;
    }
  }
  return base + Math.floor(Math.random() * Math.max(1, max - base));
}

export interface ConfigSaveResult {
  saved: true;
  reload: HotReloadResult;
}

async function buildAgentSpawnEnv(agentId: string): Promise<Record<string, string>> {
  const agent = await getAgent(agentId);
  if (!agent) throw new Error("Agent not found");

  const cfg = await getAgentConfig(agentId);
  const flat: Record<string, string> = {};
  for (const [key, row] of Object.entries(cfg)) {
    if (row.value != null && row.value !== "") flat[key] = row.value;
  }

  const port = agent.runtime_port ?? readAgentApiPort(agentId) ?? 4000;
  const apiSecret = flat.API_SECRET || (await getAgentApiSecret(agentId)) || "";

  return {
    AGENT_ID: agentId,
    AGENT_MODE: "live",
    BRIDGE_MODE: "evm",
    DASHBOARD_PORT: String(port),
    API_SECRET: apiSecret,
    AGENT_DATA_DIR: getAgentDataDir(),
    AGENT_WALLET_ADDRESS: agent.trading_wallet || "",
    AGENT_DISPLAY_NAME: agent.display_name || `Agent ${agentId.slice(0, 8)}`,
    OWNER_WALLET: agent.owner_wallet,
    PUBLIC_BASE_URL:
      getServerEnv("PUBLIC_BASE_URL")?.replace(/\/$/, "") || `http://127.0.0.1:${port}`,
    CMC_PRO_API_KEY:
      getServerEnv("CMC_PRO_API_KEY") || getServerEnv("CMC_API_KEY") || "",
    BINANCE_WEB3_API_KEY: getServerEnv("BINANCE_WEB3_API_KEY") || "",
    BINANCE_WEB3_API_SECRET: getServerEnv("BINANCE_WEB3_API_SECRET") || "",
    MARKET_FEED_URL: getServerEnv("MARKET_FEED_URL") || "http://127.0.0.1:4100",
    DATABASE_URL: getServerEnv("DATABASE_URL") || "",
    BSC_RPC_URL: rpcUrl(),
    ...flat,
  };
}

async function syncAgentEnvFile(agentId: string): Promise<void> {
  const env = await buildAgentSpawnEnv(agentId);
  writeAgentEnvFile(agentId, env);
}

async function updateRuntimeUrlIfDrifted(agentId: string): Promise<string | null> {
  const agent = await getAgent(agentId);
  if (!agent) return null;
  const diskPort = readAgentApiPort(agentId);
  if (!diskPort) return resolveRuntimeUrl(agentId, agent.runtime_url);
  const url = `http://127.0.0.1:${diskPort}`;
  if (agent.runtime_port !== diskPort || agent.runtime_url !== url) {
    const pool = getPlatformPool();
    if (pool) {
      await pool.query(
        `UPDATE agents SET runtime_port = $1, runtime_url = $2 WHERE id = $3`,
        [diskPort, url, agentId]
      );
    }
  }
  return url;
}

let runtimeReconciled = false;
const runningPids = new Map<string, number>();
let marketFeedPid: number | null = null;

/** On dashboard boot: sync DB status with process health; auto-respawn running agents. */
export async function reconcileAgentRuntime(): Promise<void> {
  if (runtimeReconciled || isNextProductionBuild()) return;
  runtimeReconciled = true;

  const pool = getPlatformPool();
  if (!pool) return;
  await ensurePlatformSchema();

  const { rows } = await pool.query<AgentRow>(
    `SELECT * FROM agents WHERE status NOT IN ('archived', 'pending')`
  );

  for (const agent of rows) {
    await updateRuntimeUrlIfDrifted(agent.id);
    const refreshed = (await getAgent(agent.id))!;
    const runtimeUrl = resolveRuntimeUrl(agent.id, refreshed.runtime_url);
    const pid = readAgentPid(agent.id);
    const pidAlive = pid ? isProcessAlive(pid) : false;
    const health = runtimeUrl ? await probeAgentHealth(runtimeUrl) : { ok: false };

    if (health.ok) {
      if (pid && pidAlive) runningPids.set(agent.id, pid);
      if (refreshed.status !== "running") {
        await pool.query(`UPDATE agents SET status = 'running' WHERE id = $1`, [agent.id]);
      }
      await ingestErc8004Result(agent.id);
      continue;
    }

    // Was supposed to be live — respawn after dashboard/PM2 restart (SaaS resilience)
    if (refreshed.status === "running" || refreshed.status === "provisioning") {
      const port = refreshed.runtime_port ?? readAgentApiPort(agent.id);
      if (!port) {
        await pool.query(`UPDATE agents SET status = 'stopped' WHERE id = $1`, [agent.id]);
        runningPids.delete(agent.id);
        await ingestErc8004Result(agent.id);
        continue;
      }

      console.log(
        `[reconcile] Respawning agent ${agent.id.slice(0, 8)}… (was ${refreshed.status}, process down)`
      );
      try {
        const agentEnv = await buildAgentSpawnEnv(agent.id);
        await syncAgentEnvFile(agent.id);
        const started = await startAgentProcess(agent.id, port, agentEnv);
        await pool.query(`UPDATE agents SET status = $1 WHERE id = $2`, [
          started ? "running" : "stopped",
          agent.id,
        ]);
        if (!started) runningPids.delete(agent.id);
      } catch (err) {
        console.warn(`[reconcile] Respawn failed for ${agent.id}:`, err);
        await pool.query(`UPDATE agents SET status = 'stopped' WHERE id = $1`, [agent.id]);
        runningPids.delete(agent.id);
      }
    }

    await ingestErc8004Result(agent.id);
  }
}

/**
 * Provision a local agent process (MVP orchestrator).
 * Creates keystore via agent wallet module, writes env, starts process.
 */
export async function provisionAgent(opts: {
  ownerWallet: string;
  displayName: string;
  feeTxHash: string;
  /** Trading universe: spot | alpha | both (default). */
  agentUniverse?: AgentUniverse;
}): Promise<{ agent: AgentRow; apiSecret: string; mnemonic: string }> {
  await ensurePlatformSchema();
  const pool = getPlatformPool();
  if (!pool) {
    throw new Error("DATABASE_URL required for multi-tenant deploy");
  }

  const agentUniverse = resolveAgentUniverse(opts.agentUniverse);

  const fee = await verifyDeployFeeTx(opts.feeTxHash, opts.ownerWallet);
  if (!fee.ok) throw new Error(fee.error);

  // Reject fee-tx replay (zero-hash allowed for fee-skip / dev only)
  const isZeroHash = /^0x0+$/i.test(opts.feeTxHash);
  if (!isZeroHash) {
    const { rows: reused } = await pool.query<{ id: string }>(
      `SELECT id FROM deployments
       WHERE LOWER(fee_tx_hash) = LOWER($1)
       LIMIT 1`,
      [opts.feeTxHash]
    );
    if (reused.length > 0) {
      throw new Error("Fee transaction already used for another deployment");
    }
  }

  await upsertUser(opts.ownerWallet);

  const agentId = randomUUID();
  const masterSecret = requireWalletMasterSecret();
  const apiSecret = deriveAgentApiSecret(agentId);
  const port = await allocateAgentPort();
  const dataDir = getAgentDataDir();
  const agentDir = join(dataDir, agentId);
  mkdirSync(agentDir, { recursive: true });

  // Create keystore by spawning a small node script in neural-alpha
  const { address: tradingWallet, mnemonic } = await createKeystoreForAgent(
    agentId,
    agentDir,
    masterSecret
  );

  const runtimeUrl = `http://127.0.0.1:${port}`;

  await pool.query(
    `INSERT INTO agents (
      id, owner_wallet, trading_wallet, display_name, status,
      api_secret_hash, runtime_url, runtime_port, deployed_at
    ) VALUES ($1,$2,$3,$4,'provisioning',$5,$6,$7,NOW())`,
    [
      agentId,
      opts.ownerWallet.toLowerCase(),
      tradingWallet.toLowerCase(),
      opts.displayName || `Agent ${agentId.slice(0, 8)}`,
      hashSecret(apiSecret),
      runtimeUrl,
      port,
    ]
  );

  await pool.query(
    `INSERT INTO deployments (agent_id, host, port, fee_tx_hash)
     VALUES ($1,'127.0.0.1',$2,$3)`,
    [agentId, port, opts.feeTxHash]
  );

  // Seed Balanced (or Equity Trend for bStocks) into agent_config + runtime env
  const basePreset =
    agentUniverse === "bstocks"
      ? getBstocksPresetValues()
      : getBalancedPresetValues();
  const seedConfig: Record<string, string> = {
    ...basePreset,
    AGENT_UNIVERSE: agentUniverse,
  };
  for (const [key, value] of Object.entries(seedConfig)) {
    await pool.query(
      `INSERT INTO agent_config (agent_id, key, value, is_secret, updated_at)
       VALUES ($1,$2,$3,false,NOW())
       ON CONFLICT (agent_id, key) DO NOTHING`,
      [agentId, key, value]
    );
  }

  await pool.query(
    `INSERT INTO agent_config (agent_id, key, value, is_secret, updated_at)
     VALUES ($1,'API_SECRET',$2,true,NOW())
     ON CONFLICT (agent_id, key) DO UPDATE SET value = EXCLUDED.value, is_secret = true`,
    [agentId, apiSecret]
  );

  // Write per-agent env file (master secret passed via spawn env only)
  const envPath = join(agentDir, ".env");
  const envLines = [
    `AGENT_ID=${agentId}`,
    `AGENT_MODE=live`,
    `BRIDGE_MODE=evm`,
    `DASHBOARD_PORT=${port}`,
    `API_SECRET=${apiSecret}`,
    `AGENT_DATA_DIR=${dataDir}`,
    `AGENT_WALLET_ADDRESS=${tradingWallet}`,
    `AGENT_DISPLAY_NAME=${opts.displayName || `Agent ${agentId.slice(0, 8)}`}`,
    `CMC_PRO_API_KEY=${getServerEnv("CMC_PRO_API_KEY") || ""}`,
    `BINANCE_WEB3_API_KEY=${getServerEnv("BINANCE_WEB3_API_KEY") || ""}`,
    `BINANCE_WEB3_API_SECRET=${getServerEnv("BINANCE_WEB3_API_SECRET") || ""}`,
    `MARKET_FEED_URL=${getServerEnv("MARKET_FEED_URL") || "http://127.0.0.1:4100"}`,
    `DATABASE_URL=${getServerEnv("DATABASE_URL") || ""}`,
    `BSC_RPC_URL=${rpcUrl()}`,
    ...Object.entries(seedConfig).map(([k, v]) => `${k}=${v}`),
  ];
  writeFileSync(envPath, envLines.join("\n") + "\n", { mode: 0o600 });

  const publicBase =
    getServerEnv("PUBLIC_BASE_URL")?.replace(/\/$/, "") ||
    `http://127.0.0.1:${port}`;
  const metaUrl = `${publicBase}/api/agent/${agentId}/meta`;

  const started = await startAgentProcess(agentId, port, {
    AGENT_ID: agentId,
    AGENT_MODE: "live",
    BRIDGE_MODE: "evm",
    DASHBOARD_PORT: String(port),
    API_SECRET: apiSecret,
    WALLET_MASTER_SECRET: masterSecret,
    AGENT_DATA_DIR: dataDir,
    AGENT_WALLET_ADDRESS: tradingWallet,
    AGENT_DISPLAY_NAME: opts.displayName || `Agent ${agentId.slice(0, 8)}`,
    OWNER_WALLET: opts.ownerWallet.toLowerCase(),
    PUBLIC_BASE_URL: publicBase,
    CMC_PRO_API_KEY:
      getServerEnv("CMC_PRO_API_KEY") || getServerEnv("CMC_API_KEY") || "",
    BINANCE_WEB3_API_KEY: getServerEnv("BINANCE_WEB3_API_KEY") || "",
    BINANCE_WEB3_API_SECRET: getServerEnv("BINANCE_WEB3_API_SECRET") || "",
    MARKET_FEED_URL:
      getServerEnv("MARKET_FEED_URL") || "http://127.0.0.1:4100",
    DATABASE_URL: getServerEnv("DATABASE_URL") || "",
    BSC_RPC_URL: rpcUrl(),
    ...seedConfig,
  });

  await pool.query(`UPDATE agents SET status = $1 WHERE id = $2`, [
    started ? "running" : "failed",
    agentId,
  ]);

  // Best-effort ERC-8004 identity registration via bnbagent sidecar
  try {
    await runErc8004Hook(agentId, tradingWallet, metaUrl, dataDir);
  } catch (err) {
    console.warn("ERC-8004 hook failed (non-fatal)", err);
  }

  await audit("deploy", opts.ownerWallet, agentId, {
    feeTxHash: opts.feeTxHash,
    port,
    tradingWallet,
    metaUrl,
  });

  const agent = (await getAgent(agentId))!;
  // mnemonic returned once to the deploy API: never stored in DB
  return { agent, apiSecret, mnemonic };
}

async function runErc8004Hook(
  agentId: string,
  tradingWallet: string,
  endpoint: string,
  dataDir: string
): Promise<void> {
  const sidecar = join(process.cwd(), "..", "bnbagent-sidecar", "register_identity.py");
  if (!existsSync(sidecar)) return;

  await new Promise<void>((resolve) => {
    const child = spawn(
      process.env.PYTHON || "python3",
      [
        sidecar,
        "--agent-id",
        agentId,
        "--endpoint",
        endpoint,
        "--trading-wallet",
        tradingWallet,
        "--data-dir",
        dataDir,
      ],
      { stdio: "ignore", detached: true }
    );
    child.unref();
    resolve();
  });
}

async function createKeystoreForAgent(
  agentId: string,
  agentDir: string,
  masterSecret: string
): Promise<{ address: string; mnemonic: string }> {
  const neuralAlphaRoot = join(process.cwd(), "..", "neural-alpha");
  // Print JSON {address,mnemonic} once on stdout for the parent to capture.
  const script = `
    process.env.AGENT_ID = ${JSON.stringify(agentId)};
    process.env.WALLET_MASTER_SECRET = ${JSON.stringify(masterSecret)};
    process.env.AGENT_DATA_DIR = ${JSON.stringify(join(agentDir, ".."))};
    const {
      createEncryptedKeystore,
      saveKeystore,
      defaultKeystorePath,
      keystoreExists,
      exportMnemonicFromKeystore,
      loadKeystore,
    } = await import(${JSON.stringify(join(neuralAlphaRoot, "src/wallet/keystore.ts"))});
    const { deriveUnlockPassword } = await import(${JSON.stringify(join(neuralAlphaRoot, "src/wallet/secrets.ts"))});
    const password = deriveUnlockPassword(${JSON.stringify(agentId)});
    const path = defaultKeystorePath(${JSON.stringify(agentId)});
    if (keystoreExists(path)) {
      const ks = loadKeystore(path);
      const { address, mnemonic } = exportMnemonicFromKeystore(ks, password);
      process.stdout.write(JSON.stringify({ address, mnemonic }));
    } else {
      const { keystore, wallet } = createEncryptedKeystore(password);
      saveKeystore(path, keystore);
      process.stdout.write(JSON.stringify({
        address: wallet.address,
        mnemonic: wallet.mnemonic,
      }));
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "-e", script],
      {
        cwd: neuralAlphaRoot,
        env: {
          ...process.env,
          AGENT_ID: agentId,
          WALLET_MASTER_SECRET: masterSecret,
          AGENT_DATA_DIR: join(agentDir, ".."),
        },
      }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      try {
        const line = out.trim().split("\n").filter(Boolean).pop() || "";
        const parsed = JSON.parse(line) as { address?: string; mnemonic?: string };
        if (
          code === 0 &&
          parsed.address &&
          /^0x[a-fA-F0-9]{40}$/i.test(parsed.address) &&
          parsed.mnemonic &&
          parsed.mnemonic.split(" ").length >= 12
        ) {
          resolve({ address: parsed.address, mnemonic: parsed.mnemonic });
        } else {
          reject(new Error(`Keystore creation failed: ${err || out || code}`));
        }
      } catch {
        reject(new Error(`Keystore creation failed: ${err || out || code}`));
      }
    });
  });
}

/**
 * Owner-only: decrypt trading wallet private key from on-disk keystore.
 * Never logs the key. Audits that an export occurred.
 */
export async function exportAgentWalletBackup(
  agentId: string,
  ownerWallet: string
): Promise<{ address: string; privateKey: string }> {
  await assertAgentOwner(agentId, ownerWallet);

  const masterSecret =
    getServerEnv("WALLET_MASTER_SECRET") || "";
  if (!masterSecret) {
    throw new Error("WALLET_MASTER_SECRET not configured: cannot unlock keystore");
  }

  const dataDir =
    getServerEnv("AGENT_DATA_DIR") || join(process.cwd(), "..", "data", "agents");
  const neuralAlphaRoot = join(process.cwd(), "..", "neural-alpha");

  const script = `
    process.env.AGENT_ID = ${JSON.stringify(agentId)};
    process.env.WALLET_MASTER_SECRET = ${JSON.stringify(masterSecret)};
    process.env.AGENT_DATA_DIR = ${JSON.stringify(dataDir)};
    const {
      loadKeystore,
      defaultKeystorePath,
      exportPrivateKeyFromKeystore,
    } = await import(${JSON.stringify(join(neuralAlphaRoot, "src/wallet/keystore.ts"))});
    const { deriveUnlockPassword } = await import(${JSON.stringify(join(neuralAlphaRoot, "src/wallet/secrets.ts"))});
    const password = deriveUnlockPassword(${JSON.stringify(agentId)});
    const path = defaultKeystorePath(${JSON.stringify(agentId)});
    const ks = loadKeystore(path);
    const { address, privateKey } = exportPrivateKeyFromKeystore(ks, password);
    process.stdout.write(JSON.stringify({ address, privateKey }));
  `;

  const result = await new Promise<{ address: string; privateKey: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "-e", script],
        {
          cwd: neuralAlphaRoot,
          env: {
            ...process.env,
            AGENT_ID: agentId,
            WALLET_MASTER_SECRET: masterSecret,
            AGENT_DATA_DIR: dataDir,
          },
        }
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("close", (code) => {
        try {
          const line = out.trim().split("\n").filter(Boolean).pop() || "";
          const parsed = JSON.parse(line) as { address?: string; privateKey?: string };
          if (
            code === 0 &&
            parsed.address &&
            parsed.privateKey &&
            /^0x[a-fA-F0-9]{64}$/.test(parsed.privateKey)
          ) {
            resolve({ address: parsed.address, privateKey: parsed.privateKey });
          } else {
            reject(new Error(`Wallet export failed: ${err || out || code}`));
          }
        } catch {
          reject(new Error(`Wallet export failed: ${err || out || code}`));
        }
      });
    }
  );

  await audit("wallet_backup_export", ownerWallet, agentId, {
    address: result.address.toLowerCase(),
    format: "private_key",
  });

  return result;
}

async function ingestErc8004Result(agentId: string): Promise<void> {
  const resultPath = join(getAgentDir(agentId), "bnbagent", "erc8004-result.json");
  if (!existsSync(resultPath)) return;
  try {
    const raw = readFileSync(resultPath, "utf8");
    const data = JSON.parse(raw) as { agentId?: string; agent_id?: string; id?: string };
    const ercId = data.agent_id || data.agentId || data.id;
    if (ercId && typeof ercId === "string") {
      await setErc8004Id(agentId, ercId);
    }
  } catch {
    /* ignore malformed */
  }
}

/** Ensure shared market feed is up before spawning agents (saves CMC quota). */
async function ensureMarketFeedRunning(): Promise<void> {
  const feedUrl =
    (getServerEnv("MARKET_FEED_URL") || "http://127.0.0.1:4100").replace(
      /\/$/,
      ""
    );

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${feedUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = (await res.json()) as { ok?: boolean };
        if (data.ok !== false) return;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  const neuralAlphaRoot = join(process.cwd(), "..", "neural-alpha");
  if (!existsSync(join(neuralAlphaRoot, "src", "market-feed", "index.ts"))) {
    console.warn("market-feed entry missing: agents will hit CMC directly");
    return;
  }

  const portMatch = feedUrl.match(/:(\d+)$/);
  const port = portMatch?.[1] || "4100";

  await new Promise<void>((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/market-feed/index.ts"],
      {
        cwd: neuralAlphaRoot,
        env: {
          ...process.env,
          MARKET_FEED_PORT: port,
          CMC_PRO_API_KEY:
            getServerEnv("CMC_PRO_API_KEY") ||
            getServerEnv("CMC_API_KEY") ||
            "",
        },
        detached: true,
        stdio: "ignore",
      }
    );
    child.unref();
    if (child.pid) {
      marketFeedPid = child.pid;
      console.log(`Started market feed pid=${child.pid} on ${feedUrl}`);
    }
    setTimeout(() => resolve(), 3000);
  });
}

async function startAgentProcess(
  agentId: string,
  port: number,
  agentEnv: Record<string, string>
): Promise<boolean> {
  await ensureMarketFeedRunning();

  const neuralAlphaRoot = join(process.cwd(), "..", "neural-alpha");
  if (!existsSync(join(neuralAlphaRoot, "src", "index.ts"))) {
    console.warn("neural-alpha not found: agent marked provisioned without process");
    return true;
  }

  const agentDir = getAgentDir(agentId);
  mkdirSync(agentDir, { recursive: true });

  const masterSecret = requireWalletMasterSecret();
  const launched = await launchDetachedAgent({
    agentId,
    neuralAlphaRoot,
    env: {
      ...process.env,
      ...agentEnv,
      WALLET_MASTER_SECRET: masterSecret,
    },
  });

  if (!launched.ok) {
    console.warn(
      `Agent ${agentId} launch failed via ${launched.via}: ${launched.error}`
    );
    return false;
  }

  if (launched.pid) {
    runningPids.set(agentId, launched.pid);
  }

  console.log(
    `Agent ${agentId.slice(0, 8)} started via ${launched.via}` +
      (launched.pid ? ` pid=${launched.pid}` : "")
  );

  const expectedUrl = `http://127.0.0.1:${port}`;
  await updateRuntimeUrlIfDrifted(agentId);
  const runtimeUrl = resolveRuntimeUrl(agentId, expectedUrl) || expectedUrl;
  const health = await waitForAgentHealth(runtimeUrl, 35_000);
  if (!health.ok) {
    console.warn(`Agent ${agentId} health check failed: ${health.error}`);
    return false;
  }
  await updateRuntimeUrlIfDrifted(agentId);
  return true;
}

export async function stopAgent(agentId: string, ownerWallet: string): Promise<void> {
  const agent = await assertAgentOwner(agentId, ownerWallet);
  const pool = getPlatformPool();
  const pid = runningPids.get(agentId) ?? readAgentPid(agentId);
  await terminateDetachedAgent(agentId, pid);
  runningPids.delete(agentId);
  if (pool) {
    await pool.query(`UPDATE agents SET status = 'stopped' WHERE id = $1`, [agentId]);
  }
  await audit("stop", ownerWallet, agentId, { previous: agent.status });
}

/** Respawn a stopped agent process from DB config. */
export async function startAgent(
  agentId: string,
  ownerWallet: string
): Promise<{ ok: boolean; error?: string }> {
  const agent = await assertAgentOwner(agentId, ownerWallet);
  if (agent.status === "archived") {
    return { ok: false, error: "Agent is archived" };
  }

  const runtimeUrl = resolveRuntimeUrl(agentId, agent.runtime_url);
  if (runtimeUrl) {
    const health = await probeAgentHealth(runtimeUrl);
    if (health.ok) {
      const pool = getPlatformPool();
      if (pool) {
        await pool.query(`UPDATE agents SET status = 'running' WHERE id = $1`, [agentId]);
      }
      return { ok: true };
    }
  }

  const port = agent.runtime_port ?? readAgentApiPort(agentId);
  if (!port) {
    return { ok: false, error: "Agent has no runtime port: redeploy required" };
  }

  const agentEnv = await buildAgentSpawnEnv(agentId);
  await syncAgentEnvFile(agentId);

  const started = await startAgentProcess(agentId, port, agentEnv);
  const pool = getPlatformPool();
  if (pool) {
    await pool.query(`UPDATE agents SET status = $1 WHERE id = $2`, [
      started ? "running" : "failed",
      agentId,
    ]);
  }
  await audit("start", ownerWallet, agentId, { port, started });

  if (!started) {
    return { ok: false, error: "Agent process failed to start or health check timed out" };
  }
  return { ok: true };
}

export async function archiveAgent(agentId: string, ownerWallet: string): Promise<void> {
  await stopAgent(agentId, ownerWallet);
  const pool = getPlatformPool();
  if (pool) {
    await pool.query(`UPDATE agents SET status = 'archived' WHERE id = $1`, [agentId]);
  }
  await audit("archive", ownerWallet, agentId);
}

export async function setAgentConfig(
  agentId: string,
  ownerWallet: string,
  updates: Record<string, string>,
  secretKeys: Set<string>
): Promise<ConfigSaveResult> {
  await assertAgentOwner(agentId, ownerWallet);
  const pool = getPlatformPool();
  if (!pool) throw new Error("DATABASE_URL required");
  for (const [key, value] of Object.entries(updates)) {
    await pool.query(
      `INSERT INTO agent_config (agent_id, key, value, is_secret, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (agent_id, key) DO UPDATE SET
         value = EXCLUDED.value, is_secret = EXCLUDED.is_secret, updated_at = NOW()`,
      [agentId, key, value, secretKeys.has(key)]
    );
  }

  await syncAgentEnvFile(agentId);
  await audit("config_update", ownerWallet, agentId, { keys: Object.keys(updates) });

  const agent = await getAgent(agentId);
  const runtimeUrl = agent ? resolveRuntimeUrl(agentId, agent.runtime_url) : null;
  if (!runtimeUrl) {
    return {
      saved: true,
      reload: { reloaded: false, error: "Agent offline: saved for next start" },
    };
  }

  const apiSecret = await getAgentApiSecret(agentId);
  if (!apiSecret) {
    return {
      saved: true,
      reload: { reloaded: false, error: "API secret unavailable" },
    };
  }

  const reload = await hotReloadAgent(runtimeUrl, apiSecret, updates);
  return { saved: true, reload };
}

export async function getAgentConfig(
  agentId: string
): Promise<Record<string, { value: string | null; is_secret: boolean }>> {
  const pool = getPlatformPool();
  if (!pool) return {};
  const { rows } = await pool.query<{ key: string; value: string | null; is_secret: boolean }>(
    `SELECT key, value, is_secret FROM agent_config WHERE agent_id = $1`,
    [agentId]
  );
  const out: Record<string, { value: string | null; is_secret: boolean }> = {};
  for (const r of rows) out[r.key] = { value: r.value, is_secret: r.is_secret };
  return out;
}

export async function setErc8004Id(agentId: string, erc8004Id: string): Promise<void> {
  const pool = getPlatformPool();
  if (!pool) return;
  await pool.query(`UPDATE agents SET erc8004_agent_id = $1 WHERE id = $2`, [
    erc8004Id,
    agentId,
  ]);
}
