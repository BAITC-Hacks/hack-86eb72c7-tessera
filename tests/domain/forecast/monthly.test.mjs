import "../load-typescript.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { ForecastResultSchema } = await import("../../../lib/contracts/calculation.ts");
const { forecastDemand } = await import("../../../lib/domain/forecast/index.ts");
const { daysInMonth } = await import("../../../lib/domain/forecast/math.ts");
const { makeDataset, makeConfiguration, scope, uuid } = await import("../../fixtures/forecast/index.mjs");

function monthlyDataset() {
  const dataset = makeDataset();
  dataset.version.manifest[0].importMetadata.forecastBasis = "monthly";
  dataset.monthlySales = Array.from({ length: 8 }, (_, index) => {
    const periodMonth = `2025-${String(index + 1).padStart(2, "0")}-01`;
    const sale = dataset.sales[0];
    return {
      id: uuid(800_000 + index), projectId: sale.projectId, datasetVersionId: sale.datasetVersionId,
      productId: sale.productId, warehouseId: sale.warehouseId, sourceObjectId: sale.sourceObjectId,
      sourceSheet: "monthly", sourceRowNumber: index + 1,
      periodMonth, granularity: "month", quantity: String(10 * daysInMonth(periodMonth)),
      unit: "pcs", completeness: "complete", origin: "synthetic", methodVersion: "v1",
    };
  });
  dataset.version.sourceCompleteness = dataset.version.sourceCompleteness.map((source) => source.sourceType === "monthly_sales"
    ? { ...source, status: "complete", rowCount: 8, confirmedByUserId: null, confirmationReason: null }
    : source);
  return dataset;
}

test("месячная база не суммируется с дублирующими транзакциями", () => {
  const dataset = monthlyDataset();
  dataset.sales = dataset.sales.map((sale) => ({ ...sale, quantity: "9999" }));
  const result = ForecastResultSchema.parse(forecastDemand(dataset, scope, makeConfiguration({ seasonalityMode: "none" })));
  assert.equal(result.series[0].status, "known");
  assert.equal(result.series[0].model.baseAtStart, "10");
  assert.equal(result.coverage.customerAnomalyCoverage, "unavailable");
  assert.equal(result.coverage.canApprove, false);
});

test("неизвестный месячный объём не подменяется нулём", () => {
  const dataset = monthlyDataset();
  dataset.monthlySales.at(-1).quantity = null;
  dataset.monthlySales.at(-1).completeness = "missing";
  const result = ForecastResultSchema.parse(forecastDemand(dataset, scope, makeConfiguration({ seasonalityMode: "none" })));
  assert.equal(result.coverage.canApprove, false);
  assert.ok(result.warnings.some((warning) => warning.code === "incomplete_month_excluded"));
  assert.ok(result.series[0].model === null || result.series[0].model.baseAtStart === "10");
});
