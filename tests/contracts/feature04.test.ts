import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  AnonymizedCustomerKeySchema, DecimalStringSchema, IsoDateSchema, IsoMonthSchema,
  NonNegativeDecimalStringSchema, UtcTimestampSchema,
} from "../../lib/contracts/primitives";
import { ProjectSchema } from "../../lib/contracts/projects";
import {
  CategoryPolicySchema, DatasetVersionSchema, GrowthAssumptionSchema, ImportSchema, ImportStatusSchema,
  InboundShipmentSchema, MonthlySalesSchema, ProductSchema, ProductSupplierSchema,
  QualityReportSchema, SaleSchema, SeasonalityIndexSchema, SourceCompletenessSchema, SourceTypeSchema,
  SourceManifestSchema, SourceObjectSchema, StockoutIntervalSchema, StockSnapshotSchema,
  SupplierLeadTimeSchema, SupplierSchema, WarehouseSchema,
} from "../../lib/contracts/datasets";
import {
  CalculationRunSchema, CalculationRunStatusSchema, CalculationStageSchema,
  CoverageGateSchema, DispatchIntentSchema, ExplanationStatusSchema,
  RunModeSchema, StageStatusSchema,
} from "../../lib/contracts/runs";
import {
  ApprovalSchema, AuditEventSchema, canApproveRun, ExportArtifactSchema,
  parseRecommendationForRun, QuantityStatusSchema, RecommendationReviewSchema, RecommendationSchema, RunEventSchema,
  RunRecommendationsSchema,
  UrgencySchema,
} from "../../lib/contracts/recommendations";

const id = "550e8400-e29b-41d4-a716-446655440000";
const id2 = "550e8400-e29b-41d4-a716-446655440001";
const now = "2026-09-23T09:00:00.000Z";
const hash = "a".repeat(64);
const manifest = [{
  sourceType: "sales", sourceObjectId: id2, checksum: hash, sheet: "Продажи",
  origin: "synthetic",
  mappingVersion: "1", columnMappings: [{ sourceColumn: "Артикул", targetField: "sku" }],
}];
const provenance = { sourceObjectId: id2, sourceSheet: "Продажи", sourceRowNumber: 2 };
const completeness = SourceTypeSchema.options.map((sourceType) => sourceType === "sales"
  ? { sourceType, status: "complete", rowCount: 2, reasonCode: null, confirmedByUserId: null, confirmationReason: null }
  : { sourceType, status: "missing", rowCount: null, reasonCode: "not_supplied", confirmedByUserId: null, confirmationReason: null });
const entity = { id, projectId: id, datasetVersionId: id2 };
const observation = { ...entity, productId: id, warehouseId: id2, ...provenance };
const run = {
  id, projectId: id, datasetVersionId: id2, requestedBy: "user_123",
  scope: { warehouseIds: [], categoryIds: ["кабель"] }, asOfDate: "2026-09-23",
  configuration: { runMode: "full", scope: { warehouseIds: [], categoryIds: ["кабель"] }, asOfDate: "2026-09-23", historicalWindowMonths: 24, minComparableWeeks: 8, outlierMadMultiplier: "6", outlierMedianMultiplier: "5", zeroMadMinimumUnit: "1", incompleteMonthPolicy: "exclude", growthMode: "none", seasonalityMode: "estimated", reviewPeriodDays: 7, safetyDaysByCategory: [{ categoryKey: "кабель", safetyDays: 2 }], leadTimePolicyVersion: "1", unitPolicyVersion: "1", algorithmVersion: "1", parametersHash: hash },
  configurationHash: hash, requestHash: hash, algorithmVersion: "1", idempotencyKey: "request-1", runMode: "full", triggerRunId: null,
  status: "succeeded", stage: "recommend", stateVersion: 3, reviewVersion: 2,
  stageStates: {}, explanationStatus: "not_requested", coverageGate: "complete", blockingReasons: [],
  safeError: null, createdAt: now, startedAt: now, finishedAt: now,
} as const;

