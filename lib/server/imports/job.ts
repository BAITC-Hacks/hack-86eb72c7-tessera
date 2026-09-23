import "server-only"

import type { Pool } from "pg"
import { z } from "zod"
import { ImportManifestSchema, type ImportReport } from "../../contracts/imports"
import { SourceTypeSchema } from "../../contracts/datasets"
import { UuidSchema } from "../../contracts/primitives"
import { StorageError, type UploadedObject, type createPrivateStorage } from "../storage"
import { commitDataset } from "./commit"
import { parseImportObject } from "./parser"
import { importHash, validateImport } from "./service"
import { appendImportAudit } from "./audit"

export const PayloadSchema = z.strictObject({ importId: UuidSchema, projectId: UuidSchema, requestedBy: z.string().min(1) })
export type ImportJobPayload = z.infer<typeof PayloadSchema>
type JobStorage = Pick<ReturnType<typeof createPrivateStorage>, "readSource" | "uploadImportReport">
export type ImportJobDependencies = { pool: Pool; storage: JobStorage }
type Inspection = { sourceObjectId: string; sheets: { name: string; headers: string[] }[] }[]

function invalidReport(code: string): ImportReport {
  return {
    checkedRows: 0, acceptedRows: 0, rejectedRows: 0, unresolvedRows: 0,
    issues: [{ code, severity: "blocking", message: "Источник не прошёл безопасную проверку.",
      sourceObjectId: null, sourceType: null, sourceSheet: null, rowNumber: null }],
    sourceCompleteness: SourceTypeSchema.options.map(sourceType => ({ sourceType, status: "invalid" as const,
      rowCount: null, reasonCode: code, confirmedByUserId: null, confirmationReason: null })),
    coverage: { M1: "unavailable", M2: "unavailable", M3: "unavailable", M4: "unavailable" },
    customerAnomalyCoverage: "unavailable",
  }
}

type ImportRow = { status: string; manifest: unknown; manifest_hash: string; manifest_frozen: boolean; dataset_version_id: string | null }

