import { ForecastModelSchema, type ForecastModel } from "../../contracts/calculation";
import { IsoDateSchema } from "../../contracts/primitives";
import { fromScaled, toScaled } from "./decimal";

const ZERO = BigInt(0);
const TEN = BigInt(10);
const FACTOR_DIGITS = 64;
const FACTOR_SCALE = TEN ** BigInt(FACTOR_DIGITS);
// base и seasonal имеют по 8 знаков, два множителя роста — по 64.
const OUTPUT_DIVISOR = TEN ** BigInt(8 + 2 * FACTOR_DIGITS);
const DAY_MS = 86_400_000;

/**
 * Дробная степень приближённая, но количества не переводятся в Number.
 * Десятичное представление множителя переносится в bigint без суммирования
 * двоичных дробей. Запас разрядов сохраняет малые множители больших количеств.
 */
function scaledPower(factor: string, delta: number): bigint {
  if (factor === "1" || delta === 0) return FACTOR_SCALE;
  const value = Math.pow(Number(factor), delta);
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("Множитель прогноза выходит за допустимый диапазон");
  }
  const [mantissa, exponent = "0"] = value.toString().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const coefficient = BigInt(whole + fraction);
  const shift = FACTOR_DIGITS + Number(exponent) - fraction.length;
  if (shift >= 0) return coefficient * TEN ** BigInt(shift);
  const divisor = TEN ** BigInt(-shift);
  const scaled = (coefficient + divisor / BigInt(2)) / divisor;
  if (scaled === ZERO) {
    throw new RangeError("Множитель прогноза меньше поддерживаемой точности");
  }
  return scaled;
}

function monthPosition(date: Date): { month: number; fraction: number } {
  const end = new Date(date.getTime());
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  return {
    month: 12 * date.getUTCFullYear() + date.getUTCMonth(),
    fraction: (date.getUTCDate() - 1) / end.getUTCDate(),
  };
}

/**
 * Временная точка интеграции 07 → 08: формула из ForecastModelSchema.
 * Обе границы включены; пустой интервал даёт ноль. Плоские количества точны.
 * Сумма округляется half-up до numeric(30,8) только на внешней границе.
 */
export function sumDailyForecast(model: ForecastModel, fromDate: string, toDateInclusive: string): string {
  const parsed = ForecastModelSchema.parse(model);
  IsoDateSchema.parse(fromDate);
  IsoDateSchema.parse(toDateInclusive);
  if (fromDate > toDateInclusive) return "0";

  const base = toScaled(parsed.baseAtStart);
  if (base === ZERO) return "0";
  const seasonal = parsed.seasonalIndexByMonth.map(toScaled);
  const anchor = monthPosition(new Date(`${parsed.startDate}T00:00:00.000Z`));
  const end = Date.parse(`${toDateInclusive}T00:00:00.000Z`);
  let total = ZERO;

  for (let time = Date.parse(`${fromDate}T00:00:00.000Z`); time <= end; time += DAY_MS) {
    const date = new Date(time);
    const season = seasonal[date.getUTCMonth()];
    if (season === ZERO) continue;
    const position = monthPosition(date);
    const delta = position.month - anchor.month + position.fraction - anchor.fraction;
    const trend = parsed.growthMode === "replace" ? FACTOR_SCALE : scaledPower(parsed.trendMonthlyFactor, delta);
    // Схема выше гарантирует внешний множитель для replace/incremental.
    const external = parsed.externalMonthlyFactor === null ? FACTOR_SCALE : scaledPower(parsed.externalMonthlyFactor, delta);
    total += base * season * trend * external;
  }

  const rounded = (total + OUTPUT_DIVISOR / BigInt(2)) / OUTPUT_DIVISOR;
  return fromScaled(rounded);
}