function accepts<T>(schema: z.ZodType<T>, value: unknown): void {
  assert.equal(schema.safeParse(value).success, true, JSON.stringify(schema.safeParse(value).error?.issues));
}
function rejects(schema: z.ZodType, value: unknown): void {
  assert.equal(schema.safeParse(value).success, false);
}

test("numeric(30,8) JSON rejects noncanonical, overflow and coercion", () => {
  for (const value of ["0", "-0.5", "1234567890123456789012.12345678"]) accepts(DecimalStringSchema, value);
  for (const value of ["-0", "01", "1.0", "1.123456789", "12345678901234567890123", "1e3", "NaN", "Infinity", 1.25, " 1", "+1"]) rejects(DecimalStringSchema, value);
  accepts(NonNegativeDecimalStringSchema, "0");
  rejects(NonNegativeDecimalStringSchema, "-0.5");
});

test("calendar days, months and UTC instants reject impossible or local dates", () => {
  accepts(IsoDateSchema, "2024-02-29");
  accepts(IsoMonthSchema, "2026-09");
  accepts(UtcTimestampSchema, now);
  for (const value of ["2026-02-29", "2026-13-01", "2026-09-23T09:00:00Z"]) rejects(IsoDateSchema, value);
  rejects(IsoMonthSchema, "2026-13");
  rejects(UtcTimestampSchema, "2026-09-23T09:00:00+05:00");
});

test("project and source object are strict and bounded", () => {
  accepts(ProjectSchema, { id, ownerUserId: "user_123", name: "Закупки", createdAt: now, updatedAt: now, archivedAt: null });
  rejects(ProjectSchema, { id, ownerUserId: "user_123", name: "Закупки", createdAt: now, updatedAt: now, archivedAt: null, customerEmail: "test@example.com" });
  const source = { id, projectId: id, purpose: "source", objectKey: `projects/${id}/sources/${id}`, checksum: hash, byteSize: 100, contentType: "text/csv", createdAt: now };
  accepts(SourceObjectSchema, source);
  rejects(SourceObjectSchema, { ...source, byteSize: 26_214_401 });
  rejects(SourceObjectSchema, { ...source, objectKey: "../../private.csv" });
  rejects(SourceObjectSchema, { ...source, objectKey: `projects/${id}/sources/${id2}` });
  rejects(SourceObjectSchema, { ...source, purpose: "export", objectKey: `projects/${id}/exports/${id}`, contentType: "application/zip" });
});

test("manifest and completeness distinguish empty from unavailable", () => {
  accepts(SourceManifestSchema, manifest);
  rejects(SourceManifestSchema, [...manifest, ...manifest]);
  for (const entry of [
    { sourceType: "sales", status: "complete", rowCount: 5, reasonCode: null, confirmedByUserId: null, confirmationReason: null },
    { sourceType: "sales", status: "explicit_none", rowCount: 0, reasonCode: null, confirmedByUserId: "user_123", confirmationReason: "Источник не существует" },
    { sourceType: "sales", status: "missing", rowCount: null, reasonCode: "not_supplied", confirmedByUserId: null, confirmationReason: null },
    { sourceType: "sales", status: "invalid", rowCount: null, reasonCode: "bad_sheet", confirmedByUserId: null, confirmationReason: null },
  ]) accepts(SourceCompletenessSchema, entry);
  rejects(SourceCompletenessSchema, { sourceType: "sales", status: "explicit_none", rowCount: 1, reasonCode: null, confirmedByUserId: "user_123", confirmationReason: "Нет" });
  rejects(SourceCompletenessSchema, { sourceType: "sales", status: "complete", rowCount: 0, reasonCode: null, confirmedByUserId: null, confirmationReason: null });
  rejects(SourceCompletenessSchema, { sourceType: "sales", status: "missing", rowCount: 0, reasonCode: null, confirmedByUserId: null, confirmationReason: null });
  rejects(SourceManifestSchema, [{ ...manifest[0], columnMappings: [{ sourceColumn: "Клиент", targetField: "customerName" }] }]);
});

