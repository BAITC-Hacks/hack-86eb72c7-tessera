import { z } from "zod";
import {
  NormalizedFieldSchema,
  SourceCompletenessSchema,
  SourceCompletenessStatusSchema,
  SourceTypeSchema,
} from "./datasets";
import {
  IsoDateSchema, NonNegativeIntSchema, PositiveIntSchema, SafeTextSchema,
  Sha256Schema, SourceKeySchema, UtcTimestampSchema, UuidSchema, VersionSchema,
} from "./primitives";

/** Семантика неизвестного поля никогда не выводится из названия файла. */
export const ImportFieldSchema = z.enum([
  ...NormalizedFieldSchema.options, "operationType", "sourceLineId", "supplierSku",
  "targetSku", "reviewPeriodDays", "safetyDays", "safetyStock", "stockoutStatus",
]);
export const ForecastBasisSchema = z.enum(["transactions", "monthly"]);
export const ImportPeriodSchema = z.strictObject({
  startDate: IsoDateSchema,
  endDate: IsoDateSchema,
}).refine((value) => value.endDate > value.startDate, "Период должен быть непустым: [начало, конец)");

export const ImportSourceSchema = z.strictObject({
  sourceObjectId: UuidSchema.nullable(),
  checksum: Sha256Schema.nullable(),
  sourceType: SourceTypeSchema,
  namespace: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "Некорректное пространство имён источника"),
  format: z.enum(["iek", "systeme", "generic"]),
  origin: z.enum(["partner", "synthetic"]),
  sheet: z.string().min(1).max(200).nullable(),
  mappingVersion: VersionSchema,
  exportedAt: UtcTimestampSchema,
  period: ImportPeriodSchema.nullable(),
  periodCompleteness: z.enum(["complete", "partial", "unknown"]).optional(),
  datedColumns: z.array(z.strictObject({
    sourceColumn: SourceKeySchema, expectedDate: IsoDateSchema,
  })).max(200).optional(),
  unit: SourceKeySchema.nullable(),
  completeness: SourceCompletenessStatusSchema,
  confirmedByUserId: SafeTextSchema.max(200).nullable(),
  confirmationReason: SafeTextSchema.max(500).nullable(),
  columnMappings: z.array(z.strictObject({
    sourceColumn: SourceKeySchema,
    targetField: ImportFieldSchema,
  })).max(200),
  priority: NonNegativeIntSchema.max(1000),
  correctionReason: SafeTextSchema.max(500).nullable(),
  headerRow: PositiveIntSchema.max(1_048_576).default(1),
  semantics: z.strictObject({
    operationType: z.enum(["sale", "return", "correction", "unresolved"]),
    growth: z.enum(["rate", "unresolved"]),
    seasonality: z.enum(["index", "unresolved"]),
    quantitySign: z.literal("preserve"),
  }),
}).superRefine((value, ctx) => {
  if ((value.sourceObjectId === null) !== (value.checksum === null)) {
    ctx.addIssue({ code: "custom", message: "Файл и контрольная сумма задаются вместе" });
  }
  if (value.completeness === "complete" && (value.sourceObjectId === null || value.sheet === null || value.columnMappings.length === 0)) {
    ctx.addIssue({ code: "custom", message: "Полный источник требует файл, лист и сопоставление колонок" });
  }
  if (value.completeness === "explicit_none") {
    if (value.confirmedByUserId === null || value.confirmationReason === null) {
      ctx.addIssue({ code: "custom", message: "Подтверждённое отсутствие требует автора и основание" });
    }
    if (value.sourceObjectId !== null || value.columnMappings.length !== 0) {
      ctx.addIssue({ code: "custom", message: "Подтверждённое отсутствие не содержит файла или сопоставлений" });
    }
  } else if (value.confirmedByUserId !== null || value.confirmationReason !== null) {
    ctx.addIssue({ code: "custom", message: "Подтверждение допустимо только для explicit_none" });
  }
  if (value.datedColumns?.length) {
    if (value.sourceType !== "inbound" || value.completeness !== "complete") {
      ctx.addIssue({ code: "custom", message: "Колонки поставок по датам допустимы только для полного источника пути" });
    }
    const columns = value.datedColumns.map((entry) => entry.sourceColumn);
    if (new Set(columns).size !== columns.length) {
      ctx.addIssue({ code: "custom", message: "Повтор колонки поставки по дате" });
    }
    if (value.columnMappings.some((entry) => columns.includes(entry.sourceColumn))) {
      ctx.addIssue({ code: "custom", message: "Колонка поставки по дате уже сопоставлена другому полю" });
    }
  }
  const targets = value.columnMappings.map((entry) => entry.targetField);
  if (new Set(targets).size !== targets.length) {
    ctx.addIssue({ code: "custom", message: "Повтор целевого поля сопоставления" });
  }
  if (value.priority > 0 && value.correctionReason === null) {
    ctx.addIssue({ code: "custom", message: "Ручной приоритет требует основания" });
  }
});

