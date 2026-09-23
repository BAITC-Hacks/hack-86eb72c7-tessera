import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { ApproveRequestSchema } from '../contracts/review';
import { canonicalDecimal, canonicalJsonHash, DatabaseAccessError, DatabaseConflictError } from './db';
import { getPool } from './db/pool';

type ApprovalRow = {
  id: string;
  review_version: number;
  author_user_id: string;
  approved_at: Date | string;
  request_hash: string;
};

type RunRow = {
  project_id: string;
  review_version: number;
  run_mode: string;
  status: string;
  coverage_gate: string;
  blocking_reasons: unknown;
  safe_error: string | null;
  configuration: { runMode?: string };
};

type LineRow = {
  id: string;
  recommended_quantity: string | null;
  reviewed_quantity: string | null;
  quantity_status: string;
};

function approvalDto(row: ApprovalRow) {
  return {
    id: row.id,
    reviewVersion: row.review_version,
    authorUserId: row.author_user_id,
    approvedAt: new Date(row.approved_at).toISOString(),
  };
}

/** Утверждение фиксирует точную редакцию; отправка поставщику здесь невозможна. */
export async function approveRun(userId: string, runId: string, input: unknown) {
  if (!userId) throw new DatabaseAccessError();
  const request = ApproveRequestSchema.parse(input);
  const requestHash = canonicalJsonHash({ runId, ...request });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Порядок блокировок совпадает с репозиториями: проект, затем запуск.
    const project = await client.query<{ project_id: string }>(
      `SELECT p.id AS project_id FROM projects p
       JOIN calculation_runs r ON r.project_id=p.id
       WHERE r.id=$1 AND p.owner_user_id=$2 AND p.archived_at IS NULL
       FOR UPDATE OF p`,
      [runId, userId],
    );
    if (!project.rowCount) throw new DatabaseAccessError();
    const run = await client.query<RunRow>(
      'SELECT * FROM calculation_runs WHERE id=$1 AND project_id=$2 FOR UPDATE',
      [runId, project.rows[0].project_id],
    );
    if (!run.rowCount) throw new DatabaseAccessError();
    const existing = await client.query<ApprovalRow>(
      'SELECT * FROM approvals WHERE run_id=$1 AND idempotency_key=$2',
      [runId, request.idempotencyKey],
    );
    if (existing.rowCount) {
      if (existing.rows[0].request_hash !== requestHash) throw new DatabaseConflictError();
      await client.query('COMMIT');
      return approvalDto(existing.rows[0]);
    }

    const state = run.rows[0];
    if (
      state.review_version !== request.reviewVersion ||
      state.configuration.runMode !== 'full' || state.run_mode !== 'full' || state.status !== 'succeeded' ||
      state.coverage_gate !== 'complete' ||
      !Array.isArray(state.blocking_reasons) || state.blocking_reasons.length > 0 ||
      state.safe_error
    ) throw new DatabaseConflictError();

    const lines = await client.query<LineRow>(
      `SELECT r.id,r.recommended_quantity,r.quantity_status,rv.reviewed_quantity
       FROM recommendations r
       LEFT JOIN LATERAL (
         SELECT reviewed_quantity FROM recommendation_reviews
         WHERE recommendation_id=r.id AND run_id=$1 AND review_version<=$2
         ORDER BY review_version DESC LIMIT 1
       ) rv ON true
       WHERE r.run_id=$1 ORDER BY r.id`,
      [runId, request.reviewVersion],
    );
    if (!lines.rowCount || lines.rows.some(
      (line) => line.recommended_quantity === null || line.quantity_status !== 'known',
    )) throw new DatabaseConflictError();
    const snapshot = lines.rows.map((line) => {
      const quantity = line.reviewed_quantity ?? line.recommended_quantity;
      if (quantity === null) throw new DatabaseConflictError();
      return [line.id, canonicalDecimal(quantity)];
    });
    if (!snapshot.some(([, quantity]) => quantity !== '0')) throw new DatabaseConflictError();
    const snapshotHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    if (snapshotHash !== request.expectedSnapshotHash) throw new DatabaseConflictError();

    // Новый ключ не создаёт повторный снимок уже утверждённой редакции.
    const approved = await client.query(
      'SELECT id FROM approvals WHERE run_id=$1 AND review_version=$2',
      [runId, request.reviewVersion],
    );
    if (approved.rowCount) throw new DatabaseConflictError();
    const result = await client.query<ApprovalRow>(
      `INSERT INTO approvals
       (id,project_id,run_id,review_version,lines_hash,author_user_id,idempotency_key,request_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [randomUUID(), state.project_id, runId, request.reviewVersion, snapshotHash,
        userId, request.idempotencyKey, requestHash],
    );
    await client.query(`INSERT INTO audit_events(id,project_id,sequence_no,actor_user_id,action,resource_type,resource_id,safe_payload)
      SELECT $1,$2,COALESCE(MAX(sequence_no),0)+1,$3,'approved','approval',$4,$5::jsonb FROM audit_events WHERE project_id=$2`,
      [randomUUID(),state.project_id,userId,result.rows[0].id,JSON.stringify({runId,safeCode:null})]);
    await client.query('COMMIT');
    return approvalDto(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
