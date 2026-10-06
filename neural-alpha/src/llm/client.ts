import OpenAI from "openai";

/**
 * Shared OpenAI-compatible client (OpenAI, OpenRouter, DeepSeek, Groq, Ollama…).
 * Configured by OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL.
 */
let client: OpenAI | null = null;

export function llmEnabled(): boolean {
  return !!process.env.OPENAI_API_KEY?.trim();
}

export function llmModel(): string {
  return process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
}

/** Optional stronger model for the assistant and daily review (falls back to OPENAI_MODEL). */
export function llmReasoningModel(): string {
  return process.env.OPENAI_REASONING_MODEL?.trim() || llmModel();
}

export function llmClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
      timeout: 60_000,
      maxRetries: 1,
    });
  }
  return client;
}

export async function chatText(opts: {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  const res = await llmClient().chat.completions.create({
    model: opts.model ?? llmReasoningModel(),
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    max_tokens: opts.maxTokens ?? 900,
    temperature: opts.temperature ?? 0.3,
  });
  return res.choices[0]?.message?.content?.trim() ?? "";
}
