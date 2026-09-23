/**
 * Контракт передачи между чистыми модулями расчёта:
 * 07 `lib/domain/forecast/` → 08 `lib/domain/replenishment/` → 09 (сохранение).
 *
 * Входы — уже проверенные DTO набора данных (datasets.ts) и снимок запуска (runs.ts).
 * Выходы — Zod-схемы: 09 проверяет их перед записью, тесты 07/08 — в эталонах.
 * Количества на границе — канонические десятичные строки numeric(30,8).
 * `null`/`unavailable` никогда не означает ноль.
 */
import { z } from "zod";
import type {
  CategoryPolicy, DatasetVersion, GrowthAssumption, InboundShipment, MonthlySales, Product,
  ProductSupplier, Sale, SeasonalityIndex, StockoutInterval, StockSnapshot, Supplier,
  SupplierLeadTime, Warehouse,
} from "./datasets";
import {
  IsoDateSchema, NonNegativeDecimalStringSchema, NonNegativeIntSchema,
  PositiveDecimalStringSchema, PositiveIntSchema, SafeTextSchema, SourceKeySchema, UuidSchema, VersionSchema,
} from "./primitives";
import { QuantityStatusSchema, UrgencySchema, NumericFactorSchema, DataQualitySchema } from "./recommendations";
import {
  BlockingReasonSchema, CoverageGateSchema, type CalculationScopeSchema, type RunConfigurationSchema,
} from "./runs";

const SafeCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{1,80}$/);

// ---------------------------------------------------------------------------
// Входы
// ---------------------------------------------------------------------------

/** Неизменяемый срез одной DatasetVersion. Строки уже прошли схемы datasets.ts. */
export type CalculationDataset = Readonly<{
  version: DatasetVersion;
  products: readonly Product[];
  warehouses: readonly Warehouse[];
  suppliers: readonly Supplier[];
  productSuppliers: readonly ProductSupplier[];
  sales: readonly Sale[];
  monthlySales: readonly MonthlySales[];
  stockSnapshots: readonly StockSnapshot[];
  inboundShipments: readonly InboundShipment[];
  stockoutIntervals: readonly StockoutInterval[];
  categoryPolicies: readonly CategoryPolicy[];
  growthAssumptions: readonly GrowthAssumption[];
  supplierLeadTimes: readonly SupplierLeadTime[];
  seasonalityIndices: readonly SeasonalityIndex[];
}>;

export type CalculationScope = z.infer<typeof CalculationScopeSchema>;
export type RunConfiguration = z.infer<typeof RunConfigurationSchema>;

/**
 * Параметры, которых нет в RunConfigurationSchema (04), но которые требуют 07/08.
 * ОТКРЫТО: перенести в снимок запуска/parametersHash до 09, иначе расчёт невоспроизводим.
 */
export const CalculationPoliciesSchema = z.strictObject({
  /** 07 шаг 7: максимум месячного множителя тренда — явный параметр категории. */
  trendCapsByCategory: z.array(z.strictObject({
    categoryKey: SourceKeySchema, maxMonthlyTrendFactor: PositiveDecimalStringSchema,
  })).max(200),
  /** 08 шаг 6: минимальный шаг количества артикула в его основной единице. */
  unitSteps: z.array(z.strictObject({
    productId: UuidSchema, unit: SourceKeySchema, step: PositiveDecimalStringSchema,
  })).max(100_000),
}).superRefine((value, ctx) => {
  if (new Set(value.trendCapsByCategory.map((item) => item.categoryKey)).size !== value.trendCapsByCategory.length) {
    ctx.addIssue({ code: "custom", message: "Повтор ограничения тренда категории" });
  }
  if (new Set(value.unitSteps.map((item) => item.productId)).size !== value.unitSteps.length) {
    ctx.addIssue({ code: "custom", message: "Повтор шага единицы артикула" });
  }
});
export type CalculationPolicies = z.infer<typeof CalculationPoliciesSchema>;

export type CalculationConfiguration = Readonly<{
  run: RunConfiguration;
  policies: CalculationPolicies;
}>;

// ---------------------------------------------------------------------------
// Общие элементы выхода
// ---------------------------------------------------------------------------

export const SeriesKeySchema = z.strictObject({ productId: UuidSchema, warehouseId: UuidSchema });
export type SeriesKey = z.infer<typeof SeriesKeySchema>;

/** Ссылка на исходную строку: файл/лист/строка из RowProvenance. */
export const SourceRefSchema = z.strictObject({
  sourceObjectId: UuidSchema,
  sourceSheet: z.string().min(1).max(200).nullable(),
  sourceRowNumber: PositiveIntSchema,
});

