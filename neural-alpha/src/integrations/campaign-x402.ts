import { logger } from "../utils/logger.js";
import { bawData, bawJson } from "./baw-cli.js";
import {
  AGENT_STUDIO_BASE,
  CMC_CAMPAIGN_TOOLS,
  CMC_X402_MCP_URL,
  recordCmcCall,
  recordStudioCall,
  type CampaignCallRecord,
} from "./campaign.js";
import { isCmcX402Enabled, isStudioX402Enabled } from "./campaign-x402-schedule.js";

interface X402Option {
  index: number;
  status: string;
  tokenSymbol?: string;
  assetTransferMethod?: string;
  amount?: string;
  amountUsd?: string;
  reasons?: string[];
}

interface X402Preview {
  paymentId: string;
  options: X402Option[];
}

interface X402SignResult {
  paymentHeaderName: string;
  paymentHeaderValue: string;
  approveTxHash?: string | null;
  signatureExpiresAt?: number;
}

function headerValue(headers: Headers, name: string): string | null {
  return headers.get(name) ?? headers.get(name.toLowerCase()) ?? headers.get(name.toUpperCase());
}

function pickReadyOption(options: X402Option[]): X402Option {
  const ready = options.filter((o) => o.status === "READY_TO_SIGN");
  if (ready.length === 0) {
    const reasons = options.flatMap((o) => o.reasons ?? []);
    throw new Error(
      `No READY_TO_SIGN x402 payment option. Reasons: ${reasons.join(", ") || "none"}`
    );
  }
  const preferGasless = ready.find(
    (o) =>
      o.assetTransferMethod === "eip3009" &&
      (o.tokenSymbol === "U" || o.tokenSymbol === "USD1")
  );
  return preferGasless ?? ready[0]!;
}

async function previewAndSign(paymentRequired: string): Promise<X402SignResult> {
  const previewRaw = await bawJson(
    ["x402-payment", "preview", "--paymentRequirements", paymentRequired],
    { timeoutMs: 45_000 }
  );
  const preview = bawData<X402Preview>(previewRaw);
  if (!preview?.paymentId || !Array.isArray(preview.options)) {
    throw new Error("x402 preview returned no paymentId/options");
  }

  const option = pickReadyOption(preview.options);
  logger.info("x402 payment option selected", {
    index: option.index,
    token: option.tokenSymbol,
    method: option.assetTransferMethod,
    amount: option.amount,
    amountUsd: option.amountUsd,
  });

  const signRaw = await bawJson(
    [
      "x402-payment",
      "sign",
      "--paymentId",
      preview.paymentId,
      "--selectedIndex",
      String(option.index),
    ],
    { timeoutMs: 90_000 }
  );
  const signed = bawData<X402SignResult>(signRaw);
  if (!signed?.paymentHeaderValue) {
    throw new Error("x402 sign returned no paymentHeaderValue");
  }
  return {
    paymentHeaderName: signed.paymentHeaderName || "PAYMENT-SIGNATURE",
    paymentHeaderValue: signed.paymentHeaderValue,
    approveTxHash: signed.approveTxHash,
    signatureExpiresAt: signed.signatureExpiresAt,
  };
}

function parseSseJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* SSE */
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      return JSON.parse(payload) as Record<string, unknown>;
    } catch {
      /* next line */
    }
  }
  return null;
}

function extractCmcText(body: Record<string, unknown>): string {
  const result = body.result as Record<string, unknown> | undefined;
  const content = result?.content;
  if (Array.isArray(content) && content[0] && typeof content[0] === "object") {
    const text = (content[0] as Record<string, unknown>).text;
    if (typeof text === "string") return text;
  }
  return JSON.stringify(body).slice(0, 4000);
}

/**
 * Paid CMC Agent Hub call that counts toward the campaign (≥3 of the 4 designated tools).
 */
export async function completeCmcCampaignCall(
  tool: (typeof CMC_CAMPAIGN_TOOLS)[number] = "get_global_metrics_latest",
  args: Record<string, unknown> = {}
): Promise<{ text: string; record: CampaignCallRecord }> {
  if (!isCmcX402Enabled()) {
    logger.info("Skipping paid CMC x402 call — CMC_X402_ENABLED/CMC_MACRO_ENABLED is off");
    throw new Error("CMC x402 disabled (CMC_X402_ENABLED=false)");
  }

  const rpc = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name: tool, arguments: args },
  };
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };

  const challenge = await fetch(CMC_X402_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(rpc),
  });

  if (challenge.status !== 402) {
    const bodyText = await challenge.text();
    throw new Error(`Expected HTTP 402 from CMC MCP, got ${challenge.status}: ${bodyText.slice(0, 240)}`);
  }

  const paymentRequired =
    headerValue(challenge.headers, "payment-required") ??
    headerValue(challenge.headers, "PAYMENT-REQUIRED");
  if (!paymentRequired) {
    throw new Error("CMC 402 response missing payment-required header");
  }

  const signed = await previewAndSign(paymentRequired);
  const replay = await fetch(CMC_X402_MCP_URL, {
    method: "POST",
    headers: {
      ...headers,
      [signed.paymentHeaderName]: signed.paymentHeaderValue,
    },
    body: JSON.stringify(rpc),
  });

  const replayText = await replay.text();
  if (!replay.ok) {
    throw new Error(`CMC x402 replay HTTP ${replay.status}: ${replayText.slice(0, 240)}`);
  }

  const parsed = parseSseJson(replayText) ?? {};
  const text = extractCmcText(parsed);
  const record: CampaignCallRecord = {
    at: Date.now(),
    tool,
    settled: true,
  };
  recordCmcCall(record);
  logger.info("CMC campaign x402 call settled", { tool });
  return { text, record };
}

