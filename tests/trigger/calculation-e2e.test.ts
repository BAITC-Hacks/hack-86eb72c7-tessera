import assert from 'node:assert/strict';
import test from 'node:test';
import { withPostgres } from '../helpers/postgres';
import { createSyntheticImportFixture } from '../../scripts/generate-import-fixture';
import { canonicalJsonHash, createRepositories } from '../../lib/server/db';
import { validateImport } from '../../lib/server/imports/service';
import { commitDataset } from '../../lib/server/imports/commit';
import { createRunService } from '../../lib/server/runs';
import { createCalculationExecutionRepository } from '../../lib/server/calculation-execution';
import { executeCalculation } from '../../trigger/calculate-procurement';

test('calculation: synthetic import → durable run → saved recommendations → replay', async () => withPostgres(async (pool) => {
  const owner = 'calculation-owner';
  const repo = createRepositories(pool);
  const project = await repo.createProject(owner, 'Синтетический расчёт');
  const fixture = await createSyntheticImportFixture();
  fixture.manifest.projectId = project.id;
  fixture.manifest.sources = fixture.manifest.sources.filter((source) => source.sourceType !== 'material_statement');
  const object = fixture.objects[0];
  await repo.createSourceObject(owner, { id: object.id, projectId: project.id,
    objectKey: `projects/${project.id}/sources/${object.id}`,
    checksum: fixture.manifest.sources[0].checksum!, byteSize: object.bytes.byteLength,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', purpose: 'source' });
  const validation = await validateImport(fixture.manifest, fixture.objects);
  assert.equal(validation.status, 'ready');
  assert.ok(validation.normalizedDraft);
  const dataset = await commitDataset(validation.normalizedDraft, { pool, userId: owner });
  const product = (await pool.query('SELECT id FROM products WHERE dataset_version_id=$1', [dataset.id])).rows[0];
  const scope = { warehouseIds: [], categoryIds: [] };
  const parameters = {
    runMode: 'diagnostic', scope, asOfDate: '2026-09-23', historicalWindowMonths: 12, minComparableWeeks: 8,
    outlierMadMultiplier: '3', outlierMedianMultiplier: '3', zeroMadMinimumUnit: '1',
    incompleteMonthPolicy: 'exclude', growthMode: 'none', seasonalityMode: 'provided', reviewPeriodDays: 30,
    safetyDaysByCategory: [{ categoryKey: 'cable', safetyDays: 3 }],
    leadTimePolicyVersion: '1', unitPolicyVersion: '1', algorithmVersion: '1',
    policies: { trendCapsByCategory: [{ categoryKey: 'cable', maxMonthlyTrendFactor: '2' }],
      unitSteps: [{ productId: product.id, unit: 'pcs', step: '1' }], growthSemanticsByAssumption: [] },
  };
  const configuration = { ...parameters, parametersHash: canonicalJsonHash(parameters) };
  const execution = createCalculationExecutionRepository(pool);
  const service = createRunService(pool, 'synthetic-test-secret-long-enough-for-hmac', { cancelTransaction: execution.cancelCalculationRun });
  const created = await service.create(owner, project.id, {
    datasetVersionId: dataset.id, scope, configuration, idempotencyKey: 'calculation-e2e',
  });
  assert.equal(created.statusCode, 202);
  const runId = String(created.data.runId);
  const payload = { runId, projectId: project.id, datasetVersionId: dataset.id, requestedBy: owner };
  assert.deepEqual(await executeCalculation({ ...payload, requestedBy: 'forged-owner' }, execution), { status: 'rejected' });
  assert.equal((await pool.query('SELECT status FROM calculation_runs WHERE id=$1', [runId])).rows[0].status, 'queued');
  const outcome = await executeCalculation(payload, execution);
  const persisted = (await pool.query('SELECT status,safe_error,stage_states FROM calculation_runs WHERE id=$1', [runId])).rows[0];
  assert.equal(outcome.status, 'succeeded', JSON.stringify(persisted));
  const state = await service.get(owner, runId);
  assert.equal(state.status, 'succeeded');
  assert.equal(state.stageStates.explain?.status, 'skipped');
  assert.equal(state.canApprove, false);
  assert.ok(state.stateVersion > 0);
  const recommendations = await service.recommendations(owner, runId);
  assert.ok(recommendations.items.length > 0);
  assert.ok(recommendations.items.every((item) => item.rationale.length > 0));
  assert.ok(recommendations.items.some((item) => item.quantityStatus === 'unavailable' && item.recommendedQuantity === null));
  const before = (await pool.query('SELECT count(*)::int AS n FROM recommendations WHERE run_id=$1', [runId])).rows[0].n;
  assert.deepEqual(await executeCalculation(payload, execution), { status: 'succeeded' });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM recommendations WHERE run_id=$1', [runId])).rows[0].n, before);
  assert.equal((await service.recommendations(owner, runId)).items.length, recommendations.items.length);
}));