export const CalculationWarningCodeSchema = z.enum([
  // 07
  "short_history", "outlier_manual_review", "customer_anomaly_unavailable",
  "stockout_insufficient_evidence", "seasonality_fallback", "trend_insufficient_evidence",
  "growth_source_missing", "incomplete_month_excluded", "forecast_unavailable",
  // 08
  "missing_supplier", "ambiguous_supplier", "missing_lead_time", "missing_category_policy",
  "missing_stock", "negative_usable_stock", "unit_mismatch", "missing_unit_step",
  "inbound_overdue", "inbound_without_date", "inbound_after_horizon", "inbound_duplicate",
]);
export const CalculationWarningSchema = z.strictObject({
  code: CalculationWarningCodeSchema,
  severity: z.enum(["warning", "blocking"]),
  key: SeriesKeySchema.nullable(),
});
export type CalculationWarning = z.infer<typeof CalculationWarningSchema>;

/** Полнота возможностей расчёта. canApprove выводится, клиентскому значению не доверять. */
export const CalculationCoverageSchema = z.strictObject({
  coverageGate: CoverageGateSchema,
  blockingReasons: z.array(BlockingReasonSchema).max(20),
  customerAnomalyCoverage: z.enum(["available", "unavailable"]),
  canApprove: z.boolean(),
}).superRefine((value, ctx) => {
  if ((value.coverageGate === "complete") !== (value.blockingReasons.length === 0)) {
    ctx.addIssue({ code: "custom", message: "Покрытие и блокировки не согласованы" });
  }
  if (value.canApprove && value.coverageGate !== "complete") {
    ctx.addIssue({ code: "custom", message: "Неполное покрытие нельзя утвердить" });
  }
});

// ---------------------------------------------------------------------------
// 07 → 08: прогноз
// ---------------------------------------------------------------------------

/**
 * Параметры дневного прогноза (07 шаг 8), без материализации дней:
 * горизонт H знает только 08 (срок поставки + период пересмотра + страховка).
 *
 *   u(date)       = 12*year + (month-1) + (day-1)/daysInMonth
 *   delta         = u(d) - u(startDate)
 *   trendFactor   = growthMode === "replace" ? 1 : trendMonthlyFactor^delta
 *   externalFactor= growthMode === "none"    ? 1 : externalMonthlyFactor^delta
 *   daily(d)      = baseAtStart * seasonalIndexByMonth[month(d)-1] * trendFactor * externalFactor
 *
 * 07 экспортирует `sumDailyForecast(model, fromDate, toDateInclusive)` — 08 использует только её.
 */
export const ForecastModelSchema = z.strictObject({
  startDate: IsoDateSchema,
  baseAtStart: NonNegativeDecimalStringSchema,
  seasonalIndexByMonth: z.array(NonNegativeDecimalStringSchema).length(12),
  trendMonthlyFactor: PositiveDecimalStringSchema,
  growthMode: z.enum(["replace", "incremental", "none"]),
  externalMonthlyFactor: PositiveDecimalStringSchema.nullable(),
}).superRefine((value, ctx) => {
  if ((value.growthMode === "none") !== (value.externalMonthlyFactor === null)) {
    ctx.addIssue({ code: "custom", message: "Внешний множитель роста не согласован с режимом" });
  }
});
export type ForecastModel = z.infer<typeof ForecastModelSchema>;

export const OutlierExclusionSchema = z.strictObject({
  level: z.enum(["document", "customer_week"]),
  /** Внутренний псевдоним; запрещён в OpenAI/Liveblocks/общем UI. */
  anonymousCustomerKey: z.string().nullable(),
  periodStart: IsoDateSchema,
  rawQty: NonNegativeDecimalStringSchema,
  excludedQty: NonNegativeDecimalStringSchema,
  regularQty: NonNegativeDecimalStringSchema,
  comparableBaseline: NonNegativeDecimalStringSchema,
  method: VersionSchema,
  sourceRefs: z.array(SourceRefSchema).min(1).max(1000),
});

export const StockoutAdjustmentSchema = z.strictObject({
  startsOn: IsoDateSchema,
  /** Полуинтервал [startsOn, endsOn). */
  endsOn: IsoDateSchema,
  days: PositiveIntSchema,
  observedQty: NonNegativeDecimalStringSchema,
  comparableQty: NonNegativeDecimalStringSchema,
  addedQty: NonNegativeDecimalStringSchema,
  quality: z.enum(["estimated", "insufficient_evidence"]),
  method: VersionSchema,
});

