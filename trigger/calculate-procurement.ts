import { task } from "@trigger.dev/sdk";
import { z } from "zod";
import { forecastDemand } from "../lib/domain/forecast";
import { calculateRecommendations } from "../lib/domain/replenishment";
import {
  CalculationExecutionError, createCalculationExecutionRepository,
  type CalculationPayload,
} from "../lib/server/calculation-execution";
import { getProjectDataPool } from "../lib/server/db/pool";

type Repository = ReturnType<typeof createCalculationExecutionRepository>;

function isTransientInfrastructureError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") return false;
  return /^(?:08|40|53|58)[A-Z0-9]{3}$/.test(error.code) ||
    ["55P03", "57P01", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"].includes(error.code);
}

/** Trigger may execute a run more than once; the repository owns all durable transitions. */
export async function executeCalculation(payload: CalculationPayload, repository: Repository) {
  let loaded: Awaited<ReturnType<Repository["loadRunForExecution"]>>;
  try {
    loaded = await repository.loadRunForExecution(payload);
  } catch (error) {
    // A forged payload must never make this worker fail or cancel a different run.
    if (error instanceof z.ZodError || error instanceof CalculationExecutionError && error.code === "not_found") {
      return { status: "rejected" as const };
    }
    throw error;
  }
  if (loaded.kind === "terminal") return { status: loaded.status };
  if (loaded.kind === "unsupported_algorithm" || loaded.kind === "invalid_snapshot") {
    await repository.failRun(payload.runId, loaded.kind);
    return { status: "failed" as const };
  }

  if (await repository.beginStage(payload.runId, "validate") === "terminal") return { status: "terminal" as const };
  if (await repository.finishStage(payload.runId, "validate") === "terminal") return { status: "terminal" as const };

  if (await repository.beginStage(payload.runId, "forecast") === "terminal") return { status: "terminal" as const };
  let forecast;
  try {
    forecast = forecastDemand(loaded.dataset, loaded.configuration.run.scope, loaded.configuration);
  } catch {
    await repository.failRun(payload.runId, "forecast_invalid");
    return { status: "failed" as const };
  }
  if (await repository.finishStage(payload.runId, "forecast") === "terminal") return { status: "terminal" as const };

  if (await repository.beginStage(payload.runId, "recommend") === "terminal") return { status: "terminal" as const };
  let result;
  try {
    result = calculateRecommendations(forecast, loaded.dataset.stockSnapshots, loaded.dataset.inboundShipments,
      { suppliers: loaded.dataset.suppliers, productSuppliers: loaded.dataset.productSuppliers,
        leadTimes: loaded.dataset.supplierLeadTimes }, loaded.dataset.categoryPolicies, loaded.configuration);
  } catch {
    await repository.failRun(payload.runId, "recommend_invalid");
    return { status: "failed" as const };
  }
  try {
    const completion = await repository.completeCalculation(payload.runId, result);
    return { status: completion === "completed" || completion === "already_completed" ? "succeeded" as const : "terminal" as const };
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof CalculationExecutionError &&
      (error.code === "coverage_incomplete" || error.code === "invalid_result")) {
      await repository.failRun(payload.runId, error instanceof z.ZodError ? "invalid_result" : error.code);
      return { status: "failed" as const };
    }
    throw error;
  }
}

export const calculateProcurement = task({
  id: "calculate-procurement",
  maxDuration: 600,
  queue: { concurrencyLimit: 2 },
  retry: { maxAttempts: 3, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000, factor: 2 },
  run: async (payload: CalculationPayload) => {
    try {
      return await executeCalculation(payload, createCalculationExecutionRepository(getProjectDataPool()));
    } catch (error) {
      // Trigger may persist thrown errors. Never expose raw SQL, rows, URLs or provider details.
      throw new Error(isTransientInfrastructureError(error) ? "transient_database"
        : error instanceof CalculationExecutionError && error.code === "invalid_state" ? "invalid_state" : "calculation_failed");
    }
  },
  catchError: ({ error }) => ({
    skipRetrying: !(error instanceof Error && error.message === "transient_database"),
    error: new Error(error instanceof Error ? error.message : "calculation_failed"),
  }),
  onFailure: async ({ payload, error }) => {
    // Called only after bounded retries. Revalidate all payload relationships before mutating DB.
    const repository = createCalculationExecutionRepository(getProjectDataPool());
    try {
      const loaded = await repository.loadRunForExecution(payload);
      if (loaded.kind === "ready" || loaded.kind === "unsupported_algorithm" || loaded.kind === "invalid_snapshot") {
        await repository.failRun(payload.runId,
          error instanceof Error && error.message === "transient_database" ? "transient_exhausted" : "calculation_failed");
      }
    } catch {
      // Infrastructure may still be unavailable; recovery/audit can inspect the durable running row.
    }
  },
});
