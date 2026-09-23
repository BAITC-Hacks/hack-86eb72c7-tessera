import "../load-typescript.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { ForecastResultSchema, ReplenishmentResultSchema } = await import("../../../lib/contracts/calculation.ts");
const { forecastDemand, sumDailyForecast } = await import("../../../lib/domain/forecast/index.ts");
const { calculateRecommendations } = await import("../../../lib/domain/replenishment/index.ts");
const { addDays } = await import("../../../lib/domain/forecast/math.ts");
const { makeDataset, makeConfiguration, makeSale, makeStockout, ids, scope, uuid } = await import("../../fixtures/forecast/index.mjs");

function sourceStatus(dataset, sourceType, status, rowCount = null) {
  Object.assign(dataset.version.sourceCompleteness.find((source) => source.sourceType === sourceType), {
    status, rowCount, reasonCode: status === "missing" ? "not_supplied" : null,
    confirmedByUserId: status === "explicit_none" ? "synthetic-author" : null,
    confirmationReason: status === "explicit_none" ? "Источник явно отсутствует" : null,
  });
}

function fixture(options = {}) {
  const dataset = makeDataset({ startDate: "2025-01-01", ...options });
  dataset.stockSnapshots[0].quantity = "30";
  dataset.supplierLeadTimes[0].days = 5;
  const category = dataset.categoryPolicies[0];
  category.reviewPeriodDays = 5;
  category.parameters.reviewPeriodDays = 5;
  category.parameters.safetyDays = 2;
  const stock = dataset.stockSnapshots[0];
  dataset.inboundShipments = [{
    id: uuid(900_001), projectId: stock.projectId, datasetVersionId: stock.datasetVersionId,
    productId: stock.productId, warehouseId: stock.warehouseId, sourceObjectId: stock.sourceObjectId,
    sourceSheet: "inbound", sourceRowNumber: 1, expectedOn: "2025-09-02",
    quantity: "40", unit: stock.unit, supplierId: ids.supplier, sourceKey: "integration-inbound",
  }];
  sourceStatus(dataset, "inbound", "complete", 1);
  return {
    dataset,
    configuration: makeConfiguration({
      runMode: "full", seasonalityMode: "none", reviewPeriodDays: 5,
      safetyDaysByCategory: [{ categoryKey: ids.category, safetyDays: 2 }],
    }),
  };
}

function recommend(dataset, configuration, forecast) {
  return ReplenishmentResultSchema.parse(calculateRecommendations(
    forecast, dataset.stockSnapshots, dataset.inboundShipments,
    { suppliers: dataset.suppliers, productSuppliers: dataset.productSuppliers, leadTimes: dataset.supplierLeadTimes },
    dataset.categoryPolicies, configuration,
  ));
}

function pipeline(input) {
  const { dataset, configuration } = input;
  const forecast = ForecastResultSchema.parse(forecastDemand(dataset, scope, configuration));
  return { forecast, result: recommend(dataset, configuration, forecast) };
}

function line(output) {
  assert.equal(output.result.supplierGroups.length, 1);
  assert.equal(output.result.supplierGroups[0].lines.length, 1);
  return output.result.supplierGroups[0].lines[0];
}

function growth(input, { mode = "replace", confirmed = true, semantics = true, value = "1.2" } = {}) {
  const assumption = {
    id: uuid(900_002), projectId: ids.project, datasetVersionId: ids.version,
    categoryKey: ids.category, effectiveFrom: "2025-01-01", growthRate: value,
    method: "provided", provenance: "synthetic",
  };
  input.dataset.growthAssumptions = [assumption];
  sourceStatus(input.dataset, "growth", "complete", 1);
  input.configuration.run.growthMode = mode;
  input.configuration.policies.growthSemanticsByAssumption = semantics ? [{
    growthAssumptionId: assumption.id, valueKind: "multiplier", period: "month",
    independentIncrementConfirmed: confirmed,
  }] : [];
  return input;
}

test("07→08: реальная история даёт цепочку 100 + 20 − 30 − 40 = 50", () => {
  const input = fixture();
  const output = pipeline(input);
  const order = line(output);
  assert.equal(output.forecast.series[0].model.baseAtStart, "10");
  assert.equal(order.evidence.forecastDemandH, "100");
  assert.equal(order.evidence.safetyStock, "20");
  assert.equal(order.evidence.usableStock, "30");
  assert.equal(order.evidence.eligibleInbound, "40");
  assert.equal(order.recommendedQty, "50");
  assert.deepEqual(order.evidence.forecast, output.forecast.series[0].evidence);
  assert.equal(output.forecast.coverage.canApprove, true);
  assert.equal(output.result.coverage.canApprove, true);
  assert.match(order.rationale, /Прогноз/);
});

