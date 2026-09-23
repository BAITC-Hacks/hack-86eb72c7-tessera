import assert from "node:assert/strict";
import { test } from "node:test";
import "../load-typescript.mjs";

const { toScaled, fromScaled, ceilToStep } = await import("../../../lib/domain/replenishment/decimal.ts");
const { addDays } = await import("../../../lib/domain/replenishment/dates.ts");
const { sumDailyForecast } = await import("../../../lib/domain/replenishment/forecast-sum.ts");
const { simulateStockout } = await import("../../../lib/domain/replenishment/urgency.ts");

test("decimal: большие количества и минимальная дробь сохраняются точно", () => {
  const value = "999999999999999999999.00000001";
  assert.equal(fromScaled(toScaled(value)), value);
  assert.equal(fromScaled(toScaled("0.1") + toScaled("0.2")), "0.3");
  assert.equal(ceilToStep("0.10000001", "0.1"), "0.2");
  assert.equal(ceilToStep("0", "0.1"), "0");
  assert.equal(ceilToStep("12.25", "0.25"), "12.25");
});

test("календарные дни считаются в UTC, включая високосный февраль", () => {
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2024-02-28", 2), "2024-03-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("временная сумма прогноза включает обе границы и не теряет дроби", () => {
  const model = {
    startDate: "2026-01-31", baseAtStart: "0.1",
    seasonalIndexByMonth: Array(12).fill("1"),
    trendMonthlyFactor: "1", growthMode: "none", externalMonthlyFactor: null,
  };
  assert.equal(sumDailyForecast(model, "2026-01-31", "2026-02-02"), "0.3");
  assert.equal(sumDailyForecast(model, "2026-01-31", "2026-01-31"), "0.1");
});

test("срочность использует накопленный прогноз, не теряя дроби при округлении каждого дня", () => {
  const model = {
    startDate: "2026-01-02", baseAtStart: "0.00000001",
    seasonalIndexByMonth: Array(12).fill("0.4"),
    trendMonthlyFactor: "1", growthMode: "none", externalMonthlyFactor: null,
  };
  assert.equal(sumDailyForecast(model, "2026-01-02", "2026-01-04"), "0.00000001");
  assert.deepEqual(simulateStockout(model, "2026-01-01", 3, 5, "0", []), {
    projectedStockoutDate: "2026-01-03", shortageDays: 2, urgent: true,
  });
});

test("машинное исчезновение положительного коэффициента не выдаётся за нулевой спрос", () => {
  const model = {
    startDate: "2026-01-01", baseAtStart: "1",
    seasonalIndexByMonth: Array(12).fill("1"),
    trendMonthlyFactor: "0.00000001", growthMode: "none", externalMonthlyFactor: null,
  };
  assert.throws(() => sumDailyForecast(model, "2056-01-01", "2056-01-01"), RangeError);
});
