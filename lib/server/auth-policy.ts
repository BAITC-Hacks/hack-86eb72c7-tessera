export class AuthConfigurationError extends Error {
  constructor() {
    super("Авторизация временно недоступна.");
    this.name = "AuthConfigurationError";
  }
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("Требуется вход в систему.");
    this.name = "UnauthenticatedError";
  }
}

export class InvalidOriginError extends Error {
  constructor() {
    super("Источник запроса не разрешён.");
    this.name = "InvalidOriginError";
  }
}

export function hasClerkKeys(publishableKey?: string, secretKey?: string): boolean {
  return Boolean(publishableKey?.trim() && secretKey?.trim());
}

export function userIdFromSession(userId: string | null | undefined): string {
  if (!userId) throw new UnauthenticatedError();
  return userId;
}

export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new InvalidOriginError();
  }
}
