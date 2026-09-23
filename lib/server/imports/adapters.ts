import "server-only";

import { createHash } from "node:crypto";
import { SourceTypeSchema, type SourceCompleteness } from "../../contracts/datasets";
import {
  AnonymizedCustomerKeySchema, DecimalStringSchema, IsoDateSchema,
} from "../../contracts/primitives";
import type {
  ImportManifest, ImportReport, NormalizedDraft, ParsedCell, ParsedRow,
  ParsedSheet, ParsedWorkbook,
} from "../../contracts/imports";

type Source = ImportManifest["sources"][number];
type Values = Record<string, string | null>;

class RowIssue extends Error {
  readonly code: string;
  readonly unresolved: boolean;
  constructor(code: string, unresolved = false) {
    super(code);
    this.code = code;
    this.unresolved = unresolved;
  }
}

/** Exact base-10 conversion; never round quantities through a JS Number. */
export function normalizeDecimal(value: string): string {
  const match = /^([+-]?)(\d+)(?:[.,](\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(value.trim());
  if (!match) throw new RowIssue("invalid_decimal");
  const exponent = Number(match[4] ?? 0);
  if (Math.abs(exponent) > 100) throw new RowIssue("decimal_overflow");
  const digits = match[2] + (match[3] ?? "");
  const point = match[2].length + exponent;
  const whole = (point <= 0 ? "0" : (digits.slice(0, point) + "0".repeat(Math.max(0, point - digits.length)))).replace(/^0+(?=\d)/, "");
  const fraction = (point < 0 ? "0".repeat(-point) + digits : digits.slice(point)).replace(/0+$/, "");
  const unsigned = `${whole}${fraction ? `.${fraction}` : ""}`;
  const result = match[1] === "-" && unsigned !== "0" ? `-${unsigned}` : unsigned;
  if (!DecimalStringSchema.safeParse(result).success) throw new RowIssue("decimal_overflow");
  return result;
}

function text(cell: ParsedCell | undefined): string | null {
  if (!cell) return null;
  if (cell.error || cell.type === "error") throw new RowIssue("excel_cell_error");
  if (cell.formula !== undefined || cell.type === "formula") {
    throw new RowIssue(cell.value === null ? "formula_cache_missing" : "formula_unverified", true);
  }
  if (cell.value === null || cell.value === "") return null;
  if (typeof cell.value === "boolean") return cell.value ? "true" : "false";
  return String(cell.value).trim();
}

function required(values: Values, field: string): string {
  const value = values[field];
  if (value === null || value === undefined || value === "") throw new RowIssue(`missing_${field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`);
  return value;
}

function date(value: string, dateSystem: "1900" | "1904"): string {
  if (IsoDateSchema.safeParse(value).success) return value;
  const local = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (local) {
    const result = `${local[3]}-${local[2]}-${local[1]}`;
    if (IsoDateSchema.safeParse(result).success) return result;
  }
  // Spreadsheet serials are whole calendar days; the fictitious 1900-02-29 is invalid.
  if (/^\d{1,7}$/.test(value)) {
    const serial = Number(value);
    if (dateSystem === "1900" && serial === 60) throw new RowIssue("invalid_excel_date");
    const epoch = dateSystem === "1904" ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
    const days = serial - (dateSystem === "1900" && serial > 60 ? 1 : 0);
    if (serial > 2_958_465) throw new RowIssue("invalid_excel_date");
    const result = new Date(epoch + days * 86_400_000).toISOString().slice(0, 10);
    if (IsoDateSchema.safeParse(result).success) return result;
  }
  throw new RowIssue("invalid_date");
}

const numericFields = new Set([
  "quantity", "price", "stockQuantity", "inboundQuantity", "growthFactor", "seasonalityIndex", "conversionFactor", "moq", "packMultiple", "leadTimeDays", "reviewPeriodDays", "safetyDays", "safetyStock",
]);
const dateFields = new Set(["date", "expectedDate", "startDate", "endDate"]);
const requiredFields: Record<Source["sourceType"], string[]> = {
  sales: ["sku", "quantity", "date", "warehouseKey", "unit"],
  monthly_sales: ["sku", "quantity", "period", "warehouseKey", "unit"],
  stock: ["sku", "stockQuantity", "date", "warehouseKey", "unit"],
  inbound: ["sku", "inboundQuantity", "warehouseKey", "unit"],
  stockouts: ["sku", "warehouseKey", "startDate", "endDate"],
  suppliers: ["supplierKey"],
  categories: ["category", "reviewPeriodDays", "safetyDays"],
  growth: ["category", "growthFactor", "date"],
  seasonality: ["seasonalityIndex", "period"],
  product_mapping: ["sku", "productName", "unit", "category"],
  material_statement: ["sku", "quantity", "unit"],
  lead_times: ["supplierKey", "leadTimeDays"],
};

function normalizeValues(values: Values, source: Source, workbook: ParsedWorkbook, manifest: ImportManifest): Values {
  if (values.unit === null || values.unit === undefined) values.unit = source.unit;
  for (const field of requiredFields[source.sourceType]) required(values, field);
  for (const [field, value] of Object.entries(values)) {
    if (value === null) continue;
    if (numericFields.has(field)) values[field] = normalizeDecimal(value);
    if (dateFields.has(field)) values[field] = date(value, workbook.dateSystem);
  }
  if (source.unit && values.unit && values.unit !== source.unit) throw new RowIssue("mixed_units", true);
  for (const field of ["stockQuantity", "inboundQuantity", "price", "moq", "packMultiple", "conversionFactor", "leadTimeDays", "seasonalityIndex", "growthFactor"]) {
    if (values[field]?.startsWith("-")) throw new RowIssue("negative_unsigned_value", true);
  }
  for (const field of ["moq", "packMultiple", "conversionFactor"]) {
    if (values[field] === "0") throw new RowIssue("positive_value_required", true);
  }
  if (values.leadTimeDays && !/^\d+$/.test(values.leadTimeDays)) throw new RowIssue("invalid_lead_time");
  if (source.sourceType === "sales") {
    const operation = values.operationType ?? source.semantics.operationType;
    if (!["sale", "return", "correction"].includes(operation)) throw new RowIssue("document_semantics_unresolved", true);
    values.operationType = operation;
    if (values.operationType === "sale" && required(values, "quantity").startsWith("-")) throw new RowIssue("sale_sign_unresolved", true);
  }
  if (source.sourceType === "monthly_sales") {
    if (required(values, "quantity").startsWith("-")) throw new RowIssue("monthly_sign_unresolved", true);
    const period = required(values, "period");
    values.period = date(/^\d{4}-\d{2}$/.test(period) ? `${period}-01` : period, workbook.dateSystem);
    if (!values.period.endsWith("-01")) throw new RowIssue("invalid_month_period");

  }
  if (source.sourceType === "sales" && required(values, "date") > manifest.asOfDate) throw new RowIssue("future_sale");
  if (source.period && source.sourceType === "sales" && (required(values, "date") < source.period.startDate || required(values, "date") >= source.period.endDate)) throw new RowIssue("outside_source_period");
  if (source.sourceType === "stockouts" && required(values, "endDate") <= required(values, "startDate")) throw new RowIssue("invalid_stockout_interval");
  if (source.sourceType === "growth" && source.semantics.growth !== "rate") throw new RowIssue("growth_semantics_unresolved", true);
  if (source.sourceType === "seasonality") {
    if (source.semantics.seasonality !== "index") throw new RowIssue("seasonality_semantics_unresolved", true);
    if (!values.sku && !values.category) throw new RowIssue("seasonality_scope_missing", true);
    if (!/^(?:[1-9]|1[0-2])$/.test(required(values, "period"))) throw new RowIssue("invalid_seasonality_month");
  }
  if (values.anonymizedCustomerKey !== null && values.anonymizedCustomerKey !== undefined) {
    if (!AnonymizedCustomerKeySchema.safeParse(values.anonymizedCustomerKey).success) throw new RowIssue("customer_identifier_rejected");
    // A syntactic prefix alone does not confirm the approved anonymization policy.
    if (!manifest.privacyPolicy) throw new RowIssue("customer_policy_unconfirmed", true);
  }
  if (values.sku) values.productKey = `${source.namespace}:${values.sku}`;
  for (const field of ["warehouseKey", "supplierKey", "sourceEventId"]) {
    if (values[field]) values[field] = `${source.namespace}:${values[field]}`;
  }
  return values;
}

function mappedColumns(source: Source, sheet: ParsedSheet): Map<string, number> {
  const header = sheet.rows.find((row) => row.rowNumber === source.headerRow);
  if (!header) throw new RowIssue("header_missing", true);
  const result = new Map<string, number>();
  for (const mapping of source.columnMappings) {
    const matching = header.cells.filter((cell) => text(cell) === mapping.sourceColumn);
    if (matching.length !== 1) throw new RowIssue(matching.length ? "column_ambiguous" : "column_missing", true);
    result.set(mapping.targetField, matching[0].column);
  }
  return result;
}

function rowValues(row: ParsedRow, columns: Map<string, number>): Values {
  const values: Values = {};
  for (const [field, column] of columns) {
    const cell = row.cells.find((entry) => entry.column === column);
    const value = text(cell);
    values[field] = value;
    if (["sku", "supplierSku", "targetSku"].includes(field) && cell?.type === "number") {
      if (!cell.numberFormat || !/^0{1,100}$/.test(cell.numberFormat) || value === null || !/^\d+$/.test(value)) throw new RowIssue("numeric_identifier_unresolved", true);
      values[field] = value.padStart(cell.numberFormat.length, "0");
    }
  }
  return values;
}

/** IEK/Systeme require explicit column mappings; names never imply business meaning. */
export function normalizeSources(manifest: ImportManifest, workbooks: ParsedWorkbook[]): { report: ImportReport; normalizedDraft: NormalizedDraft } {
  const rows: NormalizedDraft["rows"] = [];
  const report: ImportReport = {
    checkedRows: 0, acceptedRows: 0, rejectedRows: 0, unresolvedRows: 0,
    issues: [], sourceCompleteness: [], customerAnomalyCoverage: "unavailable",
    coverage: { M1: "unavailable", M2: "unavailable", M3: "unavailable", M4: "unavailable" },
  };
  const counts = new Map<Source, number>();
  const invalid = new Set<Source>();
  const seenSheets = new Set<string>();
  const seenLines = new Map<string, string>();
  const addIssue = (source: Source, rowNumber: number | null, code: string, severity: "warning" | "blocking" | "unresolved") => {
    if (report.issues.length < 1000) report.issues.push({
      code, severity, message: `Проверка источника: ${code}. Требуется проверить сопоставление и семантику.`,
      sourceObjectId: source.sourceObjectId, sourceType: source.sourceType,
      sourceSheet: source.sheet, rowNumber,
    });
  };
  const isAvailable = (type: Source["sourceType"]) => report.sourceCompleteness.some((source) => source.sourceType === type && ["complete", "explicit_none"].includes(source.status));

  for (const source of manifest.sources) {
    counts.set(source, 0);
    if (source.completeness !== "complete") continue;
    const workbook = workbooks.find((entry) => entry.objectId === source.sourceObjectId);
    const sheet = workbook?.sheets.find((entry) => entry.name === source.sheet);
    if (!workbook || !sheet || workbook.checksum !== source.checksum) {
      invalid.add(source);
      addIssue(source, null, workbook && workbook.checksum !== source.checksum ? "checksum_mismatch" : "source_missing", "blocking");
      continue;
    }
    const duplicates = `${source.namespace}:${source.sourceType}:${sheet.hash}`;
    if (source.sourceType === "seasonality" && seenSheets.has(duplicates)) {
      addIssue(source, null, "duplicate_seasonality_sheet", "warning");
      continue;
    }
    seenSheets.add(duplicates);
    let columns: Map<string, number>;
    try {
      columns = mappedColumns(source, sheet);
      const header = sheet.rows.find((entry) => entry.rowNumber === source.headerRow);
      if (header?.cells.some((cell) => /(?:фио|телефон|e-?mail|инн|бин|имя клиента|наименование клиента)/i.test(String(cell.value ?? "")))) {
        throw new RowIssue("customer_identifier_rejected");
      }
    } catch (error) {
      invalid.add(source);
      const issue = error instanceof RowIssue ? error : new RowIssue("mapping_invalid", true);
      addIssue(source, null, issue.code, issue.unresolved ? "unresolved" : "blocking");
      continue;
    }
    const dateColumns = source.datedColumns?.length ? source.datedColumns.map((dated) => {
      const header = sheet.rows.find((row) => row.rowNumber === source.headerRow);
      const matches = header?.cells.filter((cell) => String(cell.value ?? "") === dated.sourceColumn) ?? [];
      return { column: matches.length === 1 ? matches[0].column : -1, expectedDate: dated.expectedDate };
    }) : source.format === "iek" && source.sourceType === "inbound"
      ? (sheet.rows.find((row) => row.rowNumber === source.headerRow)?.cells ?? []).flatMap((cell) => {
        const label = String(cell.value ?? "");
        if (!/^(?:\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4})$/.test(label)) return [];
        try { return [{ column: cell.column, expectedDate: date(label, workbook.dateSystem) }]; } catch { return []; }
      }) : [];
    const overlapping = manifest.sources.some((other) => other !== source && other.completeness === "complete" && other.namespace === source.namespace && other.sourceType === source.sourceType &&
      (!source.period || !other.period || (source.period.startDate < other.period.endDate && other.period.startDate < source.period.endDate)));
    for (const row of sheet.rows) {
      if (row.rowNumber <= source.headerRow || row.cells.every((cell) => cell.value === null && !cell.formula && !cell.error)) continue;
      if (row.cells.some((cell) => typeof cell.value === "string" && /^(?:итого|всего|подытог)(?:\s|:|$)/i.test(cell.value.trim()))) {
        addIssue(source, row.rowNumber, "summary_row_skipped", "warning");
        continue;
      }
      report.checkedRows++;
      try {
        if (dateColumns.some((column) => column.column < 1)) throw new RowIssue("dated_column_missing", true);
        const values = rowValues(row, columns);
        if (overlapping && ["sales", "monthly_sales", "stock", "inbound"].includes(source.sourceType) && !values.sourceLineId) throw new RowIssue("overlap_requires_line_id", true);
        const variants = dateColumns.length
          ? dateColumns.map((column) => ({ ...values, inboundQuantity: text(row.cells.find((cell) => cell.column === column.column)), expectedDate: column.expectedDate }))
          : [values];
        const normalized = variants.map((entry) => normalizeValues(entry, source, workbook, manifest));
        for (const entry of normalized) {
          if (source.sourceType === "sales" || source.sourceType === "monthly_sales") {
            entry.forecastUse = (source.sourceType === "sales" ? "transactions" : "monthly") === manifest.forecastBasis ? "forecast" : "reconciliation";
          }
          if (source.periodCompleteness && source.sourceType === "monthly_sales") entry.periodCompleteness = source.periodCompleteness;
          if (source.period && entry.period && source.sourceType === "monthly_sales") {
            const end = new Date(`${entry.period}T00:00:00Z`);
            end.setUTCMonth(end.getUTCMonth() + 1);
            if (source.period.startDate > entry.period || source.period.endDate < end.toISOString().slice(0, 10)) {
              entry.periodCompleteness = "partial";
              addIssue(source, row.rowNumber, "partial_month", "warning");
            } else entry.periodCompleteness ??= "complete";
          }
        }
        const lineId = values.sourceLineId;
        const key = lineId ? `${source.namespace}:${source.sourceType}:${values.sourceEventId ?? ""}:${lineId}` : null;
        const hash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
        if (key && seenLines.has(key)) {
          if (seenLines.get(key) !== hash) throw new RowIssue("source_line_conflict", true);
          addIssue(source, row.rowNumber, "duplicate_source_line", "warning");
        } else {
          if (key) seenLines.set(key, hash);
          for (const entry of normalized) rows.push({
            sourceType: source.sourceType, sourceObjectId: workbook.objectId, sourceSheet: sheet.name,
            sourceRowNumber: row.rowNumber, namespace: source.namespace, values: entry,
          });
        }
        report.acceptedRows++;
        counts.set(source, (counts.get(source) ?? 0) + 1);
      } catch (error) {
        invalid.add(source);
        const issue = error instanceof RowIssue ? error : new RowIssue("row_invalid");
        if (issue.unresolved) report.unresolvedRows++; else report.rejectedRows++;
        addIssue(source, row.rowNumber, issue.code, issue.unresolved ? "unresolved" : "blocking");
      }
    }
  }
  report.sourceCompleteness = SourceTypeSchema.options.map((sourceType): SourceCompleteness => {
    const sources = manifest.sources.filter((source) => source.sourceType === sourceType);
    const count = sources.reduce((sum, source) => sum + (counts.get(source) ?? 0), 0);
    const empty = sources.find((source) => source.completeness === "explicit_none");
    const base = { sourceType, confirmedByUserId: null, confirmationReason: null };
    if (sources.some((source) => invalid.has(source) || source.completeness === "invalid")) return { ...base, status: "invalid", rowCount: null, reasonCode: "source_invalid" };
    if (sources.some((source) => source.completeness === "missing") || !sources.length) return { ...base, status: "missing", rowCount: null, reasonCode: "not_supplied" };
    if (empty && count > 0) {
      addIssue(empty, null, "completeness_conflict", "blocking");
      return { ...base, status: "invalid", rowCount: null, reasonCode: "completeness_conflict" };
    }
    if (count > 0) return { ...base, status: "complete", rowCount: count, reasonCode: null };
    if (empty) return { ...base, status: "explicit_none", rowCount: 0, reasonCode: null, confirmedByUserId: empty.confirmedByUserId, confirmationReason: empty.confirmationReason };
    if (sources.length) addIssue(sources[0], null, "empty_source", "blocking");
    return { ...base, status: "invalid", rowCount: null, reasonCode: "empty_source" };
  });
  const sales = rows.filter((row) => row.sourceType === "sales");
  report.customerAnomalyCoverage = !manifest.privacyPolicy || manifest.forecastBasis !== "transactions" || !sales.length ? "unavailable"
    : sales.every((row) => !!row.values.anonymizedCustomerKey) ? "available"
      : sales.some((row) => !!row.values.anonymizedCustomerKey) ? "limited" : "unavailable";
  report.coverage.M1 = isAvailable(manifest.forecastBasis === "transactions" ? "sales" : "monthly_sales") && ["stock", "inbound", "categories", "growth", "lead_times", "material_statement", "product_mapping"].every((type) => isAvailable(type as Source["sourceType"])) ? "available" : rows.length ? "limited" : "unavailable";
  report.coverage.M2 = isAvailable(manifest.forecastBasis === "transactions" ? "sales" : "monthly_sales") ? "limited" : "unavailable";
  report.coverage.M3 = manifest.forecastBasis === "transactions" && isAvailable("stockouts") ? "available" : "unavailable";
  report.coverage.M4 = report.customerAnomalyCoverage;
  return { report, normalizedDraft: { manifest, rows, sourceCompleteness: report.sourceCompleteness, forecastBasis: manifest.forecastBasis, customerAnomalyCoverage: report.customerAnomalyCoverage } };
}
