import { projectDataHandlers } from "@/lib/server/project-data-runtime"

export const runtime = "nodejs"

export function GET(request: Request, context: RouteContext<"/api/projects/[projectId]/imports/[importId]">) { return projectDataHandlers.getImport(request, context) }
