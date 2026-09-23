import "server-only"

import { S3Client } from "@aws-sdk/client-s3"
import { requireSameOrigin, requireUserId } from "./auth"
import { getProjectDataPool } from "./db/pool"
import { createProjectService } from "./projects"
import { createImportLifecycle } from "./imports/lifecycle"
import { createUploadStorage } from "./imports/upload-storage"
import { createProjectDataHandlers } from "./project-data-http"

let projects: ReturnType<typeof createProjectService> | undefined
let imports: ReturnType<typeof createImportLifecycle> | undefined

function getProjects() {
  projects ??= createProjectService(getProjectDataPool())
  return projects
}

function getImports() {
  if (!imports) {
    const bucket = process.env.S3_BUCKET
    const region = process.env.S3_REGION
    const accessKeyId = process.env.S3_ACCESS_KEY_ID
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY
    if (!bucket || !region || Boolean(accessKeyId) !== Boolean(secretAccessKey))
      throw new Error("Хранилище не настроено.")
    const client = new S3Client({
      region,
      ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    })
    imports = createImportLifecycle({
      pool: getProjectDataPool(),
      storage: createUploadStorage({ client, bucket }),
    })
  }
  return imports
}

export const projectDataHandlers = createProjectDataHandlers({
  requireUserId,
  requireSameOrigin,
  getServices: () => ({
    get projects() { return getProjects() },
    get imports() { return getImports() },
  }),
})
