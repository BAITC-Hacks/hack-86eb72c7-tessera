import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { canonicalJsonHash, createRepositories, runRequestHash } from '../../lib/server/db';

const digest = (character: string) => character.repeat(64);
const sourceTypes = ['sales', 'monthly_sales', 'stock', 'inbound', 'stockouts', 'suppliers', 'categories', 'growth', 'seasonality', 'product_mapping', 'material_statement', 'lead_times'];

function manifest(sourceObjectId: string, checksum: string, sourceType = 'sales') {
  return [{ sourceType, sourceObjectId, checksum, origin: 'synthetic', sheet: null, mappingVersion: '1', columnMappings: [] }];
}

function completeness() {
  return sourceTypes.map((sourceType) => sourceType === 'sales'
    ? { sourceType, status: 'complete', rowCount: 1, reasonCode: null, confirmedByUserId: null, confirmationReason: null }
    : { sourceType, status: 'explicit_none', rowCount: 0, reasonCode: null, confirmedByUserId: 'owner-a', confirmationReason: 'Синтетический пустой источник' });
}

export async function seedTriggerFixture(pool: Pool, writeSnapshot?: (client: PoolClient, snapshot: { projectId: string; datasetVersionId: string }) => Promise<void>) {
  const repo = createRepositories(pool);
  const owner = 'owner-a';
  const project = await repo.createProject(owner, 'Синтетический проект');
  const sourceId = randomUUID();
  const checksum = digest('a');
  const source = await repo.createSourceObject(owner, {
    id: sourceId, projectId: project.id, objectKey: `projects/${project.id}/sources/${sourceId}`,
    checksum, byteSize: 100, contentType: 'text/csv', purpose: 'source',
  });
  const firstManifest = manifest(source.id, checksum);
  const imported = await repo.createImport(owner, {
    projectId: project.id, sourceObjectId: source.id, checksum, manifest: firstManifest,
    manifestHash: canonicalJsonHash(firstManifest), adapterVersion: '1', schemaVersion: '1', idempotencyKey: 'fixture-import',
  });
  await pool.query("UPDATE imports SET status='validating',quality_report=$2::jsonb,state_version=state_version+1 WHERE id=$1", [
    imported.id, JSON.stringify({ checkedRows: 1, acceptedRows: 1, rejectedRows: 0, issues: [] }),
  ]);
  const dataset = await repo.publishDatasetVersion(owner, {
    projectId: project.id, importId: imported.id, manifest: firstManifest,
    manifestHash: canonicalJsonHash(firstManifest), asOfDate: '2026-09-23', provenance: 'synthetic',
    sourceCompleteness: completeness(), schemaVersion: '1',
  }, writeSnapshot);
  // The seed import is complete; only work created by each test remains dispatchable.
  await pool.query("UPDATE dispatch_intents SET status='sent',external_task_id='fixture' WHERE import_id=$1", [imported.id]);
  const scope = { warehouseIds: [], categoryIds: [] };
  const configuration = {
    runMode: 'full' as const, scope, asOfDate: '2026-09-23', historicalWindowMonths: 12,
    minComparableWeeks: 8, outlierMadMultiplier: '3', outlierMedianMultiplier: '3', zeroMadMinimumUnit: '1',
    incompleteMonthPolicy: 'exclude', growthMode: 'none', seasonalityMode: 'none', reviewPeriodDays: 30,
    safetyDaysByCategory: [], leadTimePolicyVersion: '1', unitPolicyVersion: '1', algorithmVersion: '1',
    parametersHash: digest('9'),
  };
  async function createRun(idempotencyKey: string) {
    const input = {
      projectId: project.id, datasetVersionId: dataset.id, scope, asOfDate: '2026-09-23', configuration,
      algorithmVersion: '1', runMode: 'full' as const, idempotencyKey,
    };
    return repo.createCalculationRun(owner, {
      ...input, configurationHash: canonicalJsonHash(configuration), requestHash: runRequestHash(input),
    });
  }
  async function createPendingImport(idempotencyKey: string) {
    const nextManifest = manifest(source.id, checksum, 'stock');
    return repo.createImport(owner, {
      projectId: project.id, sourceObjectId: source.id, checksum, manifest: nextManifest,
      manifestHash: canonicalJsonHash(nextManifest), adapterVersion: idempotencyKey, schemaVersion: '1', idempotencyKey,
    });
  }
  return { repo, owner, project, source, imported, dataset, scope, configuration, createRun, createPendingImport };
}
