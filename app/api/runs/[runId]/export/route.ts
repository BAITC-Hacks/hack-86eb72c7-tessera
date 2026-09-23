import { apiError } from "@/lib/contracts/api";
import { UuidSchema } from "@/lib/contracts/primitives";
import { requireUserId } from "@/lib/server/auth";
import { exportApproval } from "@/lib/server/exports";
import { reviewErrorResponse, routeRunId, type RunRouteContext } from "@/lib/server/review-http";

export const runtime = "nodejs";

export async function GET(request: Request, context: RunRouteContext): Promise<Response> {
  try {
    const userId = await requireUserId();
    const runId = await routeRunId(context);
    const query = new URL(request.url).searchParams;
    const approvalId = UuidSchema.parse(query.get("approvalId"));
    if (query.get("format") !== "csv") return apiError(422, "INVALID_FORMAT", "Доступен только формат CSV.");
    const artifact = await exportApproval(userId, runId, approvalId);
    return new Response(typeof artifact.body === "string" ? artifact.body : new Uint8Array(artifact.body), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="order-${approvalId}.csv"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) { return reviewErrorResponse(error); }
}
