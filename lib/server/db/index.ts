import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import type { Pool, PoolClient } from 'pg';
import { projects } from './schema';
import { SourceManifestSchema, DatasetVersionSchema, SourceObjectSchema, QualityReportSchema } from '../../contracts/datasets';
import { CalculationScopeSchema, RunConfigurationSchema } from '../../contracts/runs';
import { RecommendationSchema, RecommendationReviewSchema, RunEventSchema } from '../../contracts/recommendations';
import { CreateProjectSchema } from '../../contracts/projects';

export class DatabaseAccessError extends Error {
  constructor() { super('Ресурс недоступен'); }
}
export class DatabaseConflictError extends Error {
  constructor() { super('Конфликт версии или ключа идемпотентности'); }
}

const hashPattern = /^[a-f0-9]{64}$/;
const decimalPattern = /^(?:0|[1-9]\d{0,21})(?:\.\d{1,8})?$/;
const forbiddenKeys = /^(?:name|fullName|firstName|lastName|phone|telephone|email|address|customerName|customerEmail|customerPhone)$/i;

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function assertHash(value: string): void { if (typeof value !== 'string' || !hashPattern.test(value)) throw new TypeError('Неверная контрольная сумма'); }
function assertDecimal(value: string): void {
  if (typeof value !== 'string' || !decimalPattern.test(value) || /\.\d*0$/.test(value)) throw new TypeError('Неверная десятичная строка');
}
export function canonicalDecimal(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

function safeJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      if (Object.getPrototypeOf(item) !== Object.prototype) throw new TypeError('Неверная структура JSON');
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, nested]) => {
        if (forbiddenKeys.test(key)) throw new TypeError('Персональные данные недопустимы');
        return [key, normalize(nested)];
      }));
    }
    if (typeof item === 'number' && !Number.isSafeInteger(item)) throw new TypeError('Неточная числовая величина');
    if (item === undefined || typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol') throw new TypeError('Неверное значение JSON');
    return item;
  };
  return JSON.stringify(normalize(value));
}

export function canonicalJsonHash(value: unknown): string { return hash(safeJson(value)); }
export function runRequestHash(input: { projectId: string; datasetVersionId: string; scope: unknown; asOfDate: string; configuration: unknown; algorithmVersion: string; runMode: 'full' | 'diagnostic' }): string {
  return canonicalJsonHash({ projectId: input.projectId, datasetVersionId: input.datasetVersionId, scope: input.scope,
    asOfDate: input.asOfDate, configuration: input.configuration, algorithmVersion: input.algorithmVersion, runMode: input.runMode });
}
export function approvalRequestHash(runId: string, reviewVersion: number): string {
  return canonicalJsonHash({ runId, reviewVersion });
}

async function transaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function lockOwnedProject(client: PoolClient, projectId: string, userId: string): Promise<void> {
  if (!userId) throw new DatabaseAccessError();
  const result = await client.query('SELECT id FROM projects WHERE id=$1 AND owner_user_id=$2 AND archived_at IS NULL FOR UPDATE', [projectId, userId]);
  if (!result.rowCount) throw new DatabaseAccessError();
}

