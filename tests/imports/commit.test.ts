import assert from 'node:assert/strict';
import test from 'node:test';
import { withPostgres } from '../helpers/postgres';
import { createRepositories } from '../../lib/server/db';
import { createSyntheticImportFixture } from '../../scripts/generate-import-fixture';
import { validateImport } from '../../lib/server/imports/service';
import { commitDataset, writeNormalizedSnapshot } from '../../lib/server/imports/commit';

test('импорт атомарен, повторяем и изолирован по владельцу на PostgreSQL', async () => {
  await withPostgres(async pool => {
    const fixture = await createSyntheticImportFixture();
    const repositories = createRepositories(pool);
    const project = await repositories.createProject('import-owner', 'Синтетический импорт');
    fixture.manifest.projectId = project.id;
    // Материальная ведомость пока отклоняется встроенным writer без согласованной схемы.
    fixture.manifest.sources = fixture.manifest.sources.filter(source => source.sourceType !== 'material_statement');
    const object = fixture.objects[0];
    await repositories.createSourceObject('import-owner', {
      id: object.id, projectId: project.id, objectKey: `projects/${project.id}/sources/${object.id}`,
      checksum: fixture.manifest.sources[0].checksum!, byteSize: object.bytes.byteLength,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', purpose: 'source',
    });
    const validation = await validateImport(fixture.manifest, fixture.objects);
    assert.equal(validation.status, 'ready', JSON.stringify(validation.report.issues));
    assert.ok(validation.normalizedDraft);
    const draft = validation.normalizedDraft;
    await assert.rejects(commitDataset(draft, {pool, userId:'foreign-owner'}));
    const dataset = await commitDataset(draft, {pool, userId:'import-owner'});
    const repeated = await commitDataset(draft, {pool, userId:'import-owner'});
    assert.equal(repeated.id, dataset.id);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM sales')).rows[0].n, 4);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM dataset_versions')).rows[0].n, 1);
    const changedManifest = structuredClone(fixture.manifest);
    changedManifest.adapterVersion = 'rollback-test';
    const changed = await validateImport(changedManifest, fixture.objects);
    assert.equal(changed.status, 'ready');
    assert.ok(changed.normalizedDraft);
    await assert.rejects(commitDataset(changed.normalizedDraft, {
      pool, userId:'import-owner',
      writeSnapshot: async (client, snapshot, input) => {
        await writeNormalizedSnapshot(client, snapshot, input);
        throw new Error('synthetic failure after rows');
      },
    }), /synthetic failure/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM dataset_versions')).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM imports')).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM sales')).rows[0].n, 4);
    draft.rows[0].values.sku = 'tampered';
    await assert.rejects(commitDataset(draft, {pool, userId:'import-owner'}), /изменён/);
  });
});
