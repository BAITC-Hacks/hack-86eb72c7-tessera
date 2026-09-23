import "server-only";

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  CalculationPoliciesSchema, ReplenishmentResultSchema,
  type CalculationDataset, type ReplenishmentResult,
} from "../contracts/calculation";
import {
  CategoryPolicySchema, DatasetVersionSchema, GrowthAssumptionSchema, InboundShipmentSchema,
  MonthlySalesSchema, ProductSchema, ProductSupplierSchema, SaleSchema, SeasonalityIndexSchema,
  StockoutIntervalSchema, StockSnapshotSchema, SupplierLeadTimeSchema, SupplierSchema, WarehouseSchema,
} from "../contracts/datasets";
import { UuidSchema } from "../contracts/primitives";
import { CalculationStageSchema, RunConfigurationSchema, RunModeSchema, StageStateSchema } from "../contracts/runs";
import { canonicalJsonHash, runRequestHash } from "./db";

const PayloadSchema = z.strictObject({
  runId: UuidSchema, projectId: UuidSchema, datasetVersionId: UuidSchema,
  requestedBy: z.string().min(1).max(200),
});
export type CalculationPayload = z.infer<typeof PayloadSchema>;
export type CalculationStage = z.infer<typeof CalculationStageSchema>;
type StageState = z.infer<typeof StageStateSchema>;
/** Version of the 07/08 deterministic implementation deployed with this worker. */
export const SUPPORTED_CALCULATION_ALGORITHM_VERSION = "1";

const orderedStages = ["validate", "forecast", "recommend"] as const;
const safeCode = /^[a-z][a-z0-9_]{1,80}$/;
const numericFields = new Set([
  "quantity", "unitPrice", "moq", "packMultiple", "indexValue", "growthRate", "safetyStock",
]);
const dateFields = new Set(["asOfDate", "soldOn", "expectedOn", "startsOn", "endsOn", "effectiveFrom", "periodMonth"]);

export class CalculationExecutionError extends Error {
  constructor(readonly code: "not_found" | "invalid_state" | "coverage_incomplete" | "invalid_result") {
    super(code);
  }
}

function canonicalNumeric(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

/** pg DATE is a calendar value; node-postgres may parse it as local-midnight Date. */
function pgDate(value: unknown): string {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  return String(value);
}

function rowDto(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([name, value]) => {
    const key = name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    if (value instanceof Date) return [key, dateFields.has(key) ? pgDate(value) : value.toISOString()];
    if (typeof value === "string" && numericFields.has(key)) return [key, canonicalNumeric(value)];
    return [key, value];
  }));
}

async function transaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function rows<Schema extends z.ZodType>(
  client: PoolClient, table: string, schema: Schema, projectId: string, datasetVersionId: string,
): Promise<z.output<Schema>[]> {
  const result = await client.query(`SELECT * FROM ${table} WHERE project_id=$1 AND dataset_version_id=$2 ORDER BY id`, [projectId, datasetVersionId]);
  return result.rows.map((row: Record<string, unknown>) => schema.parse(rowDto(row)));
}

async function dataset(client: PoolClient, projectId: string, datasetVersionId: string): Promise<CalculationDataset> {
  const versionRow = await client.query("SELECT * FROM dataset_versions WHERE project_id=$1 AND id=$2", [projectId, datasetVersionId]);
  if (!versionRow.rowCount) throw new CalculationExecutionError("not_found");
  const version = DatasetVersionSchema.parse(rowDto(versionRow.rows[0]));
  // A PoolClient executes one query at a time; do not overlap reads inside this snapshot transaction.
  const products = await rows(client, "products", ProductSchema, projectId, datasetVersionId);
  const warehouses = await rows(client, "warehouses", WarehouseSchema, projectId, datasetVersionId);
  const suppliers = await rows(client, "suppliers", SupplierSchema, projectId, datasetVersionId);
  const productSuppliers = await rows(client, "product_suppliers", ProductSupplierSchema, projectId, datasetVersionId);
  const sales = await rows(client, "sales", SaleSchema, projectId, datasetVersionId);
  const monthlySales = await rows(client, "monthly_sales", MonthlySalesSchema, projectId, datasetVersionId);
  const stockSnapshots = await rows(client, "stock_snapshots", StockSnapshotSchema, projectId, datasetVersionId);
  const inboundShipments = await rows(client, "inbound_shipments", InboundShipmentSchema, projectId, datasetVersionId);
  const stockoutIntervals = await rows(client, "stockout_intervals", StockoutIntervalSchema, projectId, datasetVersionId);
  const categoryPolicies = await rows(client, "category_policies", CategoryPolicySchema, projectId, datasetVersionId);
  const growthAssumptions = await rows(client, "growth_assumptions", GrowthAssumptionSchema, projectId, datasetVersionId);
  const supplierLeadTimes = await rows(client, "supplier_lead_times", SupplierLeadTimeSchema, projectId, datasetVersionId);
  const seasonalityIndices = await rows(client, "seasonality_indices", SeasonalityIndexSchema, projectId, datasetVersionId);
  return { version, products, warehouses, suppliers, productSuppliers, sales, monthlySales,
    stockSnapshots, inboundShipments, stockoutIntervals, categoryPolicies, growthAssumptions,
    supplierLeadTimes, seasonalityIndices };
}