for (const [name, change, expected] of [
  ["продажи", (input) => { input.dataset.sales.forEach((sale) => { sale.quantity = "11"; }); }, "62"],
  ["свободный остаток", (input) => { input.dataset.stockSnapshots[0].quantity = "35"; }, "45"],
  ["путь", (input) => { input.dataset.inboundShipments[0].quantity = "45"; }, "45"],
  ["срок поставки", (input) => { input.dataset.supplierLeadTimes[0].days = 6; }, "60"],
  ["страховка категории", (input) => {
    input.dataset.categoryPolicies[0].parameters.safetyDays = 3;
    input.configuration.run.safetyDaysByCategory[0].safetyDays = 3;
  }, "60"],
  ["период пересмотра", (input) => {
    input.dataset.categoryPolicies[0].parameters.reviewPeriodDays = 6;
    input.dataset.categoryPolicies[0].reviewPeriodDays = 6;
    input.configuration.run.reviewPeriodDays = 6;
  }, "60"],
]) {
  test(`07→08: M1, ${name} меняет итог без подмены прогноза`, () => {
    const input = fixture();
    change(input);
    assert.equal(line(pipeline(input)).recommendedQty, expected);
  });
}

test("07→08: устойчивый тренд и подтверждённый внешний рост меняют заказ", () => {
  const input = fixture({ quantityForDay: (date) => 10 * 1.1 ** (Number(date.slice(5, 7)) - 1) });
  const trend = pipeline(input);
  assert.ok(Number(trend.forecast.series[0].model.trendMonthlyFactor) > 1);
  const replace = pipeline(growth(structuredClone(input)));
  const incremental = pipeline(growth(structuredClone(input), { mode: "incremental" }));
  assert.ok(Number(line(replace).recommendedQty) > Number(line(trend).recommendedQty));
  assert.ok(Number(line(incremental).recommendedQty) > Number(line(replace).recommendedQty));
  assert.equal(replace.forecast.series[0].model.baseAtStart, incremental.forecast.series[0].model.baseAtStart);
});

test("07→08: сезонность проходит до горизонта и страховки следующего месяца", () => {
  const input = fixture({ startDate: "2023-01-01", endDate: "2025-11-25", quantityForDay: (date) => date.slice(5, 7) === "12" ? 30 : 10 });
  input.configuration.run.asOfDate = "2025-11-25";
  input.configuration.run.seasonalityMode = "estimated";
  input.dataset.inboundShipments[0].expectedOn = "2025-11-27";
  const output = pipeline(input);
  const order = line(output);
  const model = output.forecast.series[0].model;
  assert.equal(model.startDate, "2025-11-26");
  assert.ok(Number(model.seasonalIndexByMonth[11]) > Number(model.seasonalIndexByMonth[10]));
  assert.ok(Math.abs(Number(order.evidence.forecastDemandH) - sumDailyForecast(model, "2025-11-26", "2025-12-05")) < 1e-7);
  assert.ok(Math.abs(Number(order.evidence.safetyStock) - sumDailyForecast(model, "2025-12-06", "2025-12-07")) < 1e-7);
});

test("07→08: M4, сто-кратный заказ в20документах не увеличивает закупку более5%", () => {
  const baseline = pipeline(fixture());
  const input = fixture();
  for (let index = 0; index < 20; index++) input.dataset.sales.push(makeSale({
    id: uuid(910_000 + index), sourceRowNumber: 910_000 + index,
    sourceEventId: `integration-spike-${index}`, quantity: "50", soldOn: "2025-08-25",
  }));
  sourceStatus(input.dataset, "sales", "complete", input.dataset.sales.length);
  const output = pipeline(input);
  assert.ok(Number(output.forecast.series[0].evidence.excludedOutlierQty) >= 900);
  assert.ok(Math.abs(Number(line(output).recommendedQty) / Number(line(baseline).recommendedQty) - 1) <= 0.05);
});

test("07→08: восстановление stockout увеличивает заказ и сохраняет доказательства", () => {
  const options = { startDate: "2023-01-01", quantityForDay: (date) => date >= "2025-07-01" ? 0 : 10 };
  const raw = pipeline(fixture(options));
  const restored = pipeline(fixture({ ...options, stockouts: [makeStockout("2025-07-01", "2025-09-01")] }));
  assert.equal(line(restored).evidence.forecast.stockoutCompensationQty, "620");
  assert.ok(Number(line(restored).recommendedQty) > Number(line(raw).recommendedQty));
});

test("07→08: нулевая потребность не скрывает ранний дефицит", () => {
  const input = fixture();
  input.dataset.stockSnapshots[0].quantity = "20";
  input.dataset.inboundShipments[0].quantity = "100";
  input.dataset.inboundShipments[0].expectedOn = "2025-09-10";
  const order = line(pipeline(input));
  assert.equal(order.recommendedQty, "0");
  assert.equal(order.urgency, "urgent");
  assert.equal(order.projectedStockoutDate, "2025-09-03");
});

