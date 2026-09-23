import { ReplenishmentResultSchema } from "../../../lib/contracts/calculation.ts";
import { calculateRecommendations } from "../../../lib/domain/replenishment/index.ts";

export const IDS = Object.freeze({
  project: "00000000-0000-4000-8000-000000000001",
  dataset: "00000000-0000-4000-8000-000000000002",
  product: "00000000-0000-4000-8000-000000000003",
  warehouse: "00000000-0000-4000-8000-000000000004",
  supplier: "00000000-0000-4000-8000-000000000005",
  source: "00000000-0000-4000-8000-000000000006",
});

/** Синтетический эталон: 10 дней × 10 + 2 дня × 10 − 30 − 40 = 50. */
export function makeFixture() {
  const asOfDate = "2026-01-01";
  const entity = { projectId: IDS.project, datasetVersionId: IDS.dataset };
  const key = { productId: IDS.product, warehouseId: IDS.warehouse };
  const provenance = { sourceObjectId: IDS.source, sourceSheet: "Синтетика", sourceRowNumber: 2 };
  return {
    forecast: {
      datasetVersionId: IDS.dataset,
      asOfDate,
      algorithmVersion: "synthetic-forecast-v1",
      series: [{
        key,
        categoryKey: "cables",
        unit: "m",
        status: "known",
        unavailableReason: null,
        model: {
          startDate: "2026-01-02",
          baseAtStart: "10",
          seasonalIndexByMonth: Array(12).fill("1"),
          trendMonthlyFactor: "1",
          growthMode: "none",
          externalMonthlyFactor: null,
        },
        evidence: {
          historyStart: "2025-01-01",
          historyEnd: asOfDate,
          rawSalesQty: "3650",
          excludedOutlierQty: "0",
          stockoutCompensationQty: "0",
          baseAnchor: "10",
          seasonality: { source: "provided", fullCyclesUsed: 1 },
          trend: { status: "not_confirmed", recentMedian: "10", priorMedian: "10", confirmingPairs: 0 },
          outlierExclusions: [],
          stockoutAdjustments: [],
        },
      }],
      warnings: [],
      coverage: { coverageGate: "complete", blockingReasons: [], customerAnomalyCoverage: "available", canApprove: true },
    },
    inventory: [{
      ...entity, ...key, ...provenance,
      id: "00000000-0000-4000-8000-000000000007",
      asOfDate, quantity: "30", unit: "m",
    }],
    inbound: [{
      ...entity, ...key, ...provenance,
      id: "00000000-0000-4000-8000-000000000008",
      sourceRowNumber: 3,
      expectedOn: "2026-01-03", quantity: "40", unit: "m",
      supplierId: IDS.supplier, sourceKey: "synthetic-shipment-1",
    }],
    supplierTerms: {
      suppliers: [{
        ...entity, id: IDS.supplier, sourceKey: "synthetic-supplier",
        name: "Синтетический поставщик", createdAt: "2026-01-01T00:00:00.000Z",
      }],
      productSuppliers: [{
        ...entity, id: "00000000-0000-4000-8000-000000000009",
        productId: IDS.product, supplierId: IDS.supplier, supplierSku: "000123",
        moq: null, packMultiple: null, conversion: null,
      }],
      leadTimes: [{
        ...entity, id: "00000000-0000-4000-8000-000000000010",
        supplierId: IDS.supplier, productId: IDS.product, categoryKey: null,
        days: 5, provenance: "synthetic",
      }],
    },
    categoryPolicies: [{
      ...entity, id: "00000000-0000-4000-8000-000000000011",
      categoryKey: "cables", reviewPeriodDays: 5, safetyStock: null,
      parameters: { reviewPeriodDays: 5, safetyStock: null, safetyDays: 2 },
      policyVersion: "synthetic-category-v1",
    }],
    configuration: {
      run: {
        runMode: "full",
        scope: { warehouseIds: [IDS.warehouse], categoryIds: ["cables"] },
        asOfDate, historicalWindowMonths: 12, minComparableWeeks: 8,
        outlierMadMultiplier: "3", outlierMedianMultiplier: "3", zeroMadMinimumUnit: "1",
        incompleteMonthPolicy: "exclude", growthMode: "none", seasonalityMode: "provided",
        reviewPeriodDays: 5,
        safetyDaysByCategory: [{ categoryKey: "cables", safetyDays: 2 }],
        leadTimePolicyVersion: "synthetic-lead-v1", unitPolicyVersion: "synthetic-unit-v1",
        algorithmVersion: "synthetic-replenishment-v1", parametersHash: "a".repeat(64),
      },
      policies: {
        growthSemanticsByAssumption: [],
        trendCapsByCategory: [{ categoryKey: "cables", maxMonthlyTrendFactor: "2" }],
        unitSteps: [{ productId: IDS.product, unit: "m", step: "1" }],
      },
    },
  };
}

/** Каждый вызов проверяет реальный публичный результат, без имитации расчётного ядра. */
export function calculate(fixture) {
  const { forecast, inventory, inbound, supplierTerms, categoryPolicies, configuration } = fixture;
  return ReplenishmentResultSchema.parse(calculateRecommendations(
    forecast, inventory, inbound, supplierTerms, categoryPolicies, configuration,
  ));
}
