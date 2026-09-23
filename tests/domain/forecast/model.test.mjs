import "../load-typescript.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { ForecastModelSchema } = await import("../../../lib/contracts/calculation.ts");
const { calendarU } = await import("../../../lib/domain/forecast/math.ts");
const { sumDailyForecast } = await import("../../../lib/domain/forecast/evaluate.ts");

function makeModel(overrides = {}) {
  return ForecastModelSchema.parse({
    startDate: "2025-01-01",
    baseAtStart: "10",
    seasonalIndexByMonth: Array(12).fill("1"),
    trendMonthlyFactor: "1.1",
    growthMode: "none",
    externalMonthlyFactor: null,
    ...overrides,
  });
}

function near(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

test("календарная шкала: первый день следующего месяца имеет delta=1", () => {
  for (const [from, to] of [
    ["2025-01-01", "2025-02-01"],
    ["2025-02-01", "2025-03-01"],
    ["2024-02-01", "2024-03-01"],
    ["2025-12-01", "2026-01-01"],
  ]) {
    assert.equal(calendarU(to) - calendarU(from), 1);
  }
});

test("календарная шкала учитывает 28, 29, 30 и 31 день", () => {
  for (const [date, denominator] of [
    ["2025-02-15", 28],
    ["2024-02-15", 29],
    ["2025-04-15", 30],
    ["2025-01-15", 31],
  ]) {
    near(calendarU(date) - calendarU(`${date.slice(0, 7)}-01`), 14 / denominator, 2e-12);
  }
  assert.throws(() => calendarU("2025-02-29"));
  assert.throws(() => calendarU("2025-13-01"));
});

test("эталон 10 → 11 / 12 / 13.2 не удваивает внешний рост", () => {
  const modes = [
    ["none", null, 11],
    ["replace", "1.2", 12],
    ["incremental", "1.2", 13.2],
  ];
  for (const [growthMode, externalMonthlyFactor, expected] of modes) {
    const model = makeModel({ growthMode, externalMonthlyFactor });
    near(sumDailyForecast(model, "2025-02-01", "2025-02-01"), expected);
    near(sumDailyForecast(model, "2025-01-01", "2025-01-01"), 10);
  }
});

test("сумма включает обе границы, високосный день и смену сезонного месяца", () => {
  const flat = makeModel({ trendMonthlyFactor: "1" });
  near(sumDailyForecast(flat, "2025-01-01", "2025-01-01"), 10);
  near(sumDailyForecast(flat, "2025-01-01", "2025-01-31"), 310);
  const leap = makeModel({ startDate: "2024-02-28", trendMonthlyFactor: "1" });
  near(sumDailyForecast(leap, "2024-02-28", "2024-03-01"), 30);
  const indices = Array(12).fill("1");
  indices[1] = "2";
  near(sumDailyForecast(makeModel({
    trendMonthlyFactor: "1", seasonalIndexByMonth: indices,
  }), "2025-01-31", "2025-02-01"), 30);
});

test("суммирование использует дробную календарную степень без округления до единицы", () => {
  const model = makeModel({ growthMode: "incremental", externalMonthlyFactor: "1.2" });
  const expected = [0, 1, 2].reduce((total, day) => total + 10 * 1.1 ** (day / 31) * 1.2 ** (day / 31), 0);
  near(sumDailyForecast(model, "2025-01-01", "2025-01-03"), expected);
});

test("нулевая база или сезонный индекс дают нулевой, а не недоступный спрос", () => {
  assert.equal(sumDailyForecast(makeModel({ baseAtStart: "0" }), "2025-01-01", "2025-02-01"), 0);
  assert.equal(sumDailyForecast(makeModel({ seasonalIndexByMonth: Array(12).fill("0") }), "2025-01-01", "2025-02-01"), 0);
});

test("схема модели отклоняет отрицательные коэффициенты и несогласованный режим", () => {
  for (const overrides of [
    { baseAtStart: "-1" },
    { trendMonthlyFactor: "-1" },
    { trendMonthlyFactor: "0" },
    { growthMode: "replace", externalMonthlyFactor: "-1" },
    { growthMode: "incremental", externalMonthlyFactor: null },
    { growthMode: "none", externalMonthlyFactor: "1.2" },
    { seasonalIndexByMonth: ["-1", ...Array(11).fill("1")] },
  ]) {
    assert.throws(() => makeModel(overrides));
  }
});

test("неверные даты, обратный период и дни до начала модели отклоняются", () => {
  const model = makeModel();
  assert.throws(() => sumDailyForecast(model, "2024-12-31", "2025-01-01"));
  assert.throws(() => sumDailyForecast(model, "2025-02-01", "2025-01-31"));
  assert.throws(() => sumDailyForecast(model, "2025-02-29", "2025-03-01"));
});

test("decimal-перегрузка сохраняет большое количество за пределами точности Number", () => {
  const model = makeModel({ baseAtStart: "900719925474099.3", trendMonthlyFactor: "1" });
  assert.equal(sumDailyForecast(model, "2025-01-01", "2025-01-10", "decimal"), "9007199254740993");
  assert.equal(typeof sumDailyForecast(model, "2025-01-01", "2025-01-10"), "number");
});

test("decimal округляет после суммирования; числовой API не округляет до8 знаков", () => {
  const model = makeModel({
    baseAtStart: "0.00000001", trendMonthlyFactor: "1", seasonalIndexByMonth: Array(12).fill("0.4"),
  });
  assert.equal(sumDailyForecast(model, "2025-01-01", "2025-01-01", "decimal"), "0");
  assert.equal(sumDailyForecast(model, "2025-01-01", "2025-01-03", "decimal"), "0.00000001");
  assert.equal(sumDailyForecast(model, "2025-01-01", "2025-01-03"), 0.000000012);
  model.seasonalIndexByMonth.fill("0.5");
  assert.equal(sumDailyForecast(model, "2025-01-01", "2025-01-01", "decimal"), "0.00000001");
});

test("decimal сохраняет малую дробь рядом с большим количеством", () => {
  const model = makeModel({ baseAtStart: "9007199254740993.00000001", trendMonthlyFactor: "1" });
  assert.equal(sumDailyForecast(model, "2025-01-01", "2025-01-01", "decimal"), "9007199254740993.00000001");
});

test("decimal проверяет предел numeric(30,8) и допустимый интервал", () => {
  const model = makeModel({ baseAtStart: "9999999999999999999999", trendMonthlyFactor: "1" });
  assert.throws(() => sumDailyForecast(model, "2025-01-01", "2025-01-02", "decimal"));
  assert.throws(() => sumDailyForecast(model, "2025-01-02", "2025-01-01", "decimal"));
});
