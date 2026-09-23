const DAY_MS = 86_400_000;

export function parseDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error("Некорректная календарная дата");
  }
  return date;
}

export function addDays(value: string, count: number): string {
  return new Date(parseDate(value).getTime() + count * DAY_MS).toISOString().slice(0, 10);
}

export function daysInMonth(value: string): number {
  const date = parseDate(value);
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return date.getUTCDate();
}

export function monthStart(value: string): string {
  parseDate(value);
  return `${value.slice(0, 7)}-01`;
}

export function shiftMonth(value: string, months: number): string {
  const date = parseDate(monthStart(value));
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

export function calendarU(value: string): number {
  const date = parseDate(value);
  return 12 * date.getUTCFullYear() + date.getUTCMonth() + (date.getUTCDate() - 1) / daysInMonth(value);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Недостаточно наблюдений для медианы");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Округление только на границе DTO numeric(30,8), не до шага заказа. */
export function decimal(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value >= 1e21) throw new Error("Количество вне поддержанного диапазона");
  return value.toFixed(8).replace(/\.?0+$/, "") || "0";
}

/** Точное сложение входных десятичных количеств до перехода к модели. */
export function sumQuantities(values: readonly string[]): number {
  const scale = BigInt(100_000_000);
  let total = BigInt(0);
  for (const value of values) {
    const negative = value.startsWith("-");
    const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
    const scaled = BigInt(whole) * scale + BigInt(fraction.padEnd(8, "0"));
    total += negative ? -scaled : scaled;
  }
  return Number(total) / Number(scale);
}
