import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { canApproveRun } from "../contracts/recommendations";
import {
  CalculationRunSchema, CreateRunRequestSchema, RecommendationPageQuerySchema,
  RunPageQuerySchema,
} from "../contracts/runs";
import { UuidSchema } from "../contracts/primitives";
import { canonicalJsonHash, runRequestHash, canonicalDecimal } from "./db";
import { SUPPORTED_CALCULATION_ALGORITHM_VERSION } from "./calculation-execution";

type RunPage = z.input<typeof RunPageQuerySchema>;
type RecommendationPage = z.input<typeof RecommendationPageQuerySchema>;
type Cursor = { scope: string; filter: string; version: number; createdAt?: string; id?: string; supplierId?: string; warehouseId?: string; productId?: string };

export class RunServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const notFound = () => new RunServiceError(404, "NOT_FOUND", "Ресурс не найден.");
const conflict = (code = "CONFLICT") => new RunServiceError(409, code, "Операция конфликтует с текущим состоянием.");
const timestamp = (value: unknown): string | null => value == null ? null : value instanceof Date ? value.toISOString() : String(value);
// node-postgres materializes DATE at local midnight; UTC serialization can move it to the previous day.
const date = (value: unknown): string => value instanceof Date
  ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
  : String(value);

function publicEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicEvidence);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "anonymousCustomerKey" && key !== "anonymizedCustomerKey")
      .map(([key, nested]) => [key, publicEvidence(nested)]));
  return value;
}

function encodeCursor(cursor: Cursor, secret: string): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decodeCursor(token: string, secret: string, scope: string, filter: string, version: number): Cursor {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined || token.length > 2048) throw new RunServiceError(422, "INVALID_CURSOR", "Некорректный курсор.");
  const expected = createHmac("sha256", secret).update(payload).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); }
  catch { throw new RunServiceError(422, "INVALID_CURSOR", "Некорректный курсор."); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new RunServiceError(422, "INVALID_CURSOR", "Некорректный курсор.");
  try {
    const data: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const parsed = z.strictObject({
      scope: z.string(), filter: z.string(), version: z.int(),
      createdAt: z.iso.datetime({ offset: false }).optional(), id: UuidSchema.optional(),
      supplierId: UuidSchema.optional(), warehouseId: UuidSchema.optional(), productId: UuidSchema.optional(),
    }).parse(data);
    if (parsed.scope !== scope || parsed.filter !== filter || parsed.version !== version) throw new Error("cursor_scope");
    return parsed;
  } catch { throw new RunServiceError(422, "INVALID_CURSOR", "Некорректный курсор."); }
}

function runDto(row: Record<string, unknown>) {
  return CalculationRunSchema.parse({
    id: row.id, projectId: row.project_id, datasetVersionId: row.dataset_version_id,
    requestedBy: row.requested_by, scope: row.scope, asOfDate: date(row.as_of_date),
    configuration: row.configuration, configurationHash: row.configuration_hash,
    requestHash: row.request_hash, algorithmVersion: row.algorithm_version,
    idempotencyKey: row.idempotency_key, runMode: row.run_mode,
    triggerRunId: row.trigger_run_id, status: row.status, stage: row.stage,
    stateVersion: row.state_version, reviewVersion: row.review_version,
    stageStates: row.stage_states, explanationStatus: row.explanation_status,
    coverageGate: row.coverage_gate, blockingReasons: row.blocking_reasons,
    safeError: row.safe_error, createdAt: timestamp(row.created_at),
    startedAt: timestamp(row.started_at), finishedAt: timestamp(row.finished_at),
  });
}

function requireUser(userId: string): void {
  if (!userId || userId.length > 200) throw new RunServiceError(401, "UNAUTHENTICATED", "Требуется вход в систему.");
}

type Cancellation = { kind: "cancelled" | "already_cancelled" | "conflict"; projectId: string; triggerRunId: string | null; stateVersion: number } | { kind: "not_found" };

