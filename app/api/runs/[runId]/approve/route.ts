import { apiData } from "@/lib/contracts/api";
import { ApproveRequestSchema } from "@/lib/contracts/review";
import { requireSameOrigin, requireUserId } from "@/lib/server/auth";
import { approveRun } from "@/lib/server/approvals";
import { readReviewJson, reviewErrorResponse, routeRunId, type RunRouteContext } from "@/lib/server/review-http";

export const runtime = "nodejs";

export async function POST(request: Request, context: RunRouteContext): Promise<Response> {
  try {
    const userId = await requireUserId();
    requireSameOrigin(request);
    const runId = await routeRunId(context);
    const input = ApproveRequestSchema.parse(await readReviewJson(request));
    return apiData(await approveRun(userId, runId, input));
  } catch (error) { return reviewErrorResponse(error); }
}