export function createRepositories(pool: Pool) {
  const db = drizzle(pool);
  return {
    async createProject(userId: string, name: string) {
      if (!userId || userId.length > 200) throw new TypeError('Неверный идентификатор владельца');
      const parsed = CreateProjectSchema.parse({ name });
      const id = randomUUID();
      const [project] = await db.insert(projects).values({ id, ownerUserId: userId, name: parsed.name }).returning();
      return project;
    },
    async getProject(userId: string, projectId: string) {
      if (!userId) throw new DatabaseAccessError();
      const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
      if (!project || project.ownerUserId !== userId) throw new DatabaseAccessError();
      return project;
    },
    async archiveProject(userId: string, projectId: string) {
      return transaction(pool, async (client) => {
        await lockOwnedProject(client, projectId, userId);
        await client.query('UPDATE projects SET archived_at=now(), updated_at=now() WHERE id=$1', [projectId]);
      });
    },
    async createSourceObject(userId: string, input: { id: string; projectId: string; objectKey: string; checksum: string; byteSize: number; contentType: string; purpose: 'source' | 'report' | 'export' }) {
      assertHash(input.checksum);
      SourceObjectSchema.parse({ id: input.id, projectId: input.projectId, objectKey: input.objectKey, checksum: input.checksum, byteSize: input.byteSize, contentType: input.contentType, purpose: input.purpose, createdAt: new Date().toISOString() });
      return transaction(pool, async (client) => {
        await lockOwnedProject(client, input.projectId, userId);
        const existing = await client.query('SELECT * FROM source_objects WHERE project_id=$1 AND checksum=$2', [input.projectId, input.checksum]);
        if (existing.rowCount) {
          if (existing.rows[0].id !== input.id || existing.rows[0].object_key !== input.objectKey || existing.rows[0].byte_size !== input.byteSize || existing.rows[0].content_type !== input.contentType) throw new DatabaseConflictError();
          return existing.rows[0];
        }
        const id = input.id;
        const result = await client.query('INSERT INTO source_objects(id,project_id,object_key,checksum,byte_size,content_type,purpose) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [id,input.projectId,input.objectKey,input.checksum,input.byteSize,input.contentType,input.purpose]);
        return result.rows[0];
      });
    },
    async createImport(userId: string, input: { projectId: string; sourceObjectId: string; checksum: string; manifest: unknown; manifestHash: string; adapterVersion: string; schemaVersion: string; idempotencyKey: string }) {
      assertHash(input.checksum); assertHash(input.manifestHash);
      const parsedManifest = SourceManifestSchema.parse(input.manifest);
      const manifest = safeJson(parsedManifest);
      if (hash(manifest) !== input.manifestHash) throw new DatabaseConflictError();
      return transaction(pool, async (client) => {
        await lockOwnedProject(client, input.projectId, userId);
        const existing = await client.query('SELECT * FROM imports WHERE project_id=$1 AND checksum=$2 AND manifest_hash=$3 AND adapter_version=$4 AND schema_version=$5',
          [input.projectId,input.checksum,input.manifestHash,input.adapterVersion,input.schemaVersion]);
        if (existing.rowCount) {
          if (existing.rows[0].source_object_id !== input.sourceObjectId || safeJson(existing.rows[0].manifest) !== manifest) throw new DatabaseConflictError();
          return existing.rows[0];
        }
        const source = await client.query('SELECT id,checksum,purpose FROM source_objects WHERE project_id=$1 AND id=ANY($2::uuid[])',
          [input.projectId,parsedManifest.map((entry) => entry.sourceObjectId)]);
        if (source.rowCount !== new Set(parsedManifest.map((entry) => entry.sourceObjectId)).size ||
          !parsedManifest.some((entry) => entry.sourceObjectId === input.sourceObjectId && entry.checksum === input.checksum) ||
          parsedManifest.some((entry) => !source.rows.some((row) => row.id === entry.sourceObjectId && row.checksum === entry.checksum && row.purpose === 'source'))) throw new DatabaseConflictError();
        const id = randomUUID();
        const result = await client.query(`INSERT INTO imports(id,project_id,source_object_id,checksum,manifest,manifest_hash,adapter_version,schema_version,status)
          VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,'awaiting-validation') RETURNING *`,
          [id,input.projectId,input.sourceObjectId,input.checksum,manifest,input.manifestHash,input.adapterVersion,input.schemaVersion]);
        await client.query(`INSERT INTO dispatch_intents(id,project_id,operation_type,import_id,idempotency_key,payload_version,payload_hash)
          VALUES($1,$2,'import',$3,$4,'1',$5)`, [randomUUID(),input.projectId,id,input.idempotencyKey,canonicalJsonHash({ operationType: 'import', businessId: id, manifestHash: input.manifestHash })]);
        return result.rows[0];
      });
    },
    async publishDatasetVersion(userId: string, input: { projectId: string; importId: string; manifest: unknown; manifestHash: string; asOfDate: string; provenance: 'partner' | 'synthetic' | 'mixed'; sourceCompleteness: unknown; schemaVersion: string }, writeSnapshot?: (client: PoolClient, snapshot: { projectId: string; datasetVersionId: string }) => Promise<void>) {
      assertHash(input.manifestHash);
      if (canonicalJsonHash(SourceManifestSchema.parse(input.manifest)) !== input.manifestHash) throw new DatabaseConflictError();
      return transaction(pool, async (client) => {
        await lockOwnedProject(client, input.projectId, userId);
        const source = await client.query('SELECT * FROM imports WHERE project_id=$1 AND id=$2 FOR UPDATE', [input.projectId,input.importId]);
        if (!source.rowCount) throw new DatabaseAccessError();
        if (source.rows[0].status !== 'validating' || source.rows[0].quality_report === null || source.rows[0].dataset_version_id || source.rows[0].manifest_hash !== input.manifestHash || safeJson(source.rows[0].manifest) !== safeJson(input.manifest)) throw new DatabaseConflictError();
        const quality = QualityReportSchema.parse(source.rows[0].quality_report);
        if (quality.issues.some((issue) => issue.severity === 'blocking')) throw new DatabaseConflictError();
        const id = randomUUID();
        const parsed = DatasetVersionSchema.parse({ id, projectId: input.projectId, importId: input.importId, schemaVersion: input.schemaVersion, asOfDate: input.asOfDate, provenance: input.provenance, manifest: input.manifest, manifestHash: input.manifestHash, sourceCompleteness: input.sourceCompleteness, createdAt: new Date().toISOString() });
        const result = await client.query(`INSERT INTO dataset_versions(id,project_id,import_id,manifest,manifest_hash,as_of_date,provenance,source_completeness,schema_version)
          VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8::jsonb,$9) RETURNING *`,
          [id,input.projectId,input.importId,safeJson(parsed.manifest),input.manifestHash,input.asOfDate,input.provenance,safeJson(parsed.sourceCompleteness),input.schemaVersion]);
        // Нормализатор06 пишет проверенные строки в эту же транзакцию до запечатывания снимка.
        await writeSnapshot?.(client, { projectId: input.projectId, datasetVersionId: id });
        await client.query(`UPDATE imports SET dataset_version_id=$1,status='ready',state_version=state_version+1,updated_at=now() WHERE id=$2`, [id,input.importId]);
        return result.rows[0];
      });
    },
    async createCalculationRun(userId: string, input: { projectId: string; datasetVersionId: string; scope: unknown; asOfDate: string; configuration: unknown; configurationHash: string; requestHash: string; algorithmVersion: string; idempotencyKey: string; runMode: 'full' | 'diagnostic' }) {
      assertHash(input.configurationHash); assertHash(input.requestHash);
      const parsedConfig = RunConfigurationSchema.parse(input.configuration);
      const parsedScope = CalculationScopeSchema.parse(input.scope);
      if (parsedConfig.runMode !== input.runMode || parsedConfig.asOfDate !== input.asOfDate || parsedConfig.algorithmVersion !== input.algorithmVersion || safeJson(parsedConfig.scope) !== safeJson(parsedScope)) throw new DatabaseConflictError();
      const configuration = safeJson(parsedConfig); const scope = safeJson(parsedScope);
      if (hash(configuration) !== input.configurationHash || runRequestHash({ ...input, configuration: parsedConfig, scope: parsedScope }) !== input.requestHash) throw new DatabaseConflictError();
      return transaction(pool, async (client) => {
        await lockOwnedProject(client, input.projectId, userId);
        if (parsedScope.warehouseIds.length) {
          const warehouses = await client.query('SELECT id FROM warehouses WHERE project_id=$1 AND dataset_version_id=$2 AND id=ANY($3::uuid[])', [input.projectId,input.datasetVersionId,parsedScope.warehouseIds]);
          if (warehouses.rowCount !== parsedScope.warehouseIds.length) throw new DatabaseAccessError();
        }
        if (parsedScope.categoryIds.length) {
          const categories = await client.query('SELECT category_key FROM products WHERE project_id=$1 AND dataset_version_id=$2 UNION SELECT category_key FROM category_policies WHERE project_id=$1 AND dataset_version_id=$2', [input.projectId,input.datasetVersionId]);
          if (parsedScope.categoryIds.some((key) => !categories.rows.some((row) => row.category_key === key))) throw new DatabaseAccessError();
        }
        const existing = await client.query('SELECT * FROM calculation_runs WHERE project_id=$1 AND idempotency_key=$2', [input.projectId,input.idempotencyKey]);
        if (existing.rowCount) {
          const matched = await client.query('SELECT 1 FROM calculation_runs WHERE id=$1 AND dataset_version_id=$2 AND scope=$3::jsonb AND as_of_date=$4 AND configuration=$5::jsonb AND configuration_hash=$6 AND request_hash=$7 AND algorithm_version=$8 AND run_mode=$9',
            [existing.rows[0].id,input.datasetVersionId,scope,input.asOfDate,configuration,input.configurationHash,input.requestHash,input.algorithmVersion,input.runMode]);
          if (!matched.rowCount) throw new DatabaseConflictError();
          return existing.rows[0];
        }
        const id = randomUUID();
        const result = await client.query(`INSERT INTO calculation_runs(id,project_id,dataset_version_id,requested_by,scope,as_of_date,configuration,configuration_hash,request_hash,algorithm_version,idempotency_key,run_mode,status)
          VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10,$11,$12,'queued') RETURNING *`,
          [id,input.projectId,input.datasetVersionId,userId,scope,input.asOfDate,configuration,input.configurationHash,input.requestHash,input.algorithmVersion,input.idempotencyKey,input.runMode]);
        await client.query(`INSERT INTO dispatch_intents(id,project_id,operation_type,run_id,idempotency_key,payload_version,payload_hash)
          VALUES($1,$2,'calculation',$3,$4,'1',$5)`,[randomUUID(),input.projectId,id,input.idempotencyKey,canonicalJsonHash({ operationType: 'calculation', businessId: id, configurationHash: input.configurationHash })]);
        return result.rows[0];
      });
    },
    async addRecommendation(userId: string, input: {
      projectId: string; datasetVersionId: string; runId: string; productId: string; warehouseId: string; supplierId: string;
      calculationVersion: string; supplierArticle: string | null; recommendedQuantity: string | null;
      quantityStatus: 'known' | 'unavailable'; unit: string; urgency: 'unknown' | 'urgent' | 'planned' | 'none';
      projectedStockoutDate: string | null; shortageDays: number | null;
      numericFactors: unknown; dataQuality: 'complete' | 'limited' | 'unavailable'; rationale: string;
    }) {
      if (input.recommendedQuantity !== null) assertDecimal(input.recommendedQuantity);
      const id = randomUUID();
      const parsed = RecommendationSchema.parse({ ...input, id, createdAt: new Date().toISOString() });
      return transaction(pool, async (client) => {
        await lockOwnedProject(client,input.projectId,userId);
        const run = await client.query('SELECT run_mode FROM calculation_runs WHERE project_id=$1 AND dataset_version_id=$2 AND id=$3', [input.projectId,input.datasetVersionId,input.runId]);
        if (!run.rowCount || (input.quantityStatus==='unavailable' && run.rows[0].run_mode!=='diagnostic')) throw new DatabaseConflictError();
        const result = await client.query(`INSERT INTO recommendations(id,project_id,dataset_version_id,run_id,product_id,warehouse_id,supplier_id,calculation_version,supplier_article,
          recommended_quantity,quantity_status,unit,urgency,projected_stockout_date,shortage_days,numeric_factors,data_quality,rationale)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18) RETURNING *`,
          [id,input.projectId,input.datasetVersionId,input.runId,input.productId,input.warehouseId,input.supplierId,parsed.calculationVersion,parsed.supplierArticle,
            parsed.recommendedQuantity,parsed.quantityStatus,parsed.unit,parsed.urgency,parsed.projectedStockoutDate,parsed.shortageDays,safeJson(parsed.numericFactors),parsed.dataQuality,parsed.rationale]);
        return { ...result.rows[0], recommended_quantity: result.rows[0].recommended_quantity === null ? null : canonicalDecimal(result.rows[0].recommended_quantity) };
      });
    },
    async addReview(userId: string, input: { projectId: string; runId: string; recommendationId: string; expectedReviewVersion: number; reviewedQuantity: string; reason: string }) {
      assertDecimal(input.reviewedQuantity);
      if (!input.reason.trim()) throw new TypeError('Укажите причину');
      RecommendationReviewSchema.parse({ id: randomUUID(), projectId: input.projectId, runId: input.runId, recommendationId: input.recommendationId, reviewVersion: input.expectedReviewVersion + 1, reviewedQuantity: input.reviewedQuantity, reason: input.reason, authorUserId: userId, createdAt: new Date().toISOString() });
      return transaction(pool, async (client) => {
        await lockOwnedProject(client,input.projectId,userId);
        const run = await client.query('SELECT review_version FROM calculation_runs WHERE project_id=$1 AND id=$2 FOR UPDATE',[input.projectId,input.runId]);
        if (!run.rowCount || run.rows[0].review_version!==input.expectedReviewVersion) throw new DatabaseConflictError();
        const nextVersion = input.expectedReviewVersion+1;
        const result = await client.query(`INSERT INTO recommendation_reviews(id,project_id,run_id,recommendation_id,review_version,reviewed_quantity,reason,author_user_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[randomUUID(),input.projectId,input.runId,input.recommendationId,nextVersion,input.reviewedQuantity,input.reason.trim(),userId]);
        await client.query('UPDATE calculation_runs SET review_version=$1,state_version=state_version+1 WHERE id=$2',[nextVersion,input.runId]);
        return { ...result.rows[0], reviewed_quantity: canonicalDecimal(result.rows[0].reviewed_quantity) };
      });
    },
    async approve(userId: string, input: { projectId: string; runId: string; expectedReviewVersion: number; idempotencyKey: string; requestHash: string }) {
      assertHash(input.requestHash);
      if (approvalRequestHash(input.runId,input.expectedReviewVersion) !== input.requestHash) throw new DatabaseConflictError();
      return transaction(pool, async (client) => {
        await lockOwnedProject(client,input.projectId,userId);
        const run = await client.query('SELECT * FROM calculation_runs WHERE project_id=$1 AND id=$2 FOR UPDATE',[input.projectId,input.runId]);
        if (!run.rowCount) throw new DatabaseAccessError();
        const existing = await client.query('SELECT * FROM approvals WHERE run_id=$1 AND idempotency_key=$2',[input.runId,input.idempotencyKey]);
        if (existing.rowCount) {
          if (existing.rows[0].request_hash!==input.requestHash || existing.rows[0].review_version!==input.expectedReviewVersion) throw new DatabaseConflictError();
          return existing.rows[0];
        }
        const state=run.rows[0];
        if (state.review_version!==input.expectedReviewVersion || state.run_mode!=='full' || state.status!=='succeeded' || state.coverage_gate!=='complete' || !Array.isArray(state.blocking_reasons) || state.blocking_reasons.length || state.safe_error) throw new DatabaseConflictError();
        const lines = await client.query(`SELECT r.id,r.recommended_quantity,rv.reviewed_quantity FROM recommendations r
          LEFT JOIN LATERAL (SELECT reviewed_quantity FROM recommendation_reviews WHERE recommendation_id=r.id AND review_version<=$2 ORDER BY review_version DESC LIMIT 1) rv ON true
          WHERE r.run_id=$1 ORDER BY r.id`,[input.runId,input.expectedReviewVersion]);
        if (!lines.rowCount || lines.rows.some((line) => line.recommended_quantity===null)) throw new DatabaseConflictError();
        const linesHash=hash(JSON.stringify(lines.rows.map((line) => [line.id,canonicalDecimal(line.reviewed_quantity ?? line.recommended_quantity)])));
        const result=await client.query(`INSERT INTO approvals(id,project_id,run_id,review_version,lines_hash,author_user_id,idempotency_key,request_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[randomUUID(),input.projectId,input.runId,input.expectedReviewVersion,linesHash,userId,input.idempotencyKey,input.requestHash]);
        return result.rows[0];
      });
    },
    async appendRunEvent(userId: string, input: { projectId: string; runId: string; eventType: string; safePayload: unknown }) {
      return transaction(pool,async(client)=>{
        await lockOwnedProject(client,input.projectId,userId);
        const run=await client.query('SELECT id FROM calculation_runs WHERE project_id=$1 AND id=$2 FOR UPDATE',[input.projectId,input.runId]);
        if(!run.rowCount)throw new DatabaseAccessError();
        const sequence=await client.query('SELECT COALESCE(MAX(sequence_no),0)+1 AS next FROM run_events WHERE run_id=$1',[input.runId]);
        const event = RunEventSchema.parse({ id: randomUUID(), projectId: input.projectId, runId: input.runId, sequenceNo: sequence.rows[0].next, eventType: input.eventType, safePayload: input.safePayload, createdAt: new Date().toISOString() });
        const result=await client.query('INSERT INTO run_events(id,project_id,run_id,sequence_no,event_type,safe_payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *',[event.id,event.projectId,event.runId,event.sequenceNo,event.eventType,safeJson(event.safePayload)]);
        return result.rows[0];
      });
    },
  };
}
