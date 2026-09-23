import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ProjectCreateSchema, ProjectUpdateSchema, PaginationSchema, type Pagination } from '../contracts/project-data';
import { ProjectSchema } from '../contracts/projects';
import { UuidSchema } from '../contracts/primitives';
import { ProjectDataError } from './project-data-errors';

const PROJECT_LIMIT = 100;
const notFound = () => new ProjectDataError(404, 'not_found', 'Ресурс не найден');
function requireUser(userId: string) {
  if (!userId || userId.length > 200) throw new ProjectDataError(401, 'unauthorized', 'Требуется вход');
}
function projectDto(row: Record<string, unknown>) {
  const timestamp = (value: unknown) => value instanceof Date ? value.toISOString() : value;
  return ProjectSchema.parse({ id: row.id, ownerUserId: row.owner_user_id, name: row.name,
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at), archivedAt: timestamp(row.archived_at) });
}
async function transaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await action(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export function createProjectService(pool: Pool) {
  return {
    async list(userId: string, input: Pagination = {}) {
      requireUser(userId);
      const page = PaginationSchema.parse(input);
      const result = await pool.query('SELECT * FROM projects WHERE owner_user_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3', [userId, page.cursor ?? null, page.limit + 1]);
      const items = result.rows.slice(0, page.limit).map(projectDto);
      return { items, nextCursor: result.rows.length > page.limit ? items.at(-1)!.id : null };
    },
    async create(userId: string, input: unknown) {
      requireUser(userId);
      const parsed = ProjectCreateSchema.parse(input);
      return transaction(pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`projects:${userId}`]);
        const count = await client.query('SELECT count(*)::int AS count FROM projects WHERE owner_user_id=$1', [userId]);
        if (count.rows[0].count >= PROJECT_LIMIT) throw new ProjectDataError(429, 'project_limit', 'Достигнут лимит проектов');
        const result = await client.query('INSERT INTO projects(id,owner_user_id,name) VALUES($1,$2,$3) RETURNING *', [randomUUID(), userId, parsed.name]);
        return projectDto(result.rows[0]);
      });
    },
    async get(userId: string, projectId: string) {
      requireUser(userId); UuidSchema.parse(projectId);
      const result = await pool.query('SELECT * FROM projects WHERE id=$1 AND owner_user_id=$2', [projectId, userId]);
      if (!result.rowCount) throw notFound();
      return projectDto(result.rows[0]);
    },
    async update(userId: string, projectId: string, input: unknown) {
      requireUser(userId); UuidSchema.parse(projectId);
      const parsed = ProjectUpdateSchema.parse(input);
      return transaction(pool, async (client) => {
        const current = await client.query('SELECT * FROM projects WHERE id=$1 AND owner_user_id=$2 FOR UPDATE', [projectId, userId]);
        if (!current.rowCount) throw notFound();
        const result = await client.query(`UPDATE projects SET name=COALESCE($3,name),
          archived_at=CASE WHEN $4::boolean IS NULL THEN archived_at WHEN $4 THEN COALESCE(archived_at,now()) ELSE NULL END,
          updated_at=now() WHERE id=$1 AND owner_user_id=$2 RETURNING *`, [projectId, userId, parsed.name ?? null, parsed.archived ?? null]);
        return projectDto(result.rows[0]);
      });
    },
    async listDatasets(userId: string, projectId: string, input: Pagination = {}) {
      requireUser(userId); UuidSchema.parse(projectId);
      const page = PaginationSchema.parse(input);
      const project = await pool.query('SELECT id FROM projects WHERE id=$1 AND owner_user_id=$2', [projectId, userId]);
      if (!project.rowCount) throw notFound();
      const result = await pool.query(`SELECT id,project_id,import_id,manifest,manifest_hash,as_of_date,provenance,source_completeness,schema_version,created_at
        FROM dataset_versions WHERE project_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3`, [projectId, page.cursor ?? null, page.limit + 1]);
      const items = result.rows.slice(0, page.limit).map((row) => ({
        id: row.id, projectId: row.project_id, importId: row.import_id, manifestHash: row.manifest_hash,
        asOfDate: row.as_of_date instanceof Date ? row.as_of_date.toISOString().slice(0,10) : row.as_of_date,
        provenance: row.provenance, sourceCompleteness: row.source_completeness,
        schemaVersion: row.schema_version, createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        sources: Array.isArray(row.manifest) ? row.manifest.map((source: Record<string, unknown>) => ({ sourceObjectId: source.sourceObjectId, sourceType: source.sourceType })) : [],
        report: null,
      }));
      return { items, nextCursor: result.rows.length > page.limit ? items.at(-1)!.id : null };
    },
  };
}