/** DB state, not the Trigger payload, is the authority for files and versions. */
export async function processImportJob(input: ImportJobPayload, { pool, storage }: ImportJobDependencies) {
  const payload = PayloadSchema.parse(input)
  const client = await pool.connect()
  let row: ImportRow
  try {
    await client.query("BEGIN")
    const owner = await client.query<{ owner_user_id: string; archived_at: Date | null }>(
      "SELECT owner_user_id,archived_at FROM projects WHERE id=$1 FOR UPDATE", [payload.projectId])
    if (owner.rows[0]?.owner_user_id !== payload.requestedBy || owner.rows[0].archived_at)
      throw new Error("Проект недоступен")
    const found = await client.query<ImportRow>("SELECT * FROM imports WHERE project_id=$1 AND id=$2 FOR UPDATE", [payload.projectId,payload.importId])
    if (!found.rows[0] || !found.rows[0].manifest_frozen) throw new Error("Попытка импорта недоступна")
    row = found.rows[0]
    if (["ready", "needs_mapping", "invalid", "failed"].includes(row.status)) {
      await client.query("COMMIT")
      return { status: row.status, datasetVersionId: row.dataset_version_id }
    }
    if (row.status !== "awaiting-validation" && row.status !== "validating") throw new Error("Недопустимое состояние импорта")
    if (row.status === "awaiting-validation") {
      const changed = await client.query<{state_version:number}>("UPDATE imports SET status='validating',state_version=state_version+1,updated_at=now() WHERE project_id=$1 AND id=$2 RETURNING state_version", [payload.projectId,payload.importId])
      await appendImportAudit(client,{projectId:payload.projectId,importId:payload.importId,actorUserId:payload.requestedBy,status:'validating',stateVersion:changed.rows[0].state_version})
    }
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally { client.release() }

  const manifest = ImportManifestSchema.parse(row.manifest)
  if (manifest.projectId !== payload.projectId || importHash(manifest) !== row.manifest_hash)
    throw new Error("Сохранённый manifest не подтверждён")
  if (manifest.adapterVersion !== "1" || manifest.schemaVersion !== "1")
    throw new Error("Неподдерживаемая версия адаптера или схемы")
  const references = new Map(manifest.sources.filter(source => source.sourceObjectId !== null)
    .map(source => [source.sourceObjectId!, source.checksum]))
  const sources = await pool.query<{ id: string; checksum: string; byte_size: number }>(
    "SELECT id,checksum,byte_size FROM source_objects WHERE project_id=$1 AND purpose='source' AND id=ANY($2::uuid[])",
    [payload.projectId,[...references.keys()]])
  if (sources.rowCount !== references.size || sources.rows.some(source => references.get(source.id) !== source.checksum))
    throw new Error("Источник недоступен")
  if (sources.rows.length > 8 || sources.rows.reduce((total,source) => total + source.byte_size,0) > 100 * 1024 * 1024)
    throw new Error("Превышен лимит партии импорта")
  const objects: {id:string;bytes:Uint8Array}[] = []
  let integrityFailure = false
  for (const id of references.keys()) {
    try {
      objects.push({ id, bytes: await storage.readSource({ userId: payload.requestedBy, projectId: payload.projectId, objectId: id }) })
    } catch (error) {
      if (error instanceof StorageError && error.code === "INTEGRITY_FAILED") { integrityFailure = true; break }
      throw error
    }
  }
  const missingMapping = manifest.sources.some(source => source.sourceObjectId !== null &&
    (source.completeness !== "complete" || source.columnMappings.length === 0 || source.sheet === null))
  let result: Awaited<ReturnType<typeof validateImport>>
  const inspection: Inspection = []
  if (integrityFailure) {
    result = { status: "invalid", report: invalidReport("source_checksum_mismatch"), normalizedDraft: null }
  } else if (missingMapping) {
    // Still parse through the bounded 05 parser; never infer a mapping from a filename.
    try {
      for (const object of objects) {
        const workbook = await parseImportObject(object)
        inspection.push({sourceObjectId:object.id,sheets:workbook.sheets.map(sheet=>({
          name:sheet.name,headers:(sheet.rows.find(row=>row.rowNumber===(manifest.sources.find(source=>
            source.sourceObjectId===object.id && source.sheet===sheet.name)?.headerRow ?? 1))?.cells ?? [])
            .slice(0,200).map(cell=>String(cell.value ?? "").slice(0,120)),
        }))})
      }
    } catch {
      result = { status: "invalid", report: invalidReport("source_parse_failed"), normalizedDraft: null }
    }
    const report: ImportReport = {
      checkedRows: 0, acceptedRows: 0, rejectedRows: 0, unresolvedRows: 0,
      issues: [{ code: "mapping_required", severity: "unresolved", message: "Требуется сопоставление полей и листов.",
        sourceObjectId: null, sourceType: null, sourceSheet: null, rowNumber: null }],
      sourceCompleteness: SourceTypeSchema.options.map(sourceType => ({ sourceType, status: "missing" as const,
        rowCount: null, reasonCode: "mapping_required", confirmedByUserId: null, confirmationReason: null })),
      coverage: { M1: "unavailable", M2: "unavailable", M3: "unavailable", M4: "unavailable" },
      customerAnomalyCoverage: "unavailable",
    }
    result ??= { status: "needs_mapping", report, normalizedDraft: null }
  } else {
    result = await validateImport(manifest, objects)
  }
  const reportBytes = Buffer.from(JSON.stringify({ importId: payload.importId, manifestHash: row.manifest_hash,
    adapterVersion: manifest.adapterVersion, schemaVersion: manifest.schemaVersion, report: result.report, inspection }))
  const reportObject = await storage.uploadImportReport({
    userId: payload.requestedBy, projectId: payload.projectId, importId: payload.importId, body: reportBytes,
  })
  if (result.status === "ready") {
    if (!result.normalizedDraft) throw new Error("Проверенный набор отсутствует")
    const dataset = await commitDataset(result.normalizedDraft, {
      pool, userId: payload.requestedBy, importId: payload.importId, reportObject,
    })
    return { status: "ready", datasetVersionId: dataset.id }
  }
  await completeRejectedImport(pool,payload,result.status,result.report,reportObject)
  return { status: result.status, datasetVersionId: null }
}

async function completeRejectedImport(pool: Pool, payload: ImportJobPayload, status: "needs_mapping" | "invalid", report: ImportReport, object: UploadedObject) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const owner = await client.query("SELECT id FROM projects WHERE id=$1 AND owner_user_id=$2 AND archived_at IS NULL FOR UPDATE", [payload.projectId,payload.requestedBy])
    if (!owner.rowCount) throw new Error("Проект недоступен")
    const found = await client.query<{ status: string }>("SELECT status FROM imports WHERE project_id=$1 AND id=$2 FOR UPDATE", [payload.projectId,payload.importId])
    if (found.rows[0]?.status !== "validating") {
      await client.query("COMMIT")
      return
    }
    await client.query(`INSERT INTO source_objects(id,project_id,object_key,checksum,byte_size,content_type,purpose)
      VALUES($1,$2,$3,$4,$5,$6,'report') ON CONFLICT(id) DO NOTHING`,
      [object.id,object.projectId,object.key,object.sha256Hex,object.sizeBytes,object.contentType])
    const summary = { checkedRows: report.checkedRows, acceptedRows: report.acceptedRows,
      rejectedRows: report.rejectedRows + report.unresolvedRows,
      issues: report.issues.filter(issue=>issue.sourceType!==null).map(issue => ({
        code: issue.code, severity: issue.severity==='warning'?'warning':'blocking', sourceType:issue.sourceType,
        rowNumber:issue.rowNumber,count:1,
      })) }
    const changed = await client.query<{state_version:number}>(`UPDATE imports SET status=$3,quality_report=$4::jsonb,report_object_id=$5,report_checksum=$6,
      state_version=state_version+1,updated_at=now() WHERE project_id=$1 AND id=$2 AND status='validating' RETURNING state_version`,
      [payload.projectId,payload.importId,status,JSON.stringify(summary),object.id,object.sha256Hex])
    if (changed.rows[0]) await appendImportAudit(client,{projectId:payload.projectId,importId:payload.importId,actorUserId:payload.requestedBy,status,stateVersion:changed.rows[0].state_version})
    await client.query("COMMIT")
  } catch (error) { await client.query("ROLLBACK"); throw error }
  finally { client.release() }
}

