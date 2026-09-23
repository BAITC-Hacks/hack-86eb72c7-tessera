import assert from "node:assert/strict";
import test from "node:test";
import {
  CalculationPoliciesSchema, ForecastResultSchema,
} from "../../../lib/contracts/calculation.ts";
import {
  CategoryPolicySchema, InboundShipmentSchema, ProductSupplierSchema,
  StockSnapshotSchema, SupplierLeadTimeSchema, SupplierSchema,
} from "../../../lib/contracts/datasets.ts";
import { RunConfigurationSchema } from "../../../lib/contracts/runs.ts";
import { calculate, IDS, makeFixture } from "../../fixtures/replenishment/base.mjs";

function onlyLine(result) {
  assert.equal(result.issues.length, 0);
  assert.equal(result.supplierGroups.length, 1);
  assert.equal(result.supplierGroups[0].lines.length, 1);
  return result.supplierGroups[0].lines[0];
}

function setSafetyDays(fixture, days) {
  fixture.categoryPolicies[0].parameters.safetyDays = days;
  fixture.configuration.run.safetyDaysByCategory[0].safetyDays = days;
}

function freezeDeep(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

test("синтетический эталон проходит все входные схемы", () => {
  const fixture = makeFixture();
  ForecastResultSchema.parse(fixture.forecast);
  fixture.inventory.forEach((item) => StockSnapshotSchema.parse(item));
  fixture.inbound.forEach((item) => InboundShipmentSchema.parse(item));
  fixture.supplierTerms.suppliers.forEach((item) => SupplierSchema.parse(item));
  fixture.supplierTerms.productSuppliers.forEach((item) => ProductSupplierSchema.parse(item));
  fixture.supplierTerms.leadTimes.forEach((item) => SupplierLeadTimeSchema.parse(item));
  fixture.categoryPolicies.forEach((item) => CategoryPolicySchema.parse(item));
  RunConfigurationSchema.parse(fixture.configuration.run);
  CalculationPoliciesSchema.parse(fixture.configuration.policies);
});

test("точный эталон: 100 + 20 − 30 − 40 = 50 с числовой цепочкой", () => {
  const fixture = makeFixture();
  const result = calculate(fixture);
  const line = onlyLine(result);
  assert.equal(line.recommendedQty, "50");
  assert.equal(line.quantityStatus, "known");
  assert.equal(line.urgency, "planned");
  assert.deepEqual({
    horizonDays: line.evidence.horizonDays,
    leadTimeDays: line.evidence.leadTimeDays,
    reviewPeriodDays: line.evidence.reviewPeriodDays,
    safetyDays: line.evidence.safetyDays,
    forecastDemandH: line.evidence.forecastDemandH,
    safetyStock: line.evidence.safetyStock,
    usableStock: line.evidence.usableStock,
    eligibleInbound: line.evidence.eligibleInbound,
    rawNeed: line.evidence.rawNeed,
    unitStep: line.evidence.unitStep,
    finalQty: line.evidence.finalQty,
  }, {
    horizonDays: 10, leadTimeDays: 5, reviewPeriodDays: 5, safetyDays: 2,
    forecastDemandH: "100", safetyStock: "20", usableStock: "30", eligibleInbound: "40",
    rawNeed: "50", unitStep: "1", finalQty: "50",
  });
  assert.equal(line.evidence.stockBasis, "free_stock");
  assert.equal(line.evidence.onHand, null);
  assert.equal(line.evidence.reserved, null);
  assert.deepEqual(line.evidence.forecast, fixture.forecast.series[0].evidence);
  assert.deepEqual(line.evidence.inbound[0].sourceRef, {
    sourceObjectId: IDS.source, sourceSheet: "Синтетика", sourceRowNumber: 3,
  });
  assert.equal(result.coverage.coverageGate, "complete");
  assert.equal(result.coverage.canApprove, true);
});

const sensitivities = [
  {
    name: "спрос, переданный прогнозом продаж", expectedQty: "62", factor: "forecastDemandH", expectedFactor: "110",
    change(f) { f.forecast.series[0].model.baseAtStart = "11"; },
  },
  {
    name: "свободный остаток", expectedQty: "49", factor: "usableStock", expectedFactor: "31",
    change(f) { f.inventory[0].quantity = "31"; },
  },
  {
    name: "подходящий товар в пути", expectedQty: "49", factor: "eligibleInbound", expectedFactor: "41",
    change(f) { f.inbound[0].quantity = "41"; },
  },
  {
    name: "страховка категории", expectedQty: "60", factor: "safetyStock", expectedFactor: "30",
    change(f) { setSafetyDays(f, 3); },
  },
  {
    name: "период пересмотра", expectedQty: "60", factor: "horizonDays", expectedFactor: 11,
    change(f) {
      f.categoryPolicies[0].reviewPeriodDays = 6;
      f.categoryPolicies[0].parameters.reviewPeriodDays = 6;
      f.configuration.run.reviewPeriodDays = 6;
    },
  },
  {
    name: "срок поставки", expectedQty: "60", factor: "horizonDays", expectedFactor: 11,
    change(f) { f.supplierTerms.leadTimes[0].days = 6; },
  },
  {
    name: "сезонный индекс", expectedQty: "170", factor: "forecastDemandH", expectedFactor: "200",
    change(f) { f.forecast.series[0].model.seasonalIndexByMonth[0] = "2"; },
  },
];

for (const { name, expectedQty, factor, expectedFactor, change } of sensitivities) {
  test(`чувствительность M1 на ненасыщенном эталоне: ${name}`, () => {
    const fixture = makeFixture();
    change(fixture);
    const line = onlyLine(calculate(fixture));
    assert.equal(line.recommendedQty, expectedQty);
    assert.equal(line.evidence[factor], expectedFactor);
  });
}

test("внешний рост изменяет прогноз горизонта и заказ, а не только подпись", () => {
  const fixture = makeFixture();
  fixture.configuration.run.growthMode = "incremental";
  fixture.forecast.series[0].model.growthMode = "incremental";
  fixture.forecast.series[0].model.externalMonthlyFactor = "2";
  const line = onlyLine(calculate(fixture));
  assert.ok(Number(line.evidence.forecastDemandH) > 100);
  assert.ok(Number(line.evidence.safetyStock) > 20);
  assert.ok(Number(line.recommendedQty) > 50);
});

test("подтверждённый тренд влияет на расчёт при выключенном внешнем росте", () => {
  const fixture = makeFixture();
  fixture.forecast.series[0].model.trendMonthlyFactor = "2";
  const line = onlyLine(calculate(fixture));
  assert.ok(Number(line.evidence.forecastDemandH) > 100);
  assert.ok(Number(line.recommendedQty) > 50);
});

test("страховка суммирует дни после горизонта, включая смену сезона", () => {
  const fixture = makeFixture();
  fixture.forecast.asOfDate = "2026-01-21";
  fixture.configuration.run.asOfDate = "2026-01-21";
  fixture.inventory[0].asOfDate = "2026-01-21";
  fixture.inbound[0].expectedOn = "2026-01-23";
  fixture.forecast.series[0].model.startDate = "2026-01-22";
  fixture.forecast.series[0].model.seasonalIndexByMonth[1] = "2";
  fixture.forecast.series[0].evidence.historyEnd = "2026-01-21";
  const line = onlyLine(calculate(fixture));
  assert.equal(line.evidence.forecastDemandH, "100");
  assert.equal(line.evidence.safetyStock, "40");
  assert.equal(line.recommendedQty, "70");
});

test("исключённые продажи и компенсация отсутствия сохраняются как факты прогноза", () => {
  const fixture = makeFixture();
  fixture.forecast.series[0].evidence.excludedOutlierQty = "100";
  fixture.forecast.series[0].evidence.stockoutCompensationQty = "20";
  const line = onlyLine(calculate(fixture));
  assert.equal(line.evidence.forecast.excludedOutlierQty, "100");
  assert.equal(line.evidence.forecast.stockoutCompensationQty, "20");
  // Эти факторы уже учтены в переданной модели 07: 08 не применяет их второй раз.
  assert.equal(line.recommendedQty, "50");
});

test("округление вверх до дробного шага не добавляет двоичную погрешность", () => {
  const fixture = makeFixture();
  fixture.inventory[0].quantity = "29.95";
  fixture.configuration.policies.unitSteps[0].step = "0.1";
  const line = onlyLine(calculate(fixture));
  assert.equal(line.evidence.rawNeed, "50.05");
  assert.equal(line.recommendedQty, "50.1");
});

test("малое изменение потребности может не менять округлённое количество", () => {
  const fixture = makeFixture();
  fixture.inventory[0].quantity = "29.95";
  fixture.configuration.policies.unitSteps[0].step = "0.1";
  const before = onlyLine(calculate(fixture));
  fixture.inventory[0].quantity = "29.96";
  const after = onlyLine(calculate(fixture));
  assert.equal(before.evidence.rawNeed, "50.05");
  assert.equal(after.evidence.rawNeed, "50.04");
  assert.equal(before.recommendedQty, "50.1");
  assert.equal(after.recommendedQty, "50.1");
});

test("нулевой порог сохраняет ноль при избытке и не округляет до минимального заказа", () => {
  const fixture = makeFixture();
  fixture.inventory[0].quantity = "120";
  fixture.inbound = [];
  fixture.supplierTerms.productSuppliers[0].moq = "100";
  const before = onlyLine(calculate(fixture));
  fixture.inventory[0].quantity = "121";
  const after = onlyLine(calculate(fixture));
  for (const line of [before, after]) {
    assert.equal(line.evidence.rawNeed, "0");
    assert.equal(line.recommendedQty, "0");
    assert.equal(line.quantityStatus, "known");
    assert.equal(line.urgency, "none");
  }
});

test("MOQ и упаковочная кратность остаются метаданными", () => {
  const fixture = makeFixture();
  fixture.supplierTerms.productSuppliers[0].moq = "100";
  fixture.supplierTerms.productSuppliers[0].packMultiple = "24";
  assert.equal(onlyLine(calculate(fixture)).recommendedQty, "50");
});

test("минимальная точность 10⁻⁸ сохраняется в сумме и округлении", () => {
  const fixture = makeFixture();
  fixture.forecast.series[0].model.baseAtStart = "0.00000001";
  fixture.inventory[0].quantity = "0";
  fixture.inbound = [];
  fixture.configuration.policies.unitSteps[0].step = "0.00000001";
  const line = onlyLine(calculate(fixture));
  assert.equal(line.evidence.forecastDemandH, "0.0000001");
  assert.equal(line.evidence.safetyStock, "0.00000002");
  assert.equal(line.recommendedQty, "0.00000012");
});

test("плоский прогноз выше безопасного целого Number считается точно", () => {
  const fixture = makeFixture();
  fixture.forecast.series[0].model.baseAtStart = "900719925474099.3";
  fixture.inventory[0].quantity = "0";
  fixture.inbound = [];
  setSafetyDays(fixture, 0);
  fixture.configuration.policies.unitSteps[0].step = "0.1";
  const line = onlyLine(calculate(fixture));
  assert.equal(line.evidence.forecastDemandH, "9007199254740993");
  assert.equal(line.evidence.rawNeed, "9007199254740993");
  assert.equal(line.recommendedQty, "9007199254740993");
});

test("результат воспроизводим и не изменяет даже глубоко замороженные входы", () => {
  const fixture = freezeDeep(makeFixture());
  const original = structuredClone(fixture);
  const first = calculate(fixture);
  assert.deepEqual(calculate(fixture), first);
  assert.deepEqual(fixture, original);
});

test("без ИИ доступны русский текст, артикул, версия, количество и срочность", () => {
  const fixture = makeFixture();
  const result = calculate(fixture);
  const line = onlyLine(result);
  assert.match(line.rationale, /[А-Яа-яЁё]/);
  assert.ok(line.rationale.length > 20);
  assert.equal(line.supplierId, IDS.supplier);
  assert.equal(line.supplierArticle, "000123");
  assert.equal(line.productId, IDS.product);
  assert.equal(line.warehouseId, IDS.warehouse);
  assert.equal(line.unit, "m");
  assert.equal(line.datasetVersionId, IDS.dataset);
  assert.equal(line.calculationVersion, fixture.configuration.run.algorithmVersion);
  assert.equal(result.calculationVersion, fixture.configuration.run.algorithmVersion);
  assert.ok(line.numericFactors.length > 0);
});

test("в группе поставщика сохраняются отдельные склады одного SKU", () => {
  const fixture = makeFixture();
  const warehouse = "00000000-0000-4000-8000-000000000012";
  const extra = structuredClone(fixture.forecast.series[0]);
  extra.key.warehouseId = warehouse;
  fixture.forecast.series.push(extra);
  fixture.inventory.push({ ...fixture.inventory[0], id: "00000000-0000-4000-8000-000000000013", warehouseId: warehouse });
  fixture.configuration.run.scope.warehouseIds.push(warehouse);
  const result = calculate(fixture);
  assert.equal(result.supplierGroups.length, 1);
  assert.equal(result.supplierGroups[0].lines.length, 2);
  const lines = new Map(result.supplierGroups[0].lines.map((line) => [line.warehouseId, line]));
  assert.equal(lines.get(IDS.warehouse).recommendedQty, "50");
  assert.equal(lines.get(warehouse).recommendedQty, "90");
  assert.deepEqual(Object.keys(result.supplierGroups[0]).sort(), ["lines", "supplierId"]);
});
