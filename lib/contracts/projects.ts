import { z } from "zod";
import { SafeTextSchema, UtcTimestampSchema, UuidSchema } from "./primitives";

export const ProjectSchema = z.strictObject({
  id: UuidSchema,
  ownerUserId: z.string().min(1).max(200),
  name: SafeTextSchema.max(200),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
  archivedAt: UtcTimestampSchema.nullable(),
});
export const CreateProjectSchema = ProjectSchema.pick({ name: true });
export type Project = z.infer<typeof ProjectSchema>;
export type CreateProject = z.infer<typeof CreateProjectSchema>;
