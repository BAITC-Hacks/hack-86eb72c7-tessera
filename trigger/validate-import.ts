import { task } from "@trigger.dev/sdk"
import { getProjectDataPool } from "../lib/server/db/pool"
import { createImportPrivateStorage } from "../lib/server/imports/private-storage"
import {
  PayloadSchema, failImportJob, isTemporaryImportError, processImportJob,
  type ImportJobPayload,
} from "../lib/server/imports/job"

export const validateImportTask = task<"validate-import", ImportJobPayload>({
  id: "validate-import",
  queue: { concurrencyLimit: 2 },
  maxDuration: 600,
  retry: { maxAttempts: 3, minTimeoutInMs: 1000, maxTimeoutInMs: 5000, factor: 2 },
  onFailure: async ({ payload }) => {
    const parsed = PayloadSchema.safeParse(payload)
    if (!parsed.success) return
    try { await failImportJob(parsed.data, getProjectDataPool()) } catch { /* recovery can still inspect validating */ }
  },
  run: async (payload: ImportJobPayload, { ctx }) => {
    const parsed = PayloadSchema.safeParse(payload)
    if (!parsed.success) throw new Error("invalid_import_payload")
    try {
      const pool = getProjectDataPool()
      return await processImportJob(parsed.data, { pool, storage: createImportPrivateStorage(pool) })
    } catch (error) {
      if (isTemporaryImportError(error) && ctx.attempt.number < 3)
        throw new Error("import_temporarily_unavailable")
      try { await failImportJob(parsed.data, getProjectDataPool()) }
      catch { throw new Error("import_state_unavailable") }
      return { status: "failed" as const, datasetVersionId: null }
    }
  },
})
