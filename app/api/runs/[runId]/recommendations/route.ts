import { apiData } from "@/lib/contracts/api";
import { ReviewPatchSchema } from "@/lib/contracts/review";
import { requireSameOrigin, requireUserId } from "@/lib/server/auth";
import { saveReview } from "@/lib/server/reviews";
import { readReviewJson, reviewErrorResponse, routeRunId, type RunRouteContext } from "@/lib/server/review-http";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: RunRouteContext): Promise<Response> {
  try {
    const userId = await requireUserId();
    requireSameOrigin(request);
    const runId = await routeRunId(context);
    const input = ReviewPatchSchema.parse(await readReviewJson(request));
    return apiData(await saveReview(userId, runId, input));
  } catch (error) { return reviewErrorResponse(error); }
}
