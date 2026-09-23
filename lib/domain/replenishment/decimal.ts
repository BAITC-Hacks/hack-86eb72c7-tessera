import { DecimalStringSchema } from "../../contracts/primitives";

const SCALE = BigInt(100_000_000);
const ZERO = BigInt(0);

/** Точное внутреннее представление канонического numeric(30,8). */
export function toScaled(value: string): bigint {
  DecimalStringSchema.parse(value);
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const result = BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, "0"));
  return negative ? -result : result;
}

/** Каноническая строка; переполнение не превращается в неточное число. */
export function fromScaled(value: bigint): string {
  const negative = value < ZERO;
  const absolute = negative ? -value : value;
  const whole = absolute / SCALE;
  const fraction = (absolute % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return DecimalStringSchema.parse(`${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`);
}

/** Ноль остаётся нулём; положительная потребность округляется вверх до шага. */
export function ceilToStep(value: string, step: string): string {
  const quantity = toScaled(value);
  const increment = toScaled(step);
  if (quantity < ZERO || increment <= ZERO) {
    throw new RangeError("Количество должно быть неотрицательным, а шаг — положительным");
  }
  return fromScaled(((quantity + increment - BigInt(1)) / increment) * increment);
}
