import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import { DatasetVersionSchema, SourceManifestSchema, type DatasetVersion, ProductSchema, SupplierSchema, WarehouseSchema, ProductSupplierSchema, SaleSchema, MonthlySalesSchema, StockSnapshotSchema, InboundShipmentSchema, StockoutIntervalSchema, CategoryPolicySchema, GrowthAssumptionSchema, SeasonalityIndexSchema, SupplierLeadTimeSchema } from '../../contracts/datasets';
import type { NormalizedDraft } from '../../contracts/imports';
import { assertValidatedDraft, importHash } from './service';
import type { UploadedObject } from '../storage';
import { appendImportAudit } from './audit';

export interface CommitDependencies {
  pool: Pool;
  /** Только проверенная серверная личность, не значение из HTTP body. */
  userId: string;
  /** Фоновая публикация привязывается к уже замороженной попытке, а не создаёт импорт заново. */
  importId?: string;
  reportObject?: UploadedObject;
  /** Доверенная замена встроенного writer для тестов/специальных схем; та же транзакция, без сети и COMMIT. */
  writeSnapshot?: (client: PoolClient, snapshot: { projectId: string; datasetVersionId: string }, draft: NormalizedDraft) => Promise<void>;
}

/** Публикация атомарна: ошибка writer откатывает импорт, версию и все строки. */
export async function commitDataset(draft: NormalizedDraft, dependencies: CommitDependencies): Promise<DatasetVersion> {
  const report = assertValidatedDraft(draft);
  if (!dependencies.userId) throw new Error('Для публикации требуется авторизованный обработчик записи');
  // Не позволять вызывающему коду изменить проверенные данные во время await.
  const snapshotDraft = structuredClone(draft);
  const { manifest } = snapshotDraft;
  const sources = manifest.sources.filter(source => source.sourceObjectId !== null && source.checksum !== null);
  if (!sources.length) throw new Error('Нельзя опубликовать набор без исходного объекта');
  const client = await dependencies.pool.connect();
  try {
    await client.query('BEGIN');
    const owner = await client.query('SELECT id FROM projects WHERE id=$1 AND owner_user_id=$2 AND archived_at IS NULL FOR UPDATE', [manifest.projectId, dependencies.userId]);
    if (!owner.rowCount) throw new Error('Ресурс недоступен');
    // Только уже подтверждённые приватные SourceObject. Сервис никогда не загружает URL.
    const objects = await client.query<{id:string;checksum:string}>('SELECT id,checksum FROM source_objects WHERE project_id=$1 AND purpose=$2 AND id=ANY($3::uuid[])', [manifest.projectId,'source',sources.map(source => source.sourceObjectId)]);
    for (const source of sources) {
      if (!objects.rows.some(object => object.id === source.sourceObjectId && object.checksum === source.checksum)) throw new Error('Исходный объект недоступен или изменён');
    }
    const persistedManifest = SourceManifestSchema.parse(sources.map(source => ({
      sourceType:source.sourceType,sourceObjectId:source.sourceObjectId,checksum:source.checksum,
      origin:source.origin,sheet:source.sheet,mappingVersion:source.mappingVersion,
      columnMappings:[], importMetadata:{...manifest,validationReport:report},
    })));
    const manifestHash = importHash(persistedManifest);
    const primary = sources[0];
    const existing = dependencies.importId
      ? await client.query<{id:string;dataset_version_id:string|null;status:string;manifest_hash:string}>(
        'SELECT id,dataset_version_id,status,manifest_hash FROM imports WHERE project_id=$1 AND id=$2 FOR UPDATE',
        [manifest.projectId,dependencies.importId])
      : await client.query<{id:string;dataset_version_id:string|null;status:string;manifest_hash:string}>(
        'SELECT id,dataset_version_id,status,manifest_hash FROM imports WHERE project_id=$1 AND checksum=$2 AND manifest_hash=$3 AND adapter_version=$4 AND schema_version=$5 FOR UPDATE',
        [manifest.projectId,primary.checksum,manifestHash,manifest.adapterVersion,manifest.schemaVersion]);
    if (existing.rows[0]) {
      const previous = existing.rows[0];
      if (dependencies.importId && previous.manifest_hash !== importHash(manifest)) throw new Error('Manifest попытки не совпадает с проверенным');
      if (previous.status === 'ready' && previous.dataset_version_id) {
        const found = await client.query<{created_at:Date}>('SELECT created_at FROM dataset_versions WHERE project_id=$1 AND id=$2', [manifest.projectId,previous.dataset_version_id]);
        if (!found.rows[0]) throw new Error('Версия данных недоступна');
        const result = dataset(previous.dataset_version_id,previous.id,found.rows[0].created_at.toISOString());
        await client.query('COMMIT');
        return result;
      }
      if (!dependencies.importId || previous.status !== 'validating') throw new Error('Импорт уже обрабатывается или требует исправления');
    } else if (dependencies.importId) {
      throw new Error('Попытка импорта недоступна');
    }
    const importId = dependencies.importId ?? randomUUID();
    const datasetId = randomUUID();
    const quality = {checkedRows:report.checkedRows,acceptedRows:report.acceptedRows,rejectedRows:0,issues:report.issues.filter(issue=>issue.sourceType !== null && issue.severity === 'warning').map(issue=>({code:issue.code,severity:'warning',sourceType:issue.sourceType,rowNumber:issue.rowNumber,count:1}))};
    if (!dependencies.importId) {
      await client.query(`INSERT INTO imports(id,project_id,source_object_id,checksum,manifest,manifest_hash,adapter_version,schema_version,status,quality_report) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,'validating',$9::jsonb)`,
        [importId,manifest.projectId,primary.sourceObjectId,primary.checksum,JSON.stringify(persistedManifest),manifestHash,manifest.adapterVersion,manifest.schemaVersion,JSON.stringify(quality)]);
    }
    if (dependencies.reportObject) {
      const object = dependencies.reportObject;
      if (object.projectId !== manifest.projectId || object.id !== importId || object.purpose !== 'report' || !object.confirmed)
        throw new Error('Отчёт не соответствует попытке импорта');
      await client.query(`INSERT INTO source_objects(id,project_id,object_key,checksum,byte_size,content_type,purpose)
        VALUES($1,$2,$3,$4,$5,$6,'report') ON CONFLICT(id) DO NOTHING`,
        [object.id,object.projectId,object.key,object.sha256Hex,object.sizeBytes,object.contentType]);
    }
    if (dependencies.importId) {
      const validated = await client.query<{state_version:number}>(`UPDATE imports SET
        publication_manifest=$3::jsonb,publication_manifest_hash=$4,quality_report=$5::jsonb,
        state_version=state_version+1,updated_at=now()
        WHERE project_id=$1 AND id=$2 AND status='validating'
          AND (publication_manifest IS NULL OR publication_manifest=$3::jsonb)
          AND (publication_manifest_hash IS NULL OR publication_manifest_hash=$4)
        RETURNING state_version`,
        [manifest.projectId,importId,JSON.stringify(persistedManifest),manifestHash,JSON.stringify(quality)]);
      if (!validated.rows[0]) throw new Error('Сохранённый снимок публикации не совпадает');
      await appendImportAudit(client,{projectId:manifest.projectId,importId,actorUserId:dependencies.userId,status:'validated',stateVersion:validated.rows[0].state_version});
    }
    const result = dataset(datasetId,importId,new Date().toISOString());
    await client.query(`INSERT INTO dataset_versions(id,project_id,import_id,manifest,manifest_hash,as_of_date,provenance,source_completeness,schema_version,created_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8::jsonb,$9,$10)`,
      [datasetId,manifest.projectId,importId,JSON.stringify(persistedManifest),manifestHash,result.asOfDate,result.provenance,JSON.stringify(result.sourceCompleteness),result.schemaVersion,result.createdAt]);
    await (dependencies.writeSnapshot ?? writeNormalizedSnapshot)(client,{projectId:manifest.projectId,datasetVersionId:datasetId},snapshotDraft);
    let published;
    if (dependencies.reportObject) {
      published = await client.query<{state_version:number}>(`UPDATE imports SET dataset_version_id=$1,status='ready',quality_report=$3::jsonb,
        report_object_id=$4,report_checksum=$5,state_version=state_version+1,updated_at=now()
        WHERE id=$2 AND status='validating' RETURNING state_version`,[datasetId,importId,JSON.stringify(quality),dependencies.reportObject.id,dependencies.reportObject.sha256Hex]);
    } else {
      published = await client.query<{state_version:number}>("UPDATE imports SET dataset_version_id=$1,status='ready',quality_report=$3::jsonb,state_version=state_version+1,updated_at=now() WHERE id=$2 AND status='validating' RETURNING state_version",[datasetId,importId,JSON.stringify(quality)]);
    }
    if (!published.rows[0]) throw new Error('Попытка изменила состояние при публикации');
    await appendImportAudit(client,{projectId:manifest.projectId,importId,actorUserId:dependencies.userId,status:'ready',stateVersion:published.rows[0].state_version});
    await client.query('COMMIT');
    return result;

    function dataset(id:string, importId:string, createdAt:string): DatasetVersion {
      const origins = new Set(sources.map(source=>source.origin));
      return DatasetVersionSchema.parse({id,projectId:manifest.projectId,importId,manifest:persistedManifest,manifestHash,
        asOfDate:manifest.asOfDate,provenance:origins.size>1?'mixed':sources[0].origin,
        sourceCompleteness:snapshotDraft.sourceCompleteness,schemaVersion:manifest.schemaVersion,createdAt});
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

/** Встроенный writer: только явные связи и проверенные DTO04; неизвестное не публикуется. */
export async function writeNormalizedSnapshot(client:PoolClient, snapshot:{projectId:string;datasetVersionId:string}, draft:NormalizedDraft):Promise<void> {
  const products = new Map<string,{id:string;unit:string}>();
  const warehouses = new Map<string,string>();
  const suppliers = new Map<string,string>();
  const now = new Date().toISOString();
  const entity = () => ({...snapshot,id:randomUUID()});
  const required = (values:Record<string,string|null>, key:string):string => {
    const value=values[key]; if (!value) throw new Error(`Не разрешено обязательное поле: ${key}`); return value;
  };
  async function insert(table:string,schema:z.ZodType,value:unknown):Promise<void> {
    const parsed=schema.parse(value);
    if (!parsed || typeof parsed !== 'object') throw new Error('Некорректная строка снимка');
    const entries=Object.entries(parsed);
    const columns=entries.map(([key])=>key.replace(/[A-Z]/g,letter=>`_${letter.toLowerCase()}`));
    const values=entries.map(([,item])=>item!==null && typeof item==='object'?JSON.stringify(item):item);
    await client.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${values.map((_,index)=>`$${index+1}`).join(',')})`,values);
  }
  for (const row of draft.rows) {
    const v=row.values;
    for (const [key,map,table,schema] of [
      ['warehouseKey',warehouses,'warehouses',WarehouseSchema],['supplierKey',suppliers,'suppliers',SupplierSchema],
    ] as const) {
      const sourceKey=v[key];
      if (sourceKey && !map.has(sourceKey)) {
        const record={...entity(),sourceKey,name:sourceKey,createdAt:now};
        await insert(table,schema,record); map.set(sourceKey,record.id);
      }
    }
    if (row.sourceType==='product_mapping') {
      const key=v.productKey ?? `${row.namespace}:${required(v,'sku')}`;
      if (products.has(key)) throw new Error('Конфликт сопоставлений товара');
      const product={...entity(),sourceKey:key,sku:required(v,'sku'),name:required(v,'productName'),unit:required(v,'unit'),categoryKey:required(v,'category'),conversions:[],createdAt:now};
      if (v.conversionFactor) throw new Error('Для конверсии требуется явная исходная единица');
      await insert('products',ProductSchema,product);products.set(key,{id:product.id,unit:product.unit});
    }
  }
  for (const row of draft.rows) {
    const v=row.values;
    const source=draft.manifest.sources.find(source=>source.sourceObjectId===row.sourceObjectId && source.sourceType===row.sourceType && source.sheet===row.sourceSheet && source.namespace===row.namespace);
    if (!source) throw new Error('Происхождение строки не соответствует manifest');
    const product=products.get(v.productKey ?? `${row.namespace}:${v.sku}`);
    const warehouseId=v.warehouseKey?warehouses.get(v.warehouseKey):undefined;
    const supplierId=v.supplierKey?suppliers.get(v.supplierKey):undefined;
    if (v.unit && product && v.unit!==product.unit) throw new Error('Единица не соответствует товару');
    const observation={...entity(),productId:product?.id,warehouseId,sourceObjectId:row.sourceObjectId,sourceSheet:row.sourceSheet,sourceRowNumber:row.sourceRowNumber};
    switch(row.sourceType) {
      case 'product_mapping':
        if (supplierId) await insert('product_suppliers',ProductSupplierSchema,{...entity(),productId:product?.id,supplierId,supplierSku:v.supplierSku??null,moq:v.moq??null,packMultiple:v.packMultiple??null,conversion:null});
        break;
      case 'suppliers': break;
      case 'sales':
        await insert('sales',SaleSchema,{...observation,soldOn:required(v,'date'),quantity:required(v,'quantity'),unit:required(v,'unit'),operationType:required(v,'operationType'),sourceEventId:v.sourceEventId??`${row.namespace}:${row.sourceObjectId}:${row.sourceSheet}:${row.sourceRowNumber}`,unitPrice:v.price??null,anonymousCustomerKey:v.anonymizedCustomerKey??null,customerKeyAvailable:!!v.anonymizedCustomerKey});break;
      case 'monthly_sales':
        if (v.periodCompleteness === 'partial') throw new Error('Неполный месяц нельзя опубликовать как полный');
        await insert('monthly_sales',MonthlySalesSchema,{...observation,periodMonth:required(v,'period'),quantity:required(v,'quantity'),unit:required(v,'unit'),granularity:'month',completeness:'complete',origin:source.origin,methodVersion:source.mappingVersion});break;
      case 'stock':
        await insert('stock_snapshots',StockSnapshotSchema,{...observation,asOfDate:required(v,'date'),quantity:required(v,'stockQuantity'),unit:required(v,'unit')});break;
      case 'inbound':
        await insert('inbound_shipments',InboundShipmentSchema,{...observation,expectedOn:required(v,'expectedDate'),quantity:required(v,'inboundQuantity'),unit:required(v,'unit'),supplierId:supplierId??null,sourceKey:v.sourceEventId??`${row.namespace}:${row.sourceObjectId}:${row.sourceSheet}:${row.sourceRowNumber}`});break;
      case 'stockouts':
        await insert('stockout_intervals',StockoutIntervalSchema,{...observation,startsOn:required(v,'startDate'),endsOn:required(v,'endDate'),status:required(v,'stockoutStatus')});break;
      case 'categories': {
        const reviewPeriodDays=Number(required(v,'reviewPeriodDays'));
        const safetyDays=Number(required(v,'safetyDays'));
        await insert('category_policies',CategoryPolicySchema,{...entity(),categoryKey:required(v,'category'),reviewPeriodDays,safetyStock:v.safetyStock??null,parameters:{reviewPeriodDays,safetyDays,safetyStock:v.safetyStock??null},policyVersion:source.mappingVersion});break;
      }
      case 'growth':
        await insert('growth_assumptions',GrowthAssumptionSchema,{...entity(),categoryKey:required(v,'category'),effectiveFrom:required(v,'date'),growthRate:required(v,'growthFactor'),method:'provided',provenance:source.origin});break;
      case 'seasonality':
        await insert('seasonality_indices',SeasonalityIndexSchema,{...entity(),productId:product?.id??null,categoryKey:product?null:v.category??null,periodMonth:Number(required(v,'period')),indexValue:required(v,'seasonalityIndex'),methodVersion:source.mappingVersion,method:'provided',completeness:'complete'});break;
      case 'lead_times':
        await insert('supplier_lead_times',SupplierLeadTimeSchema,{...entity(),supplierId,productId:product?.id??null,categoryKey:product?null:v.category??null,days:Number(required(v,'leadTimeDays')),provenance:source.origin});break;
      case 'material_statement': throw new Error('Материальная ведомость требует подтверждённой предметной схемы');
    }
  }
}
