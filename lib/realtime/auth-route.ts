import "server-only";
import { apiError } from "../contracts/api";
import { AuthConfigurationError, InvalidOriginError, UnauthenticatedError } from "../server/auth-policy";
import { authorizeRunRoom, type AuthorizationPort, type OwnershipLookup } from "./authorize";

export type LiveblocksAuthDependencies = {
  requireUserId(): Promise<string>;
  requireSameOrigin(request: Request): void;
  lookup: OwnershipLookup;
  getLiveblocks(): AuthorizationPort | null;
};

export function createLiveblocksAuthHandler(dependencies: LiveblocksAuthDependencies) {
  return async (request: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    let userId: string;
    try {
      userId = await dependencies.requireUserId();
      dependencies.requireSameOrigin(request);
    } catch (error) {
      if (error instanceof UnauthenticatedError) return apiError(401, "UNAUTHENTICATED", error.message, requestId);
      if (error instanceof InvalidOriginError) return apiError(403, "INVALID_ORIGIN", error.message, requestId);
      if (error instanceof AuthConfigurationError) return apiError(503, "AUTH_UNAVAILABLE", error.message, requestId);
      return apiError(503, "AUTH_UNAVAILABLE", "Авторизация временно недоступна.", requestId);
    }
    let liveblocks: AuthorizationPort | null;
    try { liveblocks = dependencies.getLiveblocks(); }
    catch { return apiError(503, "REALTIME_UNAVAILABLE", "Обновления временно недоступны.", requestId); }
    return authorizeRunRoom(request, userId, dependencies.lookup, liveblocks, requestId);
  };
}
