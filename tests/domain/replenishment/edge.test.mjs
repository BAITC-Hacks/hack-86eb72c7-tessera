import assert from "node:assert/strict";
import { test } from "node:test";
import { makeFixture, calculate } from "../../fixtures/replenishment/base.mjs";
import { calculateRecommendations } from "../../../lib/domain/replenishment/index.ts";
import { ReplenishmentResultSchema } from "../../../lib/contracts/calculation.ts";

function onlyLine(result) {
  assert.equal(result.issues.length, 0);
  assert.equal(result.supplierGroups.length, 1);
  assert.equal(result.supplierGroups[0].lines.length, 1);
  const line = result.supplierGroups[0].lines[0];
  assert.equal(line.quantityStatus, "known");
  assert.notEqual(line.evidence, null);
  return line;
}

function assertBlocked(result, fixture, expectedCode) {
  ReplenishmentResultSchema.parse(result);
  assert.equal(result.coverage.coverageGate, "incomplete");
  assert.equal(result.coverage.canApprove, false);
  assert.ok(result.coverage.blockingReasons.length > 0);
  const key = fixture.forecast.series[0].key;
  const lines = result.supplierGroups.flatMap((group) => group.lines)
    .filter((line) => line.productId === key.productId && line.warehouseId === key.warehouseId);
  const issues = result.issues.filter((issue) => issue.key.productId === key.productId && issue.key.warehouseId === key.warehouseId);
  assert.equal(lines.length + issues.length, 1, "SKU/склад не должен исчезать или дублироваться");
  for (const line of lines) {
    assert.equal(line.recommendedQty, null);
    assert.equal(line.quantityStatus, "unavailable");
    assert.equal(line.evidence, null);
    assert.equal(line.urgency, "unknown");
    assert.match(line.rationale, /[А-Яа-яЁё]/);
  }
  if (expectedCode) {
    const codes = [...result.warnings, ...issues, ...lines.flatMap((line) => line.warnings)].map((item) => item.code);
    assert.ok(codes.includes(expectedCode), `Нет явного кода ${expectedCode}: ${codes.join(", ")}`);
  }
}

// Невалидный DTO может быть отвергнут на входе, но не превращён в известный ноль.
// Проверка выходной схемы выполняется вне catch: ошибка самой схемы не засчитывается.
function assertExplicitFailure(fixture) {
  let result;
  try {
    result = calculateRecommendations(fixture.forecast, fixture.inventory, fixture.inbound,
      fixture.supplierTerms, fixture.categoryPolicies, fixture.configuration);
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok(error.message.length > 0);
    assert.ok(error.name === "ZodError" || /[А-Яа-яЁё]/.test(error.message),
      "Ожидается ошибка валидации или явное предметное сообщение, а не случайный сбой");
    return;
  }
  assertBlocked(result, fixture);
}

for (const [label, expectedOn, counted, reason] of [
  ["просроченная", "2025-12-31", false, "overdue"],
  ["на дату среза", "2026-01-01", false, "overdue"],
  ["в первый день", "2026-01-02", true, "within_horizon"],
  ["в последний день", "2026-01-11", true, "within_horizon"],
  ["после горизонта", "2026-01-12", false, "after_horizon"],
  ["без ETA", null, false, "without_date"],
]) {
  test(`ETA: поставка ${label} учитывается ровно по границам (asOf, asOf + H]`, () => {
    const fixture = makeFixture();
    fixture.inbound[0].expectedOn = expectedOn;
    const line = onlyLine(calculate(fixture));
    assert.equal(line.evidence.eligibleInbound, counted ? "40" : "0");
    assert.equal(line.evidence.rawNeed, counted ? "50" : "90");
    assert.equal(line.recommendedQty, counted ? "50" : "90");
    assert.equal(line.evidence.inbound.length, 1);
    assert.equal(line.evidence.inbound[0].counted, counted);
    assert.equal(line.evidence.inbound[0].reason, reason);
    assert.equal(line.evidence.inbound[0].expectedOn, expectedOn);
    assert.deepEqual(line.evidence.inbound[0].sourceRef, {
      sourceObjectId: fixture.inbound[0].sourceObjectId,
      sourceSheet: fixture.inbound[0].sourceSheet,
      sourceRowNumber: fixture.inbound[0].sourceRowNumber,
    });
  });
}

