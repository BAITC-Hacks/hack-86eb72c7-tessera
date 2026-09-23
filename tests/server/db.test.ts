import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { applyMigrations } from '../../lib/server/db/migrate';
import { createRepositories, DatabaseAccessError, DatabaseConflictError, canonicalJsonHash, runRequestHash, approvalRequestHash, canonicalDecimal } from '../../lib/server/db';
import { withPostgres } from '../helpers/postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { projects, sourceObjects, imports, datasetVersions, calculationRuns, dispatchIntents } from '../../lib/server/db/schema';
import { ProjectSchema } from '../../lib/contracts/projects';
import { SourceObjectSchema, ImportSchema, DatasetVersionSchema } from '../../lib/contracts/datasets';
import { CalculationRunSchema, DispatchIntentSchema } from '../../lib/contracts/runs';

const digest = (character: string) => character.repeat(64);
const uuid = () => randomUUID();

const makeManifest = (sourceObjectId: string, checksum: string, sourceType = 'sales') => [{ sourceType, sourceObjectId, checksum, origin: 'synthetic', sheet: null, mappingVersion: '1', columnMappings: [] }];
const makeCompleteness = () => ['sales','monthly_sales','stock','inbound','stockouts','suppliers','categories','growth','seasonality','product_mapping','material_statement','lead_times'].map((sourceType) => sourceType==='sales' ? ({sourceType,status:'complete',rowCount:1,reasonCode:null,confirmedByUserId:null,confirmationReason:null}) : ({sourceType,status:'explicit_none',rowCount:0,reasonCode:null,confirmedByUserId:'clerk_owner',confirmationReason:'Синтетический пустой источник'}));
const makeScope = () => ({ warehouseIds: [], categoryIds: [] });
const makeConfig = () => ({runMode:'full',scope:makeScope(),asOfDate:'2026-09-23',historicalWindowMonths:12,minComparableWeeks:8,outlierMadMultiplier:'3',outlierMedianMultiplier:'3',zeroMadMinimumUnit:'1',incompleteMonthPolicy:'exclude',growthMode:'none',seasonalityMode:'none',reviewPeriodDays:30,safetyDaysByCategory:[],leadTimePolicyVersion:'1',unitPolicyVersion:'1',algorithmVersion:'1',parametersHash:digest('9')});
const makeRunInput = (projectId:string,datasetVersionId:string,idempotencyKey:string) => { const base={projectId,datasetVersionId,scope:makeScope(),asOfDate:'2026-09-23',configuration:makeConfig(),algorithmVersion:'1',runMode:'full' as const}; return {...base,idempotencyKey,configurationHash:canonicalJsonHash(base.configuration),requestHash:runRequestHash(base)}; };

async function seedDataset(pool: Parameters<typeof createRepositories>[0], owner = 'clerk_owner', writeSnapshot?: Parameters<ReturnType<typeof createRepositories>['publishDatasetVersion']>[2], completeness: unknown = makeCompleteness()) {
  const repo = createRepositories(pool);
  const project = await repo.createProject(owner, 'Синтетика');
  const sourceId=uuid();
  const source = await repo.createSourceObject(owner, { id:sourceId, projectId: project.id, objectKey: `projects/${project.id}/sources/${sourceId}`, checksum: digest('a'), byteSize: 100, contentType: 'text/csv', purpose: 'source' });
  const imported = await repo.createImport(owner, { projectId: project.id, sourceObjectId: source.id, checksum: source.checksum, manifest: makeManifest(source.id,source.checksum), manifestHash: canonicalJsonHash(makeManifest(source.id,source.checksum)), adapterVersion: '1', schemaVersion: '1', idempotencyKey: 'import-1' });
  await pool.query("UPDATE imports SET status='validating',quality_report=$2::jsonb,state_version=state_version+1 WHERE id=$1",[imported.id,JSON.stringify({checkedRows:1,acceptedRows:1,rejectedRows:0,issues:[]})]);
  const dataset = await repo.publishDatasetVersion(owner, { projectId: project.id, importId: imported.id, manifest: makeManifest(source.id,source.checksum), manifestHash: canonicalJsonHash(makeManifest(source.id,source.checksum)), asOfDate: '2026-09-23', provenance: 'synthetic', sourceCompleteness: completeness, schemaVersion: '1' }, writeSnapshot);
  return { repo, project, source, imported, dataset, owner };
}

