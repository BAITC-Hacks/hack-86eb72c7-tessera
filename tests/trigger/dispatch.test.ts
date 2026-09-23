import assert from 'node:assert/strict';
import test from 'node:test';
import { withPostgres } from '../helpers/postgres';
import { seedTriggerFixture } from './fixtures';
import { dispatchOne, recoverDispatch, type DispatchTransport } from '../../lib/server/dispatch';

test('dispatch: transient failure recovers with one business run and stable Trigger key', async () => withPostgres(async (pool) => {
  const fixture = await seedTriggerFixture(pool);
  const run = await fixture.createRun('recover-calculation');
  const calls: string[] = [];
  const transport: DispatchTransport = {
    trigger: async (operation, payload, key) => {
      assert.equal(operation, 'calculation');
      assert.deepEqual(payload, { runId: run.id, projectId: fixture.project.id, datasetVersionId: fixture.dataset.id, requestedBy: fixture.owner });
      calls.push(key);
      if (calls.length === 1) throw Object.assign(new Error('private-provider-token'), { status: 503 });
      return 'trigger-recovered';
    },
  };
  assert.equal(await dispatchOne(pool, transport, 'calculation', run.id), 'retry');
  const pending = await pool.query('SELECT status,attempts,safe_error FROM dispatch_intents WHERE run_id=$1', [run.id]);
  assert.deepEqual(pending.rows[0], { status: 'pending', attempts: 1, safe_error: 'dispatch_unavailable' });
  assert.ok(!JSON.stringify(pending.rows[0]).includes('private-provider-token'));
  await pool.query('UPDATE dispatch_intents SET next_attempt_at=now()-interval \'1 second\' WHERE run_id=$1', [run.id]);
  assert.equal(await dispatchOne(pool, transport, 'calculation', run.id), 'sent');
  assert.equal(await dispatchOne(pool, transport, 'calculation', run.id), 'skipped');
  assert.deepEqual(calls, [`calculation:${run.id}`, `calculation:${run.id}`]);
  assert.deepEqual((await pool.query('SELECT status,attempts,external_task_id FROM dispatch_intents WHERE run_id=$1', [run.id])).rows[0],
    { status: 'sent', attempts: 2, external_task_id: 'trigger-recovered' });
  assert.equal((await pool.query('SELECT trigger_run_id FROM calculation_runs WHERE id=$1', [run.id])).rows[0].trigger_run_id, 'trigger-recovered');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM calculation_runs WHERE idempotency_key=$1', ['recover-calculation'])).rows[0].n, 1);
}));

test('dispatch: parallel recovery leases once; successful acknowledgement is not resent', async () => withPostgres(async (pool) => {
  const fixture = await seedTriggerFixture(pool);
  const run = await fixture.createRun('parallel-calculation');
  let calls = 0;
  const transport: DispatchTransport = { trigger: async () => { calls++; return 'trigger-once'; } };
  const outcomes = await Promise.all([
    dispatchOne(pool, transport, 'calculation', run.id), dispatchOne(pool, transport, 'calculation', run.id),
  ]);
  assert.deepEqual(outcomes.sort(), ['sent', 'skipped']);
  assert.equal(calls, 1);
  assert.equal(await dispatchOne(pool, transport, 'calculation', run.id), 'skipped');
  assert.equal(calls, 1);
}));

test('dispatch: cancelled or archived work never reaches Trigger', async () => withPostgres(async (pool) => {
  const fixture = await seedTriggerFixture(pool);
  const cancelled = await fixture.createRun('cancel-before-dispatch');
  await pool.query("UPDATE calculation_runs SET status='cancelled',state_version=state_version+1 WHERE id=$1", [cancelled.id]);
  let calls = 0;
  const transport: DispatchTransport = { trigger: async () => { calls++; return 'unexpected'; } };
  assert.equal(await dispatchOne(pool, transport, 'calculation', cancelled.id), 'skipped');
  assert.equal((await pool.query('SELECT status,safe_error FROM dispatch_intents WHERE run_id=$1', [cancelled.id])).rows[0].status, 'failed');
  const archived = await fixture.createRun('archive-before-dispatch');
  await fixture.repo.archiveProject(fixture.owner, fixture.project.id);
  assert.equal(await dispatchOne(pool, transport, 'calculation', archived.id), 'skipped');
  assert.equal(calls, 0);
}));

test('dispatch: import and calculation use separate stable payloads and keys', async () => withPostgres(async (pool) => {
  const fixture = await seedTriggerFixture(pool);
  const imported = await fixture.createPendingImport('pending-import');
  const run = await fixture.createRun('pending-calculation');
  const seen: Array<{ operation: string; payload: unknown; key: string }> = [];
  const transport: DispatchTransport = { trigger: async (operation, payload, key) => {
    seen.push({ operation, payload, key });
    return `${operation}-external`;
  } };
  assert.equal(await dispatchOne(pool, transport, 'import', imported.id), 'sent');
  assert.equal(await dispatchOne(pool, transport, 'calculation', run.id), 'sent');
  assert.deepEqual(seen, [
    { operation: 'import', payload: { importId: imported.id, projectId: fixture.project.id, requestedBy: fixture.owner }, key: `import:${imported.id}` },
    { operation: 'calculation', payload: { runId: run.id, projectId: fixture.project.id, datasetVersionId: fixture.dataset.id, requestedBy: fixture.owner }, key: `calculation:${run.id}` },
  ]);
  assert.equal((await pool.query('SELECT external_task_id FROM dispatch_intents WHERE import_id=$1', [imported.id])).rows[0].external_task_id, 'import-external');
}));

test('dispatch: recovery bounds batch size and rejects invalid limits', async () => withPostgres(async (pool) => {
  const fixture = await seedTriggerFixture(pool);
  const imported = await fixture.createPendingImport('batch-import');
  const run = await fixture.createRun('batch-calculation');
  const keys: string[] = [];
  const transport: DispatchTransport = { trigger: async (_operation, _payload, key) => { keys.push(key); return key; } };
  await assert.rejects(recoverDispatch(pool, transport, 0), RangeError);
  await assert.rejects(recoverDispatch(pool, transport, 101), RangeError);
  const first = await recoverDispatch(pool, transport, 1);
  assert.equal(first.sent, 1);
  const second = await recoverDispatch(pool, transport, 10);
  assert.ok(second.sent >= 1);
  assert.ok(keys.includes(`import:${imported.id}`));
  assert.ok(keys.includes(`calculation:${run.id}`));
}));
