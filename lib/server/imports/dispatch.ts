import "server-only"

import { createHash, randomUUID } from "node:crypto"
import type { PoolClient } from "pg"

/** The intent is committed with the import, never after the HTTP response. */
export async function insertImportDispatch(
  client: PoolClient,
  input: { projectId: string; importId: string; manifestHash: string },
): Promise<void> {
  const payload = {
    businessId: input.importId,
    manifestHash: input.manifestHash,
    operationType: "import",
  }
  const key = `import:${input.importId}`
  const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex")
  await client.query(
    `INSERT INTO dispatch_intents
      (id, project_id, operation_type, import_id, idempotency_key, payload_version, payload_hash, status)
     VALUES ($1, $2, 'import', $3, $4, '1', $5, 'pending')
     ON CONFLICT (import_id) DO NOTHING`,
    [randomUUID(), input.projectId, input.importId, key, hash],
  )
}
