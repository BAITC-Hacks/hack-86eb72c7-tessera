import type { ForecastModel } from "../../contracts/calculation";
import { sumDailyForecast as forecastSum } from "../forecast";

/** Адаптер DTO08; формула и точное суммирование принадлежат только07. */
export function sumDailyForecast(model: ForecastModel, fromDate: string, toDateInclusive: string): string {
  return forecastSum(model, fromDate, toDateInclusive, "decimal");
}
