import 'server-only';
import { createHash } from 'node:crypto';
import { ImportManifestSchema, ImportReportSchema, type ImportObject, type ImportManifest, type NormalizedDraft, type ImportReport, type ParsedWorkbook } from '../../contracts/imports';
import { SourceTypeSchema } from '../../contracts/datasets';
import { ImportParserError, parseImportObject } from './parser';
import { normalizeSources } from './adapters';

export function importHash(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical)
    : input !== null && typeof input === 'object'
      ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
      : input;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
const validatedDrafts = new WeakMap<NormalizedDraft, {hash:string; report:ImportReport}>();
export function assertValidatedDraft(draft: NormalizedDraft): ImportReport {
  const validated = validatedDrafts.get(draft);
  if (!validated || validated.hash !== importHash(draft)) throw new Error('Набор не проверен или изменён после проверки');
  return structuredClone(validated.report);
}
export type ValidateImportResult = { status: 'ready' | 'needs_mapping' | 'invalid'; report: ImportReport; normalizedDraft: NormalizedDraft | null };
export interface ValidationDependencies {
  parseObject?: (object: ImportObject) => Promise<ParsedWorkbook>;
  normalize?: (manifest: ImportManifest, workbooks: ParsedWorkbook[]) => { report: ImportReport; normalizedDraft: NormalizedDraft };
}
/** Чистая локальная проверка: загрузка S3 и авторизация выполняются серверным вызывающим кодом. */
export async function validateImport(input: unknown, objects: ImportObject[], dependencies: ValidationDependencies = {}): Promise<ValidateImportResult> {
  let currentSourceObjectId:string|null=null;
  let failureCode='manifest_invalid';
  try {
  const manifest = ImportManifestSchema.parse(input);
  failureCode='import_object_invalid';
  const byId = new Map<string, ImportObject>();
  for (const object of objects) {
    if (!(object.bytes instanceof Uint8Array) || byId.has(object.id)) throw new Error('Некорректный или повторный объект импорта');
    byId.set(object.id, object);
  }
  const referenced = new Set(manifest.sources.filter(source => source.completeness === 'complete' && source.sourceObjectId !== null).map(source => source.sourceObjectId!));
  if (objects.some(object => !referenced.has(object.id))) throw new Error('Объект отсутствует в manifest');
  const workbooks: ParsedWorkbook[] = [];
  for (const id of referenced) {
    currentSourceObjectId=id;
    failureCode='source_object_missing';
    const object = byId.get(id);
    if (!object) throw new Error('Исходный объект отсутствует');
    failureCode='source_checksum_mismatch';
    const checksum = createHash('sha256').update(object.bytes).digest('hex');
    if (manifest.sources.some(source => source.sourceObjectId === id && source.checksum !== checksum)) throw new Error('Контрольная сумма источника не совпадает');
    failureCode='source_parse_failed';
    const workbook = await (dependencies.parseObject ?? parseImportObject)(object);
    if (workbook.objectId !== id || workbook.checksum !== checksum) throw new Error('Парсер вернул другой источник');
    workbooks.push(workbook);
  }
  failureCode='normalization_failed';
  const { report, normalizedDraft } = (dependencies.normalize ?? normalizeSources)(manifest, workbooks);
  ImportReportSchema.parse(report);
  if (importHash(normalizedDraft.manifest) !== importHash(manifest)) throw new Error('Нормализатор изменил manifest');
  const status = report.rejectedRows > 0 ? 'invalid' : report.unresolvedRows > 0 || report.issues.some(issue=>issue.severity === 'unresolved') ? 'needs_mapping' : report.issues.some(issue => issue.severity === 'blocking' || issue.severity === 'unresolved') ? 'invalid' : 'ready';
  if (status !== 'ready') return { status, report, normalizedDraft: null };
  validatedDrafts.set(normalizedDraft, {hash:importHash(normalizedDraft), report:structuredClone(report)});
  return { status, report, normalizedDraft };
  } catch (error) {
    const parserCode=error instanceof ImportParserError?error.code.toLowerCase():null;
    const code=parserCode && /^[a-z][a-z0-9_]{1,80}$/.test(parserCode)?parserCode:failureCode;
    // Не включать содержимое ячеек или исходное исключение в публичный отчёт.
    return { status:'invalid', normalizedDraft:null, report:{
      checkedRows:0, acceptedRows:0, rejectedRows:0, unresolvedRows:0,
      issues:[{code, severity:'blocking', message:'Источник не прошёл безопасную проверку: проверьте manifest, контрольную сумму и формат файла.', sourceObjectId:currentSourceObjectId, sourceType:null, sourceSheet:null, rowNumber:null}],
      sourceCompleteness:SourceTypeSchema.options.map(sourceType => ({sourceType,status:'invalid',rowCount:null,reasonCode:code,confirmedByUserId:null,confirmationReason:null})),
      coverage:{M1:'unavailable',M2:'unavailable',M3:'unavailable',M4:'unavailable'},customerAnomalyCoverage:'unavailable',
    }};
  }
}
