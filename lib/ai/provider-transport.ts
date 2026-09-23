import "server-only";
import type { SafeErrorCode, Usage } from "./explanation-context";

export type FetchLike = typeof fetch;
export type Provider = "openai" | "nvidia";
export type ProviderConfig = Readonly<{ apiKey: string; model: string; baseUrl: string }>;
export type TransportResult =
  | { ok: true; body: unknown; durationMs: number }
  | { ok: false; errorCode: SafeErrorCode; durationMs: number };

const MAX_REQUEST_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 65_536;
const TIMEOUT_MS = 12_000;

function endpointFor(provider: Provider, config: ProviderConfig, path: "/responses" | "/chat/completions"): string | null {
  const expectedHost = provider === "openai" ? "api.openai.com" : "integrate.api.nvidia.com";
  const expectedPath = provider === "openai" ? "/responses" : "/chat/completions";
  if (path !== expectedPath || !config.apiKey?.trim() || !config.model?.trim() ||
      config.apiKey.length > 512 || config.model.length > 128) return null;
  try {
    const url = new URL(config.baseUrl);
    if (url.protocol !== "https:" || url.hostname !== expectedHost || url.port || url.username || url.password ||
        url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/v1") return null;
    return `${url.origin}/v1${path}`;
  } catch {
    return null;
  }
}

export function resolveProviderConfig(provider: Provider, env: Record<string, string | undefined>): ProviderConfig | null {
  const prefix = provider === "openai" ? "OPENAI" : "NVIDIA";
  const apiKey = env[`${prefix}_API_KEY`]?.trim();
  const model = env[`${prefix}_MODEL`]?.trim();
  const baseUrl = env[`${prefix}_BASE_URL`]?.trim();
  if (!apiKey || !model || !baseUrl || apiKey.length > 512 || model.length > 128) return null;
  try {
    const url = new URL(baseUrl);
    const expectedHost = provider === "openai" ? "api.openai.com" : "integrate.api.nvidia.com";
    if (url.protocol !== "https:" || url.hostname !== expectedHost || url.port || url.username || url.password ||
        url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/v1") return null;
    return { apiKey, model, baseUrl: `${url.origin}/v1` };
  } catch {
    return null;
  }
}

function classifyStatus(status: number): SafeErrorCode {
  return status === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR";
}

async function limitedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_RESPONSE_BYTES) throw new Error("OUTPUT_TOO_LARGE");
  if (!response.body) throw new Error("OUTPUT_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error("ABORTED");
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("OUTPUT_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(merged)); }
  catch { throw new Error("OUTPUT_INVALID"); }
}

export async function postProviderJson(
  provider: Provider, config: ProviderConfig | null, path: "/responses" | "/chat/completions",
  body: unknown, options: { fetchImpl?: FetchLike; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<TransportResult> {
  const start = performance.now();
  const elapsed = () => Math.max(0, Math.round(performance.now() - start));
  const endpoint = config ? endpointFor(provider, config, path) : null;
  if (!config || !endpoint) return { ok: false, errorCode: "CONFIG_UNAVAILABLE", durationMs: elapsed() };
  const serialized = JSON.stringify(body);
  if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) {
    return { ok: false, errorCode: "REQUEST_TOO_LARGE", durationMs: elapsed() };
  }
  if (options.signal?.aborted) return { ok: false, errorCode: "CANCELLED", durationMs: elapsed() };

  const controller = new AbortController();
  let timedOut = false;
  const onCancel = () => controller.abort();
  options.signal?.addEventListener("abort", onCancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(options.timeoutMs ?? TIMEOUT_MS, TIMEOUT_MS));
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("ABORTED")), { once: true });
  });
  try {
    const request = (options.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: serialized,
      signal: controller.signal,
      cache: "no-store",
      redirect: "error",
    });
    const response = await Promise.race([request, aborted]);
    if (!response.ok) {
      controller.abort();
      void response.body?.cancel().catch(() => undefined);
      return { ok: false, errorCode: classifyStatus(response.status), durationMs: elapsed() };
    }
    const parsed = await Promise.race([limitedJson(response, controller.signal), aborted]);
    return { ok: true, body: parsed, durationMs: elapsed() };
  } catch (error) {
    const code: SafeErrorCode = timedOut ? "TIMEOUT" : controller.signal.aborted ? "CANCELLED" :
      error instanceof Error && error.message === "OUTPUT_TOO_LARGE" ? "OUTPUT_TOO_LARGE" :
      error instanceof Error && error.message === "OUTPUT_INVALID" ? "OUTPUT_INVALID" : "NETWORK_ERROR";
    return { ok: false, errorCode: code, durationMs: elapsed() };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCancel);
  }
}

export function usageFrom(value: unknown, provider: Provider): Usage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const input = record[provider === "openai" ? "input_tokens" : "prompt_tokens"];
  const output = record[provider === "openai" ? "output_tokens" : "completion_tokens"];
  const valid = (number: unknown): number is number => Number.isSafeInteger(number) && (number as number) >= 0;
  if (!valid(input) && !valid(output)) return null;
  return { ...(valid(input) ? { inputTokens: input } : {}), ...(valid(output) ? { outputTokens: output } : {}) };
}
