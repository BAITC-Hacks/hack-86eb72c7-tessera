import "server-only";
import { auth } from "@clerk/nextjs/server";
import { apiError } from "@/lib/contracts/api";
import {
  AuthConfigurationError,
  InvalidOriginError,
  UnauthenticatedError,
  hasClerkKeys,
  requireSameOrigin,
  userIdFromSession,
} from "./auth-policy";

export { AuthConfigurationError, InvalidOriginError, UnauthenticatedError, requireSameOrigin };

export function isClerkConfigured(): boolean {
  return hasClerkKeys(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    process.env.CLERK_SECRET_KEY,
  );
}

export async function requireUserId(): Promise<string> {
  if (!isClerkConfigured()) throw new AuthConfigurationError();
  const { userId } = await auth();
  return userIdFromSession(userId);
}

export function authErrorResponse(error: unknown): Response {
  if (error instanceof UnauthenticatedError) {
    return apiError(401, "UNAUTHENTICATED", error.message);
  }
  if (error instanceof InvalidOriginError) {
    return apiError(403, "INVALID_ORIGIN", error.message);
  }
  if (error instanceof AuthConfigurationError) {
    return apiError(503, "AUTH_UNAVAILABLE", error.message);
  }
  throw error;
}
