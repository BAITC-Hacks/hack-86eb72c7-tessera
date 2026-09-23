import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { ReviewPatchSchema, validateReviewQuantity } from "../contracts/review";
import { canonicalDecimal, DatabaseAccessError, DatabaseConflictError } from "./db";
import { getPool } from "./db/pool";

type RunState = {
  id: string; project_id: string; review_version: number; status: string; run_mode: string;
  coverage_gate: string; blocking_reasons: unknown; safe_error: unknown;
  configuration: { runMode?: string };
};
type Line = {
  id: string; recommended_quantity: string | null; reviewed_quantity: string | null;
  reason: string | null; unit: string; quantity_status: string; supplier_id: string; sku: string; name: string; quantity_precision: number | null; quantity_step: string | null;
};
export function reviewSnapshotHash(lines: { recommendationId: string; quantity: string | null }[]) {
  return createHash("sha256").update(JSON.stringify([...lines].sort((a,b) => a.recommendationId.localeCompare(b.recommendationId))
    .map((line) => [line.recommendationId, line.quantity === null ? null : canonicalDecimal(line.quantity)]))).digest("hex");
}
async function ownedRun(client: PoolClient, userId: string, runId: string): Promise<RunState> {
  if (!userId) throw new DatabaseAccessError();
  const result = await client.query<RunState>(`SELECT r.* FROM calculation_runs r JOIN projects p ON p.id=r.project_id
    WHERE r.id=$1 AND p.owner_user_id=$2 AND p.archived_at IS NULL FOR UPDATE OF p,r`, [runId,userId]);
  if (!result.rowCount) throw new DatabaseAccessError();
  return result.rows[0];
}
async function snapshot(client: PoolClient, run: RunState) {
  const result = await client.query<Line>(`SELECT r.id,r.recommended_quantity,r.quantity_status,r.unit,r.supplier_id,p.sku,p.name,p.quantity_precision,p.quantity_step,rv.reviewed_quantity,rv.reason
    FROM recommendations r JOIN products p ON p.id=r.product_id AND p.project_id=r.project_id AND p.dataset_version_id=r.dataset_version_id LEFT JOIN LATERAL (
      SELECT reviewed_quantity,reason FROM recommendation_reviews
      WHERE recommendation_id=r.id AND run_id=$1 AND review_version<=$2 ORDER BY review_version DESC LIMIT 1
    ) rv ON true WHERE r.run_id=$1 ORDER BY r.id`, [run.id,run.review_version]);
  const rows = result.rows.map((line) => ({
    recommendationId: line.id,
    recommendedQty: line.recommended_quantity === null ? null : canonicalDecimal(line.recommended_quantity),
    reviewedQty: line.reviewed_quantity === null ? null : canonicalDecimal(line.reviewed_quantity),
    quantity: line.recommended_quantity === null ? null : canonicalDecimal(line.reviewed_quantity ?? line.recommended_quantity),
    reason: line.reason, unit: line.unit, supplierId: line.supplier_id, sku: line.sku, name: line.name, quantityPrecision: line.quantity_precision, quantityStep: line.quantity_step === null ? null : canonicalDecimal(line.quantity_step),
  }));
  const snapshotHash = reviewSnapshotHash(rows);
  const approved = await client.query(`SELECT id,review_version,author_user_id,approved_at FROM approvals
    WHERE run_id=$1 AND review_version=$2 AND lines_hash=$3`, [run.id,run.review_version,snapshotHash]);
  const record = approved.rows[0];
  const approval = record ? { id: record.id as string, reviewVersion: record.review_version as number,
    authorUserId: record.author_user_id as string, approvedAt: new Date(record.approved_at).toISOString() } : null;
  const canApprove = run.status === "succeeded" && run.run_mode === "full" && run.configuration.runMode === "full"
    && run.coverage_gate === "complete" && Array.isArray(run.blocking_reasons) && run.blocking_reasons.length === 0
    && !run.safe_error && rows.length > 0 && result.rows.every((row) => row.quantity_status === "known" && row.recommended_quantity !== null)
    && rows.some((row) => row.quantity !== null && row.quantity !== "0");
  return { runId: run.id, reviewVersion: run.review_version, snapshotHash, rows, approval, canApprove, canExport: approval !== null && canApprove };
}
async function withTransaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const value = await action(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
export async function readReview(userId: string, runId: string) {
  return withTransaction(async (client) => snapshot(client, await ownedRun(client,userId,runId)));
}
export async function saveReview(userId: string, runId: string, input: unknown) {
  const parsed = ReviewPatchSchema.parse(input);
  return withTransaction(async (client) => {
    const run = await ownedRun(client,userId,runId);
    if (run.review_version !== parsed.reviewVersion || run.status !== "succeeded") throw new DatabaseConflictError();
    const current = await snapshot(client,run);
    for (const change of parsed.changes) {
      const line = current.rows.find((row) => row.recommendationId === change.recommendationId);
      if (!line) throw new DatabaseAccessError();
      if (line.recommendedQty === null) throw new DatabaseConflictError();
    }
    for (const change of parsed.changes) {
      const line = current.rows.find((row) => row.recommendationId === change.recommendationId)!;
      validateReviewQuantity(change.reviewedQty, line.quantityPrecision, line.quantityStep);
    }
    const nextVersion = run.review_version + 1;
    for (const change of parsed.changes) {
      await client.query(`INSERT INTO recommendation_reviews(id,project_id,run_id,recommendation_id,review_version,reviewed_quantity,reason,author_user_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(),run.project_id,runId,change.recommendationId,nextVersion,change.reviewedQty,change.reason,userId]);
    }
    await client.query("UPDATE calculation_runs SET review_version=$2,state_version=state_version+1 WHERE id=$1", [runId,nextVersion]);
    await client.query(`INSERT INTO audit_events(id,project_id,sequence_no,actor_user_id,action,resource_type,resource_id,safe_payload)
      SELECT $1,$2,COALESCE(MAX(sequence_no),0)+1,$3,'review_changed','calculation_run',$4,$5::jsonb FROM audit_events WHERE project_id=$2`,
      [randomUUID(),run.project_id,userId,runId,JSON.stringify({runId,safeCode:null})]);
    return snapshot(client,{...run,review_version:nextVersion});
  });
}
