export type ApiErrorKind =
  | "unauthenticated" | "forbidden" | "not_found" | "conflict" | "invalid_input"
  | "unavailable" | "rate_limited" | "cancelled" | "timeout" | "network"
  | "invalid_response" | "invalid_request";

const MESSAGES: Record<ApiErrorKind, string> = {
  unauthenticated: "Войдите в систему, чтобы продолжить.",
  forbidden: "Недостаточно прав для этого действия.",
  not_found: "Запрошенные данные не найдены.",
  conflict: "Данные изменились. Обновите результат.",
  invalid_input: "Проверьте введённые данные.",
  unavailable: "Сервис временно недоступен. Повторите попытку позже.",
  rate_limited: "Слишком много запросов. Повторите попытку позже.",
  cancelled: "Запрос отменён.",
  timeout: "Ответ задерживается. Попробуйте ещё раз.",
  network: "Не удалось связаться с сервером.",
  invalid_response: "Сервер вернул неожиданный ответ.",
  invalid_request: "Не удалось отправить запрос.",
};

export class ApiClientError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly requestId: string | null;

  constructor(kind: ApiErrorKind, status: number | null = null, code: string | null = null, requestId: string | null = null) {
    super(MESSAGES[kind]);
    this.name = "ApiClientError";
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export type QueryValue = string | number | boolean | null | undefined;
export type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type ApiRequest<T> = Readonly<{
  method: ApiMethod;
  path: string;
  query?: Readonly<Record<string, QueryValue>>;
  body?: unknown;
  decode: (value: unknown) => T;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;
export type ApiTransport = Readonly<{ origin: string; fetchImpl?: typeof fetch }>;

const MAX_QUERY_BYTES = 2_048;
const MAX_REQUEST_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 524_288;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 20_000;
const PATH = /^\/api\/[A-Za-z0-9_/-]+$/;
const QUERY_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

function sameOriginUrl(origin: string, path: string, query?: Readonly<Record<string, QueryValue>>): string {
  if (!PATH.test(path) || path.includes("//") || path.includes("..") || path.length > 512) throw new ApiClientError("invalid_request");
  let base: URL;
  try { base = new URL(origin); } catch { throw new ApiClientError("invalid_request"); }
  if (!(["http:", "https:"].includes(base.protocol)) || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new ApiClientError("invalid_request");
  }
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith("/api/")) throw new ApiClientError("invalid_request");
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (!QUERY_KEY.test(key)) throw new ApiClientError("invalid_request");
      if (value === null || value === undefined) continue;
      if (typeof value === "number" && !Number.isFinite(value)) throw new ApiClientError("invalid_request");
      if (!["string", "number", "boolean"].includes(typeof value) || String(value).length > 512) throw new ApiClientError("invalid_request");
      url.searchParams.set(key, String(value));
    }
  }
  if (new TextEncoder().encode(url.search).byteLength > MAX_QUERY_BYTES) throw new ApiClientError("invalid_request");
  return url.toString();
}

function encodeBody(method: ApiMethod, body: unknown): string | undefined {
  if (method === "GET" && body !== undefined) throw new ApiClientError("invalid_request");
  if (body === undefined) return undefined;
  let encoded: string | undefined;
  try { encoded = JSON.stringify(body); } catch { throw new ApiClientError("invalid_request"); }
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > MAX_REQUEST_BYTES) throw new ApiClientError("invalid_request");
  return encoded;
}

function statusKind(status: number): ApiErrorKind {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422) return "invalid_input";
  if (status === 429) return "rate_limited";
  if (status === 503) return "unavailable";
  return status >= 500 ? "unavailable" : "invalid_response";
}

function own(value: object, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function cancelBody(response: Response): void { void response.body?.cancel().catch(() => undefined); }

async function readJsonBounded(response: Response, signal: AbortSignal): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json") && !contentType.includes("+json")) {
    cancelBody(response);
    throw new ApiClientError("invalid_response", response.status);
  }
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_RESPONSE_BYTES) {
    cancelBody(response);
    throw new ApiClientError("invalid_response", response.status);
  }
  if (!response.body) throw new ApiClientError("invalid_response", response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    while (true) {
      if (signal.aborted) throw new ApiClientError("cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new ApiClientError("invalid_response", response.status);
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(merged)); }
  catch { throw new ApiClientError("invalid_response", response.status); }
}

function safeFailure(response: Response, parsed: unknown): ApiClientError {
  let code: string | null = null;
  let requestId: string | null = null;
  if (record(parsed) && Object.keys(parsed).length === 1 && own(parsed, "error") && record(parsed.error)) {
    const error = parsed.error;
    if (typeof error.code === "string" && SAFE_CODE.test(error.code)) code = error.code;
    if (typeof error.requestId === "string" && SAFE_REQUEST_ID.test(error.requestId)) requestId = error.requestId;
  }
  return new ApiClientError(statusKind(response.status), response.status, code, requestId);
}

export async function requestApi<T>(request: ApiRequest<T>, transport: ApiTransport): Promise<T> {
  const url = sameOriginUrl(transport.origin, request.path, request.query);
  const body = encodeBody(request.method, request.body);
  if (request.signal?.aborted) throw new ApiClientError("cancelled");
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new ApiClientError("invalid_request");
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  request.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (request.signal?.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let rejectAbort: (reason?: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new ApiClientError(timedOut ? "timeout" : "cancelled"));
  controller.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const fetchPromise = Promise.resolve((transport.fetchImpl ?? fetch)(url, {
        method: request.method,
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      }));
    // A mocked or noncompliant fetch may settle after our deadline. The late
    // response must not retain an unread stream or become visible to callers.
    void fetchPromise.then((lateResponse) => {
      if (controller.signal.aborted && lateResponse instanceof Response) cancelBody(lateResponse);
    }, () => undefined);
    const response = await Promise.race([fetchPromise, aborted]);
    if (!(response instanceof Response)) throw new ApiClientError("invalid_response");
    let parsed: unknown;
    try { parsed = await Promise.race([readJsonBounded(response, controller.signal), aborted]); }
    catch (error) {
      if (!response.ok && !controller.signal.aborted) throw safeFailure(response, null);
      throw error;
    }
    if (!response.ok) throw safeFailure(response, parsed);
    if (!record(parsed) || Object.keys(parsed).length !== 1 || !own(parsed, "data")) {
      throw new ApiClientError("invalid_response", response.status);
    }
    try { return request.decode(parsed.data); }
    catch { throw new ApiClientError("invalid_response", response.status); }
  } catch (error) {
    if (timedOut) throw new ApiClientError("timeout");
    if (controller.signal.aborted) throw new ApiClientError("cancelled");
    if (error instanceof ApiClientError) throw error;
    throw new ApiClientError("network");
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    request.signal?.removeEventListener("abort", onExternalAbort);
  }
}

export function browserApiRequest<T>(request: ApiRequest<T>): Promise<T> {
  if (typeof window === "undefined") return Promise.reject(new ApiClientError("invalid_request"));
  return requestApi(request, { origin: window.location.origin });
}
