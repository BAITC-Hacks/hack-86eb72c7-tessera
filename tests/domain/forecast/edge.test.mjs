import "../load-typescript.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { CalculationPoliciesSchema, ForecastResultSchema } = await import("../../../lib/contracts/calculation.ts");
const { GrowthAssumptionSchema } = await import("../../../lib/contracts/datasets.ts");
const { forecastDemand } = await import("../../../lib/domain/forecast/index.ts");
const { buildModel } = await import("../../../lib/domain/forecast/model.ts");
const { calendarU } = await import("../../../lib/domain/forecast/math.ts");
const { makeConfiguration, makeDataset, scope } = await import("../../fixtures/forecast/index.mjs");

function runForecast(dataset, configuration = makeConfiguration({ runMode: "diagnostic", seasonalityMode: "none", historicalWindowMonths: 6 }), selectedScope = scope) {
  return ForecastResultSchema.parse(forecastDemand(dataset, selectedScope, configuration));
}

function near(actual, expected, tolerance = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

function withGrowth(growthRate = "20") {
  const dataset = makeDataset({ startDate: "2025-03-01", endDate: "2025-08-31" });
  const growth = GrowthAssumptionSchema.parse({
    id: "90000000-0000-4000-8000-000000000001",
    projectId: dataset.version.projectId,
    datasetVersionId: dataset.version.id,
    categoryKey: dataset.products[0].categoryKey,
    effectiveFrom: "2025-01-01",
    growthRate,
    method: "provided",
    provenance: "synthetic",
  });
  dataset.growthAssumptions = [growth];
  dataset.version.sourceCompleteness = dataset.version.sourceCompleteness.map((entry) =>
    entry.sourceType === "growth"
      ? { ...entry, status: "complete", rowCount: 1, reasonCode: null, confirmedByUserId: null, confirmationReason: null }
      : entry,
  );
  return { dataset, growth };
}

function growthConfiguration(growth, options = {}) {
  const { growthMode = "replace", valueKind = "percent", period = "month", independentIncrementConfirmed = false } = options;
  return makeConfiguration({ runMode: "diagnostic", growthMode, seasonalityMode: "none" }, {
    growthSemanticsByAssumption: [{ growthAssumptionId: growth.id, valueKind, period, independentIncrementConfirmed }],
  });
}

test("внешний рост требует явной семантики; отсутствие не превращается в none", () => {
  const { dataset } = withGrowth();
  const result = runForecast(dataset, makeConfiguration({ runMode: "diagnostic", growthMode: "replace" }));
  assert.ok(result.warnings.some((warning) => warning.code === "growth_semantics_unconfirmed"));
  assert.equal(result.coverage.coverageGate, "incomplete");
  assert.equal(result.coverage.canApprove, false);
  assert.ok(result.series.every((series) => series.model === null || series.model.externalMonthlyFactor === null));
});

test("проценты, доля и множитель переводятся в месячный рост только явно", () => {
  for (const [growthRate, valueKind] of [["20", "percent"], ["0.2", "fractional_rate"], ["1.2", "multiplier"]]) {
    const { dataset, growth } = withGrowth(growthRate);
    const result = runForecast(dataset, growthConfiguration(growth, { valueKind }));
    assert.equal(result.series[0].status, "known");
    near(Number(result.series[0].model.externalMonthlyFactor), 1.2);
  }
  const { dataset, growth } = withGrowth("1.44");
  const result = runForecast(dataset, growthConfiguration(growth, { valueKind: "multiplier", period: "year" }));
  near(Number(result.series[0].model.externalMonthlyFactor), 1.44 ** (1 / 12));
});

test("incremental разрешён только при подтверждённом отдельном приросте", () => {
  const { dataset, growth } = withGrowth();
  const rejected = runForecast(dataset, growthConfiguration(growth, { growthMode: "incremental" }));
  assert.ok(rejected.warnings.some((warning) => warning.code === "growth_semantics_unconfirmed"));
  assert.equal(rejected.coverage.canApprove, false);
  const confirmed = runForecast(dataset, growthConfiguration(growth, {
    growthMode: "incremental", independentIncrementConfirmed: true,
  }));
  assert.equal(confirmed.series[0].model.growthMode, "incremental");
  near(Number(confirmed.series[0].model.externalMonthlyFactor), 1.2);
});

test("нулевой внешний множитель не становится допустимым прогнозом", () => {
  const { dataset, growth } = withGrowth("0");
  const result = runForecast(dataset, growthConfiguration(growth, { valueKind: "multiplier" }));
  assert.equal(result.coverage.canApprove, false);
  assert.ok(result.warnings.some((warning) => warning.code === "growth_semantics_unconfirmed"));
  assert.ok(result.series.every((series) => series.model?.externalMonthlyFactor !== "0"));
});

test("исторический перенос базы одинаков для replace и incremental", () => {
  const { dataset, growth } = withGrowth();
  const history = {
    days: [],
    months: [10, 11, 12, 13.31, 14.641, 16.1051].map((dailyMean, index) => ({
      month: `2025-${String(index + 3).padStart(2, "0")}-01`, dailyMean, full: true,
    })),
    historyStart: "2025-03-01",
    rawSalesQty: 1000, excludedOutlierQty: 0, stockoutCompensationQty: 0,
    outlierExclusions: [], stockoutAdjustments: [], customerAnomalyAvailable: true,
    warnings: [], unavailableReason: null,
  };
  const models = ["replace", "incremental"].map((growthMode) => buildModel(
    history, dataset, dataset.products[0], growthConfiguration(growth, {
      growthMode, independentIncrementConfirmed: true,
    }),
  ).model);
  assert.ok(models.every(Boolean));
  const expected = 14.641 * 1.1 ** (calendarU("2025-09-01") - (calendarU("2025-07-01") + 0.5));
  near(Number(models[0].baseAtStart), expected);
  assert.equal(models[0].baseAtStart, models[1].baseAtStart);
  near(Number(models[0].trendMonthlyFactor), 1.1);
});

test("неполный сентябрь виден в фактах, но не меняет базу и тренд полных месяцев", () => {
  const dataset = makeDataset({
    startDate: "2025-03-01", endDate: "2025-09-15",
    quantityForDay: (date) => date >= "2025-09-01" ? 100 : 10,
  });
  const result = runForecast(dataset, makeConfiguration({
    runMode: "diagnostic", asOfDate: "2025-09-15", seasonalityMode: "none",
    incompleteMonthPolicy: "exclude",
  }));
  const series = result.series[0];
  assert.equal(series.status, "known");
  assert.equal(series.model.startDate, "2025-09-16");
  near(Number(series.evidence.baseAnchor), 10);
  near(Number(series.model.trendMonthlyFactor), 1);
  assert.ok(Number(series.evidence.rawSalesQty) >= 1500);
  assert.ok(result.warnings.some((warning) => warning.code === "incomplete_month_excluded"));
});

test("короткая история не создаёт выдуманный полный прогноз", () => {
  const result = runForecast(makeDataset({ startDate: "2025-08-25", endDate: "2025-08-31" }));
  assert.ok(result.warnings.some((warning) => warning.code === "short_history" || warning.code === "trend_insufficient_evidence"));
  assert.equal(result.coverage.canApprove, false);
  assert.equal(result.series[0].status, "unavailable");
  assert.equal(result.series[0].model, null);
});

test("нет клиента: доступность аномалий unavailable, а не подмена документом", () => {
  const dataset = makeDataset({ startDate: "2025-03-01", endDate: "2025-08-31" });
  dataset.sales = dataset.sales.map((sale) => ({ ...sale, anonymousCustomerKey: null, customerKeyAvailable: false }));
  const result = runForecast(dataset);
  assert.equal(result.coverage.customerAnomalyCoverage, "unavailable");
  assert.equal(result.coverage.coverageGate, "incomplete");
  assert.equal(result.coverage.canApprove, false);
  assert.ok(result.warnings.some((warning) => warning.code === "customer_anomaly_unavailable"));
});

test("пропущенный источник stockout явно блокирует полноту diagnostic", () => {
  const dataset = makeDataset({ startDate: "2025-03-01", endDate: "2025-08-31" });
  dataset.version.sourceCompleteness = dataset.version.sourceCompleteness.map((entry) =>
    entry.sourceType === "stockouts" ? {
      ...entry, status: "missing", rowCount: null, reasonCode: "not_supplied",
      confirmedByUserId: null, confirmationReason: null,
    } : entry,
  );
  const result = runForecast(dataset);
  assert.equal(result.coverage.coverageGate, "incomplete");
  assert.equal(result.coverage.canApprove, false);
  assert.ok(result.coverage.blockingReasons.includes("missing_source"));
});

test("неподтверждённая экспозиция не заполняет пропуски нулями", () => {
  const dataset = makeDataset({ startDate: "2025-03-01", endDate: "2025-08-31" });
  dataset.version.manifest = dataset.version.manifest.map((entry) => {
    const copy = { ...entry };
    delete copy.importMetadata;
    return copy;
  });
  const result = runForecast(dataset);
  assert.equal(result.coverage.canApprove, false);
  assert.equal(result.coverage.coverageGate, "incomplete");
});

test("конфигурация отклоняет отрицательный cap и повтор семантики роста", () => {
  const configuration = makeConfiguration();
  assert.throws(() => CalculationPoliciesSchema.parse({
    ...configuration.policies,
    trendCapsByCategory: [{ categoryKey: "test", maxMonthlyTrendFactor: "-1" }],
  }));
  const semantic = {
    growthAssumptionId: "90000000-0000-4000-8000-000000000001",
    valueKind: "percent", period: "month", independentIncrementConfirmed: false,
  };
  assert.throws(() => CalculationPoliciesSchema.parse({
    ...configuration.policies, growthSemanticsByAssumption: [semantic, semantic],
  }));
  assert.throws(() => forecastDemand(makeDataset({ startDate: "2025-03-01", endDate: "2025-08-31" }), scope, makeConfiguration({ minComparableWeeks: 1 })));
});

test("forecastDemand не изменяет входной набор и конфигурацию", () => {
  const dataset = makeDataset({ startDate: "2025-03-01", endDate: "2025-08-31" });
  const configuration = makeConfiguration({ runMode: "diagnostic", seasonalityMode: "none", historicalWindowMonths: 6 });
  const before = JSON.stringify({ dataset, configuration });
  const first = runForecast(dataset, configuration);
  const second = runForecast(dataset, configuration);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify({ dataset, configuration }), before);
});

