import "../load-typescript.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { ForecastModelSchema } = await import("../../../lib/contracts/calculation.ts");
const { sumDailyForecast } = await import("../../../lib/domain/forecast/index.ts");
const { sumDailyForecast: replenishmentSum } = await import("../../../lib/domain/replenishment/forecast-sum.ts");

for (const growthMode of ["none", "replace", "incremental"]) {
  test(`07→08: общий вычислитель для ${growthMode}, високосного месяца и страховки`, () => {
    const model = ForecastModelSchema.parse({
      startDate: "2024-02-28", baseAtStart: "100000000.00000001",
      seasonalIndexByMonth: ["1", "0.7", "1.3", ...Array(9).fill("1")],
      trendMonthlyFactor: "1.1", growthMode,
      externalMonthlyFactor: growthMode === "none" ? null : "1.2",
    });
    for (const [from, to] of [["2024-02-28", "2024-03-08"], ["2024-03-09", "2024-03-10"]]) {
      assert.equal(replenishmentSum(model, from, to), sumDailyForecast(model, from, to, "decimal"));
    }
  });
}