export const ForecastEvidenceSchema = z.strictObject({
  historyStart: IsoDateSchema.nullable(),
  historyEnd: IsoDateSchema,
  rawSalesQty: NonNegativeDecimalStringSchema,
  excludedOutlierQty: NonNegativeDecimalStringSchema,
  stockoutCompensationQty: NonNegativeDecimalStringSchema,
  baseAnchor: NonNegativeDecimalStringSchema.nullable(),
  seasonality: z.strictObject({
    source: z.enum(["estimated", "provided", "category_fallback", "none_fallback"]),
    fullCyclesUsed: NonNegativeIntSchema,
  }),
  trend: z.strictObject({
    status: z.enum(["applied", "not_confirmed", "capped", "insufficient_evidence"]),
    recentMedian: NonNegativeDecimalStringSchema.nullable(),
    priorMedian: NonNegativeDecimalStringSchema.nullable(),
    confirmingPairs: z.int().min(0).max(3),
  }),
  outlierExclusions: z.array(OutlierExclusionSchema).max(1000),
  stockoutAdjustments: z.array(StockoutAdjustmentSchema).max(1000),
});
export type ForecastEvidence = z.infer<typeof ForecastEvidenceSchema>;

export const ForecastSeriesSchema = z.strictObject({
  key: SeriesKeySchema,
  categoryKey: SourceKeySchema,
  unit: SourceKeySchema,
  status: z.enum(["known", "unavailable"]),
  unavailableReason: SafeCodeSchema.nullable(),
  model: ForecastModelSchema.nullable(),
  evidence: ForecastEvidenceSchema,
}).superRefine((value, ctx) => {
  if ((value.status === "known") !== (value.model !== null)) {
    ctx.addIssue({ code: "custom", message: "Статус прогноза и модель не согласованы" });
  }
  if ((value.status === "unavailable") !== (value.unavailableReason !== null)) {
    ctx.addIssue({ code: "custom", message: "Недоступный прогноз требует код причины" });
  }
});
export type ForecastSeries = z.infer<typeof ForecastSeriesSchema>;

export const ForecastResultSchema = z.strictObject({
  datasetVersionId: UuidSchema,
  asOfDate: IsoDateSchema,
  algorithmVersion: VersionSchema,
  series: z.array(ForecastSeriesSchema).max(100_000),
  warnings: z.array(CalculationWarningSchema).max(100_000),
  coverage: CalculationCoverageSchema,
}).superRefine((value, ctx) => {
  const keys = value.series.map((item) => `${item.key.productId}:${item.key.warehouseId}`);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "Повтор ряда прогноза" });
});
export type ForecastResult = z.infer<typeof ForecastResultSchema>;

export type ForecastDemand = (
  dataset: CalculationDataset,
  scope: CalculationScope,
  configuration: CalculationConfiguration,
) => ForecastResult;

// ---------------------------------------------------------------------------
// 08 → 09: рекомендации
// ---------------------------------------------------------------------------

export type SupplierTerms = Readonly<{
  suppliers: readonly Supplier[];
  productSuppliers: readonly ProductSupplier[];
  leadTimes: readonly SupplierLeadTime[];
}>;

export const InboundDecisionSchema = z.strictObject({
  sourceRef: SourceRefSchema,
  expectedOn: IsoDateSchema.nullable(),
  quantity: NonNegativeDecimalStringSchema,
  counted: z.boolean(),
  reason: z.enum(["within_horizon", "overdue", "without_date", "after_horizon", "duplicate", "unit_mismatch"]),
}).refine((value) => value.counted === (value.reason === "within_horizon"), "Учёт поставки не согласован с причиной");

export const ReplenishmentEvidenceSchema = z.strictObject({
  leadTimeDays: NonNegativeIntSchema,
  reviewPeriodDays: PositiveIntSchema,
  horizonDays: PositiveIntSchema,
  safetyDays: NonNegativeIntSchema,
  forecastDemandH: NonNegativeDecimalStringSchema,
  safetyStock: NonNegativeDecimalStringSchema,
  /** Ровно один источник: свободный остаток либо onHand - reserved. */
  stockBasis: z.enum(["free_stock", "on_hand_minus_reserved"]),
  onHand: NonNegativeDecimalStringSchema.nullable(),
  reserved: NonNegativeDecimalStringSchema.nullable(),
  usableStock: NonNegativeDecimalStringSchema,
  eligibleInbound: NonNegativeDecimalStringSchema,
  inbound: z.array(InboundDecisionSchema).max(1000),
  rawNeed: NonNegativeDecimalStringSchema,
  unitStep: PositiveDecimalStringSchema,
  finalQty: NonNegativeDecimalStringSchema,
  forecast: ForecastEvidenceSchema,
}).superRefine((value, ctx) => {
  if (value.horizonDays !== value.leadTimeDays + value.reviewPeriodDays) {
    ctx.addIssue({ code: "custom", message: "Горизонт не равен сроку поставки плюс период пересмотра" });
  }
  if ((value.stockBasis === "on_hand_minus_reserved") !== (value.onHand !== null && value.reserved !== null)) {
    ctx.addIssue({ code: "custom", message: "Основание остатка не согласовано с onHand/reserved" });
  }
});
export type ReplenishmentEvidence = z.infer<typeof ReplenishmentEvidenceSchema>;

