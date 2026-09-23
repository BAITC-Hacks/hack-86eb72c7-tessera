import { z } from "zod";
import {
  DecimalStringSchema, IsoDateSchema, NonNegativeDecimalStringSchema, NonNegativeIntSchema, PositiveIntSchema, SafeTextSchema,
  Sha256Schema, SourceKeySchema, UtcTimestampSchema, UuidSchema, VersionSchema,
} from "./primitives";
import { CalculationRunSchema } from "./runs";

export const QuantityStatusSchema = z.enum(["known", "unavailable"]);
export const UrgencySchema = z.enum(["unknown", "urgent", "planned", "none"]);
export const NumericFactorSchema = z.strictObject({
  code: z.enum(["baseline", "seasonality", "growth", "stockout", "outlier", "stock", "inbound", "lead_time", "safety_stock"]),
  value: DecimalStringSchema, unit: SourceKeySchema,
});
export const DataQualitySchema = z.enum(["complete", "limited", "unavailable"]);
export const RecommendationSchema = z.strictObject({
  id: UuidSchema, projectId: UuidSchema, runId: UuidSchema, datasetVersionId: UuidSchema,
  calculationVersion: VersionSchema,
  productId: UuidSchema, warehouseId: UuidSchema, supplierId: UuidSchema,
  supplierArticle: SourceKeySchema.nullable(),
  recommendedQuantity: NonNegativeDecimalStringSchema.nullable(), quantityStatus: QuantityStatusSchema,
  unit: SourceKeySchema, urgency: UrgencySchema,
  projectedStockoutDate: IsoDateSchema.nullable(), shortageDays: NonNegativeIntSchema.nullable(),
  numericFactors: z.array(NumericFactorSchema).max(30),
  dataQuality: DataQualitySchema,
  rationale: SafeTextSchema.max(2000), createdAt: UtcTimestampSchema,
}).superRefine((value, ctx) => {
  if ((value.quantityStatus === "known") !== (value.recommendedQuantity !== null)) {
    ctx.addIssue({ code: "custom", message: "Доступность количества и значение не согласованы" });
  }
  if (value.quantityStatus === "unavailable" && value.dataQuality !== "unavailable") {
    ctx.addIssue({ code: "custom", message: "Недоступное количество требует статус качества unavailable" });
  }
  if (value.quantityStatus === "known" && value.dataQuality === "unavailable") {
    ctx.addIssue({ code: "custom", message: "Доступное количество несовместимо с качеством unavailable" });
  }
  if (value.urgency === "unknown" && value.quantityStatus !== "unavailable") {
    ctx.addIssue({ code: "custom", message: "Неизвестная срочность требует недоступное количество" });
  }
});
export const RunRecommendationsSchema = z.strictObject({
  run: CalculationRunSchema,
  recommendations: z.array(RecommendationSchema).max(100_000),
}).superRefine((value, ctx) => {
  for (const recommendation of value.recommendations) {
    if (recommendation.runId !== value.run.id || recommendation.projectId !== value.run.projectId || recommendation.datasetVersionId !== value.run.datasetVersionId) {
      ctx.addIssue({ code: "custom", message: "Рекомендация не относится к запуску или набору" });
    }
    if (recommendation.quantityStatus === "unavailable" && value.run.configuration.runMode !== "diagnostic") {
      ctx.addIssue({ code: "custom", message: "Недоступное количество допустимо только в диагностике" });
    }
  }
});
export const RecommendationReviewSchema = z.strictObject({
  id: UuidSchema, projectId: UuidSchema, runId: UuidSchema, recommendationId: UuidSchema,
  reviewedQuantity: NonNegativeDecimalStringSchema, reason: SafeTextSchema.max(1000),
  authorUserId: z.string().min(1).max(200), reviewVersion: PositiveIntSchema,
  createdAt: UtcTimestampSchema,
});
export const ApprovalSchema = z.strictObject({
  id: UuidSchema, projectId: UuidSchema, runId: UuidSchema,
  reviewVersion: NonNegativeIntSchema, linesHash: Sha256Schema,
  authorUserId: z.string().min(1).max(200), approvedAt: UtcTimestampSchema,
  idempotencyKey: z.string().min(1).max(200), requestHash: Sha256Schema,
});
export const ExportArtifactSchema = z.strictObject({
  id: UuidSchema, projectId: UuidSchema, approvalId: UuidSchema,
  sourceObjectId: UuidSchema, checksum: Sha256Schema,
  format: z.literal("csv"), formatVersion: VersionSchema, createdAt: UtcTimestampSchema,
});
export const RunEventPayloadSchema = z.strictObject({
  stage: z.enum(["validate", "forecast", "recommend", "explain"]).nullable(),
  safeCode: z.string().regex(/^[a-z][a-z0-9_]{1,80}$/).nullable(),
});
export const RunEventSchema = z.strictObject({
  id: UuidSchema, projectId: UuidSchema, runId: UuidSchema,
  sequenceNo: PositiveIntSchema, eventType: z.enum(["queued", "stage_started", "stage_completed", "stage_failed", "completed", "cancelled"]),
  safePayload: RunEventPayloadSchema, createdAt: UtcTimestampSchema,
}).refine((value) => value.eventType.startsWith("stage_") === (value.safePayload.stage !== null), "Этап события не согласован с типом");
export const AuditEventPayloadSchema = z.strictObject({
  runId: UuidSchema.nullable(), safeCode: z.string().regex(/^[a-z][a-z0-9_]{1,80}$/).nullable(),
});
export const AuditEventSchema = z.strictObject({
  id: UuidSchema, projectId: UuidSchema, sequenceNo: PositiveIntSchema,
  action: z.enum(["project_created", "project_archived", "import_created", "run_created", "review_changed", "approved", "export_created"]),
  resourceType: z.enum(["project", "import", "dataset_version", "calculation_run", "recommendation", "approval", "export_artifact"]),
  actorUserId: z.string().min(1).max(200), resourceId: UuidSchema,
  safePayload: AuditEventPayloadSchema, createdAt: UtcTimestampSchema,
});

/** Accepts persisted server state only; never accept a client's canApprove flag. */
export function canApproveRun(input: {
  run: z.infer<typeof CalculationRunSchema>;
  currentReviewVersion: number;
  expectedReviewVersion: number;
  unavailableRecommendations: number;
  projectArchived: boolean;
}): boolean {
  const { run, currentReviewVersion, expectedReviewVersion, unavailableRecommendations, projectArchived } = input;
  return run.runMode === "full" && run.status === "succeeded"
    && run.coverageGate === "complete" && run.blockingReasons.length === 0 && run.safeError === null
    && !projectArchived
    && Number.isSafeInteger(currentReviewVersion) && currentReviewVersion >= 0
    && run.reviewVersion === currentReviewVersion
    && currentReviewVersion === expectedReviewVersion
    && unavailableRecommendations === 0;
}

/** Cross-record invariant for the only nullable calculated quantity. */
export function parseRecommendationForRun(recommendation: unknown, run: unknown): Recommendation {
  return RunRecommendationsSchema.parse({ run, recommendations: [recommendation] }).recommendations[0];
}

export type Recommendation = z.infer<typeof RecommendationSchema>;
export type RecommendationReview = z.infer<typeof RecommendationReviewSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type ExportArtifact = z.infer<typeof ExportArtifactSchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
