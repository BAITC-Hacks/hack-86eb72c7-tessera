import "server-only";

import { z } from "zod";
import { apiData, apiError } from "../contracts/api";
import { RunServiceError } from "./runs";
import { AuthConfigurationError, InvalidOriginError, UnauthenticatedError } from "./auth-policy";

type RunService = {
  create(userId: string, projectId: string, input: unknown): Promise<{ statusCode: number; data: unknown }>;
  list(userId: string, projectId: string, page: Record<string, unknown>): Promise<unknown>;
  get(userId: string, runId: string): Promise<unknown>;
  recommendations(userId: string, runId: string, page: Record<string, unknown>): Promise<unknown>;
  cancel(userId: string, runId: string): Promise<{ statusCode: number; data: unknown }>;
};

export type RunsRouteContext = { params: Promise<{ projectId?: string; runId?: string }> };
const MAX_BODY = 256 * 1024;

async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new RunServiceError(422, "INVALID_CONTENT_TYPE", "Ожидается JSON.");
  if (!request.body) throw new RunServiceError(400, "INVALID_JSON", "Отсутствует JSON.");
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY))
    throw new RunServiceError(422, "BODY_TOO_LARGE", "Превышен размер запроса.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new RunServiceError(422, "BODY_TOO_LARGE", "Превышен размер запроса.");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw new RunServiceError(400, "INVALID_JSON", "Некорректный JSON."); }
}

function query(request: Request, allowed: readonly string[]): Record<string, string> {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => !allowed.includes(key) || params.getAll(key).length !== 1))
    throw new RunServiceError(422, "INVALID_QUERY", "Некорректные параметры запроса.");
  return Object.fromEntries(params.entries());
}

function safeError(error: unknown): Response {
  if (error instanceof UnauthenticatedError) return apiError(401, "UNAUTHENTICATED", error.message);
  if (error instanceof InvalidOriginError) return apiError(403, "INVALID_ORIGIN", error.message);
  if (error instanceof AuthConfigurationError) return apiError(503, "AUTH_UNAVAILABLE", error.message);
  if (error instanceof RunServiceError) return apiError(error.status, error.code, error.message);
  if (error instanceof z.ZodError) return apiError(422, "INVALID_INPUT", "Некорректные поля запроса.");
  return apiError(503, "SERVICE_UNAVAILABLE", "Сервис временно недоступен.");
}

export function createRunsHandlers(dependencies: {
  requireUserId(): Promise<string>;
  requireSameOrigin(request: Request): void;
  service(): RunService;
  now?: () => number;
}) {
  const requests = new Map<string, { count: number; expires: number }>();
  const now = dependencies.now ?? Date.now;
  async function handle(request: Request, context: RunsRouteContext, mutation: boolean,
    operation: (service: RunService, userId: string, ids: Awaited<RunsRouteContext["params"]>) => Promise<{ statusCode?: number; data: unknown }>): Promise<Response> {
    try {
      const userId = await dependencies.requireUserId();
      if (mutation) dependencies.requireSameOrigin(request);
      const time = now();
      for (const [key, value] of requests) if (value.expires <= time) requests.delete(key);
      const rateKey = `${userId}:${mutation ? "write" : "read"}`;
      const entry = requests.get(rateKey) ?? { count: 0, expires: time + 60_000 };
      if (entry.count >= (mutation ? 30 : 120) || (!requests.has(rateKey) && requests.size >= 10_000))
        throw new RunServiceError(429, "RATE_LIMITED", "Превышен лимит запросов.");
      entry.count++;
      requests.set(rateKey, entry);
      const ids = await context.params;
      const response = await operation(dependencies.service(), userId, ids);
      return apiData(response.data, { status: response.statusCode ?? 200 });
    } catch (error) { return safeError(error); }
  }
  return {
    create: (request: Request, context: RunsRouteContext) => handle(request, context, true, async (service, userId, ids) =>
      service.create(userId, ids.projectId ?? "", await readJson(request))),
    list: (request: Request, context: RunsRouteContext) => handle(request, context, false, async (service, userId, ids) => ({
      data: await service.list(userId, ids.projectId ?? "", query(request, ["cursor", "limit"])),
    })),
    get: (request: Request, context: RunsRouteContext) => handle(request, context, false, async (service, userId, ids) => ({
      data: await service.get(userId, ids.runId ?? ""),
    })),
    recommendations: (request: Request, context: RunsRouteContext) => handle(request, context, false, async (service, userId, ids) => ({
      data: await service.recommendations(userId, ids.runId ?? "", query(request, ["cursor", "limit", "supplierId", "q", "urgency"])),
    })),
    cancel: (request: Request, context: RunsRouteContext) => handle(request, context, true, async (service, userId, ids) => {
      if (request.body) throw new RunServiceError(422, "INVALID_INPUT", "Тело запроса не требуется.");
      return service.cancel(userId, ids.runId ?? "");
    }),
  };
}
