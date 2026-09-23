import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { withPostgres } from '../helpers/postgres';
import { seedTriggerFixture } from './fixtures';
import { createRunService, RunServiceError } from '../../lib/server/runs';
import { createCalculationExecutionRepository } from '../../lib/server/calculation-execution';
import { canonicalJsonHash } from '../../lib/server/db';

const policies = { trendCapsByCategory: [], unitSteps: [], growthSemanticsByAssumption: [] };
const cursorSecret = 'synthetic-test-secret-long-enough-for-hmac';

test('runs: durable 202, same-key replay and conflict survive dispatch failure', async () => withPostgres(async (pool) => {
  const fixture = await seedTriggerFixture(pool);
  const service = createRunService(pool, cursorSecret, {
    cancelTransaction: createCalculationExecutionRepository(pool).cancelCalculationRun,
    dispatch: async () => { throw new Error('provider unavailable'); },
  });
  const { parametersHash: previousHash, ...baseParameters } = fixture.configuration;
  void previousHash;
  const parameters = { ...baseParameters, policies };
  const body = { datasetVersionId: fixture.dataset.id, scope: fixture.scope,
    configuration: { ...parameters, parametersHash: canonicalJsonHash(parameters) }, idempotencyKey: 'same-key' };
  const created = await service.create(fixture.owner, fixture.project.id, body);
  const runId = String(created.data.runId);
  assert.equal(created.statusCode, 202);
  assert.equal(created.data.status, 'queued');
  const replay = await service.create(fixture.owner, fixture.project.id, body);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.data.runId, runId);
  await assert.rejects(service.create(fixture.owner, fixture.project.id, {
    ...body, configuration: { ...body.configuration, historicalWindowMonths: 24 },
  }), (error: unknown) => error instanceof RunServiceError && error.status === 409);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM calculation_runs WHERE project_id=$1', [fixture.project.id])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM dispatch_intents WHERE run_id=$1', [runId])).rows[0].n, 1);
  await assert.rejects(service.get('foreign-owner', runId), (error: unknown) => error instanceof RunServiceError && error.status === 404);
}));

test('runs: stable cursor has no duplicates and cannot cross owner/project', async () => withPostgres(async (pool) => {
  const fixture = await seedTriggerFixture(pool);
  const other = await seedTriggerFixture(pool);
  const service = createRunService(pool, cursorSecret, {
    cancelTransaction: createCalculationExecutionRepository(pool).cancelCalculationRun,
  });
  const ids: string[] = [];
  for (let index = 0; index < 5; index++) ids.push((await fixture.createRun(`page-${index}`)).id);
  const first = await service.list(fixture.owner, fixture.project.id, { limit: 2 });
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const second = await service.list(fixture.owner, fixture.project.id, { limit: 2, cursor: first.nextCursor! });
  const third = await service.list(fixture.owner, fixture.project.id, { limit: 2, cursor: second.nextCursor! });
  const actual = [...first.items, ...second.items, ...third.items].map((item) => item.runId);
  assert.equal(new Set(actual).size, 5);
  assert.deepEqual(new Set(actual), new Set(ids));
  await assert.rejects(service.list('foreign-owner', fixture.project.id, { cursor: first.nextCursor }),
    (error: unknown) => error instanceof RunServiceError && error.status === 404);
  await assert.rejects(service.list(other.owner, other.project.id, { cursor: first.nextCursor }),
    (error: unknown) => error instanceof RunServiceError && error.status === 422);
  await assert.rejects(service.list(fixture.owner, fixture.project.id, { cursor: `${first.nextCursor}tampered` }),
    (error: unknown) => error instanceof RunServiceError && error.status === 422);
}));

test('recommendations: not-ready is 409; filtered pages stay bound to run/filter/version', async () => withPostgres(async (pool) => {
  const productIds = [randomUUID(), randomUUID(), randomUUID()];
  const supplierIds = [randomUUID(), randomUUID()];
  const warehouseId = randomUUID();
  const fixture = await seedTriggerFixture(pool, async (client, snapshot) => {
    await client.query('INSERT INTO warehouses(id,project_id,dataset_version_id,source_key,name) VALUES($1,$2,$3,$4,$5)',
      [warehouseId, snapshot.projectId, snapshot.datasetVersionId, 'warehouse', 'Склад']);
    for (const [index, id] of supplierIds.entries()) await client.query(
      'INSERT INTO suppliers(id,project_id,dataset_version_id,source_key,name) VALUES($1,$2,$3,$4,$5)',
      [id, snapshot.projectId, snapshot.datasetVersionId, `supplier-${index}`, `Поставщик ${index}`]);
    for (const [index, id] of productIds.entries()) await client.query(
      'INSERT INTO products(id,project_id,dataset_version_id,source_key,sku,name,unit,category_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, snapshot.projectId, snapshot.datasetVersionId, `product-${index}`, `000${index}`, `Товар ${index}`, 'pcs', 'cables']);
    for (const [index, id] of productIds.entries()) await client.query(
      'INSERT INTO product_suppliers(id,project_id,dataset_version_id,product_id,supplier_id) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), snapshot.projectId, snapshot.datasetVersionId, id, supplierIds[index === 2 ? 1 : 0]]);
  });
  const run = await fixture.createRun('recommendation-page');
  const service = createRunService(pool, cursorSecret, {
    cancelTransaction: createCalculationExecutionRepository(pool).cancelCalculationRun,
  });
  await assert.rejects(service.recommendations(fixture.owner, run.id),
    (error: unknown) => error instanceof RunServiceError && error.code === 'RESULTS_NOT_READY');
  for (const [index, productId] of productIds.entries()) await fixture.repo.addRecommendation(fixture.owner, {
    projectId: fixture.project.id, datasetVersionId: fixture.dataset.id, runId: run.id, productId,
    warehouseId, supplierId: supplierIds[index === 2 ? 1 : 0], calculationVersion: '1', supplierArticle: null,
    recommendedQuantity: String(index + 1), quantityStatus: 'known', unit: 'pcs', urgency: 'planned',
    projectedStockoutDate: null, shortageDays: null, numericFactors: [], dataQuality: 'complete', rationale: 'Синтетический расчёт',
  });
  await pool.query("UPDATE calculation_runs SET status='succeeded',coverage_gate='complete',finished_at=now(),result_version=state_version+1,state_version=state_version+1 WHERE id=$1", [run.id]);
  const first = await service.recommendations(fixture.owner, run.id, { limit: 1, supplierId: supplierIds[0] });
  const second = await service.recommendations(fixture.owner, run.id, { limit: 1, supplierId: supplierIds[0], cursor: first.nextCursor! });
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.recommendationId)).size, 2);
  assert.equal(second.nextCursor, null);
  assert.equal(first.supplierGroups.length, 2);
  await assert.rejects(service.recommendations(fixture.owner, run.id, { cursor: first.nextCursor!, supplierId: supplierIds[1] }),
    (error: unknown) => error instanceof RunServiceError && error.status === 422);
  await assert.rejects(service.recommendations(fixture.owner, run.id, { supplierId: randomUUID() }),
    (error: unknown) => error instanceof RunServiceError && error.status === 404);
  await assert.rejects(service.recommendations('foreign-owner', run.id),
    (error: unknown) => error instanceof RunServiceError && error.status === 404);
}));