test("режим full не позволяет утверждение при пропущенном обязательном источнике", () => {
  const dataset = makeDataset({ startDate: "2025-03-01", endDate: "2025-08-31" });
  dataset.version.sourceCompleteness = dataset.version.sourceCompleteness.map((entry) =>
    entry.sourceType === "growth" ? {
      ...entry, status: "missing", rowCount: null, reasonCode: "not_supplied",
      confirmedByUserId: null, confirmationReason: null,
    } : entry,
  );
  const result = runForecast(dataset, makeConfiguration({ runMode: "full", historicalWindowMonths: 6, seasonalityMode: "none" }));
  assert.equal(result.coverage.coverageGate, "incomplete");
  assert.equal(result.coverage.canApprove, false);
  assert.ok(result.coverage.blockingReasons.includes("missing_source"));
  assert.ok(result.warnings.some((warning) => warning.code === "growth_source_missing"));
});

test("scope проверяется против снимка, неизвестных складов и повторов", () => {
  const dataset = makeDataset({ startDate: "2025-03-01", endDate: "2025-08-31" });
  const selected = { warehouseIds: [dataset.warehouses[0].id], categoryIds: [] };
  assert.throws(() => forecastDemand(dataset, selected, makeConfiguration()));
  const unknown = { warehouseIds: ["90000000-0000-4000-8000-000000000099"], categoryIds: [] };
  assert.throws(() => forecastDemand(dataset, unknown, makeConfiguration({ scope: unknown })));
  const duplicate = { warehouseIds: [dataset.warehouses[0].id, dataset.warehouses[0].id], categoryIds: [] };
  assert.throws(() => forecastDemand(dataset, duplicate, makeConfiguration({ scope: duplicate })));
});