export function createRunService(pool: Pool, cursorSecret: string, ports: {
  dispatch?: (runId: string) => Promise<void>;
  cancelTransaction: (input: { runId: string; requestedBy: string }) => Promise<Cancellation>;
  cancelExternal?: (runId: string) => Promise<void>;
}) {
  if (cursorSecret.length < 32) throw new RunServiceError(503, "CURSOR_UNAVAILABLE", "Сервис временно недоступен.");
  const MAX_ACTIVE_RUNS = 10;

  async function withIdempotencyLock<T>(projectId: string, key: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`calculation-project:${projectId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
      const value = await action(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof Error && "code" in error && error.code === "23505") throw conflict("IDEMPOTENCY_CONFLICT");
      throw error;
    } finally { client.release(); }
  }

  async function ownedRun(userId: string, runId: string) {
    requireUser(userId); UuidSchema.parse(runId);
    const result = await pool.query(`SELECT r.*,p.archived_at FROM calculation_runs r
      JOIN projects p ON p.id=r.project_id AND p.owner_user_id=$2
      WHERE r.id=$1`, [runId, userId]);
    if (!result.rowCount) throw notFound();
    return result.rows[0] as Record<string, unknown>;
  }

  return {
    async create(userId: string, projectId: string, input: unknown) {
      requireUser(userId); UuidSchema.parse(projectId);
      const body = CreateRunRequestSchema.parse(input);
      const result = await withIdempotencyLock(projectId, `calculation:${projectId}:${body.idempotencyKey}`, async (client) => {
        const config = body.configuration;
        const requestHash = runRequestHash({ projectId, datasetVersionId: body.datasetVersionId,
          scope: body.scope, asOfDate: config.asOfDate, configuration: config,
          algorithmVersion: config.algorithmVersion, runMode: config.runMode });
        const project = await client.query(`SELECT id,archived_at FROM projects
          WHERE id=$1 AND owner_user_id=$2 FOR UPDATE`, [projectId, userId]);
        if (!project.rowCount) throw notFound();
        const previous = await client.query(`SELECT id,status,request_hash FROM calculation_runs
          WHERE project_id=$1 AND idempotency_key=$2`, [projectId, body.idempotencyKey]);
        if (previous.rowCount) {
          if (previous.rows[0].request_hash !== requestHash) throw conflict("IDEMPOTENCY_CONFLICT");
          return { statusCode: 200, data: { runId: previous.rows[0].id, status: previous.rows[0].status } };
        }
        if (project.rows[0].archived_at) throw conflict("ARCHIVED");
        const owned = await client.query(`SELECT d.id,d.source_completeness,i.status
          FROM dataset_versions d JOIN imports i ON i.id=d.import_id AND i.project_id=d.project_id
          WHERE d.id=$1 AND d.project_id=$2`, [body.datasetVersionId, projectId]);
        if (!owned.rowCount) throw notFound();
        if (owned.rows[0].status !== "ready") throw conflict("DATASET_NOT_READY");
        if (config.algorithmVersion !== SUPPORTED_CALCULATION_ALGORITHM_VERSION)
          throw new RunServiceError(422, "UNKNOWN_ALGORITHM_VERSION", "Неизвестная версия алгоритма.");
        const { parametersHash, ...parameters } = config;
        if (parametersHash !== canonicalJsonHash(parameters))
          throw new RunServiceError(422, "INVALID_PARAMETERS_HASH", "Некорректный хеш параметров.");
        const active = await client.query(`SELECT count(*)::int AS total FROM calculation_runs
          WHERE project_id=$1 AND status IN ('queued','running')`, [projectId]);
        if (Number(active.rows[0].total) >= MAX_ACTIVE_RUNS)
          throw new RunServiceError(429, "ACTIVE_RUN_LIMIT", "Достигнут лимит активных расчётов.");
        if (config.runMode === "full") {
          const completeness = owned.rows[0].source_completeness as unknown;
          if (!Array.isArray(completeness)) throw conflict("INCOMPLETE_DATASET");
          const required = ["sales", "stock", "inbound", "stockouts", "suppliers", "categories", "growth", "product_mapping", "lead_times",
            ...(config.seasonalityMode === "provided" ? ["seasonality"] : [])];
          if (required.some((type) => !completeness.some((item) => item && typeof item === "object" && "sourceType" in item && item.sourceType === type && "status" in item && ["complete", "explicit_none"].includes(String(item.status)))))
            throw conflict("INCOMPLETE_DATASET");
        }
        if (body.scope.warehouseIds.length) {
          const warehouses = await client.query(`SELECT id FROM warehouses WHERE project_id=$1 AND dataset_version_id=$2 AND id=ANY($3::uuid[])`,
            [projectId, body.datasetVersionId, body.scope.warehouseIds]);
          if (warehouses.rowCount !== body.scope.warehouseIds.length) throw notFound();
        }
        if (body.scope.categoryIds.length) {
          const categories = await client.query(`SELECT category_key FROM products WHERE project_id=$1 AND dataset_version_id=$2
            UNION SELECT category_key FROM category_policies WHERE project_id=$1 AND dataset_version_id=$2`,
            [projectId, body.datasetVersionId]);
          if (body.scope.categoryIds.some((key) => !categories.rows.some((row) => row.category_key === key))) throw notFound();
        }
        const id = randomUUID();
        const configurationHash = canonicalJsonHash(config);
        const inserted = await client.query(`INSERT INTO calculation_runs
          (id,project_id,dataset_version_id,requested_by,scope,as_of_date,configuration,configuration_hash,
           request_hash,algorithm_version,idempotency_key,run_mode,status)
          VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10,$11,$12,'queued') RETURNING id,status`,
          [id, projectId, body.datasetVersionId, userId, JSON.stringify(body.scope), config.asOfDate,
            JSON.stringify(config), configurationHash, requestHash, config.algorithmVersion, body.idempotencyKey, config.runMode]);
        await client.query(`INSERT INTO dispatch_intents
          (id,project_id,operation_type,run_id,idempotency_key,payload_version,payload_hash)
          VALUES($1,$2,'calculation',$3,$4,'1',$5)`,
          [randomUUID(), projectId, id, body.idempotencyKey,
            canonicalJsonHash({ operationType: "calculation", businessId: id, configurationHash })]);
        return { statusCode: 202, data: { runId: inserted.rows[0].id, status: inserted.rows[0].status } };
      });
      // Delivery is best-effort: the durable intent has committed and recovery owns retries.
      if (result.statusCode === 202 && ports.dispatch) void ports.dispatch(String(result.data.runId)).catch(() => {});
      return result;
    },

    async list(userId: string, projectId: string, input: RunPage = {}) {
      requireUser(userId); UuidSchema.parse(projectId);
      const page = RunPageQuerySchema.parse(input);
      const owner = await pool.query("SELECT id FROM projects WHERE id=$1 AND owner_user_id=$2", [projectId, userId]);
      if (!owner.rowCount) throw notFound();
      const scope = `${userId}:${projectId}:runs`;
      const cursor = page.cursor ? decodeCursor(page.cursor, cursorSecret, scope, "", 1) : null;
      if (cursor && (!cursor.createdAt || !cursor.id)) throw new RunServiceError(422, "INVALID_CURSOR", "Некорректный курсор.");
      const result = await pool.query(`SELECT id,dataset_version_id,status,created_at,scope,coverage_gate,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
        FROM calculation_runs
        WHERE project_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
        ORDER BY created_at DESC,id DESC LIMIT $4`, [projectId, cursor?.createdAt ?? null, cursor?.id ?? null, page.limit + 1]);
      const rows = result.rows.slice(0, page.limit);
      const items = rows.map((row) => ({ runId: row.id, datasetVersionId: row.dataset_version_id,
        status: row.status, createdAt: timestamp(row.created_at), scope: row.scope,
        coverageGate: row.coverage_gate }));
      const last = rows.at(-1);
      return { items, nextCursor: result.rows.length > page.limit && last ? encodeCursor({
        scope, filter: "", version: 1, createdAt: last.created_at_cursor, id: last.id,
      }, cursorSecret) : null };
    },

    async get(userId: string, runId: string) {
      const row = await ownedRun(userId, runId);
      const run = runDto(row);
      const count = await pool.query(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE recommended_quantity IS NULL)::int AS unavailable
        FROM recommendations WHERE run_id=$1 AND project_id=$2`, [runId, run.projectId]);
      const total = Number(count.rows[0].total);
      return { runId: run.id, projectId: run.projectId, datasetVersionId: run.datasetVersionId,
        status: run.status, stage: run.stage, stageStates: run.stageStates,
        stateVersion: run.stateVersion, scope: run.scope, configuration: run.configuration,
        asOfDate: run.asOfDate, algorithmVersion: run.algorithmVersion,
        coverageGate: run.coverageGate, blockingReasons: run.blockingReasons,
        canApprove: total > 0 && canApproveRun({ run, currentReviewVersion: run.reviewVersion,
          expectedReviewVersion: run.reviewVersion, unavailableRecommendations: Number(count.rows[0].unavailable),
          projectArchived: row.archived_at !== null }),
        warnings: Array.isArray(row.warnings) ? row.warnings : [],
        explanationStatus: run.explanationStatus, createdAt: run.createdAt,
        startedAt: run.startedAt, finishedAt: run.finishedAt,
        error: run.safeError === null ? null : { code: run.safeError, message: "Расчёт завершился ошибкой." },
      };
    },

    async recommendations(userId: string, runId: string, input: RecommendationPage = {}) {
      const row = await ownedRun(userId, runId);
      if (row.status !== "succeeded") throw conflict("RESULTS_NOT_READY");
      const page = RecommendationPageQuerySchema.parse(input);
      const version = typeof row.result_version === "number" ? row.result_version : Number(row.state_version);
      const filter = canonicalJsonHash({ supplierId: page.supplierId ?? null, q: page.q ?? null, urgency: page.urgency ?? null });
      const scope = `${userId}:${runId}:recommendations`;
      const cursor = page.cursor ? decodeCursor(page.cursor, cursorSecret, scope, filter, version) : null;
      if (cursor && (!cursor.supplierId || !cursor.warehouseId || !cursor.productId || !cursor.id))
        throw new RunServiceError(422, "INVALID_CURSOR", "Некорректный курсор.");
      if (page.supplierId) {
        const supplier = await pool.query(`SELECT 1 FROM suppliers WHERE id=$1 AND project_id=$2 AND dataset_version_id=$3`,
          [page.supplierId, row.project_id, row.dataset_version_id]);
        if (!supplier.rowCount) throw notFound();
      }
      const query = page.q ? `%${page.q.replace(/[\\%_]/g, "\\$&")}%` : null;
      const result = await pool.query(`SELECT r.*,p.sku,p.name AS product_name,s.name AS supplier_name
        FROM recommendations r JOIN products p ON p.id=r.product_id AND p.project_id=r.project_id AND p.dataset_version_id=r.dataset_version_id
        JOIN suppliers s ON s.id=r.supplier_id AND s.project_id=r.project_id AND s.dataset_version_id=r.dataset_version_id
        WHERE r.run_id=$1 AND r.project_id=$2 AND ($3::uuid IS NULL OR r.supplier_id=$3)
          AND ($4::text IS NULL OR p.sku ILIKE $4 ESCAPE '\\' OR p.name ILIKE $4 ESCAPE '\\')
          AND ($5::text IS NULL OR r.urgency=$5)
          AND ($6::uuid IS NULL OR (r.supplier_id,r.warehouse_id,r.product_id,r.id)>($6::uuid,$7::uuid,$8::uuid,$9::uuid))
        ORDER BY r.supplier_id,r.warehouse_id,r.product_id,r.id LIMIT $10`,
        [runId, row.project_id, page.supplierId ?? null, query, page.urgency ?? null,
          cursor?.supplierId ?? null, cursor?.warehouseId ?? null, cursor?.productId ?? null, cursor?.id ?? null, page.limit + 1]);
      const rows = result.rows.slice(0, page.limit);
      const items = rows.map((item) => ({
        recommendationId: item.id, productId: item.product_id, warehouseId: item.warehouse_id,
        supplierId: item.supplier_id, sku: item.sku, productName: item.product_name,
        supplierArticle: item.supplier_article, recommendedQuantity: item.recommended_quantity === null ? null : canonicalDecimal(String(item.recommended_quantity)),
        quantityStatus: item.quantity_status, unit: item.unit, urgency: item.urgency,
        projectedStockoutDate: item.projected_stockout_date === null ? null : date(item.projected_stockout_date),
        shortageDays: item.shortage_days, numericFactors: item.numeric_factors,
        dataQuality: item.data_quality, rationale: item.rationale,
        evidence: publicEvidence(item.evidence), warnings: item.warnings,
      }));
      const groups = await pool.query(`SELECT s.id AS supplier_id,s.name,count(r.id)::int AS line_count
        FROM recommendations r JOIN suppliers s ON s.id=r.supplier_id AND s.project_id=r.project_id AND s.dataset_version_id=r.dataset_version_id
        WHERE r.run_id=$1 AND r.project_id=$2 GROUP BY s.id,s.name ORDER BY s.id`, [runId, row.project_id]);
      const last = rows.at(-1);
      return { items, nextCursor: result.rows.length > page.limit && last ? encodeCursor({
        scope, filter, version, supplierId: last.supplier_id, warehouseId: last.warehouse_id,
        productId: last.product_id, id: last.id,
      }, cursorSecret) : null,
      supplierGroups: groups.rows.map((group) => ({ supplierId: group.supplier_id, name: group.name, lineCount: group.line_count })),
      resultVersion: version };
    },

    async cancel(userId: string, runId: string) {
      requireUser(userId); UuidSchema.parse(runId);
      const outcome = await ports.cancelTransaction({ runId, requestedBy: userId });
      if (outcome.kind === "not_found") throw notFound();
      if (outcome.kind === "conflict") throw conflict("RUN_TERMINAL");
      if (outcome.kind === "cancelled" && ports.cancelExternal)
        void ports.cancelExternal(runId).catch(() => {});
      const row = await ownedRun(userId, runId);
      return { statusCode: outcome.kind === "already_cancelled" ? 200 : 202,
        data: { runId, status: row.status, stage: row.stage, stageStates: row.stage_states,
          stateVersion: row.state_version, finishedAt: timestamp(row.finished_at) } };
    },

    ownedRun,
  };
}
