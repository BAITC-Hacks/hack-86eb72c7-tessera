import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { withPostgres } from '../helpers/postgres';
import { createSyntheticImportFixture } from '../../scripts/generate-import-fixture';
import { createProjectService } from '../../lib/server/projects';
import { createImportLifecycle, importHttpStatus } from '../../lib/server/imports/lifecycle';
import { processImportJob } from '../../lib/server/imports/job';
import type { UploadedObject } from '../../lib/server/storage';
import { dispatchOne } from '../../lib/server/dispatch';

test('import job: finalize is durable; validated publication and replay keep one dataset/report', async () => withPostgres(async (pool) => {
  const fixture = await createSyntheticImportFixture();
  const owner = 'import-owner';
  const project = await createProjectService(pool).create(owner, { name: 'Синтетический импорт' });
  const bytes = fixture.objects[0].bytes;
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const lifecycle = createImportLifecycle({ pool, storage: {
    signUpload: async () => ({ url: 'https://private.invalid/upload', method: 'PUT' as const,
      headers: { 'content-type': contentType, 'content-length': String(bytes.byteLength), 'if-none-match': '*',
        'x-amz-checksum-sha256': Buffer.from(checksum, 'hex').toString('base64'),
        'x-amz-meta-sha256-hex': checksum, 'x-amz-meta-project-id': project.id, 'x-amz-meta-purpose': 'source' },
      expiresAt: '2026-09-23T12:00:00Z' }),
    head: async () => ({ sizeBytes: bytes.byteLength, contentType, checksum, checksumPending: false }),
  } });
  const created = await lifecycle.create(owner, project.id, {
    fileName: 'synthetic.xlsx', size: bytes.byteLength, contentType, checksum, sourceRole: 'sales',
  });
  const manifest = { ...fixture.manifest, projectId: project.id,
    sources: fixture.manifest.sources.filter((source) => source.sourceType !== 'material_statement')
      .map((source) => ({ ...source, sourceObjectId: created.sourceObjectId })) };
  await assert.rejects(lifecycle.finalize('foreign-owner', project.id, created.importId, { manifest }));
  const finalized = await lifecycle.finalize(owner, project.id, created.importId, { manifest });
  assert.equal(finalized.status, 'awaiting-validation');
  assert.equal(finalized[importHttpStatus], 202);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM dispatch_intents WHERE import_id=$1', [created.importId])).rows[0].n, 1);
  const dispatched = await dispatchOne(pool, { trigger: async (operation, taskPayload, key) => {
    assert.equal(operation, 'import');
    assert.deepEqual(taskPayload, { importId: created.importId, projectId: project.id, requestedBy: owner });
    assert.equal(key, `import:${created.importId}`);
    return 'synthetic-trigger-import';
  } }, 'import', created.importId);
  assert.equal(dispatched, 'sent');
  assert.equal((await lifecycle.finalize(owner, project.id, created.importId, { manifest }))[importHttpStatus], 200);
  const payload = { importId: created.importId, projectId: project.id, requestedBy: owner };
  const storage = {
    readSource: async () => bytes,
    uploadImportReport: async ({ importId, projectId, body }: { importId: string; projectId: string; body: Uint8Array }): Promise<UploadedObject> => ({
      id: importId, projectId, key: `projects/${projectId}/reports/${importId}`, purpose: 'report',
      contentType: 'application/json', sizeBytes: body.byteLength,
      sha256Hex: createHash('sha256').update(body).digest('hex'), confirmed: true,
    }),
  };
  await assert.rejects(processImportJob({ ...payload, requestedBy: 'foreign-owner' }, { pool, storage }));
  assert.equal((await pool.query('SELECT status FROM imports WHERE id=$1', [created.importId])).rows[0].status, 'awaiting-validation');
  const first = await processImportJob(payload, { pool, storage });
  assert.equal(first.status, 'ready');
  assert.ok(first.datasetVersionId);
  assert.deepEqual(await processImportJob(payload, { pool, storage }), first);
  const state = (await pool.query('SELECT status,dataset_version_id,report_object_id,report_checksum FROM imports WHERE id=$1', [created.importId])).rows[0];
  assert.equal(state.dataset_version_id, first.datasetVersionId);
  assert.equal(state.report_object_id, created.importId);
  assert.equal(state.report_checksum.length, 64);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM dataset_versions WHERE import_id=$1', [created.importId])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM source_objects WHERE id=$1 AND purpose=$2', [created.importId, 'report'])).rows[0].n, 1);
  const changedManifest = { ...manifest, sources: manifest.sources.map((source) => source.sourceType === 'sales'
    ? { ...source, mappingVersion: 'synthetic-v2' } : source) };
  await assert.rejects(lifecycle.finalize(owner, project.id, created.importId, { manifest: changedManifest }));
  const next = await lifecycle.attempt(owner, project.id, created.importId, {
    manifest: changedManifest,
  });
  assert.notEqual(next.importId, created.importId);
  assert.equal(next.status, 'awaiting-validation');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM dispatch_intents WHERE import_id=$1', [next.importId])).rows[0].n, 1);
  const tampered = await processImportJob({ ...payload, importId: next.importId }, {
    pool, storage: { ...storage, readSource: async () => new Uint8Array([1, 2, 3]) },
  });
  assert.deepEqual(tampered, { status: 'invalid', datasetVersionId: null });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM dataset_versions WHERE import_id=$1', [next.importId])).rows[0].n, 0);
  const rejected = await lifecycle.get(owner, project.id, next.importId);
  assert.equal(rejected.status, 'invalid');
  assert.equal(JSON.stringify(rejected).includes('private-provider-token'), false);
  await assert.rejects(lifecycle.get('foreign-owner', project.id, next.importId));
  assert.equal((await pool.query('SELECT status FROM imports WHERE id=$1', [created.importId])).rows[0].status, 'ready');
}));
