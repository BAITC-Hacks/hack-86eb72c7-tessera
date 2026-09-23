import { projectDataHandlers } from "@/lib/server/project-data-runtime"

export const runtime = "nodejs"

export const GET = projectDataHandlers.getProject
export const PATCH = projectDataHandlers.updateProject
