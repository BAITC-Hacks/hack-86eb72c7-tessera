import 'server-only';

import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export type DispatchOperation = 'calculation' | 'import';

export type DispatchPayload =
  | { runId: string; projectId: string; datasetVersionId: string; requestedBy: string }
  | { importId: string; projectId: string; requestedBy: string };

export interface DispatchTransport {
  trigger(operation: DispatchOperation, payload: DispatchPayload, idempotencyKey: string): Promise<string>;
  cancel?(externalTaskId: string): Promise<void>;
}

type LeasedIntent = {
  id: string;
  project_id: string;
  operation_type: DispatchOperation;
  import_id: string | null;
  run_id: string | null;
  attempts: number;
  lease_until: string;
  business_status: string | null;
  dataset_version_id: string | null;
  requested_by: string | null;
  owner_user_id: string | null;
  archived_at: Date | null;
  payload_version: string;
  payload_hash: string;
  configuration_hash: string | null;
  manifest_hash: string | null;
};

const MAX_ATTEMPTS = 5;
const LEASE_SECONDS = 120;
const TERMINAL_RUNS = new Set(['cancelled', 'failed', 'succeeded']);
const TERMINAL_IMPORTS = new Set(['ready', 'invalid', 'needs_mapping', 'failed']);

async function transaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await action(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function isTerminal(intent: LeasedIntent): boolean {
  return intent.operation_type === 'calculation'
    ? TERMINAL_RUNS.has(intent.business_status ?? '')
    : TERMINAL_IMPORTS.has(intent.business_status ?? '');
}

async function failBusiness(client: PoolClient, intent: LeasedIntent): Promise<void> {
  if (intent.operation_type === 'calculation') {
    await client.query(`UPDATE calculation_runs SET status='failed',safe_error='dispatch_failed',
      blocking_reasons='["run_failed"]'::jsonb,finished_at=now(),state_version=state_version+1
      WHERE id=$1 AND status IN ('queued','running')`, [intent.run_id]);
  } else {
    await client.query(`UPDATE imports SET status='failed',safe_error='dispatch_failed',
      updated_at=now(),state_version=state_version+1
      WHERE id=$1 AND status IN ('awaiting-validation','validating')`, [intent.import_id]);
  }
}

async function lease(pool: Pool, operation?: DispatchOperation, businessId?: string): Promise<LeasedIntent | null> {
  return transaction(pool, async (client) => {
    const result = await client.query<LeasedIntent>(`
      SELECT d.id, d.project_id, d.operation_type, d.import_id, d.run_id, d.attempts,
        d.payload_version,d.payload_hash,r.configuration_hash,i.manifest_hash,
        d.lease_until::text AS lease_until, COALESCE(r.status, i.status) AS business_status,
        r.dataset_version_id, r.requested_by,
        p.owner_user_id, p.archived_at
      FROM dispatch_intents d
      LEFT JOIN calculation_runs r ON r.id=d.run_id AND r.project_id=d.project_id
      LEFT JOIN imports i ON i.id=d.import_id AND i.project_id=d.project_id
      LEFT JOIN projects p ON p.id=d.project_id
      WHERE (d.status='pending' OR (d.status='leased' AND d.lease_until<=now()))
        AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=now())
        AND p.archived_at IS NULL
        AND ($1::text IS NULL OR d.operation_type=$1)
        AND ($2::uuid IS NULL OR COALESCE(d.run_id,d.import_id)=$2)
      ORDER BY d.created_at,d.id
      LIMIT 1 FOR UPDATE OF d SKIP LOCKED`, [operation ?? null, businessId ?? null]);
    const intent = result.rows[0];
    if (!intent) return null;
    const eligible = intent.operation_type === 'calculation'
      ? ['queued', 'running'].includes(intent.business_status ?? '')
      : ['awaiting-validation', 'validating'].includes(intent.business_status ?? '');
    if (!eligible || !intent.owner_user_id || intent.archived_at || isTerminal(intent)) {
      await client.query("UPDATE dispatch_intents SET status='failed',safe_error='business_unavailable',lease_until=NULL,next_attempt_at=NULL WHERE id=$1", [intent.id]);
      return { ...intent, business_status: null };
    }
    if (intent.attempts >= MAX_ATTEMPTS) {
      await client.query("UPDATE dispatch_intents SET status='failed',safe_error='dispatch_exhausted',lease_until=NULL,next_attempt_at=NULL WHERE id=$1", [intent.id]);
      await failBusiness(client, intent);
      return { ...intent, business_status: null };
    }
    const leased = await client.query<LeasedIntent>(`
      UPDATE dispatch_intents SET status='leased',attempts=attempts+1,
        lease_until=now()+($2::int * interval '1 second'),next_attempt_at=NULL,safe_error=NULL
      WHERE id=$1 RETURNING lease_until::text AS lease_until,attempts`, [intent.id, LEASE_SECONDS]);
    return { ...intent, ...leased.rows[0] };
  });
}

function retryable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = 'status' in error ? Number(error.status) : NaN;
  if (Number.isFinite(status)) return status >= 500 || status === 408 || status === 429;
  const code = 'code' in error ? String(error.code) : '';
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return true;
  return 'cause' in error && retryable(error.cause);
}

