import { z } from "zod";
import {
  AnonymizedCustomerKeySchema, DecimalStringSchema, IsoDateSchema,
  NonNegativeDecimalStringSchema, NonNegativeIntSchema, PositiveDecimalStringSchema,
  PositiveIntSchema, SafeTextSchema, Sha256Schema, SourceKeySchema, UtcTimestampSchema,
  UuidSchema, VersionSchema,
} from "./primitives";

export const DataOriginSchema = z.enum(["partner", "synthetic", "mixed"]);
export const SourceTypeSchema = z.enum([
  "sales", "monthly_sales", "stock", "inbound", "stockouts", "suppliers",
  "categories", "growth", "seasonality", "product_mapping", "material_statement", "lead_times",
]);
export const NormalizedFieldSchema = z.enum([
  "sku", "productName", "category", "unit", "quantity", "date", "period",
  "warehouseKey", "supplierKey", "sourceEventId", "anonymizedCustomerKey",
  "price", "stockQuantity", "inboundQuantity", "expectedDate", "startDate",
  "endDate", "growthFactor", "leadTimeDays", "seasonalityIndex",
  "conversionFactor", "moq", "packMultiple",
]);
export const SourceCompletenessStatusSchema = z.enum(["complete", "explicit_none", "missing", "invalid"]);
export const SourceCompletenessSchema = z.strictObject({
  sourceType: SourceTypeSchema,
  status: SourceCompletenessStatusSchema,
  rowCount: NonNegativeIntSchema.nullable(),
  reasonCode: z.string().regex(/^[a-z][a-z0-9_]{1,80}$/).nullable(),
  confirmedByUserId: z.string().min(1).max(200).nullable(),
  confirmationReason: SafeTextSchema.max(500).nullable(),
}).superRefine((value, ctx) => {
  if ((value.status === "complete" || value.status === "explicit_none") && value.rowCount === null) {
    ctx.addIssue({ code: "custom", message: "Для доступного источника требуется число строк" });
  }
  if (value.status === "explicit_none" && (value.rowCount !== 0 || value.confirmedByUserId === null || value.confirmationReason === null)) {
    ctx.addIssue({ code: "custom", message: "Подтверждённое отсутствие требует ноль строк, автора и основание" });
  }
  if (value.status === "complete" && value.rowCount === 0) {
    ctx.addIssue({ code: "custom", message: "Полный источник не может быть пустым" });
  }
  if ((value.status === "missing" || value.status === "invalid") && (value.rowCount !== null || value.reasonCode === null)) {
    ctx.addIssue({ code: "custom", message: "Недоступный источник требует код причины без числа строк" });
  }
  if ((value.status === "complete" || value.status === "explicit_none") && value.reasonCode !== null) {
    ctx.addIssue({ code: "custom", message: "Доступный источник не содержит код ошибки" });
  }
  if (value.status !== "explicit_none" && (value.confirmedByUserId !== null || value.confirmationReason !== null)) {
    ctx.addIssue({ code: "custom", message: "Подтверждение допустимо только для explicit_none" });
  }
});