test("import state, quality and dataset version enforce publication boundary", () => {
  const quality = { checkedRows: 3, acceptedRows: 2, rejectedRows: 1, issues: [] };
  accepts(QualityReportSchema, quality);
  rejects(QualityReportSchema, { ...quality, checkedRows: 4 });
  const imported = { id, projectId: id, sourceObjectId: id2, checksum: hash, manifest, manifestHash: hash, adapterVersion: "1", schemaVersion: "1", status: "ready", stateVersion: 2, qualityReport: quality, datasetVersionId: id2, safeError: null, createdAt: now, updatedAt: now };
  accepts(ImportSchema, imported);
  rejects(ImportSchema, { ...imported, datasetVersionId: null });
  rejects(ImportSchema, { ...imported, status: "uploaded" });
  for (const status of ["uploaded", "awaiting-validation", "validating", "needs_mapping", "invalid", "ready", "failed"]) accepts(ImportStatusSchema, status);
  const dataset = { id, projectId: id, importId: id2, schemaVersion: "1", asOfDate: "2026-09-23", provenance: "synthetic", manifest, manifestHash: hash, sourceCompleteness: completeness, createdAt: now };
  accepts(DatasetVersionSchema, dataset);
  rejects(DatasetVersionSchema, { ...dataset, sourceCompleteness: [...dataset.sourceCompleteness, ...dataset.sourceCompleteness] });
  rejects(DatasetVersionSchema, { ...dataset, sourceCompleteness: dataset.sourceCompleteness.slice(1) });
  rejects(DatasetVersionSchema, { ...dataset, provenance: "partner" });
});

test("all versioned reference and observation entities have runtime validators", () => {
  const cases: [z.ZodType, unknown][] = [
    [SupplierSchema, { ...entity, sourceKey: "0001", name: "Поставщик", createdAt: now }],
    [WarehouseSchema, { ...entity, sourceKey: "0002", name: "Склад", createdAt: now }],
    [ProductSchema, { ...entity, sourceKey: "0003", sku: "0003", name: "Кабель", unit: "м", categoryKey: "кабель", conversions: [{ fromUnit: "бухта", toUnit: "м", factor: "100" }], createdAt: now }],
    [ProductSupplierSchema, { ...entity, productId: id, supplierId: id2, supplierSku: null, moq: null, packMultiple: "2", conversion: null }],
    [SaleSchema, { ...observation, soldOn: "2026-09-22", quantity: "2", unit: "шт", operationType: "sale", sourceEventId: "sale-1", unitPrice: null, anonymousCustomerKey: "anon_abc", customerKeyAvailable: true }],
    [MonthlySalesSchema, { ...observation, periodMonth: "2026-09-01", granularity: "month", quantity: "10", unit: "шт", completeness: "complete", origin: "synthetic", methodVersion: "1" }],
    [StockSnapshotSchema, { ...observation, asOfDate: "2026-09-23", quantity: "0", unit: "шт" }],
    [InboundShipmentSchema, { ...observation, expectedOn: "2026-10-01", quantity: "3", unit: "шт", supplierId: id, sourceKey: "shipment-1" }],
    [StockoutIntervalSchema, { ...observation, startsOn: "2026-09-01", endsOn: "2026-09-02", status: "observed" }],
    [CategoryPolicySchema, { ...entity, categoryKey: "кабель", reviewPeriodDays: 7, safetyStock: null, parameters: { reviewPeriodDays: 7, safetyStock: null, safetyDays: 2 }, policyVersion: "1" }],
    [GrowthAssumptionSchema, { ...entity, categoryKey: "кабель", effectiveFrom: "2026-09-01", growthRate: "0.1", method: "provided", provenance: "synthetic" }],
    [SupplierLeadTimeSchema, { ...entity, supplierId: id2, productId: null, categoryKey: "кабель", days: 10, provenance: "synthetic" }],
    [SeasonalityIndexSchema, { ...entity, productId: id2, categoryKey: null, periodMonth: 9, indexValue: "1.2", methodVersion: "1", method: "estimated", completeness: "complete" }],
  ];
  for (const [schema, value] of cases) {
    accepts(schema, value);
    rejects(schema, { ...value as object, customerPhone: "+70000000000" });
  }
  rejects(SaleSchema, { ...cases[4][1] as object, anonymousCustomerKey: "buyer@example.com" });
  rejects(SaleSchema, { ...cases[4][1] as object, sourceRowNumber: undefined });
  rejects(AnonymizedCustomerKeySchema, "Иван Иванов");
  rejects(MonthlySalesSchema, { ...cases[5][1] as object, completeness: "missing", quantity: "0" });
  accepts(MonthlySalesSchema, { ...cases[5][1] as object, completeness: "missing", quantity: null });
  rejects(StockoutIntervalSchema, { ...cases[8][1] as object, endsOn: "2026-08-31" });
  accepts(ProductSupplierSchema, { ...cases[3][1] as object, conversion: { fromUnit: "бухта", toUnit: "м", factor: "100" } });
  rejects(ProductSupplierSchema, { ...cases[3][1] as object, conversion: { fromUnit: "м", toUnit: "м", factor: "100" } });
});

