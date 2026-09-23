import {
  CalculationPoliciesSchema, ForecastResultSchema,
  type CalculationDataset, type CalculationWarning, type ForecastDemand, type ForecastSeries,
} from "../../contracts/calculation";
import {
  CategoryPolicySchema, DatasetVersionSchema, GrowthAssumptionSchema, InboundShipmentSchema,
  MonthlySalesSchema, ProductSchema, ProductSupplierSchema, SaleSchema, SeasonalityIndexSchema,
  StockoutIntervalSchema, StockSnapshotSchema, SupplierLeadTimeSchema, SupplierSchema, WarehouseSchema,
} from "../../contracts/datasets";
import { CalculationScopeSchema, RunConfigurationSchema } from "../../contracts/runs";
import { calculateCoverage, warningSeverity } from "./coverage";
import { decimal } from "./math";
import { buildModel } from "./model";
import { prepareSeries } from "./prepare";
import type { ModelResult } from "./types";

export { sumDailyForecast } from "./evaluate";
export { calendarU } from "./math";

function validateDataset(dataset: CalculationDataset): void {
  DatasetVersionSchema.parse(dataset.version);
  const groups = [
    [dataset.products, ProductSchema], [dataset.warehouses, WarehouseSchema],
    [dataset.suppliers, SupplierSchema], [dataset.productSuppliers, ProductSupplierSchema],
    [dataset.sales, SaleSchema], [dataset.monthlySales, MonthlySalesSchema],
    [dataset.stockSnapshots, StockSnapshotSchema], [dataset.inboundShipments, InboundShipmentSchema],
    [dataset.stockoutIntervals, StockoutIntervalSchema], [dataset.categoryPolicies, CategoryPolicySchema],
    [dataset.growthAssumptions, GrowthAssumptionSchema], [dataset.supplierLeadTimes, SupplierLeadTimeSchema],
    [dataset.seasonalityIndices, SeasonalityIndexSchema],
  ] as const;
  for (const [rows, schema] of groups) {
    for (const row of rows) {
      schema.parse(row);
      if (row.projectId !== dataset.version.projectId || row.datasetVersionId !== dataset.version.id) {
        throw new Error("Строка не принадлежит выбранной версии данных");
      }
    }
  }
  for (const rows of [dataset.products, dataset.warehouses]) {
    if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("Повтор справочной записи набора");
  }
  const productIds = new Set(dataset.products.map((product) => product.id));
  const warehouseIds = new Set(dataset.warehouses.map((warehouse) => warehouse.id));
  for (const rows of [dataset.sales, dataset.monthlySales, dataset.stockSnapshots, dataset.inboundShipments, dataset.stockoutIntervals]) {
    for (const row of rows) {
      if (!productIds.has(row.productId) || !warehouseIds.has(row.warehouseId)) {
        throw new Error("Наблюдение содержит неизвестный товар или склад");
      }
    }
  }
}

function equalSets(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

/** Чистая точка входа 07: без времени, сети, случайности и изменения входного снимка. */
export const forecastDemand: ForecastDemand = (dataset, scope, configuration) => {
  const selectedScope = CalculationScopeSchema.parse(scope);
  const run = RunConfigurationSchema.parse(configuration.run);
  const policies = CalculationPoliciesSchema.parse(configuration.policies);
  if (!equalSets(selectedScope.warehouseIds, run.scope.warehouseIds) || !equalSets(selectedScope.categoryIds, run.scope.categoryIds)) {
    throw new Error("Область расчёта не совпадает со снимком конфигурации");
  }
  validateDataset(dataset);
  const warehouseIds = new Set(dataset.warehouses.map((warehouse) => warehouse.id));
  const categoryIds = new Set(dataset.products.map((product) => product.categoryKey));
  if (selectedScope.warehouseIds.some((id) => !warehouseIds.has(id)) || selectedScope.categoryIds.some((id) => !categoryIds.has(id))) {
    throw new Error("Область расчёта содержит неизвестный склад или категорию");
  }
  const products = dataset.products.filter((product) => selectedScope.categoryIds.length === 0 || selectedScope.categoryIds.includes(product.categoryKey))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const warehouses = dataset.warehouses.filter((warehouse) => selectedScope.warehouseIds.length === 0 || selectedScope.warehouseIds.includes(warehouse.id))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  if (products.length * warehouses.length > 100_000) throw new Error("Область расчёта превышает предел числа рядов");

  const snapshot = { run, policies };
  const series: ForecastSeries[] = [];
  const warnings: CalculationWarning[] = [];
  let customerAnomalyAvailable = products.length > 0 && warehouses.length > 0;
  for (const product of products) {
    for (const warehouse of warehouses) {
      const key = { productId: product.id, warehouseId: warehouse.id };
      const history = prepareSeries(dataset, product, warehouse.id, snapshot);
      customerAnomalyAvailable &&= history.customerAnomalyAvailable;
      const modelResult: ModelResult = history.unavailableReason === null
        ? buildModel(history, dataset, product, snapshot)
        : {
          model: null, baseAnchor: null,
          seasonality: { source: "none_fallback", fullCyclesUsed: 0 },
          trend: { status: "insufficient_evidence", recentMedian: null, priorMedian: null, confirmingPairs: 0 },
          warnings: [], unavailableReason: history.unavailableReason,
        };
      const codes = new Set([...history.warnings, ...modelResult.warnings]);
      if (!history.customerAnomalyAvailable) codes.add("customer_anomaly_unavailable");
      if (modelResult.model === null) codes.add("forecast_unavailable");
      for (const code of [...codes].sort()) warnings.push({ code, severity: warningSeverity(code), key });
      series.push({
        key, categoryKey: product.categoryKey, unit: product.unit,
        status: modelResult.model === null ? "unavailable" : "known",
        unavailableReason: modelResult.model === null ? modelResult.unavailableReason ?? "insufficient_history" : null,
        model: modelResult.model,
        evidence: {
          historyStart: history.historyStart, historyEnd: run.asOfDate,
          rawSalesQty: decimal(history.rawSalesQty), excludedOutlierQty: decimal(history.excludedOutlierQty),
          stockoutCompensationQty: decimal(history.stockoutCompensationQty), baseAnchor: modelResult.baseAnchor,
          seasonality: modelResult.seasonality, trend: modelResult.trend,
          outlierExclusions: history.outlierExclusions, stockoutAdjustments: history.stockoutAdjustments,
        },
      });
    }
  }
  return ForecastResultSchema.parse({
    datasetVersionId: dataset.version.id, asOfDate: run.asOfDate, algorithmVersion: run.algorithmVersion,
    series, warnings, coverage: calculateCoverage(dataset, snapshot, series, warnings, customerAnomalyAvailable),
  });
};
