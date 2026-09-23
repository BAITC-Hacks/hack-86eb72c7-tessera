import { apiData } from "@/lib/contracts/api";
import { requireUserId } from "@/lib/server/auth";
import { readReview } from "@/lib/server/reviews";
import { reviewErrorResponse, routeRunId, type RunRouteContext } from "@/lib/server/review-http";

export const runtime = "nodejs";

export async function GET(_request: Request, context: RunRouteContext): Promise<Response> {
  try {
    const userId = await requireUserId();
    return apiData(await readReview(userId, await routeRunId(context)));
  } catch (error) { return reviewErrorResponse(error); }
}
