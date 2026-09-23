import { z } from 'zod';
import { UuidSchema } from './primitives';

export const ProjectCreateSchema = z.strictObject({ name: z.string().trim().min(1).max(120) });
export const ProjectUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  archived: z.boolean().optional(),
}).refine((value) => value.name !== undefined || value.archived !== undefined, 'Укажите изменение');
export const PaginationSchema = z.strictObject({
  cursor: UuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.input<typeof PaginationSchema>;
export type ProjectCreate = z.infer<typeof ProjectCreateSchema>;
export type ProjectUpdate = z.infer<typeof ProjectUpdateSchema>;