test('migration is repeatable, checksum-tracked, and creates every required table', async () => withPostgres(async (pool) => {
  await applyMigrations(pool);
  const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  for (const name of ['projects','source_objects','imports','dataset_versions','products','product_suppliers','monthly_sales','seasonality_indices','sales','stock_snapshots','inbound_shipments','stockout_intervals','category_policies','growth_assumptions','supplier_lead_times','calculation_runs','dispatch_intents','recommendations','recommendation_reviews','approvals','export_artifacts','run_events','audit_events']) {
    assert.ok(tables.rows.some((row) => row.tablename === name), name);
  }
  const expectedMigrations = (await readdir('drizzle')).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  const appliedMigrations = await pool.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
  assert.deepEqual(appliedMigrations.rows.map(row => row.name), expectedMigrations);
}));

test('project isolation, immutable datasets, archive guard and atomic dispatch', async () => withPostgres(async (pool) => {
  const first = await seedDataset(pool);
  const second = await seedDataset(pool, 'other_owner');
  await assert.rejects(first.repo.getProject('other_owner', first.project.id), DatabaseAccessError);
  await assert.rejects(first.repo.createCalculationRun('other_owner', makeRunInput(first.project.id,first.dataset.id,'other')), DatabaseAccessError);
  await assert.rejects(first.repo.createCalculationRun(first.owner, makeRunInput(first.project.id,second.dataset.id,'cross')), /foreign key/i);
  assert.equal((await pool.query("SELECT count(*) FROM dispatch_intents WHERE idempotency_key='cross'")).rows[0].count,'0');
  const scoped = makeRunInput(first.project.id,first.dataset.id,'wrong-scope');
  const scope = {warehouseIds:[uuid()],categoryIds:[]};
  const badScope = {...scoped,scope,configuration:{...scoped.configuration,scope}};
  await assert.rejects(first.repo.createCalculationRun(first.owner,{...badScope,configurationHash:canonicalJsonHash(badScope.configuration),requestHash:runRequestHash(badScope)}),DatabaseAccessError);
  await assert.rejects(pool.query('UPDATE dataset_versions SET provenance=$1 WHERE id=$2',['partner',first.dataset.id]), /immutable snapshot/i);
  await assert.rejects(pool.query('UPDATE projects SET owner_user_id=$1 WHERE id=$2',['stolen',first.project.id]), /identity is immutable/i);
  await first.repo.archiveProject(first.owner, first.project.id);
  const archivedObjectId=uuid();
  await assert.rejects(first.repo.createSourceObject(first.owner, { id:archivedObjectId, projectId: first.project.id, objectKey: `projects/${first.project.id}/sources/${archivedObjectId}`, checksum: digest('f'), byteSize: 2, contentType: 'text/csv', purpose: 'source' }), DatabaseAccessError);
  await assert.rejects(pool.query("UPDATE imports SET status='failed' WHERE id=$1",[first.imported.id]), /project archived/i);
}));

test('manifest-aware import and run idempotency reject hash conflicts', async () => withPostgres(async (pool) => {
  const {repo,project,source,dataset,owner} = await seedDataset(pool);
  const duplicate = await repo.createImport(owner, { projectId: project.id, sourceObjectId: source.id, checksum: source.checksum, manifest: makeManifest(source.id,source.checksum), manifestHash: canonicalJsonHash(makeManifest(source.id,source.checksum)), adapterVersion: '1', schemaVersion: '1', idempotencyKey: 'ignored' });
  assert.equal(duplicate.dataset_version_id,dataset.id);
  const secondImport = await repo.createImport(owner, { projectId: project.id, sourceObjectId: source.id, checksum: source.checksum, manifest: makeManifest(source.id,source.checksum,'stock'), manifestHash: canonicalJsonHash(makeManifest(source.id,source.checksum,'stock')), adapterVersion: '1', schemaVersion: '1', idempotencyKey: 'import-2' });
  assert.notEqual(secondImport.id,duplicate.id);
  await assert.rejects(repo.publishDatasetVersion(owner,{projectId:project.id,importId:secondImport.id,manifest:makeManifest(source.id,source.checksum,'stock'),manifestHash:canonicalJsonHash(makeManifest(source.id,source.checksum,'stock')),asOfDate:'2026-09-23',provenance:'synthetic',sourceCompleteness:makeCompleteness(),schemaVersion:'1'}),DatabaseConflictError);
  const input=makeRunInput(project.id,dataset.id,'run-1');
  const concurrent = await Promise.all([repo.createCalculationRun(owner,input), repo.createCalculationRun(owner,input), repo.createCalculationRun(owner,input)]);
  const run = concurrent[0];
  assert.ok(concurrent.every((value) => value.id === run.id));
  assert.equal((await repo.createCalculationRun(owner,input)).id,run.id);
  assert.ok((await repo.createCalculationRun(owner, makeRunInput(project.id,dataset.id,'import-1'))).id);
  await assert.rejects(repo.createCalculationRun(owner,{...input,configuration:{...makeConfig(),historicalWindowMonths:24}}),DatabaseConflictError);
  assert.equal((await pool.query('SELECT count(*) FROM dispatch_intents WHERE run_id=$1',[run.id])).rows[0].count,'1');
}));

