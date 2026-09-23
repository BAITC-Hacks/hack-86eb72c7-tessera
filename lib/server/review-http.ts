import "server-only";
import { ZodError } from "zod";
import { apiError } from "@/lib/contracts/api";
import { UuidSchema } from "@/lib/contracts/primitives";
import { AuthConfigurationError, InvalidOriginError, UnauthenticatedError, authErrorResponse } from "./auth";
import { DatabaseAccessError, DatabaseConflictError } from "./db";

export type RunRouteContext = { params: Promise<{ runId: string }> };

class RequestBodyError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export async function routeRunId(context: RunRouteContext): Promise<string> {
  const { runId } = await context.params;
  if (!UuidSchema.safeParse(runId).success) throw new DatabaseAccessError();
  return runId;
}

export async function readReviewJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new RequestBodyError(400, "INVALID_JSON", "Требуется тело запроса JSON.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new RequestBodyError(400, "INVALID_JSON", "Требуется тело запроса JSON.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw new RequestBodyError(413, "PAYLOAD_TOO_LARGE", "Превышен размер запроса.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new RequestBodyError(400, "INVALID_JSON", "Некорректный JSON."); }
}

export function reviewErrorResponse(error: unknown): Response {
  if (error instanceof UnauthenticatedError || error instanceof InvalidOriginError || error instanceof AuthConfigurationError) return authErrorResponse(error);
  if (error instanceof DatabaseAccessError) return apiError(404, "NOT_FOUND", "Ресурс не найден.");
  if (error instanceof DatabaseConflictError) return apiError(409, "REVIEW_CONFLICT", "Данные изменились. Обновите результат.");
  if (error instanceof ZodError) return apiError(422, "VALIDATION_ERROR", "Проверьте количество, причину и параметры запроса.");
  if (error instanceof RequestBodyError) return apiError(error.status, error.code, error.message);
  return apiError(503, "SERVICE_UNAVAILABLE", "Сервис временно недоступен. Повторите попытку позже.");
}