test("отрицательное сырое предположение роста отклоняется границей DTO", () => {
  const { dataset, growth } = withGrowth();
  dataset.growthAssumptions = [{ ...growth, growthRate: "-0.2" }];
  assert.throws(() => forecastDemand(dataset, scope, growthConfiguration(growth)));
});

test("полный подтверждённый набор допускает full, diagnostic не допускает утверждение", () => {
  const dataset = makeDataset({ startDate: "2025-03-01", endDate: "2025-08-31" });
  const full = runForecast(dataset, makeConfiguration({
    runMode: "full", historicalWindowMonths: 6, seasonalityMode: "none",
  }));
  assert.equal(full.coverage.coverageGate, "complete");
  assert.equal(full.coverage.canApprove, true);
  assert.equal(full.coverage.customerAnomalyCoverage, "available");
  const diagnostic = runForecast(dataset);
  assert.equal(diagnostic.coverage.coverageGate, "complete");
  assert.equal(diagnostic.coverage.canApprove, false);
});

test("ложный explicit_none с реальными строками не скрывает invalid_source", () => {
  const { dataset } = withGrowth();
  dataset.version.sourceCompleteness = dataset.version.sourceCompleteness.map((entry) =>
    entry.sourceType === "growth" ? {
      ...entry, status: "explicit_none", rowCount: 0, reasonCode: null,
      confirmedByUserId: "synthetic-user", confirmationReason: "Синтетическая проверка противоречия",
    } : entry,
  );
  const result = runForecast(dataset);
  assert.equal(result.coverage.coverageGate, "incomplete");
  assert.equal(result.coverage.canApprove, false);
  assert.ok(result.coverage.blockingReasons.includes("invalid_source"));
});