export async function failImportJob(payload: ImportJobPayload, pool: Pool): Promise<void> {
  const input = PayloadSchema.parse(payload)
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const owner = await client.query("SELECT id FROM projects WHERE id=$1 AND owner_user_id=$2 AND archived_at IS NULL FOR UPDATE",[input.projectId,input.requestedBy])
    if (owner.rowCount) {
      const changed = await client.query<{state_version:number}>(`UPDATE imports SET status='failed',safe_error='validation_failed',
        state_version=state_version+1,updated_at=now()
        WHERE project_id=$1 AND id=$2 AND status IN ('awaiting-validation','validating') RETURNING state_version`,
        [input.projectId,input.importId])
      if (changed.rows[0]) await appendImportAudit(client,{projectId:input.projectId,importId:input.importId,actorUserId:input.requestedBy,status:'failed',stateVersion:changed.rows[0].state_version})
    }
    await client.query("COMMIT")
  } catch (error) { await client.query("ROLLBACK"); throw error }
  finally { client.release() }
}

export function isTemporaryImportError(error: unknown): boolean {
  if (error instanceof Error && "code" in error && typeof error.code === "string")
    return ["STORAGE_UNAVAILABLE", "ECONNRESET", "ETIMEDOUT", "08006", "08003", "53300", "57P03"].includes(error.code)
  return false
}
