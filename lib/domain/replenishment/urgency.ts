import type { ForecastModel } from "../../contracts/calculation";
import { IsoDateSchema, NonNegativeDecimalStringSchema } from "../../contracts/primitives";
import { addDays } from "./dates";
import { toScaled } from "./decimal";
import { sumDailyForecast } from "./forecast-sum";

/** Приход — до дневного спроса; отрицательный баланс сохраняет накопленный дефицит. */
export function simulateStockout(
  model: ForecastModel,
  asOfDate: string,
  horizonDays: number,
  leadTimeDays: number,
  usableStock: string,
  arrivals: { date: string; quantity: string }[],
): { projectedStockoutDate: string | null; shortageDays: number; urgent: boolean } {
  IsoDateSchema.parse(asOfDate);
  NonNegativeDecimalStringSchema.parse(usableStock);
  if (!Number.isSafeInteger(horizonDays) || horizonDays < 0
    || !Number.isSafeInteger(leadTimeDays) || leadTimeDays < 0) {
    throw new RangeError("Горизонт и срок поставки должны быть целыми неотрицательными днями");
  }

  const horizonEnd = addDays(asOfDate, horizonDays);
  const arrivalsByDate = new Map<string, bigint>();
  for (const arrival of arrivals) {
    IsoDateSchema.parse(arrival.date);
    NonNegativeDecimalStringSchema.parse(arrival.quantity);
    if (arrival.date <= asOfDate || arrival.date > horizonEnd) continue;
    arrivalsByDate.set(arrival.date, (arrivalsByDate.get(arrival.date) ?? BigInt(0)) + toScaled(arrival.quantity));
  }

  let available = toScaled(usableStock);
  const firstForecastDate = horizonDays === 0 ? asOfDate : addDays(asOfDate, 1);
  let projectedStockoutDate: string | null = null;
  let shortageDays = 0;
  let urgent = false;
  for (let offset = 1; offset <= horizonDays; offset += 1) {
    const date = addDays(asOfDate, offset);
    available += arrivalsByDate.get(date) ?? BigInt(0);
    // Округляем накопленный спрос, а не каждый день: иначе погрешность
    // округления расходится с forecastDemandH и создаёт ложный дефицит.
    const balance = available - toScaled(sumDailyForecast(model, firstForecastDate, date));
    if (balance < BigInt(0)) {
      projectedStockoutDate ??= date;
      shortageDays += 1;
      // Новая поставка прибывает до спроса; дефицит в день её ETA не «до» ETA.
      if (offset < leadTimeDays) urgent = true;
    }
  }

  return { projectedStockoutDate, shortageDays, urgent };
}
