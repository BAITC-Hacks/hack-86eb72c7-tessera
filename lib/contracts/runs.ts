import { z } from "zod";
import {
  IsoDateSchema, NonNegativeIntSchema, PositiveDecimalStringSchema, PositiveIntSchema, Sha256Schema,
  SourceKeySchema,
  UtcTimestampSchema, UuidSchema, VersionSchema,
} from "./primitives";

export const RunModeSchema = z.enum(["full", "diagnostic"]);
export const CalculationRunStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export const CalculationStageSchema = z.enum(["validate", "forecast", "recommend", "explain"]);
export const StageStatusSchema = z.enum(["pending", "running", "succeeded", "failed", "skipped"]);
export const ExplanationStatusSchema = z.enum(["not_requested", "pending", "succeeded", "degraded"]);
export const CoverageGateSchema = z.enum(["complete", "incomplete"]);
export const BlockingReasonSchema = z.enum([
  "missing_source", "invalid_source", "missing_stock", "missing_lead_time", "missing_product_mapping",
  "unavailable_quantity", "data_quality", "run_failed", "stale_review",
]);
export const CalculationScopeSchema = z.strictObject({
  warehouseIds: z.array(UuidSchema).max(100),
  categoryIds: z.array(SourceKeySchema).max(100),
}).superRefine((value, ctx) => {
  if (new Set(value.warehouseIds).size !== value.warehouseIds.length || new Set(value.categoryIds).size !== value.categoryIds.length) {
    ctx.addIssue({ code: "custom", message: "Повтор в области расчёта" });
  }
});
export const RunConfigurationSchema = z.strictObject({
  runMode: RunModeSchema, scope: CalculationScopeSchema, asOfDate: IsoDateSchema,
  historicalWindowMonths: PositiveIntSchema.max(120),
  minComparableWeeks: PositiveIntSchema.min(8).max(104),
  outlierMadMultiplier: PositiveDecimalStringSchema,
  outlierMedianMultiplier: PositiveDecimalStringSchema,
  zeroMadMinimumUnit: PositiveDecimalStringSchema,
  incompleteMonthPolicy: z.enum(["exclude", "normalize_exposure"]),
  growthMode: z.enum(["replace", "incremental", "none"]),
  seasonalityMode: z.enum(["estimated", "provided", "none"]),
  reviewPeriodDays: PositiveIntSchema.max(365),
  safetyDaysByCategory: z.array(z.strictObject({ categoryKey: SourceKeySchema, safetyDays: NonNegativeIntSchema.max(365) })).max(200),
  leadTimePolicyVersion: VersionSchema, unitPolicyVersion: VersionSchema,
  algorithmVersion: VersionSchema,
  parametersHash: Sha256Schema,
}).refine((value) => new Set(value.safetyDaysByCategory.map((item) => item.categoryKey)).size === value.safetyDaysByCategory.length, "Повтор политики безопасности категории");
export const StageStateSchema = z.strictObject({
  status: StageStatusSchema,
  startedAt: UtcTimestampSchema.nullable(), completedAt: UtcTimestampSchema.nullable(),
  safeErrorCode: z.string().regex(/^[a-z][a-z0-9_]{1,80}$/).nullable(),
}).superRefine((value, ctx) => {
  if (value.status === "running" && value.startedAt === null) ctx.addIssue({ code: "custom", message: "Активный этап требует время начала" });
  if (["succeeded", "failed", "skipped"].includes(value.status) && value.completedAt === null) ctx.addIssue({ code: "custom", message: "Завершённый этап требует время окончания" });
  if (value.status === "failed" && value.safeErrorCode === null) ctx.addIssue({ code: "custom", message: "Сбой этапа требует безопасный код" });
});
export const CalculationRunSchema = z.strictObject({
  id: UuidSchema, projectId: UuidSchema, datasetVersionId: UuidSchema,
  requestedBy: z.string().min(1).max(200),
  scope: CalculationScopeSchema, asOfDate: IsoDateSchema,
  configuration: RunConfigurationSchema, configurationHash: Sha256Schema,
  requestHash: Sha256Schema, algorithmVersion: VersionSchema,
  idempotencyKey: z.string().min(1).max(200), runMode: RunModeSchema,
  triggerRunId: z.string().min(1).max(200).nullable(),
  status: CalculationRunStatusSchema, stage: CalculationStageSchema.nullable(),
  stateVersion: NonNegativeIntSchema, reviewVersion: NonNegativeIntSchema,
  stageStates: z.partialRecord(CalculationStageSchema, StageStateSchema),
  explanationStatus: ExplanationStatusSchema,
  coverageGate: CoverageGateSchema, blockingReasons: z.array(BlockingReasonSchema).max(20),
  safeError: z.string().regex(/^[a-z][a-z0-9_]{1,80}$/).nullable(),
  createdAt: UtcTimestampSchema,
  startedAt: UtcTimestampSchema.nullable(), finishedAt: UtcTimestampSchema.nullable(),
}).superRefine((value, ctx) => {
  if (value.runMode !== value.configuration.runMode || value.asOfDate !== value.configuration.asOfDate || value.algorithmVersion !== value.configuration.algorithmVersion || JSON.stringify(value.scope) !== JSON.stringify(value.configuration.scope)) {
    ctx.addIssue({ code: "custom", message: "Снимок конфигурации запуска не согласован с полями запуска" });
  }
  if (value.status === "queued" && (value.stage !== null || value.startedAt !== null || value.finishedAt !== null)) {
    ctx.addIssue({ code: "custom", message: "Ожидающий запуск не начат" });
  }
  if (value.status === "running" && (value.stage === null || value.startedAt === null || value.finishedAt !== null)) {
    ctx.addIssue({ code: "custom", message: "Активному запуску нужен этап и время начала" });
  }
  if (["succeeded", "failed", "cancelled"].includes(value.status) && value.finishedAt === null) {
    ctx.addIssue({ code: "custom", message: "Завершённый запуск требует время окончания" });
  }
  if (value.status === "failed" && value.safeError === null) ctx.addIssue({ code: "custom", message: "Сбой запуска требует безопасный код" });
  if (value.coverageGate === "complete" && value.blockingReasons.length > 0) ctx.addIssue({ code: "custom", message: "Полное покрытие несовместимо с блокировками" });
  if (value.coverageGate === "incomplete" && value.blockingReasons.length === 0 && ["succeeded", "failed", "cancelled"].includes(value.status)) {
    ctx.addIssue({ code: "custom", message: "Завершённое неполное покрытие требует причину" });
  }
});

