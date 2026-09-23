export type ApiSuccess<T> = { data: T };

export type ApiFailure = {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
};

export function apiData<T>(data: T, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json({ data } satisfies ApiSuccess<T>, { ...init, headers });
}

export function apiError(
  status: number,
  code: string,
  message: string,
  requestId = crypto.randomUUID(),
  details?: unknown,
): Response {
  const error = { code, message, requestId, ...(details === undefined ? {} : { details }) };
  return Response.json(
    { error } satisfies ApiFailure,
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