export interface StudioJob {
  jobId: string;
  jobToken: string;
  symbols: string[];
}

/**
 * Submit a paid Agent Studio stock-analysis job (counts on successful x402 payment).
 * Does not block for the 2–5 minute report — persist jobId/jobToken and poll later.
 */
export async function submitStudioAnalysis(tickers: string[]): Promise<StudioJob> {
  if (!isStudioX402Enabled()) {
    logger.info("Skipping paid Agent Studio x402 call — STUDIO_X402_ENABLED is off");
    throw new Error("Studio x402 disabled (STUDIO_X402_ENABLED=false)");
  }

  const symbols = [...new Set(tickers.map((s) => s.toUpperCase()).filter(Boolean))];
  if (symbols.length === 0) throw new Error("Agent Studio requires at least one ticker");

  const body = JSON.stringify({ symbols, analysis_type: "comprehensive" });
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const challenge = await fetch(`${AGENT_STUDIO_BASE}/x402/analyze/async`, {
    method: "POST",
    headers,
    body,
  });

  if (challenge.status === 429) {
    const retryAfter = challenge.headers.get("Retry-After") ?? "unknown";
    throw new Error(`Agent Studio rate limited (wallet_rate_limited). Retry-After: ${retryAfter}`);
  }
  if (challenge.status !== 402) {
    const text = await challenge.text();
    throw new Error(`Expected HTTP 402 from Agent Studio, got ${challenge.status}: ${text.slice(0, 240)}`);
  }

  const paymentRequired =
    headerValue(challenge.headers, "payment-required") ??
    headerValue(challenge.headers, "PAYMENT-REQUIRED");
  if (!paymentRequired) {
    throw new Error("Agent Studio 402 response missing payment-required header");
  }

  const signed = await previewAndSign(paymentRequired);
  const replay = await fetch(`${AGENT_STUDIO_BASE}/x402/analyze/async`, {
    method: "POST",
    headers: {
      ...headers,
      [signed.paymentHeaderName]: signed.paymentHeaderValue,
    },
    body,
  });

  if (replay.status === 503) {
    throw new Error(
      "Agent Studio settlement_pending (503). Replay the same PAYMENT-SIGNATURE — do not sign a new one."
    );
  }
  if (replay.status !== 202 && replay.status !== 200) {
    const text = await replay.text();
    throw new Error(`Agent Studio replay HTTP ${replay.status}: ${text.slice(0, 240)}`);
  }

  const json = (await replay.json()) as { jobId?: string; jobToken?: string };
  if (!json.jobId || !json.jobToken) {
    throw new Error("Agent Studio response missing jobId/jobToken");
  }

  const job: StudioJob = { jobId: json.jobId, jobToken: json.jobToken, symbols };
  recordStudioCall({
    at: Date.now(),
    symbols,
    jobId: job.jobId,
    jobToken: job.jobToken,
    settled: true,
  });
  logger.info("Agent Studio analysis submitted", { jobId: job.jobId, symbols });
  return job;
}

export async function pollStudioJob(
  jobId: string,
  jobToken: string
): Promise<{ status: string; downloadUrl?: string; retryable?: boolean; report?: string }> {
  const res = await fetch(`${AGENT_STUDIO_BASE}/x402/jobs/${encodeURIComponent(jobId)}`, {
    headers: { "X-Job-Token": jobToken, Accept: "application/json" },
  });
  const json = (await res.json()) as {
    status?: string;
    job_status?: string;
    downloadUrl?: string;
    retryable?: boolean;
  };
  const jobStatus = String(json.status ?? json.job_status ?? "unknown");
  let report: string | undefined;
  if (jobStatus === "succeeded" && json.downloadUrl) {
    try {
      const dl = await fetch(json.downloadUrl);
      report = await dl.text();
    } catch (err) {
      logger.warn("Agent Studio report download failed", { error: String(err) });
    }
  }
  return {
    status: jobStatus,
    downloadUrl: json.downloadUrl,
    retryable: json.retryable,
    report,
  };
}