/** Строка до сохранения: id/runId/projectId/createdAt добавляет 09 (RecommendationSchema). */
export const ReplenishmentLineSchema = z.strictObject({
  productId: UuidSchema,
  warehouseId: UuidSchema,
  supplierId: UuidSchema,
  supplierArticle: SourceKeySchema.nullable(),
  unit: SourceKeySchema,
  recommendedQty: NonNegativeDecimalStringSchema.nullable(),
  quantityStatus: QuantityStatusSchema,
  urgency: UrgencySchema,
  projectedStockoutDate: IsoDateSchema.nullable(),
  shortageDays: NonNegativeIntSchema.nullable(),
  numericFactors: z.array(NumericFactorSchema).max(30),
  dataQuality: DataQualitySchema,
  /** Шаблонный русский текст; строится до и независимо от ИИ. */
  rationale: SafeTextSchema.max(2000),
  evidence: ReplenishmentEvidenceSchema.nullable(),
  warnings: z.array(CalculationWarningSchema).max(50),
  calculationVersion: VersionSchema,
  datasetVersionId: UuidSchema,
}).superRefine((value, ctx) => {
  if ((value.quantityStatus === "known") !== (value.recommendedQty !== null)) {
    ctx.addIssue({ code: "custom", message: "Доступность количества и значение не согласованы" });
  }
  if ((value.quantityStatus === "known") !== (value.evidence !== null)) {
    ctx.addIssue({ code: "custom", message: "Известное количество требует числовое обоснование" });
  }
  if (value.evidence !== null && value.recommendedQty !== value.evidence.finalQty) {
    ctx.addIssue({ code: "custom", message: "Количество не совпадает с итогом обоснования" });
  }
  if (value.urgency === "unknown" && value.quantityStatus !== "unavailable") {
    ctx.addIssue({ code: "custom", message: "Неизвестная срочность требует недоступное количество" });
  }
});
export type ReplenishmentLine = z.infer<typeof ReplenishmentLineSchema>;

/** SKU/склад без строки (нет/неоднозначен поставщик и т. п.) — не исчезает молча. */
export const ReplenishmentIssueSchema = z.strictObject({
  key: SeriesKeySchema,
  code: CalculationWarningCodeSchema,
  candidateSupplierIds: z.array(UuidSchema).max(50),
});

export const ReplenishmentResultSchema = z.strictObject({
  datasetVersionId: UuidSchema,
  asOfDate: IsoDateSchema,
  calculationVersion: VersionSchema,
  supplierGroups: z.array(z.strictObject({
    supplierId: UuidSchema,
    lines: z.array(ReplenishmentLineSchema).min(1).max(100_000),
  })).max(10_000),
  issues: z.array(ReplenishmentIssueSchema).max(100_000),
  warnings: z.array(CalculationWarningSchema).max(100_000),
  coverage: CalculationCoverageSchema,
}).superRefine((value, ctx) => {
  const supplierIds = value.supplierGroups.map((group) => group.supplierId);
  if (new Set(supplierIds).size !== supplierIds.length) ctx.addIssue({ code: "custom", message: "Повтор группы поставщика" });
  const keys = new Set<string>();
  for (const group of value.supplierGroups) {
    for (const line of group.lines) {
      if (line.supplierId !== group.supplierId) ctx.addIssue({ code: "custom", message: "Строка в чужой группе поставщика" });
      const key = `${line.productId}:${line.warehouseId}`;
      if (keys.has(key)) ctx.addIssue({ code: "custom", message: "Повтор строки SKU/склада" });
      keys.add(key);
    }
  }
  for (const issue of value.issues) {
    if (keys.has(`${issue.key.productId}:${issue.key.warehouseId}`)) {
      ctx.addIssue({ code: "custom", message: "SKU/склад одновременно в строках и проблемах" });
    }
  }
});
export type ReplenishmentResult = z.infer<typeof ReplenishmentResultSchema>;

export type CalculateRecommendations = (
  forecast: ForecastResult,
  inventory: readonly StockSnapshot[],
  inbound: readonly InboundShipment[],
  supplierTerms: SupplierTerms,
  categoryPolicies: readonly CategoryPolicy[],
  configuration: CalculationConfiguration,
) => ReplenishmentResult;
