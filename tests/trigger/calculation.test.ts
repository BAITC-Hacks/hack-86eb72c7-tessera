import assert from 'node:assert/strict';
import test from 'node:test';
import { withPostgres } from '../helpers/postgres';
import { seedTriggerFixture } from './fixtures';
import { createCalculationExecutionRepository, CalculationExecutionError } from '../../lib/server/calculation-execution';

test('calculation: forged payload cannot start or change another run', async () => withPostgres(async (pool) => {
  const fixture = await seedTriggerFixture(pool);
  const run = await fixture.createRun('forged-payload');
  const execution = createCalculationExecutionRepository(pool);
  const payload = { runId: run.id, projectId: fixture.project.id, datasetVersionId: fixture.dataset.id, requestedBy: fixture.owner };
  for (const forged of [
    { ...payload, requestedBy: 'foreign-owner' },
    { ...payload, projectId: '00000000-0000-4000-8000-000000000001' },
    { ...payload, datasetVersionId: '00000000-0000-4000-8000-000000000002' },
  ]) {
    await assert.rejects(execution.loadRunForExecution(forged),
      (error: unknown) => error instanceof CalculationExecutionError && error.code === 'not_found');
  }
  assert.deepEqual((await pool.query('SELECT status,state_version FROM calculation_runs WHERE id=$1', [run.id])).rows[0],
    { status: 'queued', state_version: 0 });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM recommendations WHERE run_id=$1', [run.id])).rows[0].n, 0);
  await fixture.repo.archiveProject(fixture.owner, fixture.project.id);
  await assert.rejects(execution.loadRunForExecution(payload),
    (error: unknown) => error instanceof CalculationExecutionError && error.code === 'not_found');
}));

test('calculation: cancellation wins over in-flight stage and retry cannot duplicate events', async () => withPostgres(async (pool) => {
  const fixture = await seedTriggerFixture(pool);
  const run = await fixture.createRun('cancel-race');
  const execution = createCalculationExecutionRepository(pool);
  assert.equal(await execution.beginStage(run.id, 'validate'), 'started');
  assert.equal(await execution.beginStage(run.id, 'validate'), 'started');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM run_events WHERE run_id=$1', [run.id])).rows[0].n, 1);
  assert.deepEqual(await execution.cancelCalculationRun({ runId: run.id, requestedBy: 'foreign-owner' }), { kind: 'not_found' });
  const cancelled = await execution.cancelCalculationRun({ runId: run.id, requestedBy: fixture.owner });
  assert.equal(cancelled.kind, 'cancelled');
  assert.equal((await execution.cancelCalculationRun({ runId: run.id, requestedBy: fixture.owner })).kind, 'already_cancelled');
  assert.equal(await execution.finishStage(run.id, 'validate'), 'terminal');
  assert.equal(await execution.beginStage(run.id, 'forecast'), 'terminal');
  assert.equal(await execution.failRun(run.id, 'synthetic_failure'), 'terminal');
  const state = (await pool.query('SELECT status,stage_states,state_version,finished_at FROM calculation_runs WHERE id=$1', [run.id])).rows[0];
  assert.equal(state.status, 'cancelled');
  assert.equal(state.stage_states.validate.status, 'skipped');
  assert.equal(state.state_version, 2);
  assert.ok(state.finished_at);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM run_events WHERE run_id=$1', [run.id])).rows[0].n, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM recommendations WHERE run_id=$1', [run.id])).rows[0].n, 0);
}));

test('calculation: completed stage is resumable without duplicate audit rows', async () => withPostgres(async (pool) => {
  const fixture = await seedTriggerFixture(pool);
  const run = await fixture.createRun('resume-stage');
  const execution = createCalculationExecutionRepository(pool);
  assert.equal(await execution.beginStage(run.id, 'validate'), 'started');
  assert.equal(await execution.finishStage(run.id, 'validate'), 'completed');
  assert.equal(await execution.finishStage(run.id, 'validate'), 'already_completed');
  assert.equal(await execution.beginStage(run.id, 'validate'), 'already_completed');
  assert.equal(await execution.beginStage(run.id, 'forecast'), 'started');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM run_events WHERE run_id=$1', [run.id])).rows[0].n, 3);
}));
