import { ForecastModelSchema, type ForecastModel } from "../../contracts/calculation";
import { addDays, calendarU, parseDate } from "./math";

/** Сумма по календарным дням, обе границы включены; без округления до шага заказа. */
export function sumDailyForecast(model: ForecastModel, fromDate: string, toDateInclusive: string): number {
  ForecastModelSchema.parse(model);
  parseDate(fromDate);
  parseDate(toDateInclusive);
  if (fromDate < model.startDate || toDateInclusive < fromDate) {
    throw new Error("Период прогноза должен начинаться не раньше модели и иметь прямой порядок дат");
  }
  const startU = calendarU(model.startDate);
  const base = Number(model.baseAtStart);
  if (base === 0) return 0;
  const trend = Number(model.trendMonthlyFactor);
  const external = model.externalMonthlyFactor === null ? 1 : Number(model.externalMonthlyFactor);
  let sum = 0;
  let correction = 0;
  for (let date = fromDate; ; date = addDays(date, 1)) {
    const delta = calendarU(date) - startU;
    const month = Number(date.slice(5, 7)) - 1;
    const seasonalIndex = Number(model.seasonalIndexByMonth[month]);
    const trendFactor = model.growthMode === "replace" ? 1 : trend ** delta;
    const externalFactor = model.growthMode === "none" ? 1 : external ** delta;
    const daily = seasonalIndex === 0 ? 0 : base * seasonalIndex * trendFactor * externalFactor;
    if (!Number.isFinite(daily) || daily < 0) throw new Error("Дневной прогноз вне поддержанного диапазона");
    // Компенсированное суммирование не накапливает ошибку длинного горизонта.
    const corrected = daily - correction;
    const next = sum + corrected;
    correction = (next - sum) - corrected;
    sum = next;
    if (!Number.isFinite(sum)) throw new Error("Сумма прогноза вне поддержанного диапазона");
    if (date === toDateInclusive) return sum;
  }
}