export const SourceObjectSchema = z.strictObject({
  id: UuidSchema, projectId: UuidSchema, purpose: z.enum(["source", "report", "export"]),
  objectKey: z.string().regex(/^projects\/[a-f0-9-]{36}\/(sources|reports|exports)\/[a-f0-9-]{36}$/),
  checksum: Sha256Schema, byteSize: z.int().min(1).max(26_214_400),
  contentType: z.enum(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/csv", "application/zip", "application/json"]),
  createdAt: UtcTimestampSchema,
}).superRefine((value, ctx) => {
  const [, keyProjectId, keyPrefix, keyObjectId] = value.objectKey.split("/");
  const purpose = value.purpose;
  if (keyProjectId !== value.projectId || keyObjectId !== value.id || keyPrefix !== `${purpose}s`) {
    ctx.addIssue({ code: "custom", message: "Ключ объекта не соответствует проекту и объекту" });
  }
  const allowed = purpose === "source"
    ? ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/csv", "application/zip"]
    : purpose === "report" ? ["application/json", "text/csv"] : ["text/csv"];
  if (!allowed.includes(value.contentType)) ctx.addIssue({ code: "custom", message: "Тип файла не соответствует назначению" });
});
export const SourceManifestEntrySchema = z.strictObject({
  sourceType: SourceTypeSchema, sourceObjectId: UuidSchema, checksum: Sha256Schema,
  origin: z.enum(["partner", "synthetic"]),
  sheet: z.string().min(1).max(200).nullable(),
  mappingVersion: VersionSchema,
  columnMappings: z.array(z.strictObject({ sourceColumn: SourceKeySchema, targetField: NormalizedFieldSchema })).max(200),
}).refine((value) => new Set(value.columnMappings.map((item) => item.targetField)).size === value.columnMappings.length, "Повтор целевого поля");
export const SourceManifestSchema = z.array(SourceManifestEntrySchema).min(1).max(100).superRefine((entries, ctx) => {
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.sourceType}:${entry.sourceObjectId}:${entry.sheet ?? ""}`;
    if (seen.has(key)) ctx.addIssue({ code: "custom", message: "Повтор источника в manifest" });
    seen.add(key);
  }
});
export const QualityIssueSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,80}$/), severity: z.enum(["warning", "blocking"]),
  sourceType: SourceTypeSchema, rowNumber: PositiveIntSchema.nullable(), count: PositiveIntSchema,
});
export const QualityReportSchema = z.strictObject({
  checkedRows: NonNegativeIntSchema, acceptedRows: NonNegativeIntSchema,
  rejectedRows: NonNegativeIntSchema, issues: z.array(QualityIssueSchema).max(1000),
}).refine((value) => value.checkedRows === value.acceptedRows + value.rejectedRows, "Число строк отчёта не согласовано");
export const ImportStatusSchema = z.enum(["uploaded", "awaiting-validation", "validating", "needs_mapping", "invalid", "ready", "failed"]);
export const ImportSchema = z.strictObject({
  id: UuidSchema, projectId: UuidSchema, sourceObjectId: UuidSchema,
  checksum: Sha256Schema, manifest: SourceManifestSchema, manifestHash: Sha256Schema,
  adapterVersion: VersionSchema, schemaVersion: VersionSchema,
  status: ImportStatusSchema, stateVersion: NonNegativeIntSchema,
  qualityReport: QualityReportSchema.nullable(), datasetVersionId: UuidSchema.nullable(),
  safeError: z.string().regex(/^[a-z][a-z0-9_]{1,80}$/).nullable(),
  createdAt: UtcTimestampSchema, updatedAt: UtcTimestampSchema,
}).superRefine((value, ctx) => {
  if (value.status === "ready" && (value.datasetVersionId === null || value.qualityReport === null)) {
    ctx.addIssue({ code: "custom", message: "Готовый импорт требует версию данных и отчёт" });
  }
  if (value.status !== "ready" && value.datasetVersionId !== null) {
    ctx.addIssue({ code: "custom", message: "Версия данных допустима только для готового импорта" });
  }
  if (value.status === "failed" && value.safeError === null) {
    ctx.addIssue({ code: "custom", message: "Ошибка импорта требует безопасный код" });
  }
});
export const DatasetVersionSchema = z.strictObject({
  id: UuidSchema, projectId: UuidSchema, importId: UuidSchema,
  schemaVersion: VersionSchema, asOfDate: IsoDateSchema, provenance: DataOriginSchema,
  manifest: SourceManifestSchema, manifestHash: Sha256Schema,
  sourceCompleteness: z.array(SourceCompletenessSchema).min(1).max(100),
  createdAt: UtcTimestampSchema,
}).superRefine((value, ctx) => {
  const types = value.sourceCompleteness.map((item) => item.sourceType);
  if (new Set(types).size !== types.length) ctx.addIssue({ code: "custom", message: "Повтор типа полноты источника" });
  if (types.length !== SourceTypeSchema.options.length || SourceTypeSchema.options.some((type) => !types.includes(type))) {
    ctx.addIssue({ code: "custom", message: "Требуется явная полнота каждого типа источника" });
  }
  const sources = new Set(value.manifest.map((item) => item.sourceType));
  if ([...sources].some((type) => !types.includes(type))) ctx.addIssue({ code: "custom", message: "Для источника manifest нужна запись полноты" });
  const origins = new Set(value.manifest.map((item) => item.origin));
  const expectedOrigin = origins.size === 2 ? "mixed" : value.manifest[0].origin;
  if (value.provenance !== expectedOrigin) ctx.addIssue({ code: "custom", message: "Происхождение набора не соответствует источникам" });
});

const DatasetEntitySchema = z.strictObject({ id: UuidSchema, projectId: UuidSchema, datasetVersionId: UuidSchema });
const ReferenceSchema = DatasetEntitySchema.extend({ sourceKey: SourceKeySchema });
export const SupplierSchema = ReferenceSchema.extend({ name: SafeTextSchema.max(200), createdAt: UtcTimestampSchema });
export const WarehouseSchema = ReferenceSchema.extend({ name: SafeTextSchema.max(200), createdAt: UtcTimestampSchema });
export const UnitConversionSchema = z.strictObject({
  fromUnit: SourceKeySchema, toUnit: SourceKeySchema, factor: PositiveDecimalStringSchema,
}).refine((value) => value.fromUnit !== value.toUnit, "Единицы конверсии должны отличаться");
export const ProductSchema = ReferenceSchema.extend({
  quantityPrecision: z.number().int().min(0).max(8).nullable().default(null),
  quantityStep: PositiveDecimalStringSchema.nullable().default(null),
  sku: SourceKeySchema, name: SafeTextSchema.max(200), unit: SourceKeySchema,
  categoryKey: SourceKeySchema, conversions: z.array(UnitConversionSchema).max(20),
  createdAt: UtcTimestampSchema,
}).refine((value) => value.conversions.every((item) => item.toUnit === value.unit), "Конверсии должны вести к основной единице");
export const ProductSupplierSchema = DatasetEntitySchema.extend({
  productId: UuidSchema, supplierId: UuidSchema,
  supplierSku: SourceKeySchema.nullable(), moq: PositiveDecimalStringSchema.nullable(),
  packMultiple: PositiveDecimalStringSchema.nullable(), conversion: UnitConversionSchema.nullable(),
});
export const RowProvenanceSchema = z.strictObject({
  sourceObjectId: UuidSchema, sourceSheet: z.string().min(1).max(200).nullable(), sourceRowNumber: PositiveIntSchema,
});
const ObservationSchema = DatasetEntitySchema.extend({ productId: UuidSchema, warehouseId: UuidSchema, ...RowProvenanceSchema.shape });
export const SaleSchema = ObservationSchema.extend({
  soldOn: IsoDateSchema, quantity: DecimalStringSchema, unit: SourceKeySchema,
  operationType: z.enum(["sale", "return", "correction"]), sourceEventId: SourceKeySchema,
  unitPrice: NonNegativeDecimalStringSchema.nullable(), anonymousCustomerKey: AnonymizedCustomerKeySchema.nullable(),
  customerKeyAvailable: z.boolean(),
}).superRefine((value, ctx) => {
  if (value.operationType === "sale" && value.quantity.startsWith("-")) {
    ctx.addIssue({ code: "custom", message: "Продажа не может иметь отрицательное количество" });
  }
  if (value.customerKeyAvailable !== (value.anonymousCustomerKey !== null)) {
    ctx.addIssue({ code: "custom", message: "Признак клиентского ключа не согласован со значением" });
  }
});
export const MonthlySalesSchema = ObservationSchema.extend({
  periodMonth: IsoDateSchema.refine((value) => value.endsWith("-01"), "Месячный период начинается первого числа"),
  granularity: z.literal("month"),
  quantity: NonNegativeDecimalStringSchema.nullable(), unit: SourceKeySchema,
  completeness: SourceCompletenessStatusSchema, origin: DataOriginSchema,
  methodVersion: VersionSchema,
}).superRefine((value, ctx) => {
  if (["missing", "invalid"].includes(value.completeness) && value.quantity !== null) {
    ctx.addIssue({ code: "custom", message: "Недоступный месячный период не имеет количества" });
  }
  if (["complete", "explicit_none"].includes(value.completeness) && value.quantity === null) {
    ctx.addIssue({ code: "custom", message: "Доступный месячный период требует количество" });
  }
  if (value.completeness === "explicit_none" && value.quantity !== "0") {
    ctx.addIssue({ code: "custom", message: "Пустой месячный период равен нулю" });
  }
});
export const StockSnapshotSchema = ObservationSchema.extend({ asOfDate: IsoDateSchema, quantity: NonNegativeDecimalStringSchema, unit: SourceKeySchema });
export const InboundShipmentSchema = ObservationSchema.extend({
  expectedOn: IsoDateSchema.nullable(), quantity: NonNegativeDecimalStringSchema, unit: SourceKeySchema,
  supplierId: UuidSchema.nullable(), sourceKey: SourceKeySchema,
});
export const StockoutIntervalSchema = ObservationSchema.extend({
  startsOn: IsoDateSchema, endsOn: IsoDateSchema, status: z.enum(["observed", "estimated"]),
}).refine((value) => value.endsOn >= value.startsOn, "Конец отсутствия товара раньше начала");
export const CategoryPolicyParametersSchema = z.strictObject({
  reviewPeriodDays: PositiveIntSchema.max(365),
  safetyStock: NonNegativeDecimalStringSchema.nullable(),
  safetyDays: NonNegativeIntSchema.max(365),
});
export const CategoryPolicySchema = DatasetEntitySchema.extend({
  categoryKey: SourceKeySchema,
  reviewPeriodDays: PositiveIntSchema.max(365), safetyStock: NonNegativeDecimalStringSchema.nullable(),
  parameters: CategoryPolicyParametersSchema,
  policyVersion: VersionSchema,
}).refine((value) => value.reviewPeriodDays === value.parameters.reviewPeriodDays && value.safetyStock === value.parameters.safetyStock, "Параметры категории не совпадают со снимком");
export const GrowthAssumptionSchema = DatasetEntitySchema.extend({
  categoryKey: SourceKeySchema, effectiveFrom: IsoDateSchema, growthRate: NonNegativeDecimalStringSchema,
  method: z.enum(["provided", "estimated"]), provenance: z.enum(["partner", "synthetic"]),
});
export const SupplierLeadTimeSchema = DatasetEntitySchema.extend({
  supplierId: UuidSchema, productId: UuidSchema.nullable(), categoryKey: SourceKeySchema.nullable(),
  days: NonNegativeIntSchema, provenance: z.enum(["partner", "synthetic"]),
}).refine((value) => value.productId === null || value.categoryKey === null, "Срок поставки привязывается к товару или категории");
export const SeasonalityIndexSchema = DatasetEntitySchema.extend({
  productId: UuidSchema.nullable(), categoryKey: SourceKeySchema.nullable(),
  periodMonth: z.int().min(1).max(12), indexValue: NonNegativeDecimalStringSchema,
  methodVersion: VersionSchema, method: z.enum(["provided", "estimated"]), completeness: SourceCompletenessStatusSchema,
}).refine((value) => (value.productId === null) !== (value.categoryKey === null), "Нужен товар или категория");

export type DatasetVersion = z.infer<typeof DatasetVersionSchema>;
export type Import = z.infer<typeof ImportSchema>;
export type SourceObject = z.infer<typeof SourceObjectSchema>;
export type SourceManifestEntry = z.infer<typeof SourceManifestEntrySchema>;
export type SourceCompleteness = z.infer<typeof SourceCompletenessSchema>;
export type QualityReport = z.infer<typeof QualityReportSchema>;
export type Supplier = z.infer<typeof SupplierSchema>;
export type Warehouse = z.infer<typeof WarehouseSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type ProductSupplier = z.infer<typeof ProductSupplierSchema>;
export type Sale = z.infer<typeof SaleSchema>;
export type MonthlySales = z.infer<typeof MonthlySalesSchema>;
export type StockSnapshot = z.infer<typeof StockSnapshotSchema>;
export type InboundShipment = z.infer<typeof InboundShipmentSchema>;
export type StockoutInterval = z.infer<typeof StockoutIntervalSchema>;
export type CategoryPolicy = z.infer<typeof CategoryPolicySchema>;
export type GrowthAssumption = z.infer<typeof GrowthAssumptionSchema>;
export type SupplierLeadTime = z.infer<typeof SupplierLeadTimeSchema>;
export type SeasonalityIndex = z.infer<typeof SeasonalityIndexSchema>;