test("Позднее поступление обнуляет заказ, но не скрывает ранний дефицит", () => {
  const fixture = makeFixture();
  fixture.inventory[0].quantity = "0";
  fixture.inbound[0].quantity = "120";
  fixture.inbound[0].expectedOn = "2026-01-11";
  const line = onlyLine(calculate(fixture));
  assert.equal(line.evidence.rawNeed, "0");
  assert.equal(line.recommendedQty, "0");
  assert.equal(line.urgency, "urgent");
  assert.equal(line.projectedStockoutDate, "2026-01-02");
  assert.equal(line.shortageDays, 9);
});

test("Поступление будущего дня доступно перед спросом этого же дня", () => {
  const fixture = makeFixture();
  fixture.inventory[0].quantity = "0";
  fixture.inbound[0].expectedOn = "2026-01-02";
  const line = onlyLine(calculate(fixture));
  assert.equal(line.projectedStockoutDate, "2026-01-06");
  assert.equal(line.shortageDays, 6);
  assert.equal(line.urgency, "planned", "Дефицит на дате первой новой поставки не раньше неё");
});

test("Urgent применяется только строго до первой возможной новой поставки", () => {
  const fixture = makeFixture();
  fixture.inbound = [];
  fixture.inventory[0].quantity = "40";
  const onBoundary = onlyLine(calculate(fixture));
  assert.equal(onBoundary.projectedStockoutDate, "2026-01-06");
  assert.equal(onBoundary.urgency, "planned");
  fixture.inventory[0].quantity = "30";
  const beforeBoundary = onlyLine(calculate(fixture));
  assert.equal(beforeBoundary.projectedStockoutDate, "2026-01-05");
  assert.equal(beforeBoundary.urgency, "urgent");
});

test("При нулевом сроке поставки положительный заказ остаётся плановым", () => {
  const fixture = makeFixture();
  fixture.supplierTerms.leadTimes[0].days = 0;
  fixture.inventory[0].quantity = "0";
  fixture.inbound = [];
  const line = onlyLine(calculate(fixture));
  assert.equal(line.evidence.horizonDays, 5);
  assert.equal(line.recommendedQty, "70");
  assert.equal(line.projectedStockoutDate, "2026-01-02");
  assert.equal(line.urgency, "planned");
});

test("Одна поставка из двух файлов вычитается один раз с явным duplicate", () => {
  const fixture = makeFixture();
  fixture.inbound.push({ ...fixture.inbound[0],
    id: "550e8400-e29b-41d4-a716-446655449901",
    sourceObjectId: "550e8400-e29b-41d4-a716-446655449902",
    sourceRowNumber: 99,
  });
  const line = onlyLine(calculate(fixture));
  assert.equal(line.evidence.eligibleInbound, "40");
  assert.equal(line.recommendedQty, "50");
  assert.equal(line.evidence.inbound.length, 2);
  assert.equal(line.evidence.inbound.filter((item) => item.counted).length, 1);
  assert.equal(line.evidence.inbound.filter((item) => item.reason === "duplicate").length, 1);
  assert.ok(line.warnings.some((warning) => warning.code === "inbound_duplicate"));
});

test("Свободный остаток не требует отсутствующих onHand/reserved и не уменьшается повторно", () => {
  const fixture = makeFixture();
  const line = onlyLine(calculate(fixture));
  assert.equal(line.evidence.stockBasis, "free_stock");
  assert.equal(line.evidence.onHand, null);
  assert.equal(line.evidence.reserved, null);
  assert.equal(line.evidence.usableStock, "30");
  assert.equal(line.recommendedQty, "50");
});

