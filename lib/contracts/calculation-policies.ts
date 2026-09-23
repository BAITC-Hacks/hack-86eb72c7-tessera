import { z } from "zod";
import { PositiveDecimalStringSchema, SourceKeySchema, UuidSchema } from "./primitives";

/** Explicit, immutable policy inputs required by the 07/08 calculation. */
export const CalculationPoliciesSchema = z.strictObject({
  trendCapsByCategory: z.array(z.strictObject({
    categoryKey: SourceKeySchema, maxMonthlyTrendFactor: PositiveDecimalStringSchema,
  })).max(200),
  unitSteps: z.array(z.strictObject({
    productId: UuidSchema, unit: SourceKeySchema, step: PositiveDecimalStringSchema,
  })).max(100_000),
  growthSemanticsByAssumption: z.array(z.strictObject({
    growthAssumptionId: UuidSchema,
    valueKind: z.enum(["fractional_rate", "percent", "multiplier"]),
    period: z.enum(["month", "year"]),
    independentIncrementConfirmed: z.boolean(),
  })).max(10_000),
}).superRefine((value, ctx) => {
  if (new Set(value.growthSemanticsByAssumption.map((item) => item.growthAssumptionId)).size !== value.growthSemanticsByAssumption.length)
    ctx.addIssue({ code: "custom", message: "Повтор семантики предположения роста" });
  if (new Set(value.trendCapsByCategory.map((item) => item.categoryKey)).size !== value.trendCapsByCategory.length)
    ctx.addIssue({ code: "custom", message: "Повтор ограничения тренда категории" });
  if (new Set(value.unitSteps.map((item) => item.productId)).size !== value.unitSteps.length)
    ctx.addIssue({ code: "custom", message: "Повтор шага единицы артикула" });
});

export type CalculationPolicies = z.infer<typeof CalculationPoliciesSchema>;
