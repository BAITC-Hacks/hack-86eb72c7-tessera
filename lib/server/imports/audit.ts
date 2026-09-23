import "server-only"

import { randomUUID } from "node:crypto"
import type { PoolClient } from "pg"

/** Caller holds the project row lock, serializing per-project audit sequence numbers. */
export async function appendImportAudit(client: PoolClient, input: {
  projectId: string; importId: string; actorUserId: string; status: string; stateVersion: number
}): Promise<void> {
  await client.query(`INSERT INTO audit_events
    (id,project_id,sequence_no,actor_user_id,action,resource_type,resource_id,safe_payload)
    VALUES($1,$2,(SELECT COALESCE(MAX(sequence_no),0)+1 FROM audit_events WHERE project_id=$2),
      $3,$4,'import',$5,$6::jsonb)`,
    [randomUUID(),input.projectId,input.actorUserId,`import_${input.status.replaceAll("-", "_")}`,
      input.importId,JSON.stringify({ status: input.status, stateVersion: input.stateVersion })])
}
