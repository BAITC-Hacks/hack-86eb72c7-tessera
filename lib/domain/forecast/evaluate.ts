import { ForecastModelSchema, type ForecastModel } from "../../contracts/calculation";
import { NonNegativeDecimalStringSchema } from "../../contracts/primitives";
import { addDays, daysInMonth, parseDate } from "./math";

const ZERO = BigInt(0);
const TEN = BigInt(10);
const QUANTITY_DIGITS = 8;
const FACTOR_DIGITS = 64;
const FACTOR_SCALE = TEN ** BigInt(FACTOR_DIGITS);
const TOTAL_DIGITS = 2 * QUANTITY_DIGITS + 2 * FACTOR_DIGITS;
const OUTPUT_DIVISOR = TEN ** BigInt(TOTAL_DIGITS - QUANTITY_DIGITS);

function quantityUnits(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole + fraction.padEnd(QUANTITY_DIGITS, "0"));
}

/** Дробные степени приближённые; десятичные количества остаются точными. */
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
  if (scaled === ZERO) throw new RangeError("Множитель прогноза меньше поддерживаемой точности");
  return scaled;
}

function position(value: string): { month: number; fraction: number } {
  const date = parseDate(value);
  return {
    month: 12 * date.getUTCFullYear() + date.getUTCMonth(),
    fraction: (date.getUTCDate() - 1) / daysInMonth(value),
  };
}

/** Совместимый числовой API: без округления до шага заказа или8 знаков. */
export function sumDailyForecast(model: ForecastModel, fromDate: string, toDateInclusive: string): number;
/** Точная граница DTO08: half-up до8 знаков после суммирования всего интервала. */
export function sumDailyForecast(model: ForecastModel, fromDate: string, toDateInclusive: string, representation: "decimal"): string;
export function sumDailyForecast(
  model: ForecastModel, fromDate: string, toDateInclusive: string, representation?: "decimal",
): number | string {
  const parsed = ForecastModelSchema.parse(model);
  parseDate(fromDate);
  parseDate(toDateInclusive);
  if (fromDate < parsed.startDate || toDateInclusive < fromDate) {
    throw new RangeError("Период прогноза должен начинаться не раньше модели и иметь прямой порядок дат");
  }
  const base = quantityUnits(parsed.baseAtStart);
  const seasonal = parsed.seasonalIndexByMonth.map(quantityUnits);
  const anchor = position(parsed.startDate);
  let total = ZERO;
  if (base !== ZERO) {
    for (let date = fromDate; ; date = addDays(date, 1)) {
      const season = seasonal[Number(date.slice(5, 7)) - 1];
      if (season !== ZERO) {
        const current = position(date);
        // Алгебраически u(d)-u(start), без вычитания близких больших дробных чисел.
        const delta = current.month - anchor.month + current.fraction - anchor.fraction;
        const trend = parsed.growthMode === "replace" ? FACTOR_SCALE : scaledPower(parsed.trendMonthlyFactor, delta);
        const external = parsed.externalMonthlyFactor === null ? FACTOR_SCALE : scaledPower(parsed.externalMonthlyFactor, delta);
        total += base * season * trend * external;
      }
      if (date === toDateInclusive) break;
    }
  }
  if (representation === "decimal") {
    const rounded = (total + OUTPUT_DIVISOR / BigInt(2)) / OUTPUT_DIVISOR;
    const digits = rounded.toString().padStart(QUANTITY_DIGITS + 1, "0");
    const whole = digits.slice(0, -QUANTITY_DIGITS);
    const fraction = digits.slice(-QUANTITY_DIGITS).replace(/0+$/, "");
    return NonNegativeDecimalStringSchema.parse(`${whole}${fraction ? `.${fraction}` : ""}`);
  }
  // Числовое представление приблизительно;08 использует только decimal-перегрузку.
  const result = Number(`${total}e-${TOTAL_DIGITS}`);
  if (!Number.isFinite(result) || (total !== ZERO && result === 0)) {
    throw new RangeError("Сумма прогноза вне поддержанного числового диапазона");
  }
  return result;
}
