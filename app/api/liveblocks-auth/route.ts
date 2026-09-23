import { requireSameOrigin, requireUserId } from "@/lib/server/auth";
import { getProjectDataPool } from "@/lib/server/db/pool";
import { createLiveblocksAuthHandler } from "@/lib/realtime/auth-route";
import { createRunOwnershipLookup } from "@/lib/realtime/ownership";
import { liveblocksServerFromEnv } from "@/lib/realtime/server";

export const runtime = "nodejs";

export const POST = createLiveblocksAuthHandler({
  requireUserId,
  requireSameOrigin,
  // Pool construction is lazy; importing this route never opens a connection.
  lookup: (userId, projectId, runId) =>
    createRunOwnershipLookup(getProjectDataPool())(userId, projectId, runId),
  getLiveblocks: liveblocksServerFromEnv,
});