test("run state enums and approval gate cover diagnostic and stale review", () => {
  for (const value of ["queued", "running", "succeeded", "failed", "cancelled"]) accepts(CalculationRunStatusSchema, value);
  for (const value of ["validate", "forecast", "recommend", "explain"]) accepts(CalculationStageSchema, value);
  for (const value of ["pending", "running", "succeeded", "failed", "skipped"]) accepts(StageStatusSchema, value);
  for (const value of ["not_requested", "pending", "succeeded", "degraded"]) accepts(ExplanationStatusSchema, value);
  for (const value of ["full", "diagnostic"]) accepts(RunModeSchema, value);
  for (const value of ["complete", "incomplete"]) accepts(CoverageGateSchema, value);
  accepts(CalculationRunSchema, run);
  rejects(CalculationRunSchema, { ...run, scope: { warehouseIds: [], categoryIds: ["другая"] } });
  accepts(CalculationRunSchema, { ...run, status: "queued", stage: null, stateVersion: 0, reviewVersion: 0, stageStates: {}, coverageGate: "incomplete", blockingReasons: [], startedAt: null, finishedAt: null });
  rejects(CalculationRunSchema, { ...run, status: "succeeded", coverageGate: "incomplete", blockingReasons: [] });
  rejects(CalculationRunSchema, { ...run, canApprove: true });
  rejects(CalculationRunSchema, { ...run, coverageGate: "incomplete" });
  const parsed = CalculationRunSchema.parse(run);
  assert.equal(canApproveRun({ run: parsed, currentReviewVersion: 2, expectedReviewVersion: 2, unavailableRecommendations: 0, projectArchived: false }), true);
  assert.equal(canApproveRun({ run: parsed, currentReviewVersion: 3, expectedReviewVersion: 2, unavailableRecommendations: 0, projectArchived: false }), false);
  assert.equal(canApproveRun({ run: parsed, currentReviewVersion: 2, expectedReviewVersion: 2, unavailableRecommendations: 1, projectArchived: false }), false);
  assert.equal(canApproveRun({ run: parsed, currentReviewVersion: 2, expectedReviewVersion: 2, unavailableRecommendations: 0, projectArchived: true }), false);
  assert.equal(canApproveRun({ run: { ...parsed, safeError: "calculation_failed" }, currentReviewVersion: 2, expectedReviewVersion: 2, unavailableRecommendations: 0, projectArchived: false }), false);
  const diagnostic = CalculationRunSchema.parse({ ...run, runMode: "diagnostic", configuration: { ...run.configuration, runMode: "diagnostic" } });
  assert.equal(canApproveRun({ run: diagnostic, currentReviewVersion: 2, expectedReviewVersion: 2, unavailableRecommendations: 0, projectArchived: false }), false);
});

