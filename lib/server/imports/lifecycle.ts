import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ImportManifestSchema, ImportReportSchema } from '../../contracts/imports';
import { z } from 'zod';
import { ProjectDataError } from '../project-data-errors';
import type { UploadStorage } from './upload-storage';
import { SourceTypeSchema } from '../../contracts/datasets';
import { insertImportDispatch } from './dispatch';
import { appendImportAudit } from './audit';

const UploadSchema = z.strictObject({ fileName: z.string().trim().min(1).max(255), size: z.number().int().min(1).max(26214400), contentType: z.enum(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv','application/zip']), checksum: z.string().regex(/^[a-f0-9]{64}$/), sourceRole: SourceTypeSchema });
const PageSchema = z.strictObject({ cursor:z.string().uuid().optional(), limit:z.coerce.number().int().min(1).max(100).default(25) });
export class ImportLifecycleError extends ProjectDataError {
  constructor(code:string, status:number) { super(status,code,code === 'NOT_FOUND' ? 'Импорт или проект не найден.' : code === 'LIMIT_EXCEEDED' ? 'Превышен лимит активных загрузок.' : 'Операция с импортом недопустима.'); }
}
function hash(value:unknown):string {
  const canonical=(v:unknown):unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v==='object' ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a < b ? -1 : a > b ? 1 : 0).map(([k,x])=>[k,canonical(x)])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
type ImportRow={id:string; source_object_id:string; checksum:string; manifest_hash:string; manifest_frozen:boolean; status:string; state_version:number; dataset_version_id:string|null; report_object_id:string|null; quality_report:unknown; safe_error:string|null; created_at:Date; updated_at:Date};
function dto(row:ImportRow) { return {importId:row.id,sourceObjectId:row.source_object_id,status:row.status,stateVersion:row.state_version,datasetVersionId:row.dataset_version_id,report:row.quality_report,error:row.safe_error,validationPending:row.status==='awaiting-validation',createdAt:row.created_at,updatedAt:row.updated_at}; }
export const importHttpStatus = Symbol('importHttpStatus');
function response(row:ImportRow,status:number) { return Object.defineProperty(dto(row),importHttpStatus,{value:status}) as ReturnType<typeof dto> & {[importHttpStatus]:number}; }
export function createImportLifecycle({pool,storage,dispatch,readReport}:{pool:Pool;storage:Pick<UploadStorage, 'signUpload' | 'head'>;dispatch?:(importId:string)=>Promise<void>;readReport?:(userId:string,projectId:string,objectId:string)=>Promise<unknown>}) {
  async function tx<T>(fn:(c:PoolClient)=>Promise<T>):Promise<T> { const c=await pool.connect(); try { await c.query('BEGIN'); const r=await fn(c); await c.query('COMMIT'); return r; } catch(e) {await c.query('ROLLBACK'); throw e;} finally {c.release();} }
  async function project(c:PoolClient,userId:string,id:string,write=false) { z.string().uuid().parse(id); const r=await c.query('SELECT archived_at FROM projects WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[id,userId]); if(!r.rowCount) throw new ImportLifecycleError('NOT_FOUND',404); if(write&&r.rows[0].archived_at) throw new ImportLifecycleError('ARCHIVED',409); }
  async function row(c:PoolClient,projectId:string,importId:string) { z.string().uuid().parse(importId); const r=await c.query<ImportRow>('SELECT * FROM imports WHERE project_id=$1 AND id=$2 FOR UPDATE',[projectId,importId]); if(!r.rowCount) throw new ImportLifecycleError('NOT_FOUND',404); return r.rows[0]; }
  function manifest(input:unknown,projectId:string,source:ImportRow) { const parsed=z.strictObject({manifest:ImportManifestSchema}).parse(input).manifest; if(parsed.projectId!==projectId || !parsed.sources.some(s=>s.sourceObjectId===source.source_object_id && s.checksum===source.checksum)) throw new ImportLifecycleError('INVALID_MANIFEST',422); return parsed; }
  async function assertManifestObjects(c:PoolClient,projectId:string,m:z.infer<typeof ImportManifestSchema>) {
    const references = new Map(m.sources.filter(s=>s.sourceObjectId!==null).map(s=>[s.sourceObjectId!,s.checksum]));
    const found = await c.query<{id:string;checksum:string}>('SELECT id,checksum FROM source_objects WHERE project_id=$1 AND purpose=$2 AND id=ANY($3::uuid[])',[projectId,'source',[...references.keys()]]);
    if(found.rowCount!==references.size || found.rows.some(object=>references.get(object.id)!==object.checksum)) throw new ImportLifecycleError('INVALID_MANIFEST',422);
  }
  return {
    async create(userId:string,projectId:string,input:unknown) {
      const data=UploadSchema.parse(input);
      return tx(async c=>{
        await project(c,userId,projectId,true);
        const count=await c.query("SELECT count(*)::int AS count FROM imports WHERE project_id=$1 AND status='uploaded'",[projectId]); if(count.rows[0].count>=5) throw new ImportLifecycleError('LIMIT_EXCEEDED',429);
        const sourceId=randomUUID(), importId=randomUUID();
        const inserted=await c.query('INSERT INTO source_objects(id,project_id,object_key,checksum,byte_size,content_type,purpose) VALUES($1,$2,$3,$4,$5,$6,\'source\') ON CONFLICT(project_id,checksum) DO NOTHING RETURNING id',[sourceId,projectId,`projects/${projectId}/sources/${sourceId}`,data.checksum,data.size,data.contentType]);
        if(!inserted.rowCount) throw new ImportLifecycleError('SOURCE_EXISTS',409);
        const provisional={sourceRole:data.sourceRole,uploadId:importId};
        const r=await c.query<ImportRow>("INSERT INTO imports(id,project_id,source_object_id,checksum,manifest,manifest_hash,adapter_version,schema_version,status,manifest_frozen) VALUES($1,$2,$3,$4,$5,$6,'provisional','provisional','uploaded',false) RETURNING *",[importId,projectId,sourceId,data.checksum,provisional,hash(provisional)]);
        const upload=await storage.signUpload({key:`projects/${projectId}/sources/${sourceId}`,sizeBytes:data.size,contentType:data.contentType,checksum:data.checksum}); return {...dto(r.rows[0]),upload};
      });
    },
    async list(userId:string,projectId:string,page:unknown={}) { const p=PageSchema.parse(page); return tx(async c=>{await project(c,userId,projectId); const r=await c.query<ImportRow>('SELECT * FROM imports WHERE project_id=$1 AND ($2::uuid IS NULL OR id<$2) ORDER BY id DESC LIMIT $3',[projectId,p.cursor??null,p.limit+1]); const items=r.rows.slice(0,p.limit).map(dto); return {items,nextCursor:r.rows.length>p.limit?items.at(-1)!.importId:null};}); },
    async get(userId:string,projectId:string,importId:string) {
      const current=await tx(async c=>{await project(c,userId,projectId); return row(c,projectId,importId);});
      if (!current.report_object_id || !readReport) return dto(current);
      const envelope=z.strictObject({
        importId:z.string().uuid(),manifestHash:z.string().regex(/^[a-f0-9]{64}$/),
        adapterVersion:z.string(),schemaVersion:z.string(),report:ImportReportSchema,
        inspection:z.array(z.strictObject({sourceObjectId:z.string().uuid(),sheets:z.array(z.strictObject({
          name:z.string().max(200),headers:z.array(z.string().max(120)).max(200),
        })).max(100)})).max(8),
      }).parse(await readReport(userId,projectId,current.report_object_id));
      if (envelope.importId!==importId || envelope.manifestHash!==current.manifest_hash) throw new ImportLifecycleError('REPORT_MISMATCH',503);
      return {...dto(current),report:envelope.report,mappingPreview:envelope.inspection};
    },
    async finalize(userId:string,projectId:string,importId:string,input:unknown) {
      const result=await tx(async c=>{
        await project(c,userId,projectId,true); const current=await row(c,projectId,importId); const m=manifest(input,projectId,current), digest=hash(m);
        if(current.manifest_frozen) {if(current.manifest_hash!==digest) throw new ImportLifecycleError('MANIFEST_FROZEN',409); return response(current,200);}
        await assertManifestObjects(c,projectId,m);
        const s=await c.query('SELECT * FROM source_objects WHERE project_id=$1 AND id=$2',[projectId,current.source_object_id]); const source=s.rows[0];
        const head=await storage.head({key:source.object_key});
        if(head.sizeBytes!==source.byte_size || head.contentType!==source.content_type || (head.checksum!==null && head.checksum!==source.checksum)) throw new ImportLifecycleError('INTEGRITY_FAILED',422);
        const r=await c.query<ImportRow>("UPDATE imports SET manifest=$3,manifest_hash=$4,adapter_version=$5,schema_version=$6,manifest_frozen=true,status='awaiting-validation',state_version=state_version+1,updated_at=now() WHERE project_id=$1 AND id=$2 RETURNING *",[projectId,importId,m,digest,m.adapterVersion,m.schemaVersion]);
        await insertImportDispatch(c,{projectId,importId,manifestHash:digest});
        await appendImportAudit(c,{projectId,importId,actorUserId:userId,status:'awaiting-validation',stateVersion:r.rows[0].state_version});
        return response(r.rows[0],202);
      });
      if (result[importHttpStatus]===202) await dispatch?.(importId).catch(()=>{});
      return result;
    },
    async attempt(userId:string,projectId:string,importId:string,input:unknown) {
      const result=await tx(async c=>{
        await project(c,userId,projectId,true); const old=await row(c,projectId,importId); if(!old.manifest_frozen) throw new ImportLifecycleError('UPLOAD_NOT_FINALIZED',409); const m=manifest(input,projectId,old),digest=hash(m);
        await assertManifestObjects(c,projectId,m);
        const r=await c.query<ImportRow>("INSERT INTO imports(id,project_id,source_object_id,checksum,manifest,manifest_hash,adapter_version,schema_version,status,manifest_frozen,state_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'awaiting-validation',true,1) ON CONFLICT(project_id,checksum,manifest_hash,adapter_version,schema_version) DO NOTHING RETURNING *",[randomUUID(),projectId,old.source_object_id,old.checksum,m,digest,m.adapterVersion,m.schemaVersion]);
        if(r.rowCount) { await insertImportDispatch(c,{projectId,importId:r.rows[0].id,manifestHash:digest}); await appendImportAudit(c,{projectId,importId:r.rows[0].id,actorUserId:userId,status:'awaiting-validation',stateVersion:r.rows[0].state_version}); return response(r.rows[0],202); }
        const existing=await c.query<ImportRow>('SELECT * FROM imports WHERE project_id=$1 AND checksum=$2 AND manifest_hash=$3 AND adapter_version=$4 AND schema_version=$5',[projectId,old.checksum,digest,m.adapterVersion,m.schemaVersion]); return response(existing.rows[0],200);
      });
      if (result[importHttpStatus]===202) await dispatch?.(result.importId).catch(()=>{});
      return result;
    },
  };
}
