import { projectDataHandlers } from "@/lib/server/project-data-runtime"

export const runtime = "nodejs"

export function GET(request: Request, context: RouteContext<"/api/projects/[projectId]/imports">) { return projectDataHandlers.listImports(request, context) }
export function POST(request: Request, context: RouteContext<"/api/projects/[projectId]/imports">) { return projectDataHandlers.createImport(request, context) }
