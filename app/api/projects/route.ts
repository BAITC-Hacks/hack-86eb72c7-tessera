import { projectDataHandlers } from "@/lib/server/project-data-runtime"

export const runtime = "nodejs"

export function GET(request: Request) { return projectDataHandlers.listProjects(request) }
export function POST(request: Request) { return projectDataHandlers.createProject(request) }
