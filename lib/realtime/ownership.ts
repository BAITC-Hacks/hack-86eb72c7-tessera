import "server-only";
import type { Pool } from "pg";
import type { OwnershipLookup } from "./authorize";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One DB read binds the run to the requested project and its active owner. */
export function createRunOwnershipLookup(pool: Pick<Pool, "query">): OwnershipLookup {
  return async (userId, projectId, runId) => {
    if (!userId || !UUID.test(projectId) || !UUID.test(runId)) return false;
    const result = await pool.query(
      `SELECT 1 FROM calculation_runs AS run
       JOIN projects AS project ON project.id = run.project_id
       WHERE run.id = $1::uuid AND run.project_id = $2::uuid
         AND project.owner_user_id = $3 AND project.archived_at IS NULL
       LIMIT 1`,
      [runId, projectId, userId],
    );
    return Boolean(result.rowCount);
  };
}
