import { z } from "zod";
import { ProjectCreateSchema } from "@/lib/contracts/project-data";
import { ProjectSchema, type Project } from "@/lib/contracts/projects";
import { DataOriginSchema, SourceCompletenessSchema, SourceTypeSchema } from "@/lib/contracts/datasets";
import { IsoDateSchema, Sha256Schema, UtcTimestampSchema, UuidSchema, VersionSchema } from "@/lib/contracts/primitives";
import { ApiClientError, browserApiRequest } from "./procurement-api";

const ProjectPageSchema = z.strictObject({
  items: z.array(ProjectSchema).max(100),
  nextCursor: UuidSchema.nullable(),
});
const DatasetSummarySchema = z.strictObject({
  id: UuidSchema, projectId: UuidSchema, importId: UuidSchema, manifestHash: Sha256Schema,
  asOfDate: IsoDateSchema, provenance: DataOriginSchema,
  sourceCompleteness: z.array(SourceCompletenessSchema).max(100),
  schemaVersion: VersionSchema, createdAt: UtcTimestampSchema,
  sources: z.array(z.strictObject({ sourceObjectId: UuidSchema, sourceType: SourceTypeSchema })).max(100),
  report: z.null(),
});
const DatasetPageSchema = z.strictObject({ items: z.array(DatasetSummarySchema).max(100), nextCursor: UuidSchema.nullable() });

export type ProjectPage = { items: Project[]; nextCursor: string | null };
export type DatasetSummary = z.infer<typeof DatasetSummarySchema>;
export type DatasetPage = { items: DatasetSummary[]; nextCursor: string | null };

export function decodeProjectPage(value: unknown): ProjectPage {
  return ProjectPageSchema.parse(value);
}

export function decodeProject(value: unknown): Project {
  return ProjectSchema.parse(value);
}
export function decodeDatasetPage(value: unknown): DatasetPage { return DatasetPageSchema.parse(value); }

export function listProjectPage(cursor?: string, signal?: AbortSignal): Promise<ProjectPage> {
  return browserApiRequest({ method: "GET", path: "/api/projects", query: { limit: 20, cursor }, decode: decodeProjectPage, signal });
}

export function createProject(name: string, signal?: AbortSignal): Promise<Project> {
  const parsed = ProjectCreateSchema.safeParse({ name });
  if (!parsed.success) return Promise.reject(new ApiClientError("invalid_input"));
  return browserApiRequest({ method: "POST", path: "/api/projects", body: parsed.data, decode: decodeProject, signal });
}

export function getProject(projectId: string, signal?: AbortSignal): Promise<Project> {
  if (!UuidSchema.safeParse(projectId).success) return Promise.reject(new ApiClientError("invalid_request"));
  return browserApiRequest({ method: "GET", path: `/api/projects/${projectId}`, decode(value) {
    const project = decodeProject(value);
    if (project.id !== projectId) throw new Error("Project ID mismatch");
    return project;
  }, signal });
}

export function listDatasetPage(projectId: string, cursor?: string, signal?: AbortSignal): Promise<DatasetPage> {
  if (!UuidSchema.safeParse(projectId).success) return Promise.reject(new ApiClientError("invalid_request"));
  return browserApiRequest({ method: "GET", path: `/api/projects/${projectId}/datasets`, query: { limit: 20, cursor }, decode(value) {
    const page = decodeDatasetPage(value);
    if (page.items.some((item) => item.projectId !== projectId)) throw new Error("Dataset project mismatch");
    return page;
  }, signal });
}