export const DispatchIntentSchema = z.strictObject({
  id: UuidSchema, projectId: UuidSchema, operationType: z.enum(["import", "calculation"]),
  importId: UuidSchema.nullable(), runId: UuidSchema.nullable(),
  idempotencyKey: z.string().min(1).max(200),
  payloadVersion: VersionSchema, payloadHash: Sha256Schema,
  status: z.enum(["pending", "leased", "sent", "failed"]), attempts: NonNegativeIntSchema,
  nextAttemptAt: UtcTimestampSchema.nullable(), leaseUntil: UtcTimestampSchema.nullable(),
  externalTaskId: z.string().min(1).max(200).nullable(),
  safeError: z.string().regex(/^[a-z][a-z0-9_]{1,80}$/).nullable(),
  createdAt: UtcTimestampSchema,
}).superRefine((value, ctx) => {
  if ((value.operationType === "import") !== (value.importId !== null) || (value.operationType === "calculation") !== (value.runId !== null)) {
    ctx.addIssue({ code: "custom", message: "Тип dispatch и бизнес-ID не согласованы" });
  }
  if (value.status === "leased" && value.leaseUntil === null) ctx.addIssue({ code: "custom", message: "Аренда dispatch требует срок" });
  if (value.status === "sent" && value.externalTaskId === null) ctx.addIssue({ code: "custom", message: "Отправленный dispatch требует ID задачи" });
  if (value.status === "failed" && value.safeError === null) ctx.addIssue({ code: "custom", message: "Сбой dispatch требует безопасный код" });
});
export type CalculationRun = z.infer<typeof CalculationRunSchema>;
export type DispatchIntent = z.infer<typeof DispatchIntentSchema>;
