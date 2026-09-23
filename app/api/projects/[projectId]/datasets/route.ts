import { projectDataHandlers } from "@/lib/server/project-data-runtime"

export const runtime = "nodejs"

export function GET(request: Request, context: RouteContext<"/api/projects/[projectId]/datasets">) { return projectDataHandlers.listDatasets(request, context) }