async function acknowledge(pool: Pool, intent: LeasedIntent, externalTaskId: string): Promise<boolean> {
  return transaction(pool, async (client) => {
    const updated = await client.query(`UPDATE dispatch_intents SET status='sent',external_task_id=$3,
      lease_until=NULL,next_attempt_at=NULL,safe_error=NULL
      WHERE id=$1 AND status='leased' AND lease_until=$2 RETURNING id`, [intent.id, intent.lease_until, externalTaskId]);
    if (!updated.rowCount) return false;
    if (intent.operation_type === 'calculation') {
      await client.query(`UPDATE calculation_runs SET trigger_run_id=$2,state_version=state_version+1
        WHERE id=$1 AND trigger_run_id IS DISTINCT FROM $2`, [intent.run_id, externalTaskId]);
      const run = await client.query('SELECT status FROM calculation_runs WHERE id=$1', [intent.run_id]);
      return run.rows[0]?.status === 'cancelled';
    }
    return false;
  });
}

export async function recoverCancellation(pool: Pool, transport: DispatchTransport, runId?: string): Promise<'acknowledged' | 'retry' | 'skipped'> {
  if (!transport.cancel) return 'skipped';
  const intent = await transaction(pool, async (client) => {
    const found = await client.query<{ id: string; external_task_id: string; cancel_attempts: number }>(`
      SELECT d.id,d.external_task_id,d.cancel_attempts FROM dispatch_intents d
      JOIN calculation_runs r ON r.id=d.run_id AND r.project_id=d.project_id
      JOIN projects p ON p.id=d.project_id
      WHERE d.operation_type='calculation' AND d.status='sent' AND r.status='cancelled'
        AND p.archived_at IS NULL AND d.external_task_id IS NOT NULL
        AND d.cancel_ack_at IS NULL AND d.cancel_attempts<$1
        AND d.safe_error IS DISTINCT FROM 'cancel_unconfirmed'
        AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=now())
        AND ($2::uuid IS NULL OR d.run_id=$2)
      ORDER BY d.created_at,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`, [MAX_ATTEMPTS, runId ?? null]);
    const row = found.rows[0];
    if (!row) return null;
    await client.query(`UPDATE dispatch_intents SET cancel_attempts=cancel_attempts+1,
      next_attempt_at=now()+interval '120 seconds',safe_error='cancel_pending' WHERE id=$1`, [row.id]);
    return { ...row, cancel_attempts: row.cancel_attempts + 1 };
  });
  if (!intent) return 'skipped';
  try {
    await transport.cancel(intent.external_task_id);
    await pool.query(`UPDATE dispatch_intents SET cancel_ack_at=now(),next_attempt_at=NULL,safe_error=NULL
      WHERE id=$1 AND cancel_ack_at IS NULL`, [intent.id]);
    return 'acknowledged';
  } catch (error) {
    const shouldRetry = retryable(error) && intent.cancel_attempts < MAX_ATTEMPTS;
    const delaySeconds = Math.min(300, 5 * 2 ** (intent.cancel_attempts - 1));
    await pool.query(`UPDATE dispatch_intents SET safe_error=$2,
      next_attempt_at=CASE WHEN $3::boolean THEN now()+($4::int * interval '1 second') ELSE NULL END
      WHERE id=$1 AND cancel_ack_at IS NULL`,
    [intent.id, shouldRetry ? 'cancel_pending' : 'cancel_unconfirmed', shouldRetry, delaySeconds]);
    return 'retry';
  }
}

