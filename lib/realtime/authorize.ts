import "server-only";
import { apiError } from "../contracts/api";
import { parseAuthBody } from "./contracts";
import { ensurePrivateRunRoom, type RoomProvisionPort } from "./server";

export type OwnershipLookup = (userId: string, projectId: string, runId: string) => Promise<boolean>;
export type SessionPort = { allow(room: string, permissions: readonly ["*:read"]): { authorize(): Promise<{ status: number; body: string }> } };
export type AuthorizationPort = RoomProvisionPort & { prepareSession(userId: string): SessionPort };

const MAX_BODY_BYTES = 512;
const AUTH_DEADLINE_MS = 5_000;

async function readJsonBounded(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_BODY_BYTES) throw new Error("INVALID_BODY");
  if (!request.body) throw new Error("INVALID_BODY");
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("INVALID_BODY")), AUTH_DEADLINE_MS);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timedOut]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error("INVALID_BODY");
      chunks.push(value);
    }
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(merged)); }
  catch { throw new Error("INVALID_BODY"); }
}

async function deadline<T>(promise: Promise<T>, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { onTimeout?.(); reject(new Error("TIMEOUT")); }, AUTH_DEADLINE_MS);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

// A's API route must obtain userId from Clerk on the server and inject a DB
// lookup that checks both project ownership and run/project membership each time.
export async function authorizeRunRoom(
  request: Request, userId: string | null, lookup: OwnershipLookup,
  liveblocks: AuthorizationPort | null, requestId: string,
): Promise<Response> {
  if (!userId) return apiError(401, "UNAUTHENTICATED", "Требуется вход в систему.", requestId);
  let body: unknown;
  try { body = await readJsonBounded(request); }
  catch { return apiError(422, "INVALID_ROOM", "Неверная комната запуска.", requestId); }
  const parsed = parseAuthBody(body);
  if (!parsed) return apiError(422, "INVALID_ROOM", "Неверная комната запуска.", requestId);
  let owns: boolean;
  try { owns = await deadline(lookup(userId, parsed.projectId, parsed.runId)); }
  catch { return apiError(503, "LOOKUP_UNAVAILABLE", "Проверка доступа временно недоступна.", requestId); }
  if (!owns) return apiError(404, "RUN_NOT_FOUND", "Запуск не найден.", requestId);
  if (!liveblocks) return apiError(503, "REALTIME_UNAVAILABLE", "Обновления временно недоступны.", requestId);
  try {
    const roomAbort = new AbortController();
    await deadline(ensurePrivateRunRoom(liveblocks, parsed.projectId, parsed.runId, roomAbort.signal), () => roomAbort.abort());
    const result = await deadline(liveblocks.prepareSession(userId).allow(parsed.room, ["*:read"]).authorize());
    if (result.status !== 200 || typeof result.body !== "string" || result.body.length > 16_384) throw new Error("AUTHORIZE_FAILED");
    return new Response(result.body, { status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch {
    return apiError(503, "REALTIME_UNAVAILABLE", "Обновления временно недоступны.", requestId);
  }
}