test('composite dataset FKs, exact decimal round trip, review and approval revision', async () => withPostgres(async (pool) => {
  const product=uuid(),warehouse=uuid(),supplier=uuid();
  const {repo,project,dataset,owner}=await seedDataset(pool, 'clerk_owner', async (client, snapshot) => {
  await client.query('INSERT INTO products(id,project_id,dataset_version_id,source_key,sku,name,unit,category_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[product,snapshot.projectId,snapshot.datasetVersionId,'p','P','Товар','pcs','category']);
  await client.query('INSERT INTO warehouses(id,project_id,dataset_version_id,source_key,name) VALUES($1,$2,$3,$4,$5)',[warehouse,snapshot.projectId,snapshot.datasetVersionId,'w','W']);
  await client.query('INSERT INTO suppliers(id,project_id,dataset_version_id,source_key,name) VALUES($1,$2,$3,$4,$5)',[supplier,snapshot.projectId,snapshot.datasetVersionId,'s','S']);
  await client.query('INSERT INTO product_suppliers(id,project_id,dataset_version_id,product_id,supplier_id) VALUES($1,$2,$3,$4,$5)',[uuid(),snapshot.projectId,snapshot.datasetVersionId,product,supplier]);
  });
  const sourceId2=uuid();
  const source2=await repo.createSourceObject(owner,{id:sourceId2,projectId:project.id,objectKey:`projects/${project.id}/sources/${sourceId2}`,checksum:digest('d'),byteSize:10,contentType:'text/csv',purpose:'source'});
  const import2=await repo.createImport(owner,{projectId:project.id,sourceObjectId:source2.id,checksum:source2.checksum,manifest:makeManifest(source2.id,source2.checksum),manifestHash: canonicalJsonHash(makeManifest(source2.id,source2.checksum)),adapterVersion:'1',schemaVersion:'1',idempotencyKey:'import-2'});
  await pool.query("UPDATE imports SET status='validating',quality_report=$2::jsonb,state_version=state_version+1 WHERE id=$1",[import2.id,JSON.stringify({checkedRows:1,acceptedRows:1,rejectedRows:0,issues:[]})]);
  const dataset2=await repo.publishDatasetVersion(owner,{projectId:project.id,importId:import2.id,manifest:makeManifest(source2.id,source2.checksum),manifestHash: canonicalJsonHash(makeManifest(source2.id,source2.checksum)),asOfDate:'2026-09-23',provenance:'synthetic',sourceCompleteness:makeCompleteness(),schemaVersion:'1'});
  const input=makeRunInput(project.id,dataset.id,'run');
  const run=await repo.createCalculationRun(owner,input);
  await assert.rejects(pool.query('INSERT INTO products(id,project_id,dataset_version_id,source_key,sku,name,unit,category_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[uuid(),project.id,dataset.id,'late','L','Поздний','pcs','category']),/dataset already published/i);
  const exact='1234567890123456789012.12345678';
  const rec=await repo.addRecommendation(owner,{projectId:project.id,datasetVersionId:dataset.id,runId:run.id,productId:product,warehouseId:warehouse,supplierId:supplier,recommendedQuantity:exact,quantityStatus:'known',unit:'pcs',urgency:'planned',calculationVersion:'1',supplierArticle:null,projectedStockoutDate:null,shortageDays:null,numericFactors:[],dataQuality:'complete',rationale:'Расчёт'});
  assert.equal(rec.recommended_quantity,exact);
  assert.equal(canonicalDecimal('1.20000000'),'1.2');
  await assert.rejects(repo.addRecommendation(owner,{projectId:project.id,datasetVersionId:dataset2.id,runId:run.id,productId:product,warehouseId:warehouse,supplierId:supplier,recommendedQuantity:'1',quantityStatus:'known',unit:'pcs',urgency:'planned',calculationVersion:'1',supplierArticle:null,projectedStockoutDate:null,shortageDays:null,numericFactors:[],dataQuality:'complete',rationale:'Расчёт'}),DatabaseConflictError);
  await assert.rejects(repo.addRecommendation(owner,{projectId:project.id,datasetVersionId:dataset.id,runId:run.id,productId:product,warehouseId:warehouse,supplierId:supplier,recommendedQuantity:'1.000000000',quantityStatus:'known',unit:'pcs',urgency:'planned',calculationVersion:'1',supplierArticle:null,projectedStockoutDate:null,shortageDays:null,numericFactors:[],dataQuality:'complete',rationale:'Расчёт'}),TypeError);
  await assert.rejects(repo.addRecommendation(owner,{projectId:project.id,datasetVersionId:dataset.id,runId:run.id,productId:product,warehouseId:warehouse,supplierId:supplier,recommendedQuantity:'12345678901234567890123',quantityStatus:'known',unit:'pcs',urgency:'planned',calculationVersion:'1',supplierArticle:null,projectedStockoutDate:null,shortageDays:null,numericFactors:[],dataQuality:'complete',rationale:'Расчёт'}),TypeError);
  const review=await repo.addReview(owner,{projectId:project.id,runId:run.id,recommendationId:rec.id,expectedReviewVersion:0,reviewedQuantity:'2.5',reason:'Ручная проверка'});
  assert.equal(review.reviewed_quantity,'2.5');
  assert.equal((await pool.query('SELECT recommended_quantity FROM recommendations WHERE id=$1',[rec.id])).rows[0].recommended_quantity,exact);
  await pool.query("UPDATE calculation_runs SET status='succeeded',coverage_gate='complete',state_version=state_version+1 WHERE id=$1",[run.id]);
  await assert.rejects(repo.approve(owner,{projectId:project.id,runId:run.id,expectedReviewVersion:0,idempotencyKey:'approval',requestHash:approvalRequestHash(run.id,0)}),DatabaseConflictError);
  const approval=await repo.approve(owner,{projectId:project.id,runId:run.id,expectedReviewVersion:1,idempotencyKey:'approval',requestHash:approvalRequestHash(run.id,1)});
  assert.equal(approval.review_version,1);
  assert.equal((await repo.approve(owner,{projectId:project.id,runId:run.id,expectedReviewVersion:1,idempotencyKey:'approval',requestHash:approvalRequestHash(run.id,1)})).id,approval.id);
  await assert.rejects(repo.approve(owner,{projectId:project.id,runId:run.id,expectedReviewVersion:0,idempotencyKey:'approval',requestHash:approvalRequestHash(run.id,0)}),DatabaseConflictError);
  await assert.rejects(pool.query('UPDATE recommendations SET recommended_quantity=1 WHERE id=$1',[rec.id]),/immutable snapshot/i);
  await assert.rejects(pool.query("UPDATE calculation_runs SET status='running',state_version=state_version+1 WHERE id=$1",[run.id]),/immutable run/);
}));


test('публикация откатывает все строки при ошибке и запечатывает набор до первого расчёта', async () => withPostgres(async (pool) => {
  await assert.rejects(seedDataset(pool, 'clerk_owner', async (client, snapshot) => {
    await client.query('INSERT INTO suppliers(id,project_id,dataset_version_id,source_key,name) VALUES($1,$2,$3,$4,$5)', [uuid(),snapshot.projectId,snapshot.datasetVersionId,'failed','Отмена']);
    throw new Error('Остановка синтетической публикации');
  }), /Остановка/);
  assert.equal((await pool.query('SELECT count(*) FROM dataset_versions')).rows[0].count, '0');
  assert.equal((await pool.query('SELECT count(*) FROM suppliers')).rows[0].count, '0');
  assert.equal((await pool.query('SELECT status FROM imports')).rows[0].status, 'validating');

  const {repo,project,dataset,owner,imported} = await seedDataset(pool, 'second_owner');
  await assert.rejects(pool.query('INSERT INTO suppliers(id,project_id,dataset_version_id,source_key,name) VALUES($1,$2,$3,$4,$5)', [uuid(),project.id,dataset.id,'late','Поздний']), /dataset already published/);
  await assert.rejects(pool.query("UPDATE imports SET status='validating',state_version=state_version+1 WHERE id=$1", [imported.id]), /immutable import/);
  const run = await repo.createCalculationRun(owner, makeRunInput(project.id,dataset.id,'events'));
  await assert.rejects(repo.appendRunEvent(owner, {projectId:project.id,runId:run.id,eventType:'queued',safePayload:{stage:null,safeCode:null,customerEmail:'private@example.test'}}));
  const event = await repo.appendRunEvent(owner, {projectId:project.id,runId:run.id,eventType:'queued',safePayload:{stage:null,safeCode:null}});
  assert.equal(event.sequence_no,1);
}));


function wireTimestamps(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    /(?:At|Until)$/.test(key) && typeof value === 'string' ? new Date(value).toISOString() : value]));
}

