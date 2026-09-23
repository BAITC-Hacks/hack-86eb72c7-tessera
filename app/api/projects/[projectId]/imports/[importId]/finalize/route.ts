import { projectDataHandlers } from "@/lib/server/project-data-runtime"

export const runtime = "nodejs"

export function POST(request: Request, context: RouteContext<"/api/projects/[projectId]/imports/[importId]/finalize">) { return projectDataHandlers.finalizeImport(request, context) }
