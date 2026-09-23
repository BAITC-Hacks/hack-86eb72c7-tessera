import { projectDataHandlers } from "@/lib/server/project-data-runtime"

export const runtime = "nodejs"

export const GET = projectDataHandlers.listImports
export const POST = projectDataHandlers.createImport