async function recordFailure(pool: Pool, intent: LeasedIntent, error: unknown): Promise<void> {
  const willRetry = retryable(error) && intent.attempts < MAX_ATTEMPTS;
  const delaySeconds = Math.min(300, 5 * 2 ** (intent.attempts - 1));
  await transaction(pool, async (client) => {
    const result = await client.query(`UPDATE dispatch_intents SET status=$3,
      safe_error=$4,lease_until=NULL,
      next_attempt_at=CASE WHEN $5::boolean THEN now()+($6::int * interval '1 second') ELSE NULL END
      WHERE id=$1 AND status='leased' AND lease_until=$2 RETURNING id`,
    [intent.id, intent.lease_until, willRetry ? 'pending' : 'failed', willRetry ? 'dispatch_unavailable' : 'dispatch_rejected', willRetry, delaySeconds]);
    if (!result.rowCount || willRetry) return;
    await failBusiness(client, intent);
  });
}

function validPayload(intent: LeasedIntent, id: string): boolean {
  const value = intent.operation_type === 'calculation'
    ? { businessId: id, configurationHash: intent.configuration_hash, operationType: 'calculation' }
    : { businessId: id, manifestHash: intent.manifest_hash, operationType: 'import' };
  return intent.payload_version === '1' &&
    intent.payload_hash === createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function dispatchOne(pool: Pool, transport: DispatchTransport, operation?: DispatchOperation, businessId?: string): Promise<'sent' | 'retry' | 'skipped'> {
  const intent = await lease(pool, operation, businessId);
  if (!intent || !intent.business_status) return 'skipped';
  const id = intent.operation_type === 'calculation' ? intent.run_id : intent.import_id;
  if (!id) return 'skipped';
  if (!validPayload(intent, id)) {
    await recordFailure(pool, intent, { status: 422 });
    return 'retry';
  }
  const idempotencyKey = `${intent.operation_type}:${id}`;
  const payload: DispatchPayload = intent.operation_type === 'calculation'
    ? { runId: id, projectId: intent.project_id, datasetVersionId: intent.dataset_version_id!, requestedBy: intent.requested_by! }
    : { importId: id, projectId: intent.project_id, requestedBy: intent.owner_user_id! };
  try {
    const externalTaskId = await transport.trigger(intent.operation_type, payload, idempotencyKey);
    if (!externalTaskId || externalTaskId.length > 200) throw new TypeError('Invalid Trigger run ID');
    const cancelled = await acknowledge(pool, intent, externalTaskId);
    if (cancelled) await recoverCancellation(pool, transport, intent.run_id!);
    return 'sent';
  } catch (error) {
    await recordFailure(pool, intent, error);
    return 'retry';
  }
}

export async function recoverDispatch(pool: Pool, transport: DispatchTransport, limit = 25): Promise<{ sent: number; retry: number; skipped: number }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid dispatch batch limit');
  const result = { sent: 0, retry: 0, skipped: 0 };
  for (let index = 0; index < limit; index++) {
    const outcome = await dispatchOne(pool, transport);
    result[outcome]++;
  }
  return result;
}

export async function recoverCancelledRuns(pool: Pool, transport: DispatchTransport, limit = 25): Promise<{ acknowledged: number; retry: number }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid cancellation batch limit');
  const result = { acknowledged: 0, retry: 0 };
  for (let index = 0; index < limit; index++) {
    const outcome = await recoverCancellation(pool, transport);
    if (outcome === 'skipped') break;
    result[outcome]++;
  }
  return result;
}