for (const scenario of ["short_history", "missing_customer", "missing_growth_semantics", "unconfirmed_incremental", "missing_growth_source"]) {
  test(`07→08: diagnostic сохраняет unavailable без исключения (${scenario})`, () => {
    const input = fixture(scenario === "short_history" ? { startDate: "2025-08-25" } : {});
    input.configuration.run.runMode = "diagnostic";
    if (scenario === "missing_customer") input.dataset.sales.forEach((sale) => {
      sale.customerKeyAvailable = false; sale.anonymousCustomerKey = null;
    });
    if (scenario === "missing_growth_semantics") growth(input, { semantics: false });
    if (scenario === "unconfirmed_incremental") growth(input, { mode: "incremental", confirmed: false });
    if (scenario === "missing_growth_source") {
      input.configuration.run.growthMode = "replace";
      sourceStatus(input.dataset, "growth", "missing");
    }
    const output = pipeline(input);
    assert.equal(line(output).recommendedQty, null);
    assert.equal(line(output).quantityStatus, "unavailable");
    assert.equal(output.result.coverage.canApprove, false);
    assert.equal(output.result.coverage.coverageGate, "incomplete");
  });
}

test("07→08: исчезнувший обязательный источник не становится разрешением утверждения", () => {
  const input = fixture();
  sourceStatus(input.dataset, "material_statement", "missing");
  const output = pipeline(input);
  assert.equal(output.result.coverage.canApprove, false);
  assert.ok(output.result.coverage.blockingReasons.includes("missing_source"));
});

test("07→08: повтор/перестановка/будущее не меняют цепочку и вход не мутируется", () => {
  const input = fixture();
  const before = structuredClone(input);
  const first = pipeline(input);
  assert.deepEqual(pipeline(input), first);
  assert.deepEqual(input, before);
  input.dataset.sales.reverse();
  input.dataset.sales.push(makeSale({ soldOn: "2026-01-01", quantity: "999999" }));
  assert.deepEqual(pipeline(input), first);
});

test("07→08: десятичная сумма горизонта точно совпадает с публичным API07", () => {
  const input = growth(fixture({ quantity: 100_000_000 }));
  const output = pipeline(input);
  const model = output.forecast.series[0].model;
  const end = addDays(input.configuration.run.asOfDate, line(output).evidence.horizonDays);
  const exact = sumDailyForecast(model, model.startDate, end, "decimal");
  assert.equal(exact, "1027882215.44612681");
  assert.equal(line(output).evidence.forecastDemandH, exact);
  // Number не представляет все8 десятичных знаков при такой величине.
  assert.equal(sumDailyForecast(model, model.startDate, end), Number(exact));
});

for (const mode of ["replace", "incremental"]) {
  test(`07→08: full с неподтверждённым ${mode} остаётся заблокированным`, () => {
    const output = pipeline(growth(fixture(), { mode, semantics: false }));
    assert.equal(output.forecast.series[0].model.growthMode, "none");
    assert.equal(line(output).quantityStatus, "unavailable");
    assert.equal(line(output).recommendedQty, null);
    assert.equal(output.result.coverage.canApprove, false);
  });
}

for (const scenario of ["no_warning", "nonblocking_warning", "wrong_product", "wrong_warehouse", "complete_coverage", "nonneutral_model", "future_model"]) {
  test(`07→08: несогласованный режим по-прежнему отклоняется (${scenario})`, () => {
    const input = growth(fixture(), { semantics: false });
    const forecast = ForecastResultSchema.parse(forecastDemand(input.dataset, scope, input.configuration));
    const warning = forecast.warnings.find((item) => item.code === "growth_semantics_unconfirmed");
    assert.ok(warning);
    if (scenario === "no_warning") forecast.warnings = forecast.warnings.filter((item) => item !== warning);
    if (scenario === "nonblocking_warning") warning.severity = "warning";
    if (scenario === "wrong_product") warning.key.productId = uuid(990_001);
    if (scenario === "wrong_warehouse") warning.key.warehouseId = uuid(990_002);
    if (scenario === "complete_coverage") Object.assign(forecast.coverage, {
      coverageGate: "complete", blockingReasons: [], canApprove: true,
    });
    if (scenario === "nonneutral_model") Object.assign(forecast.series[0].model, {
      growthMode: "incremental", externalMonthlyFactor: "1.2",
    });
    if (scenario === "future_model") forecast.series[0].model.startDate = "2025-09-02";
    // Это валидные DTO, но не разрешённое сочетание модели и запуска.
    ForecastResultSchema.parse(forecast);
    assert.throws(() => recommend(input.dataset, input.configuration, forecast), /Модель прогноза не согласована/);
  });
}

test("07→08: глобальное блокирующее предупреждение запрещает заказ", () => {
  const input = growth(fixture(), { semantics: false });
  const forecast = ForecastResultSchema.parse(forecastDemand(input.dataset, scope, input.configuration));
  forecast.warnings.find((item) => item.code === "growth_semantics_unconfirmed").key = null;
  const result = recommend(input.dataset, input.configuration, forecast);
  assert.equal(line({ result }).recommendedQty, null);
  assert.equal(result.coverage.canApprove, false);
});