test('сохранённые поля проходят DTO и full отделён от diagnostic', async () => withPostgres(async (pool) => {
  const missingStock = makeCompleteness().map(value => value.sourceType === 'stock'
    ? {...value, status:'missing',rowCount:null,reasonCode:'not_provided',confirmedByUserId:null,confirmationReason:null} : value);
  const {repo,project,source,dataset,imported,owner} = await seedDataset(pool,'clerk_owner',undefined,missingStock);
  await assert.rejects(repo.createCalculationRun(owner,makeRunInput(project.id,dataset.id,'full')), /mandatory sources/);
  assert.equal((await pool.query("SELECT count(*) FROM dispatch_intents WHERE operation_type='calculation'")).rows[0].count,'0');
  const base = {...makeRunInput(project.id,dataset.id,'diagnostic'), runMode:'diagnostic' as const, configuration:{...makeConfig(),runMode:'diagnostic'}};
  const run = await repo.createCalculationRun(owner,{...base,configurationHash:canonicalJsonHash(base.configuration),requestHash:runRequestHash(base)});
  await assert.rejects(repo.approve(owner,{projectId:project.id,runId:run.id,expectedReviewVersion:0,idempotencyKey:'never',requestHash:approvalRequestHash(run.id,0)}),DatabaseConflictError);
  const db = drizzle(pool);
  ProjectSchema.parse(wireTimestamps((await db.select().from(projects).where(eq(projects.id,project.id)))[0]));
  SourceObjectSchema.parse(wireTimestamps((await db.select().from(sourceObjects).where(eq(sourceObjects.id,source.id)))[0]));
  const { manifestFrozen, ...importDto } = (await db.select().from(imports).where(eq(imports.id,imported.id)))[0];
  // Служебный флаг миграции06 не входит в публичный DTO импорта04.
  assert.equal(manifestFrozen, true);
  ImportSchema.parse(wireTimestamps(importDto));
  DatasetVersionSchema.parse(wireTimestamps((await db.select().from(datasetVersions).where(eq(datasetVersions.id,dataset.id)))[0]));
  CalculationRunSchema.parse(wireTimestamps((await db.select().from(calculationRuns).where(eq(calculationRuns.id,run.id)))[0]));
  for (const intent of await db.select().from(dispatchIntents)) DispatchIntentSchema.parse(wireTimestamps(intent));

  const optionalMissing = makeCompleteness().map(value => ['monthly_sales','material_statement','seasonality'].includes(value.sourceType)
    ? {...value,status:'missing',rowCount:null,reasonCode:'not_provided',confirmedByUserId:null,confirmationReason:null} : value);
  const optional = await seedDataset(pool,'optional_owner',undefined,optionalMissing);
  assert.ok((await optional.repo.createCalculationRun(optional.owner,makeRunInput(optional.project.id,optional.dataset.id,'full'))).id);
}));