for (const [label, change, code] of [
  ["нет поставщика", (fixture) => { fixture.supplierTerms.productSuppliers = []; }, "missing_supplier"],
  ["нет срока поставки", (fixture) => { fixture.supplierTerms.leadTimes = []; }, "missing_lead_time"],
  ["нет политики категории", (fixture) => { fixture.categoryPolicies = []; }, "missing_category_policy"],
  ["нет страховки в снимке", (fixture) => { fixture.configuration.run.safetyDaysByCategory = []; }, "missing_category_policy"],
  ["страховка не совпадает со снимком", (fixture) => { fixture.configuration.run.safetyDaysByCategory[0].safetyDays = 3; }, "missing_category_policy"],
  ["период не совпадает со снимком", (fixture) => { fixture.configuration.run.reviewPeriodDays = 6; }, "missing_category_policy"],
  ["нет остатка", (fixture) => { fixture.inventory = []; }, "missing_stock"],
  ["остаток устарел", (fixture) => { fixture.inventory[0].asOfDate = "2025-12-31"; }, "missing_stock"],
  ["остаток из будущего", (fixture) => { fixture.inventory[0].asOfDate = "2026-01-02"; }, "missing_stock"],
  ["нет шага единицы", (fixture) => { fixture.configuration.policies.unitSteps = []; }, "missing_unit_step"],
  ["единица остатка не совпадает", (fixture) => { fixture.inventory[0].unit = "чужая_единица"; }, "unit_mismatch"],
  ["единица поставки не совпадает", (fixture) => { fixture.inbound[0].unit = "чужая_единица"; }, "unit_mismatch"],
  ["единица шага не совпадает", (fixture) => { fixture.configuration.policies.unitSteps[0].unit = "чужая_единица"; }, "unit_mismatch"],
]) {
  test(`Недостаток доказательств: ${label} не превращается в ноль или пропуск SKU`, () => {
    const fixture = makeFixture();
    change(fixture);
    assertBlocked(calculate(fixture), fixture, code);
  });
}

for (const [label, change, expectedCode] of [
  ["разные количества одной поставки", (fixture) => {
    fixture.inbound.push({ ...fixture.inbound[0], id: "550e8400-e29b-41d4-a716-446655449905", quantity: "41" });
  }, "inbound_duplicate"],
  ["разные единицы одной поставки", (fixture) => {
    fixture.inbound.push({ ...fixture.inbound[0], id: "550e8400-e29b-41d4-a716-446655449906", unit: "чужая_единица" });
  }, "unit_mismatch"],
  ["два текущих остатка", (fixture) => {
    fixture.inventory.push({ ...fixture.inventory[0], id: "550e8400-e29b-41d4-a716-446655449907" });
  }, "missing_stock"],
  ["два срока одинакового приоритета", (fixture) => {
    fixture.supplierTerms.leadTimes.push({ ...fixture.supplierTerms.leadTimes[0], id: "550e8400-e29b-41d4-a716-446655449908", days: 6 });
  }, "missing_lead_time"],
]) {
  test(`Противоречивые источники блокируют строку: ${label}`, () => {
    const fixture = makeFixture();
    change(fixture);
    assertBlocked(calculate(fixture), fixture, expectedCode);
  });
}

test("Чужой SKU/склад в поставках не влияет на количество и единицу текущего ряда", () => {
  const fixture = makeFixture();
  fixture.inbound.push({ ...fixture.inbound[0], id: "550e8400-e29b-41d4-a716-446655449909",
    productId: "550e8400-e29b-41d4-a716-446655449910", unit: "шт", quantity: "999", sourceKey: "other-product" });
  fixture.inbound.push({ ...fixture.inbound[0], id: "550e8400-e29b-41d4-a716-446655449911",
    warehouseId: "550e8400-e29b-41d4-a716-446655449912", quantity: "999", sourceKey: "other-warehouse" });
  const line = onlyLine(calculate(fixture));
  assert.equal(line.recommendedQty, "50");
  assert.equal(line.evidence.eligibleInbound, "40");
  assert.equal(line.evidence.inbound.length, 1);
});