async function appendEvent(client: PoolClient, run: Record<string, unknown>,
  eventType: "stage_started" | "stage_completed" | "stage_failed" | "completed" | "cancelled",
  stage: CalculationStage | null, code: string | null): Promise<void> {
  const sequence = await client.query("SELECT COALESCE(MAX(sequence_no),0)+1 AS next FROM run_events WHERE run_id=$1", [run.id]);
  await client.query(`INSERT INTO run_events(id,project_id,run_id,sequence_no,event_type,safe_payload)
    VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [randomUUID(), run.project_id, run.id, sequence.rows[0].next, eventType,
    JSON.stringify({ stage, safeCode: code })]);
}

async function lockedRun(client: PoolClient, runId: string): Promise<Record<string, unknown>> {
  const result = await client.query(`SELECT r.* FROM calculation_runs r
    JOIN projects p ON p.id=r.project_id AND p.owner_user_id=r.requested_by
    WHERE r.id=$1 AND p.archived_at IS NULL FOR UPDATE OF r,p`, [runId]);
  if (!result.rowCount) throw new CalculationExecutionError("not_found");
  return result.rows[0];
}

function stageStates(row: Record<string, unknown>): Partial<Record<CalculationStage, StageState>> {
  return z.partialRecord(CalculationStageSchema, StageStateSchema).parse(row.stage_states);
}

/** Only this repository changes worker-owned run state. Every transition locks the run row. */
export function createCalculationExecutionRepository(pool: Pool) {
  return {
    async loadRunForExecution(input: CalculationPayload) {
      const payload = PayloadSchema.parse(input);
      return transaction(pool, async (client) => {
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const result = await client.query(`SELECT r.*, i.status AS import_status FROM calculation_runs r
          JOIN projects p ON p.id=r.project_id AND p.owner_user_id=r.requested_by AND p.archived_at IS NULL
          JOIN dataset_versions d ON d.id=r.dataset_version_id AND d.project_id=r.project_id
          JOIN imports i ON i.id=d.import_id AND i.project_id=r.project_id
          WHERE r.id=$1 AND r.project_id=$2 AND r.dataset_version_id=$3 AND r.requested_by=$4`,
        [payload.runId, payload.projectId, payload.datasetVersionId, payload.requestedBy]);
        if (!result.rowCount || result.rows[0].import_status !== "ready") throw new CalculationExecutionError("not_found");
        const run = result.rows[0] as Record<string, unknown>;
        if (run.status === "cancelled" || run.status === "failed" || run.status === "succeeded") {
          return { kind: "terminal" as const, status: run.status as "cancelled" | "failed" | "succeeded" };
        }
        if (run.algorithm_version !== SUPPORTED_CALCULATION_ALGORITHM_VERSION) {
          return { kind: "unsupported_algorithm" as const };
        }
        try {
          const configuration = RunConfigurationSchema.parse(run.configuration);
          const { policies } = z.object({ policies: CalculationPoliciesSchema }).parse(run.configuration);
          if (run.algorithm_version !== configuration.algorithmVersion || pgDate(run.as_of_date) !== configuration.asOfDate ||
            canonicalJsonHash(run.scope) !== canonicalJsonHash(configuration.scope) ||
            run.configuration_hash !== canonicalJsonHash(run.configuration) ||
            run.request_hash !== runRequestHash({ projectId: payload.projectId, datasetVersionId: payload.datasetVersionId,
              scope: run.scope, asOfDate: pgDate(run.as_of_date), configuration: run.configuration,
              algorithmVersion: String(run.algorithm_version), runMode: RunModeSchema.parse(run.run_mode) })) {
            return { kind: "invalid_snapshot" as const };
          }
          return { kind: "ready" as const, configuration: { run: configuration, policies },
            dataset: await dataset(client, payload.projectId, payload.datasetVersionId) };
        } catch (error) {
          if (error instanceof z.ZodError || error instanceof CalculationExecutionError) {
            return { kind: "invalid_snapshot" as const };
          }
          throw error;
        }
      });
    },

    async beginStage(runId: string, stage: CalculationStage): Promise<"started" | "already_completed" | "terminal"> {
      UuidSchema.parse(runId); CalculationStageSchema.parse(stage);
      if (stage === "explain") throw new CalculationExecutionError("invalid_state");
      return transaction(pool, async (client) => {
        const run = await lockedRun(client, runId);
        if (run.status === "cancelled" || run.status === "failed" || run.status === "succeeded") return "terminal";
        const states = stageStates(run);
        if (states[stage]?.status === "succeeded") return "already_completed";
        const previous = orderedStages[orderedStages.indexOf(stage) - 1];
        if (previous && states[previous]?.status !== "succeeded") throw new CalculationExecutionError("invalid_state");
        if (states[stage]?.status === "running") return "started";
        const now = new Date().toISOString();
        states[stage] = { status: "running", startedAt: now, completedAt: null, safeErrorCode: null };
        const version = Number(run.state_version) + 1;
        await client.query(`UPDATE calculation_runs SET status='running',stage=$2,stage_states=$3::jsonb,
          started_at=COALESCE(started_at,$4),state_version=$5 WHERE id=$1`,
        [runId, stage, JSON.stringify(states), now, version]);
        await appendEvent(client, run, "stage_started", stage, null);
        return "started";
      });
    },

    async finishStage(runId: string, stage: "validate" | "forecast"): Promise<"completed" | "already_completed" | "terminal"> {
      UuidSchema.parse(runId);
      return transaction(pool, async (client) => {
        const run = await lockedRun(client, runId);
        if (run.status !== "running") return "terminal";
        const states = stageStates(run);
        if (states[stage]?.status === "succeeded") return "already_completed";
        if (run.stage !== stage || states[stage]?.status !== "running") throw new CalculationExecutionError("invalid_state");
        states[stage] = { ...states[stage], status: "succeeded", completedAt: new Date().toISOString() };
        const version = Number(run.state_version) + 1;
        await client.query("UPDATE calculation_runs SET stage_states=$2::jsonb,state_version=$3 WHERE id=$1",
          [runId, JSON.stringify(states), version]);
        await appendEvent(client, run, "stage_completed", stage, null);
        return "completed";
      });
    },

    async completeCalculation(runId: string, resultInput: ReplenishmentResult): Promise<"completed" | "already_completed" | "terminal"> {
      UuidSchema.parse(runId);
      const result = ReplenishmentResultSchema.parse(resultInput);
      return transaction(pool, async (client) => {
        const run = await lockedRun(client, runId);
        if (run.status === "succeeded") return "already_completed";
        if (run.status !== "running") return "terminal";
        const states = stageStates(run);
        if (run.stage !== "recommend" || states.validate?.status !== "succeeded" ||
          states.forecast?.status !== "succeeded" || states.recommend?.status !== "running") throw new CalculationExecutionError("invalid_state");
        if (result.datasetVersionId !== run.dataset_version_id || result.asOfDate !== pgDate(run.as_of_date) ||
          result.calculationVersion !== run.algorithm_version) throw new CalculationExecutionError("invalid_result");
        if (run.run_mode === "full" && result.coverage.coverageGate !== "complete") {
          throw new CalculationExecutionError("coverage_incomplete");
        }
        const lines = result.supplierGroups.flatMap((group) => group.lines);
        if (run.run_mode === "full" && lines.some((line) => line.quantityStatus !== "known")) {
          throw new CalculationExecutionError("coverage_incomplete");
        }
        for (const line of lines) {
          await client.query(`INSERT INTO recommendations(id,project_id,dataset_version_id,run_id,product_id,warehouse_id,supplier_id,
            calculation_version,supplier_article,projected_stockout_date,shortage_days,recommended_quantity,
            quantity_status,unit,urgency,numeric_factors,data_quality,rationale,evidence,warnings)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19::jsonb,$20::jsonb)`,
          [randomUUID(), run.project_id, run.dataset_version_id, runId, line.productId, line.warehouseId,
            line.supplierId, line.calculationVersion, line.supplierArticle, line.projectedStockoutDate,
            line.shortageDays, line.recommendedQty, line.quantityStatus, line.unit, line.urgency,
            JSON.stringify(line.numericFactors), line.dataQuality, line.rationale, JSON.stringify(line.evidence),
            JSON.stringify(line.warnings)]);
        }
        const now = new Date().toISOString();
        states.recommend = { ...states.recommend, status: "succeeded", completedAt: now };
        states.explain = { status: "skipped", startedAt: null, completedAt: now, safeErrorCode: null };
        const version = Number(run.state_version) + 1;
        await client.query(`UPDATE calculation_runs SET status='succeeded',stage='explain',stage_states=$2::jsonb,
          coverage_gate=$3,blocking_reasons=$4::jsonb,warnings=$5::jsonb,result_version=$6,
          explanation_status='not_requested',finished_at=$7,state_version=$6 WHERE id=$1`,
        [runId, JSON.stringify(states), result.coverage.coverageGate,
          JSON.stringify(result.coverage.blockingReasons), JSON.stringify(result.warnings), version, now]);
        await appendEvent(client, run, "completed", null, null);
        return "completed";
      });
    },

    async failRun(runId: string, code: string): Promise<"failed" | "terminal"> {
      UuidSchema.parse(runId);
      if (!safeCode.test(code)) throw new TypeError("Неверный безопасный код ошибки");
      return transaction(pool, async (client) => {
        const run = await lockedRun(client, runId);
        if (run.status !== "queued" && run.status !== "running") return "terminal";
        const states = stageStates(run);
        const stage = run.stage === null ? null : CalculationStageSchema.parse(run.stage);
        const now = new Date().toISOString();
        if (stage && states[stage]?.status === "running") {
          states[stage] = { ...states[stage], status: "failed", completedAt: now, safeErrorCode: code };
        }
        const version = Number(run.state_version) + 1;
        const reasons = Array.isArray(run.blocking_reasons) && run.blocking_reasons.length > 0
          ? run.blocking_reasons : ["run_failed"];
        await client.query(`UPDATE calculation_runs SET status='failed',stage_states=$2::jsonb,
          safe_error=$3,finished_at=$4,state_version=$5,blocking_reasons=$6::jsonb,coverage_gate='incomplete' WHERE id=$1`,
        [runId, JSON.stringify(states), code, now, version, JSON.stringify(reasons)]);
        if (stage) await appendEvent(client, run, "stage_failed", stage, code);
        return "failed";
      });
    },

    async cancelCalculationRun(input: { runId: string; requestedBy: string }): Promise<
      { kind: "cancelled" | "already_cancelled" | "conflict"; projectId: string; triggerRunId: string | null; stateVersion: number } | { kind: "not_found" }
    > {
      UuidSchema.parse(input.runId);
      if (!input.requestedBy) return { kind: "not_found" };
      return transaction(pool, async (client) => {
        const result = await client.query(`SELECT r.* FROM calculation_runs r JOIN projects p ON p.id=r.project_id
          WHERE r.id=$1 AND p.owner_user_id=$2 AND p.archived_at IS NULL FOR UPDATE OF r,p`, [input.runId, input.requestedBy]);
        if (!result.rowCount) return { kind: "not_found" };
        const run = result.rows[0] as Record<string, unknown>;
        const common = { projectId: String(run.project_id), triggerRunId: run.trigger_run_id === null ? null : String(run.trigger_run_id),
          stateVersion: Number(run.state_version) };
        if (run.status === "cancelled") return { kind: "already_cancelled", ...common };
        if (run.status === "succeeded" || run.status === "failed") return { kind: "conflict", ...common };
        const states = stageStates(run);
        const stage = run.stage === null ? null : CalculationStageSchema.parse(run.stage);
        const now = new Date().toISOString();
        if (stage && states[stage]?.status === "running") {
          states[stage] = { ...states[stage], status: "skipped", completedAt: now };
        }
        const version = Number(run.state_version) + 1;
        const reasons = Array.isArray(run.blocking_reasons) && run.blocking_reasons.length > 0
          ? run.blocking_reasons : ["run_failed"];
        await client.query(`UPDATE calculation_runs SET status='cancelled',stage_states=$2::jsonb,
          finished_at=$3,state_version=$4,blocking_reasons=$5::jsonb,coverage_gate='incomplete' WHERE id=$1`,
        [input.runId, JSON.stringify(states), now, version, JSON.stringify(reasons)]);
        await appendEvent(client, run, "cancelled", null, null);
        return { kind: "cancelled", ...common, stateVersion: version };
      });
    },
  };
}
