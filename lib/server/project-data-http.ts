import "server-only"

import { apiData, apiError } from "../contracts/api"
import { ProjectDataError } from "./project-data-errors"
import { AuthConfigurationError, InvalidOriginError, UnauthenticatedError } from "./auth-policy"

type Page = { cursor?: string; limit?: number }
type Services = {
  projects: {
    list(userId: string, page: Page): Promise<unknown>
    create(userId: string, input: unknown): Promise<unknown>
    get(userId: string, projectId: string): Promise<unknown>
    update(userId: string, projectId: string, input: unknown): Promise<unknown>
    listDatasets(userId: string, projectId: string, page: Page): Promise<unknown>
  }
  imports: {
    create(userId: string, projectId: string, input: unknown): Promise<unknown>
    list(userId: string, projectId: string, page: Page): Promise<unknown>
    get(userId: string, projectId: string, importId: string, page?: Page): Promise<unknown>
    finalize(userId: string, projectId: string, importId: string, input: unknown): Promise<unknown>
    attempt(userId: string, projectId: string, importId: string, input: unknown): Promise<unknown>
  }
}
export type ProjectDataDependencies = {
  requireUserId(): Promise<string>
  requireSameOrigin(request: Request): void
  getServices(): Services | Promise<Services>
  now?: () => number
}
export type ProjectDataRouteContext = { params: Promise<{ projectId?: string; importId?: string }> }
const MAX_JSON_BYTES = 256 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new HttpError(422, "INVALID_CONTENT_TYPE", "Ожидается JSON.")
  const length = request.headers.get("content-length")
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_JSON_BYTES))
    throw new HttpError(422, "BODY_TOO_LARGE", "Превышен размер запроса.")
  if (!request.body) throw new HttpError(400, "INVALID_JSON", "Отсутствует JSON.")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_JSON_BYTES) {
        await reader.cancel()
        throw new HttpError(422, "BODY_TOO_LARGE", "Превышен размер запроса.")
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  try {
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch { throw new HttpError(400, "INVALID_JSON", "Некорректный JSON.") }
}

function page(request: Request): Page {
  const query = new URL(request.url).searchParams
  if ([...query.keys()].some(key => key !== "cursor" && key !== "limit") ||
      query.getAll("cursor").length > 1 || query.getAll("limit").length > 1)
    throw new HttpError(422, "INVALID_PAGE", "Некорректная пагинация.")
  const cursor = query.get("cursor")
  const rawLimit = query.get("limit")
  if ((cursor !== null && (!cursor || cursor.length > 1024)) ||
      (rawLimit !== null && (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100)))
    throw new HttpError(422, "INVALID_PAGE", "Некорректная пагинация.")
  return { ...(cursor ? { cursor } : {}), ...(rawLimit ? { limit: Number(rawLimit) } : {}) }
}

function safeError(error: unknown): Response {
  if (error instanceof UnauthenticatedError) return apiError(401, "UNAUTHENTICATED", error.message)
  if (error instanceof InvalidOriginError) return apiError(403, "INVALID_ORIGIN", error.message)
  if (error instanceof AuthConfigurationError) return apiError(503, "AUTH_UNAVAILABLE", error.message)
  if (error instanceof HttpError || error instanceof ProjectDataError) return apiError(error.status, error.code, error.message)
  if (error instanceof Error && error.name === "ZodError")
    return apiError(422, "INVALID_INPUT", "Некорректные поля запроса.")
  const statuses: Record<string, number> = {
    NOT_FOUND: 404, ARCHIVED: 409, CONFLICT: 409, INVALID_INPUT: 422,
    INTEGRITY_FAILED: 422, CHECKSUM_MISMATCH: 422, LIMIT_EXCEEDED: 429,
    RATE_LIMITED: 429, PROJECT_LIMIT: 429, UPLOAD_LIMIT: 429,
    UNSAFE_BUCKET: 503, STORAGE_UNAVAILABLE: 503, DATABASE_UNAVAILABLE: 503,
  }
  if (error instanceof Error && "code" in error && typeof error.code === "string" && statuses[error.code])
    return apiError(statuses[error.code], error.code, statuses[error.code] === 404
      ? "Ресурс не найден." : statuses[error.code] === 409 ? "Операция конфликтует с текущим состоянием."
      : statuses[error.code] === 429 ? "Превышен лимит операций." : statuses[error.code] === 422
      ? "Некорректные данные запроса или файла." : "Сервис временно недоступен.")
  return apiError(503, "SERVICE_UNAVAILABLE", "Сервис временно недоступен.")
}

export function createProjectDataHandlers(dependencies: ProjectDataDependencies) {
  // Локальный лимит дополняет, но не заменяет долговечные ограничения в БД.
  const requests = new Map<string, { count: number; expires: number }>()
  const now = dependencies.now ?? Date.now
  type Operation = (services: Services, userId: string, projectId: string, importId: string, input: unknown, pagination: Page) => Promise<unknown>
  function handler(mutation: boolean, scope: "none" | "project" | "import", operation: Operation, status = 200) {
    return async (request: Request, context?: ProjectDataRouteContext): Promise<Response> => {
      try {
        const userId = await dependencies.requireUserId()
        if (mutation) dependencies.requireSameOrigin(request)
        const time = now()
        for (const [key, entry] of requests) if (entry.expires <= time) requests.delete(key)
        const rateKey = userId + (mutation ? ":write" : ":read")
        const entry = requests.get(rateKey) ?? { count: 0, expires: time + 60_000 }
        if (entry.count >= (mutation ? 30 : 120) || (!requests.has(rateKey) && requests.size >= 10_000))
          throw new HttpError(429, "RATE_LIMITED", "Превышен лимит запросов.")
        entry.count++
        requests.set(rateKey, entry)
        const params = context ? await context.params : {}
        const projectId = params.projectId ?? ""
        const importId = params.importId ?? ""
        if ((scope !== "none" && !UUID.test(projectId)) || (scope === "import" && !UUID.test(importId)))
          throw new HttpError(422, "INVALID_ID", "Некорректный идентификатор.")
        const pagination = page(request)
        const input = mutation ? await readJson(request) : undefined
        const services = await dependencies.getServices()
        return apiData(await operation(services, userId, projectId, importId, input, pagination), { status })
      } catch (error) { return safeError(error) }
    }
  }
  return {
    listProjects: handler(false, "none", (s, u, _p, _i, _b, q) => s.projects.list(u, q)),
    createProject: handler(true, "none", (s, u, _p, _i, b) => s.projects.create(u, b), 201),
    getProject: handler(false, "project", (s, u, p) => s.projects.get(u, p)),
    updateProject: handler(true, "project", (s, u, p, _i, b) => s.projects.update(u, p, b)),
    listImports: handler(false, "project", (s, u, p, _i, _b, q) => s.imports.list(u, p, q)),
    createImport: handler(true, "project", (s, u, p, _i, b) => s.imports.create(u, p, b), 201),
    getImport: handler(false, "import", (s, u, p, i, _b, q) => s.imports.get(u, p, i, q)),
    finalizeImport: handler(true, "import", (s, u, p, i, b) => s.imports.finalize(u, p, i, b)),
    createAttempt: handler(true, "import", (s, u, p, i, b) => s.imports.attempt(u, p, i, b), 201),
    listDatasets: handler(false, "project", (s, u, p, _i, _b, q) => s.projects.listDatasets(u, p, q)),
  }
}
