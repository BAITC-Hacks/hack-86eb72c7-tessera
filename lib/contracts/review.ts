import { z } from "zod";
import { NonNegativeIntSchema, Sha256Schema, UuidSchema } from "./primitives";

export const ReviewPatchSchema = z.strictObject({
  reviewVersion: NonNegativeIntSchema,
  changes: z.array(z.strictObject({
    recommendationId: UuidSchema,
    reviewedQty: z.string().regex(/^(?:0|[1-9]\d{0,21})(?:\.\d{1,8})?$/, "Укажите неотрицательное десятичное количество")
      .transform((value) => value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value),
    reason: z.string().trim().min(1).max(1000).regex(/[А-Яа-яЁё]/, "Укажите причину на русском языке"),
  })).min(1).max(1000),
}).refine((value) => new Set(value.changes.map((change) => change.recommendationId)).size === value.changes.length, "Повтор позиции");

export const ApproveRequestSchema = z.strictObject({
  reviewVersion: NonNegativeIntSchema,
  expectedSnapshotHash: Sha256Schema,
  confirmed: z.literal(true),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type ReviewPatch = z.infer<typeof ReviewPatchSchema>;
export type ApproveRequest = z.infer<typeof ApproveRequestSchema>;