test("Diagnostic не разрешает утверждение даже при полном покрытии и известном количестве", () => {
  const fixture = makeFixture();
  fixture.configuration.run.runMode = "diagnostic";
  const result = calculate(fixture);
  assert.equal(onlyLine(result).recommendedQty, "50");
  assert.equal(result.coverage.coverageGate, "complete");
  assert.equal(result.coverage.canApprove, false);
});

test("Неоднозначный поставщик не выбирается автоматически: сохраняются кандидаты", () => {
  const fixture = makeFixture();
  const supplierId = "550e8400-e29b-41d4-a716-446655449903";
  fixture.supplierTerms.suppliers.push({ ...fixture.supplierTerms.suppliers[0],
    id: supplierId, sourceKey: "supplier-alternative", name: "Другой поставщик",
  });
  fixture.supplierTerms.productSuppliers.push({ ...fixture.supplierTerms.productSuppliers[0],
    id: "550e8400-e29b-41d4-a716-446655449904", supplierId,
  });
  const result = calculate(fixture);
  assertBlocked(result, fixture, "ambiguous_supplier");
  assert.equal(result.supplierGroups.length, 0);
  assert.deepEqual([...result.issues[0].candidateSupplierIds].sort(),
    fixture.supplierTerms.suppliers.map((supplier) => supplier.id).sort());
});

test("Недоступный прогноз в diagnostic сохраняет null и запрещает утверждение", () => {
  const fixture = makeFixture();
  fixture.configuration.run.runMode = "diagnostic";
  fixture.forecast.series[0].status = "unavailable";
  fixture.forecast.series[0].model = null;
  fixture.forecast.series[0].unavailableReason = "forecast_unavailable";
  fixture.forecast.coverage.coverageGate = "incomplete";
  fixture.forecast.coverage.blockingReasons = ["unavailable_quantity"];
  fixture.forecast.coverage.canApprove = false;
  assertBlocked(calculate(fixture), fixture, "forecast_unavailable");
});

for (const [label, change] of [
  ["отрицательный остаток", (fixture) => { fixture.inventory[0].quantity = "-1"; }],
  ["отрицательная поставка", (fixture) => { fixture.inbound[0].quantity = "-1"; }],
  ["null вместо остатка", (fixture) => { fixture.inventory[0].quantity = null; }],
  ["null вместо поставки", (fixture) => { fixture.inbound[0].quantity = null; }],
  ["двоичный Number вместо строки", (fixture) => { fixture.inventory[0].quantity = 30; }],
  ["экспоненциальная запись", (fixture) => { fixture.inventory[0].quantity = "3e1"; }],
  ["отрицательный срок", (fixture) => { fixture.supplierTerms.leadTimes[0].days = -1; }],
  ["нулевой шаг", (fixture) => { fixture.configuration.policies.unitSteps[0].step = "0"; }],
  ["отрицательный период пересмотра", (fixture) => { fixture.configuration.run.reviewPeriodDays = -1; }],
]) {
  test(`Невалидный вход явно отклонён: ${label}`, () => {
    const fixture = makeFixture();
    change(fixture);
    assertExplicitFailure(fixture);
  });
}

test("Неполное входное покрытие не становится полным после корректного расчёта количества", () => {
  const fixture = makeFixture();
  fixture.configuration.run.runMode = "diagnostic";
  fixture.forecast.coverage = { coverageGate: "incomplete", blockingReasons: ["missing_source"],
    customerAnomalyCoverage: "unavailable", canApprove: false };
  const result = calculate(fixture);
  assert.equal(onlyLine(result).recommendedQty, "50");
  assert.equal(result.coverage.coverageGate, "incomplete");
  assert.equal(result.coverage.canApprove, false);
  assert.equal(result.coverage.customerAnomalyCoverage, "unavailable");
  assert.ok(result.coverage.blockingReasons.includes("missing_source"));
});
