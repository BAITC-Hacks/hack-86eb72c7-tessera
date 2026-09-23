import { projectDataHandlers } from "@/lib/server/project-data-runtime"

export const runtime = "nodejs"

export function GET(request: Request, context: RouteContext<"/api/projects/[projectId]">) { return projectDataHandlers.getProject(request, context) }
export function PATCH(request: Request, context: RouteContext<"/api/projects/[projectId]">) { return projectDataHandlers.updateProject(request, context) }
