import { IsoDateSchema } from "../../contracts/primitives";

/** Календарные дни UTC, независимо от часового пояса процесса и переходов DST. */
export function addDays(date: string, days: number): string {
  IsoDateSchema.parse(date);
  if (!Number.isSafeInteger(days)) {
    throw new RangeError("Смещение даты должно быть целым числом календарных дней");
  }
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  if (!Number.isFinite(result.getTime())) {
    throw new RangeError("Дата выходит за допустимый диапазон");
  }
  return IsoDateSchema.parse(result.toISOString().slice(0, 10));
}