export const ImportManifestSchema = z.strictObject({
  projectId: UuidSchema,
  asOfDate: IsoDateSchema,
  adapterVersion: VersionSchema,
  schemaVersion: VersionSchema,
  forecastBasis: ForecastBasisSchema,
  privacyPolicy: z.strictObject({
    version: VersionSchema,
    approvedByUserId: SafeTextSchema.max(200),
    approvedAt: UtcTimestampSchema,
  }).optional(),
  sources: z.array(ImportSourceSchema).min(1).max(100),
}).superRefine((value, ctx) => {
  const seen = new Set<string>();
  const checksums = new Map<string, string>();
  for (const [index, source] of value.sources.entries()) {
    const key = JSON.stringify([source.namespace, source.sourceType, source.sourceObjectId, source.sheet]);
    if (seen.has(key)) {
      ctx.addIssue({ code: "custom", path: ["sources", index], message: "Повтор источника в manifest" });
    }
    seen.add(key);
    if (source.sourceObjectId !== null && source.checksum !== null) {
      const previous = checksums.get(source.sourceObjectId);
      if (previous !== undefined && previous !== source.checksum) {
        ctx.addIssue({ code: "custom", path: ["sources", index, "checksum"], message: "Один файл имеет разные контрольные суммы" });
      }
      checksums.set(source.sourceObjectId, source.checksum);
    }
  }
});

export type ImportManifest = z.infer<typeof ImportManifestSchema>;
export type ImportSource = z.infer<typeof ImportSourceSchema>;
export type ImportField = z.infer<typeof ImportFieldSchema>;
export type ImportSourceType = z.infer<typeof SourceTypeSchema>;
export type ForecastBasis = z.infer<typeof ForecastBasisSchema>;

/** Только уже разрешённые сервером байты. URL и пути не являются входом парсера. */
export interface ImportObject {
  id: string;
  bytes: Uint8Array;
}

/** Номер колонки и строки начинается с 1; формула не вычисляется. */
export interface ParsedCell {
  address: string;
  column: number;
  type: "string" | "number" | "boolean" | "date" | "error" | "blank" | "formula";
  value: string | number | boolean | null;
  formula?: string;
  error?: string;
  numberFormat?: string;
}
export interface ParsedRow {
  rowNumber: number;
  cells: ParsedCell[];
}
export interface ParsedSheet {
  name: string;
  rows: ParsedRow[];
  hash: string;
}
export interface ParsedWorkbook {
  objectId: string;
  checksum: string;
  sheets: ParsedSheet[];
  dateSystem: "1900" | "1904";
}

export const ImportIssueSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,80}$/),
  severity: z.enum(["warning", "blocking", "unresolved"]),
  message: SafeTextSchema.max(500),
  sourceObjectId: UuidSchema.nullable(),
  sourceType: SourceTypeSchema.nullable(),
  sourceSheet: z.string().min(1).max(200).nullable(),
  rowNumber: PositiveIntSchema.nullable(),
});
export const ImportCoverageSchema = z.enum(["available", "limited", "unavailable"]);
export const ImportReportSchema = z.strictObject({
  checkedRows: NonNegativeIntSchema,
  acceptedRows: NonNegativeIntSchema,
  rejectedRows: NonNegativeIntSchema,
  unresolvedRows: NonNegativeIntSchema,
  issues: z.array(ImportIssueSchema).max(1000),
  sourceCompleteness: z.array(SourceCompletenessSchema).max(100),
  coverage: z.strictObject({
    M1: ImportCoverageSchema,
    M2: ImportCoverageSchema,
    M3: ImportCoverageSchema,
    M4: ImportCoverageSchema,
  }),
  customerAnomalyCoverage: ImportCoverageSchema,
}).superRefine((value, ctx) => {
  if (value.checkedRows !== value.acceptedRows + value.rejectedRows + value.unresolvedRows) {
    ctx.addIssue({ code: "custom", message: "Число строк отчёта не согласовано" });
  }
  const types = value.sourceCompleteness.map((source) => source.sourceType);
  if (new Set(types).size !== types.length || SourceTypeSchema.options.some((type) => !types.includes(type))) {
    ctx.addIssue({ code: "custom", message: "Требуется явная полнота каждого типа источника без повторов" });
  }
});
export type ImportIssue = z.infer<typeof ImportIssueSchema>;
export type ImportReport = z.infer<typeof ImportReportSchema>;

/** Значения остаются десятичными/строковыми, связи разрешаются в пространстве имён. */
export interface NormalizedRow {
  sourceType: ImportSourceType;
  sourceObjectId: string;
  sourceSheet: string;
  sourceRowNumber: number;
  namespace: string;
  values: Record<string, string | null>;
}
export interface NormalizedDraft {
  manifest: ImportManifest;
  rows: NormalizedRow[];
  sourceCompleteness: z.infer<typeof SourceCompletenessSchema>[];
  forecastBasis: ForecastBasis;
  customerAnomalyCoverage: z.infer<typeof ImportCoverageSchema>;
}
export interface NormalizationResult {
  report: ImportReport;
  normalizedDraft: NormalizedDraft;
}
export interface ImportValidationResult {
  status: "ready" | "needs_mapping" | "invalid";
  report: ImportReport;
  normalizedDraft: NormalizedDraft | null;
}