test("dispatch, recommendation, review, approval, export and events are strict", () => {
  const dispatch = { id, projectId: id, operationType: "calculation", importId: null, runId: id2, idempotencyKey: "request-1", payloadVersion: "1", payloadHash: hash, status: "pending", attempts: 0, nextAttemptAt: now, leaseUntil: null, externalTaskId: null, safeError: null, createdAt: now };
  accepts(DispatchIntentSchema, dispatch);
  rejects(DispatchIntentSchema, { ...dispatch, status: "sent" });
  const recommendation = { id, projectId: id, runId: id2, datasetVersionId: id2, calculationVersion: "1", productId: id, warehouseId: id, supplierId: id, supplierArticle: null, recommendedQuantity: "3", quantityStatus: "known", unit: "шт", urgency: "planned", projectedStockoutDate: null, shortageDays: 0, numericFactors: [{ code: "stock", value: "-2", unit: "шт" }], dataQuality: "complete", rationale: "Расчёт по спросу", createdAt: now };
  accepts(RecommendationSchema, recommendation);
  rejects(RecommendationSchema, { ...recommendation, recommendedQuantity: null });
  rejects(RecommendationSchema, { ...recommendation, customerName: "Иван" });
  rejects(RecommendationSchema, { ...recommendation, dataQuality: { status: "complete", customerEmail: "buyer@example.com" } });
  assert.deepEqual(parseRecommendationForRun({ ...recommendation, runId: id }, run).recommendedQuantity, "3");
  assert.throws(() => parseRecommendationForRun({ ...recommendation, runId: id, quantityStatus: "unavailable", recommendedQuantity: null, dataQuality: "unavailable" }, run));
  assert.equal(parseRecommendationForRun({ ...recommendation, runId: id, quantityStatus: "unavailable", recommendedQuantity: null, dataQuality: "unavailable" }, { ...run, runMode: "diagnostic", configuration: { ...run.configuration, runMode: "diagnostic" } }).recommendedQuantity, null);
  accepts(RunRecommendationsSchema, { run, recommendations: [{ ...recommendation, runId: id }] });
  for (const value of ["known", "unavailable"]) accepts(QuantityStatusSchema, value);
  for (const value of ["unknown", "urgent", "planned", "none"]) accepts(UrgencySchema, value);
  accepts(RecommendationReviewSchema, { id, projectId: id, runId: id2, recommendationId: id, reviewedQuantity: "4", reason: "Проверено вручную", authorUserId: "user_123", reviewVersion: 1, createdAt: now });
  accepts(ApprovalSchema, { id, projectId: id, runId: id2, reviewVersion: 1, linesHash: hash, authorUserId: "user_123", approvedAt: now, idempotencyKey: "approve-1", requestHash: hash });
  accepts(ExportArtifactSchema, { id, projectId: id, approvalId: id2, sourceObjectId: id, checksum: hash, format: "csv", formatVersion: "1", createdAt: now });
  accepts(RunEventSchema, { id, projectId: id, runId: id2, sequenceNo: 1, eventType: "stage_started", safePayload: { stage: "validate", safeCode: null }, createdAt: now });
  rejects(RunEventSchema, { id, projectId: id, runId: id2, sequenceNo: 1, eventType: "stage_started", safePayload: { stage: "validate", safeCode: null, rawSale: "Иван" }, createdAt: now });
  accepts(AuditEventSchema, { id, projectId: id, sequenceNo: 1, action: "approved", resourceType: "approval", actorUserId: "user_123", resourceId: id2, safePayload: { runId: id2, safeCode: null }, createdAt: now });
});
